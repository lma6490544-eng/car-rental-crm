import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import { AuthRequest, fail, hash } from './security';

export const commandName = z.enum([
  'finance.post',
  'schedule.update',
  'bookings.create',
  'bookings.accounting-email',
  'bookings.terms',
  'bookings.assign',
  'bookings.move',
  'bookings.cancel',
  'schedule.create',
  'schedule.cancel',
  'pricing.quote',
  'pricing.confirm',
  'users.create',
  'users.status',
  'customers.create',
  'customers.update',
  'customers.block',
  'customers.unblock',
  'customers.note',
  'customers.resolve',
  'vehicles.create',
  'vehicles.update',
  'vehicles.archive',
  'vehicles.service',
  'vehicles.service.update',
  'files.upload',
  'inspections.save',
  'inspections.start',
  'inspections.cancel',
  'contracts.create',
  'contracts.retry',
  'contracts.sign',
  'checkout.start',
  'checkout.signAct',
  'checkout.issue',
  'checkout.stop',
  'rentalReturn.save',
  'rentalReturn.start',
  'rentalReturn.confirm',
  'rentalReturn.correct',
  'rentalReturn.damage',
  'acts.generate',
  'acts.retry',
]);

@Injectable()
export class CommandsService {
  constructor(private readonly db: DatabaseService) {}
  key(request: AuthRequest): string {
    const value = request.headers['idempotency-key'];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value))
      fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Не указан корректный ключ операции.');
    return value;
  }
  async authorize(client: PoolClient, request: AuthRequest, admin = false) {
    const auth = request.auth!;
    const result = await client.query(
      'SELECT u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND u.is_active AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>now() FOR SHARE OF u,s',
      [auth.user.id, auth.tokenHash],
    );
    if (!result.rowCount) fail(401, 'UNAUTHENTICATED', 'Сессия завершена. Войдите снова.');
    if (admin && result.rows[0].role !== 'admin')
      fail(403, 'FORBIDDEN', 'Доступно только администратору.');
  }
  async run<T>(
    request: AuthRequest,
    command: z.infer<typeof commandName>,
    fingerprint: unknown,
    work: (client: PoolClient) => Promise<T>,
    admin = true,
  ): Promise<T> {
    const key = this.key(request);
    const actor = request.auth!.user.id;
    const requestHash = hash(JSON.stringify(fingerprint));
    return this.db.transaction(async (client) => {
      // Serialize identical keys; all effect + audit + outbox + result commit together.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        actor + ':' + command + ':' + key,
      ]);
      await this.authorize(client, request, admin);
      const old = await client.query(
        'SELECT request_hash,result FROM idempotency_records WHERE actor_id=$1 AND command=$2 AND key=$3',
        [actor, command, key],
      );
      if (old.rowCount) {
        if (old.rows[0].request_hash !== requestHash)
          fail(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ уже использован для другой операции.');
        return old.rows[0].result as T;
      }
      if (command.startsWith('vehicles.'))
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('crm:schedule',0))");
      const result = await work(client);
      await client.query(
        'INSERT INTO idempotency_records (actor_id,command,key,request_hash,result) VALUES ($1,$2,$3,$4,$5)',
        [actor, command, key, requestHash, JSON.stringify(result)],
      );
      return result;
    });
  }
}
