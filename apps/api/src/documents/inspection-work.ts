import type { PoolClient } from 'pg';
import { fail } from '../platform/security';
import type { InspectionKind } from './document.dto';

export async function listInspectionWork(c: PoolClient, bookingId: number, bookingVersion: number) {
  return (
    await c.query<{ id: number; kind: InspectionKind; operatorId: number; operatorName: string }>(
      `SELECT w.id,w.kind,w.operator_id AS "operatorId",u.full_name AS "operatorName"
       FROM inspection_work w JOIN users u ON u.id=w.operator_id
       WHERE w.booking_id=$1 AND w.booking_version=$2`,
      [bookingId, bookingVersion],
    )
  ).rows;
}

export async function assertInspectionIdle(
  c: PoolClient,
  bookingId: number,
  bookingVersion: number,
  kind: InspectionKind,
) {
  const work = (await listInspectionWork(c, bookingId, bookingVersion)).find(
    (row) => row.kind === kind,
  );
  if (work)
    fail(409, 'INSPECTION_IN_PROGRESS', 'Дождитесь завершения осмотра: ' + work.operatorName + '.');
}
