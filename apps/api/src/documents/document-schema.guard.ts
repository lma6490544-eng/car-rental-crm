import { CanActivate, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { fail } from '../platform/security';

@Injectable()
export class DocumentSchemaGuard implements CanActivate {
  private ready = false;

  constructor(private readonly db: DatabaseService) {}

  async isReady() {
    if (this.ready) return true;
    const { rows } = await this.db.pool.query<{ ready: boolean }>(`SELECT
      to_regclass('private_files') IS NOT NULL
      AND to_regclass('inspection_revisions') IS NOT NULL
      AND to_regclass('inspection_work') IS NOT NULL
      AND to_regclass('inspection_revision_photos') IS NOT NULL
      AND to_regclass('contract_versions') IS NOT NULL
      AND to_regclass('contract_signing_confirmations') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('booking_checkouts')
        AND attname='stopped_at' AND NOT attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('inspection_act_versions')
        AND attname='customer_version' AND NOT attisdropped) AS ready`);
    this.ready = rows[0]?.ready === true;
    return this.ready;
  }

  async canActivate() {
    if (!(await this.isReady()))
      fail(
        503,
        'DOCUMENT_SCHEMA_REQUIRED',
        'Для осмотров и документов нужна база с актуальными миграциями.',
      );
    return true;
  }
}
