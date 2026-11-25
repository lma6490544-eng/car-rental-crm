import type { PoolClient } from 'pg';
import { AuthRequest, audit } from '../platform/security';

export type RentalEvent = 'checkout.started' | 'rentalReturn.started';

export async function recordRentalStart(
  c: PoolClient,
  request: AuthRequest,
  id: number,
  event: RentalEvent,
) {
  await audit(c, request.auth!.user.id, 'booking', event, id, request.requestId);
  await c.query(
    `INSERT INTO outbox_jobs(business_key,kind,payload)
     SELECT 'rental.push:' || $1::text || ':' || s.id, 'rental.push',
       jsonb_build_object('eventId',$1::text,'event',$2::text,'bookingId',$3::int,
                          'subscriptionId',s.id,'userId',s.user_id)
     FROM push_subscriptions s JOIN users u ON u.id=s.user_id AND u.is_active
     ON CONFLICT (business_key) DO NOTHING`,
    [request.requestId, event, id],
  );
}
