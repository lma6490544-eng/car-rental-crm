import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../database.service';
import { renderContract } from './contract-pdf';
import { renderAct } from './act-pdf';
import { queueSupersededPdfs } from './retire-pdfs';
import { fileId, version } from './document.dto';
import { DocumentSchemaGuard } from './document-schema.guard';
import { checksum, PrivateStorage } from './private-storage';

type Job = {
  id: number;
  businessKey: string;
  kind: 'private-file.publish' | 'contract.render' | 'act.render' | 'private-file.retire';
  lease: string;
  attempts: number;
  payload: unknown;
};
type DocumentJob = { versionId: number; fileId: string };
const uploadPayload = z.object({ fileId });
const documentPayload = z.object({ versionId: version, fileId });

@Injectable()
export class DocumentWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private current?: Promise<void>;
  private nextCleanup = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: PrivateStorage,
    private readonly schema: DocumentSchemaGuard,
  ) {}

  onApplicationBootstrap() {
    if (this.storage.configured) this.schedule();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.current;
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.run()
        .catch(() => {
          console.error('Document worker could not process its queue');
        })
        .finally(() => this.schedule());
    }, 1000);
    this.timer.unref();
  }

  private async run() {
    if (!(await this.schema.isReady())) return;
    const job = (
      await this.db.pool.query<Job>(
        `WITH candidate AS (
        SELECT id FROM outbox_jobs WHERE kind IN ('private-file.publish','contract.render','act.render','private-file.retire')
        AND ((status='pending' AND next_attempt_at<=now()) OR (status='running' AND lease_until<=now()))
        ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE outbox_jobs j SET status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes'
      FROM candidate WHERE j.id=candidate.id RETURNING j.id,j.business_key AS "businessKey",j.kind,
      j.lease_until::text AS lease,j.attempts,j.payload`,
      )
    ).rows[0];
    if (job) {
      try {
        if (job.kind === 'private-file.publish')
          await this.publishUpload(job, uploadPayload.parse(job.payload).fileId);
        else if (job.kind === 'private-file.retire')
          await this.retire(job, uploadPayload.parse(job.payload).fileId);
        else if (job.kind === 'act.render')
          await this.render(
            job,
            documentPayload.parse(job.payload),
            'inspection_act_versions',
            'inspection_act',
            "SELECT a.booking_id,a.created_by,i.revision,a.template_version,a.snapshot FROM inspection_act_versions a JOIN inspection_revisions i ON i.id=a.inspection_revision_id WHERE a.id=$1 AND a.status='pending'",
            renderAct,
          );
        else
          await this.render(
            job,
            documentPayload.parse(job.payload),
            'contract_versions',
            'contract',
            "SELECT booking_id,created_by,revision,template_version,snapshot FROM contract_versions WHERE id=$1 AND status='pending'",
            renderContract,
          );
      } catch {
        await this.recordFailure(job);
      }
    }
    await this.expirePhotos();
    if (Date.now() >= this.nextCleanup) {
      await this.cleanStaging();
      await queueSupersededPdfs(this.db.pool);
      this.nextCleanup = Date.now() + 3600000;
    }
  }

  private async complete(job: Job, write: (c: PoolClient) => Promise<void>) {
    await this.db.transaction(async (c) => {
      const lease = await c.query(
        `UPDATE outbox_jobs SET status='done',lease_until=NULL WHERE id=$1 AND status='running'
         AND lease_until=$2::timestamptz AND lease_until>clock_timestamp() RETURNING id`,
        [job.id, job.lease],
      );
      if (lease.rowCount) await write(c);
    });
  }

  private async findObject(id: string) {
    return this.storage.read(id).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  }

  private async publishUpload(job: Job, id: string) {
    const expected = (
      await this.db.pool.query<{ checksum: string; size: number }>(
        "SELECT checksum,size FROM private_files WHERE id=$1 AND status='pending'",
        [id],
      )
    ).rows[0];
    if (!expected) throw new Error('Missing staged file');
    let bytes = await this.findObject(id);
    if (!bytes) {
      bytes = await this.storage.read(id, true);
      if (bytes.length !== expected.size || checksum(bytes) !== expected.checksum)
        throw new Error('Staging checksum mismatch');
      await this.storage.publish(id, id);
      bytes = await this.storage.read(id);
    }
    if (checksum(bytes) !== expected.checksum) throw new Error('Private object checksum mismatch');
    await this.complete(job, async (c) => {
      await c.query("UPDATE private_files SET status='ready' WHERE id=$1 AND status='pending'", [
        id,
      ]);
    });
  }

  private async render<Snapshot>(
    job: Job,
    { versionId, fileId }: DocumentJob,
    table: 'inspection_act_versions' | 'contract_versions',
    category: 'inspection_act' | 'contract',
    select: string,
    renderFile: (
      bookingId: number,
      revision: number,
      template: string,
      snapshot: Snapshot,
    ) => Promise<Buffer>,
  ) {
    const row = (
      await this.db.pool.query<{
        booking_id: number;
        created_by: number;
        revision: number;
        template_version: string;
        snapshot: Snapshot;
      }>(select, [versionId])
    ).rows[0];
    if (!row) throw new Error('Missing document version');
    let bytes = await this.findObject(fileId);
    if (!bytes) {
      const stagedId = randomUUID();
      const pdf = await renderFile(
        row.booking_id,
        row.revision,
        row.template_version,
        row.snapshot,
      );
      await this.storage.stage(stagedId, pdf);
      await this.storage.publish(fileId, stagedId);
      bytes = await this.storage.read(fileId);
    }
    const { length } = bytes;
    const digest = checksum(bytes);
    await this.complete(job, async (c) => {
      await c.query(
        `INSERT INTO private_files(id,booking_id,category,mime,size,checksum,status,created_by)
         VALUES($1,$2,$6,'application/pdf',$3,$4,'ready',$5)`,
        [fileId, row.booking_id, length, digest, row.created_by, category],
      );
      await c.query(
        `UPDATE ${table} SET status='ready',file_id=$2 WHERE id=$1 AND status='pending'`,
        [versionId, fileId],
      );
      await queueSupersededPdfs(c);
    });
  }

  private async retire(job: Job, id: string) {
    const { rowCount } = await this.db.pool.query(
      "UPDATE private_files SET status='deleted' WHERE id=$1 AND category IN ('contract','inspection_act')",
      [id],
    );
    if (rowCount) await this.storage.remove(id);
    await this.complete(job, async () => {});
  }

  private async recordFailure(job: Job) {
    const failed = job.kind !== 'private-file.retire' && job.attempts >= 3;
    await this.db.transaction(async (c) => {
      const updated = await c.query(
        `UPDATE outbox_jobs SET status=$3,lease_until=NULL,next_attempt_at=now()+($4::int * interval '1 second')
         WHERE id=$1 AND status='running' AND lease_until=$2::timestamptz RETURNING id`,
        [job.id, job.lease, failed ? 'failed' : 'pending', Math.min(job.attempts * 3, 300)],
      );
      if (!updated.rowCount || !failed) return;
      if (job.kind !== 'private-file.publish') {
        const table = job.kind === 'act.render' ? 'inspection_act_versions' : 'contract_versions';
        const parsed = documentPayload.safeParse(job.payload);
        if (parsed.success)
          await c.query(`UPDATE ${table} SET status='failed' WHERE id=$1 AND status='pending'`, [
            parsed.data.versionId,
          ]);
      } else {
        const parsed = uploadPayload.safeParse(job.payload);
        if (parsed.success)
          await c.query(
            "UPDATE private_files SET status='failed' WHERE id=$1 AND status='pending'",
            [parsed.data.fileId],
          );
      }
    });
  }

  private async expirePhotos() {
    const rows = (
      await this.db.pool.query<{ id: string }>(
        `SELECT id FROM private_files WHERE category='inspection_photo' AND status IN ('ready','failed')
       AND deleted_at IS NULL AND delete_after<=clock_timestamp() ORDER BY delete_after LIMIT 20`,
      )
    ).rows;
    for (const { id } of rows) {
      await this.storage.remove(id);
      await this.storage.remove(id, true);
      await this.db.pool.query(
        `UPDATE private_files SET status='deleted',deleted_at=clock_timestamp()
         WHERE id=$1 AND deleted_at IS NULL AND delete_after<=clock_timestamp()`,
        [id],
      );
    }
  }

  private async cleanStaging() {
    for (const id of await this.storage.staleStaging()) {
      const retained = await this.db.pool.query(
        "SELECT id FROM private_files WHERE id=$1 AND status='pending'",
        [id],
      );
      if (!retained.rowCount) await this.storage.remove(id, true);
    }
  }
}
