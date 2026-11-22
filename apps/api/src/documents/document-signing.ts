import type { PoolClient } from 'pg';
import type { AuthRequest } from '../platform/security';
import { audit } from '../platform/security';

export async function recordContractSignature(
  c: PoolClient,
  request: AuthRequest,
  bookingId: number,
  versionId: number,
) {
  const actor = request.auth!.user.id;
  const written = await c.query(
    'INSERT INTO contract_signing_confirmations(contract_version_id,actor_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [versionId, actor],
  );
  if (written.rowCount)
    await audit(c, actor, 'booking', 'contracts.signed', bookingId, request.requestId, {
      versionId,
    });
}

export async function recordActSignature(
  c: PoolClient,
  request: AuthRequest,
  bookingId: number,
  revisionId: number,
  actVersionId: number,
) {
  const actor = request.auth!.user.id;
  const signed = await c.query(
    `UPDATE booking_checkouts SET act_revision_id=$2,act_signed_by=$3,act_signed_at=now(),act_version_id=$4
     WHERE booking_id=$1 AND (act_revision_id IS DISTINCT FROM $2 OR act_version_id IS DISTINCT FROM $4 OR act_signed_at<(SELECT updated_at FROM bookings WHERE id=$1))`,
    [bookingId, revisionId, actor, actVersionId],
  );
  if (signed.rowCount)
    await audit(c, actor, 'booking', 'checkout.actSigned', bookingId, request.requestId, {
      revisionId,
      actVersionId,
    });
  return !!signed.rowCount;
}
