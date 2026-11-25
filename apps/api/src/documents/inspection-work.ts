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
  const work = await findInspectionWork(c, bookingId, bookingVersion, kind);
  if (work)
    fail(409, 'INSPECTION_IN_PROGRESS', 'Дождитесь завершения осмотра: ' + work.operatorName + '.');
}

export async function findInspectionWork(
  c: PoolClient,
  bookingId: number,
  bookingVersion: number,
  kind: InspectionKind,
) {
  return (await listInspectionWork(c, bookingId, bookingVersion)).find((row) => row.kind === kind);
}

export function assertInspectionWorkOwner(
  work: Awaited<ReturnType<typeof findInspectionWork>>,
  workId: number | undefined,
  operatorId: number,
) {
  if (work && (work.id !== workId || work.operatorId !== operatorId))
    fail(409, 'INSPECTION_IN_PROGRESS', 'Осмотр заполняет ' + work.operatorName + '.');
  if (!work && workId !== undefined)
    fail(409, 'INSPECTION_WORK_CHANGED', 'Статус осмотра изменился. Проверьте карточку.');
}
