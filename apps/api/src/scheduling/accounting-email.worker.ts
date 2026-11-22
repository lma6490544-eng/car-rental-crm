import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { DatabaseService } from '../database.service';
import { accountingEmailKind, accountingMessage, type AccountingBooking } from './accounting-email';

type AccountingJob = AccountingBooking & { id: number; attempts: number; lease: string };
type DeliveryStatus = 'done' | 'pending' | 'failed' | 'unknown';

function deliveryFailure(error: unknown, attempts: number): DeliveryStatus {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const responseCode = 'responseCode' in error ? Number(error.responseCode) : 0;
  const connection = 'command' in error && error.command === 'CONN';
  if (connection || (responseCode >= 400 && responseCode < 500))
    return attempts < 3 ? 'pending' : 'failed';
  if (responseCode >= 500 && responseCode < 600) return 'failed';
  return 'unknown';
}

function smtpDiagnostic(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const fields: string[] = [];
  if ('code' in error && typeof error.code === 'string' && /^E[A-Z]{2,30}$/.test(error.code))
    fields.push(error.code);
  if (
    'command' in error &&
    typeof error.command === 'string' &&
    /^[A-Z ]{2,24}$/.test(error.command)
  )
    fields.push(error.command);
  if (
    'responseCode' in error &&
    typeof error.responseCode === 'number' &&
    Number.isInteger(error.responseCode) &&
    error.responseCode >= 400 &&
    error.responseCode <= 599
  )
    fields.push(`SMTP ${error.responseCode}`);
  if (
    'response' in error &&
    typeof error.response === 'string' &&
    /spam|unsolicited/i.test(error.response)
  )
    fields.push('spam policy');
  return fields.length ? ` (${fields.join(', ')})` : '';
}

@Injectable()
export class AccountingEmailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AccountingEmailWorker.name);
  private readonly from = process.env.ACCOUNTING_SMTP_USER || 'mihaillgt@yandex.com';
  private readonly to = process.env.ACCOUNTING_EMAIL_TO || 'soforadc@gmail.com';
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private current?: Promise<void>;

  constructor(private readonly db: DatabaseService) {}

  onApplicationBootstrap() {
    const password = process.env.ACCOUNTING_SMTP_APP_PASSWORD;
    // API subprocesses launched by node:test inherit the test context and local configuration.
    if (!password || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
    const transport = createTransport({
      host: 'smtp.yandex.com',
      port: 465,
      secure: true,
      auth: { user: this.from, pass: password },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });
    this.schedule(transport);
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
  }

  private schedule(transport: ReturnType<typeof createTransport>) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.run(transport)
        .catch(() => this.logger.error('Could not process the accounting email queue'))
        .finally(() => this.schedule(transport));
    }, 5000);
    this.timer.unref();
  }

  private async run(transport: ReturnType<typeof createTransport>) {
    const expired = await this.db.pool.query<{ id: number }>(
      `UPDATE outbox_jobs SET status='unknown',lease_until=NULL
       WHERE kind=$1 AND status='running' AND lease_until<=now() RETURNING id`,
      [accountingEmailKind],
    );
    for (const job of expired.rows)
      this.logger.warn(`Accounting email job ${job.id}: SMTP outcome unknown after timeout`);

    const job = (
      await this.db.pool.query<AccountingJob>(
        `WITH candidate AS (
           SELECT j.id, b.id AS "bookingId", b.start_at AS "startAt", b.end_at AS "endAt",
             c.display_name AS company, brand.name AS brand, m.name AS model, v.plate,
             terms.snapshot AS calculation
           FROM outbox_jobs j
           JOIN bookings b ON b.id=(j.payload->>'bookingId')::int AND b.status='confirmed'
           JOIN customers c ON c.id=b.customer_id AND c.type='company'
           JOIN schedule_blocks s ON s.booking_id=b.id AND s.kind='assignment' AND s.retired_at IS NULL
             AND s.id::text=j.payload->>'assignmentId'
           JOIN vehicles v ON v.id=s.vehicle_id
           JOIN vehicle_models m ON m.id=v.model_id
           JOIN vehicle_brands brand ON brand.id=m.brand_id
           JOIN LATERAL (
             SELECT snapshot FROM booking_terms WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1
           ) terms ON true
           WHERE j.kind=$1 AND j.status='pending' AND j.next_attempt_at<=now()
           ORDER BY j.next_attempt_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
         )
         UPDATE outbox_jobs j
         SET status='running',attempts=j.attempts+1,lease_until=now()+interval '5 minutes'
         FROM candidate WHERE j.id=candidate.id
         RETURNING candidate.*, j.attempts, j.lease_until::text AS lease`,
        [accountingEmailKind],
      )
    ).rows[0];
    if (!job) return;

    let status: DeliveryStatus = 'done';
    let diagnostic = '';
    const message = accountingMessage(job);
    try {
      await transport.sendMail({ from: this.from, to: this.to, ...message });
    } catch (error) {
      status = deliveryFailure(error, job.attempts);
      diagnostic = smtpDiagnostic(error);
    }
    await this.db.pool.query(
      `UPDATE outbox_jobs SET status=$3,lease_until=NULL,next_attempt_at=now()+interval '1 minute',
         payload=CASE WHEN $3='done' THEN payload || jsonb_build_object('sentAt',now()) ELSE payload END
       WHERE id=$1 AND status='running' AND lease_until=$2::timestamptz`,
      [job.id, job.lease, status],
    );
    if (status === 'failed' || status === 'unknown')
      this.logger.warn(`Accounting email for booking ${job.bookingId}: ${status}${diagnostic}`);
  }
}
