import { HttpException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { fail } from '../platform/security';
import { renderAct, type ActSnapshot } from './act-pdf';
import { renderContract } from './contract-pdf';
import type { ContractSnapshot } from './contracts.service';
import { PrivateFilesService } from './private-files.service';

@Injectable()
export class DocumentPrintService {
  constructor(
    private readonly db: DatabaseService,
    private readonly files: PrivateFilesService,
  ) {}

  contract(bookingId: number, id: number) {
    return this.print(
      bookingId,
      id,
      'contract',
      renderContract,
      `SELECT d.revision,d.template_version,d.snapshot,f.id AS file_id,f.status AS file_status
      FROM contract_versions d JOIN private_files f ON f.id=d.file_id
      WHERE d.booking_id=$1 AND d.id=$2 AND d.status='ready'`,
    );
  }

  act(bookingId: number, id: number) {
    return this.print(
      bookingId,
      id,
      'inspection_act',
      renderAct,
      `SELECT i.revision,d.template_version,d.snapshot,f.id AS file_id,f.status AS file_status
      FROM inspection_act_versions d JOIN inspection_revisions i ON i.id=d.inspection_revision_id
      JOIN private_files f ON f.id=d.file_id WHERE d.booking_id=$1 AND d.id=$2 AND d.status='ready'`,
    );
  }

  private async print<T extends ContractSnapshot | ActSnapshot>(
    bookingId: number,
    id: number,
    category: 'contract' | 'inspection_act',
    render: (bookingId: number, revision: number, template: string, snapshot: T) => Promise<Buffer>,
    sql: string,
  ) {
    const row = (
      await this.db.pool.query<{
        revision: number;
        template_version: string;
        snapshot: T;
        file_id: string;
        file_status: string;
      }>(sql, [bookingId, id])
    ).rows[0];
    if (!row) fail(404, 'NOT_FOUND', 'Готовый документ не найден.');
    if (row.file_status === 'ready') {
      try {
        return (await this.files.download({ bookingId }, row.file_id, category)).bytes;
      } catch (error) {
        if (!(error instanceof HttpException) || ![410, 503].includes(error.getStatus()))
          throw error;
        const file = await this.db.pool.query<{ status: string }>(
          'SELECT status FROM private_files WHERE id=$1',
          [row.file_id],
        );
        if (file.rows[0]?.status !== 'deleted') throw error;
      }
    } else if (row.file_status !== 'deleted') {
      fail(409, 'PDF_NOT_READY', 'Документ ещё формируется.');
    }
    return render(bookingId, row.revision, row.template_version, row.snapshot);
  }
}
