import type { PoolClient } from 'pg';

export async function queueSupersededPdfs(c: Pick<PoolClient, 'query'>) {
  await c.query(`INSERT INTO outbox_jobs(business_key,kind,payload)
    SELECT 'private-file-retire:'||f.id,'private-file.retire',jsonb_build_object('fileId',f.id)
    FROM private_files f JOIN (
      SELECT old.file_id FROM contract_versions old WHERE EXISTS (
        SELECT 1 FROM contract_versions newer WHERE newer.booking_id=old.booking_id
          AND newer.revision>old.revision AND newer.status='ready'
      )
      UNION
      SELECT old.file_id FROM inspection_act_versions old
      JOIN inspection_revisions old_inspection ON old_inspection.id=old.inspection_revision_id
      WHERE EXISTS (
        SELECT 1 FROM inspection_act_versions newer
        JOIN inspection_revisions new_inspection ON new_inspection.id=newer.inspection_revision_id
        WHERE newer.booking_id=old.booking_id AND new_inspection.kind=old_inspection.kind
          AND newer.id>old.id AND newer.status='ready'
      )
    ) superseded ON superseded.file_id=f.id
    WHERE f.status='ready' AND f.category IN ('contract','inspection_act')
    ON CONFLICT (business_key) DO NOTHING`);
}
