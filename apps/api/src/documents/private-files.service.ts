import { HttpException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database.service';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail } from '../platform/security';
import type { InspectionKind } from './document.dto';
import { lockBooking } from './booking-documents';
import { checksum, PrivateStorage, supportedFile } from './private-storage';

type FileOwner = { bookingId: number } | { customerId: number };
type UploadOwner =
  | { bookingId: number; kind: InspectionKind; expectedBookingVersion: number }
  | { customerId: number };
type FileStatus = 'pending' | 'ready' | 'failed' | 'deleted' | 'expired';
export type FileSummary = {
  id: string;
  mime: string;
  size: number;
  status: FileStatus;
  createdAt: Date;
  deleteAfter: Date | null;
};
const fileSummary = `id,mime,size,
  CASE WHEN status<>'deleted' AND delete_after<=clock_timestamp() THEN 'expired' ELSE status END AS status,
  created_at AS "createdAt",delete_after AS "deleteAfter"`;

@Injectable()
export class PrivateFilesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly commands: CommandsService,
    private readonly storage: PrivateStorage,
  ) {}

  async bookingPhotos(c: PoolClient, bookingId: number) {
    return (
      await c.query<FileSummary>(
        `SELECT ${fileSummary} FROM private_files WHERE booking_id=$1 AND category='inspection_photo' ORDER BY created_at DESC`,
        [bookingId],
      )
    ).rows;
  }

  async customerDocuments(customerId: number) {
    return this.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await this.customer(c, customerId);
      return (
        await c.query<FileSummary>(
          `SELECT ${fileSummary} FROM private_files WHERE customer_id=$1 ORDER BY created_at DESC`,
          [customerId],
        )
      ).rows;
    });
  }

  private async customer(c: PoolClient, customerId: number, lock = false) {
    const found = await c.query(
      'SELECT id FROM customers WHERE id=$1' + (lock ? ' FOR UPDATE' : ''),
      [customerId],
    );
    if (!found.rowCount) fail(404, 'NOT_FOUND', 'Клиент не найден.');
  }

  async upload(request: AuthRequest, owner: UploadOwner, mime: string, bytes: Buffer) {
    this.commands.key(request);
    const photo = 'bookingId' in owner;
    const category = photo ? 'inspection_photo' : 'customer_document';
    if (!supportedFile(mime, bytes, photo))
      fail(415, 'FILE_TYPE_UNSUPPORTED', 'Файл не соответствует допустимому формату.');
    const id = randomUUID();
    const digest = checksum(bytes);
    await this.storage.stage(id, bytes);
    const result = await this.commands
      .run(
        request,
        'files.upload',
        { owner, mime, digest },
        async (c) => {
          const booking =
            'bookingId' in owner
              ? await lockBooking(c, owner.bookingId, owner.expectedBookingVersion)
              : null;
          if ('customerId' in owner) await this.customer(c, owner.customerId, true);
          const bookingId = 'bookingId' in owner ? owner.bookingId : null;
          const customerId = 'customerId' in owner ? owner.customerId : null;
          const count = (
            await c.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM private_files
         WHERE (booking_id=$1 OR customer_id=$2) AND category=$3 AND status IN ('pending','ready')`,
              [bookingId, customerId, category],
            )
          ).rows[0]!.n;
          if (count >= (photo ? 500 : 50))
            fail(422, 'FILE_LIMIT', 'Достигнут предел числа файлов.');
          await c.query(
            `INSERT INTO private_files(id,booking_id,customer_id,category,mime,size,checksum,created_by,inspection_kind,vehicle_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              id,
              bookingId,
              customerId,
              category,
              mime,
              bytes.length,
              digest,
              request.auth!.user.id,
              'kind' in owner ? owner.kind : null,
              booking?.vehicleId ?? null,
            ],
          );
          await c.query(
            "INSERT INTO outbox_jobs(business_key,kind,payload) VALUES($1,'private-file.publish',$2)",
            ['private-file:' + id, JSON.stringify({ fileId: id })],
          );
          await audit(
            c,
            request.auth!.user.id,
            photo ? 'booking' : 'customer',
            'files.uploaded',
            bookingId ?? customerId,
            request.requestId,
            { id, category },
          );
          return { id };
        },
        false,
      )
      .catch(async (error: unknown) => {
        // A rejected business command has rolled back. For uncertain commits the worker/janitor
        // keeps staging available until it can check committed metadata.
        if (error instanceof HttpException && error.getStatus() < 500)
          await this.storage.remove(id, true).catch(() => {});
        throw error;
      });
    if (result.id !== id) await this.storage.remove(id, true).catch(() => {});
    return result;
  }

  async download(
    owner: FileOwner,
    id: string,
    category: 'inspection_photo' | 'contract' | 'inspection_act' | 'customer_document',
  ) {
    const row = (
      await this.db.pool.query<{ mime: string; checksum: string; status: FileStatus }>(
        `SELECT mime,checksum,CASE WHEN status<>'deleted' AND delete_after<=clock_timestamp() THEN 'expired'
        ELSE status END AS status FROM private_files WHERE id=$1 AND category=$2 AND
        (booking_id=$3 OR customer_id=$4)`,
        [
          id,
          category,
          'bookingId' in owner ? owner.bookingId : null,
          'customerId' in owner ? owner.customerId : null,
        ],
      )
    ).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'Файл не найден.');
    if (row.status === 'deleted' || row.status === 'expired')
      fail(
        410,
        'FILE_EXPIRED',
        category === 'inspection_photo'
          ? 'Фото удалено по сроку хранения.'
          : 'Файл снят с хранения.',
      );
    if (row.status !== 'ready') fail(409, 'FILE_NOT_READY', 'Файл ещё недоступен.');
    const bytes = await this.storage.read(id).catch(() => undefined);
    if (!bytes || checksum(bytes) !== row.checksum)
      fail(503, 'FILE_UNAVAILABLE', 'Файл временно недоступен.');
    return { bytes, mime: row.mime };
  }
}
