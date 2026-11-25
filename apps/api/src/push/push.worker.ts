import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { sendNotification, WebPushError } from 'web-push';
import { DatabaseService } from '../database.service';
import { vapidConfig } from '../env';
import type { RentalEvent } from './rental-event';

type Job = {
  id: number;
  attempts: number;
  payload: {
    event: RentalEvent;
    eventId: string;
    bookingId: number;
    subscriptionId: number;
    userId: number;
  };
};

@Injectable()
export class PushWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PushWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(private readonly db: DatabaseService) {}

  onApplicationBootstrap() {
    const config = vapidConfig();
    if (!config || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return;
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.drain(config)
          .catch(() => this.logger.error('Ошибка обработки очереди push'))
          .finally(() => {
            this.running = undefined;
          });
    }, 2000);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }

  private async drain(config: NonNullable<ReturnType<typeof vapidConfig>>) {
    // A crash after the service accepts a message has an ambiguous outcome. Do not resend it.
    await this.db.pool.query(
      "UPDATE outbox_jobs SET status='unknown',lease_until=NULL WHERE kind='rental.push' AND status='running' AND lease_until<=now()",
    );
    const jobs = await this.db.pool.query<Job>(
      `WITH due AS (SELECT id FROM outbox_jobs WHERE kind='rental.push' AND status='pending' AND next_attempt_at<=now()
       ORDER BY next_attempt_at,id LIMIT 12 FOR UPDATE SKIP LOCKED)
       UPDATE outbox_jobs j SET status='running',attempts=j.attempts+1,lease_until=now()+interval '2 minutes'
       FROM due WHERE due.id=j.id RETURNING j.id,j.payload,j.attempts`,
    );
    await Promise.all(jobs.rows.map((job) => this.deliver(job, config)));
  }

  private async deliver(job: Job, config: NonNullable<ReturnType<typeof vapidConfig>>) {
    const { event, eventId, bookingId, subscriptionId, userId } = job.payload;
    const {
      rows: [device],
    } = await this.db.pool.query<{ endpoint: string; p256dh: string; auth: string }>(
      `SELECT s.endpoint,s.p256dh,s.auth FROM push_subscriptions s JOIN users u ON u.id=s.user_id AND u.is_active
       WHERE s.id=$1 AND s.user_id=$2`,
      [subscriptionId, userId],
    );
    let status = 'done';
    if (device) {
      try {
        await sendNotification(
          { endpoint: device.endpoint, keys: { auth: device.auth, p256dh: device.p256dh } },
          JSON.stringify({ event, eventId, bookingId }),
          { vapidDetails: config, TTL: 900, timeout: 10000 },
        );
      } catch (error) {
        if (error instanceof WebPushError && [404, 410].includes(error.statusCode)) {
          await this.db.pool.query(
            'DELETE FROM push_subscriptions WHERE id=$1 AND user_id=$2 AND auth=$3',
            [subscriptionId, userId, device.auth],
          );
        } else if (error instanceof WebPushError && error.statusCode === 429 && job.attempts < 5)
          status = 'pending';
        else status = error instanceof WebPushError ? 'failed' : 'unknown';
      }
    }
    await this.db.pool.query(
      `UPDATE outbox_jobs SET status=$2,lease_until=NULL,next_attempt_at=now()+interval '1 minute' * $3::int
       WHERE id=$1 AND status='running'`,
      [job.id, status, job.attempts],
    );
    if (status === 'failed' || status === 'unknown')
      this.logger.warn(`Push job ${job.id}: ${status}`);
  }
}
