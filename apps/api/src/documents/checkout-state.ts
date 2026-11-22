import type { PoolClient } from 'pg';
import { fail } from '../platform/security';
import { actMatchesCustomer } from './act-customer';

const invoiceReceiptExists = `EXISTS (
  SELECT 1 FROM audit_logs receipt
  WHERE receipt.entity_type='financial_operation' AND receipt.entity_id=o.id
    AND receipt.action='finance.rent_payment' AND receipt.details ? 'invoiceReceipt'
)`;

export async function bookingHasInvoiceReceipts(c: PoolClient, bookingId: number) {
  const { rows } = await c.query<{ has_money: boolean }>(
    `SELECT COALESCE(sum(fa.amount_rub),0)>0 AS has_money
     FROM finance_allocations fa JOIN finance_lots l ON l.id=fa.lot_id
     JOIN financial_operations o ON o.id=l.original_operation_id
     WHERE fa.booking_id=$1 AND o.booking_id=$1 AND fa.bucket='rent' AND ${invoiceReceiptExists}`,
    [bookingId],
  );
  return rows[0]!.has_money;
}

export async function checkoutAvailable(c: PoolClient) {
  return (
    await c.query<{ ready: boolean }>(
      "SELECT to_regclass('booking_checkouts') IS NOT NULL AS ready",
    )
  ).rows[0]!.ready;
}

export async function checkoutState(c: PoolClient, bookingId: number) {
  return (await checkoutStates(c, [bookingId])).get(bookingId) ?? null;
}

type CheckoutState = {
  startedAt: string;
  issuedAt: Date | null;
  hasChanges: boolean;
  actSignedAt: Date | null;
  currentActSigned: boolean;
  currentContractSigned: boolean;
  contractId: number | null;
  inspectionId: number | null;
  requiredDepositRub: string | null;
  hasMoney: boolean;
  rentReceived: boolean;
  depositReceived: boolean;
};

export async function checkoutStates(c: PoolClient, bookingIds: readonly number[]) {
  if (!bookingIds.length || !(await checkoutAvailable(c))) return new Map<number, CheckoutState>();
  const { rows } = await c.query<CheckoutState & { booking_id: number }>(
    `SELECT x.booking_id,x.started_at::text AS "startedAt", x.issued_at AS "issuedAt", x.act_signed_at AS "actSignedAt",
      (b.updated_at>=x.started_at OR u.updated_at>=x.started_at OR v.id IS NOT NULL OR i.id IS NOT NULL
        OR EXISTS (SELECT 1 FROM private_files f WHERE f.booking_id=b.id AND f.inspection_kind='pickup'
          AND f.status IN ('pending','ready'))) AS "hasChanges",
     COALESCE(i.id=x.act_revision_id AND i.vehicle_id=assignment.vehicle_id AND x.act_signed_at>=b.updated_at
       AND (x.issued_at IS NOT NULL OR (a.status='ready' AND a.booking_version=b.version
         AND ${actMatchesCustomer})),false) AS "currentActSigned",
     COALESCE(s.contract_version_id IS NOT NULL AND v.status='ready'
       AND (v.snapshot->>'bookingVersion')::int=b.version
       AND (v.snapshot->'customer'->>'version')::int=u.version AND NOT u.is_blocked,false) AS "currentContractSigned",
     v.id AS "contractId", i.id AS "inspectionId", v.snapshot->>'securityDepositRub' AS "requiredDepositRub",
     (amounts.rent>0 OR amounts.deposit>0) AS "hasMoney",
     COALESCE((v.snapshot->'terms'->>'finalTotalRub')::numeric=0 OR amounts.rent>0,false) AS "rentReceived",
     COALESCE(amounts.deposit>=(v.snapshot->>'securityDepositRub')::numeric,false) AS "depositReceived"
     FROM booking_checkouts x JOIN bookings b ON b.id=x.booking_id JOIN customers u ON u.id=b.customer_id
     LEFT JOIN schedule_blocks assignment ON assignment.booking_id=b.id AND assignment.retired_at IS NULL
     LEFT JOIN inspection_act_versions a ON a.id=x.act_version_id
     LEFT JOIN LATERAL (SELECT id, status, snapshot FROM contract_versions WHERE booking_id=b.id ORDER BY revision DESC LIMIT 1) v ON true
     LEFT JOIN contract_signing_confirmations s ON s.contract_version_id=v.id
     LEFT JOIN LATERAL (SELECT id, vehicle_id FROM inspection_revisions WHERE booking_id=b.id AND kind='pickup' ORDER BY revision DESC LIMIT 1) i ON true
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(fa.amount_rub) FILTER (WHERE fa.bucket='rent'),0) AS rent,
              COALESCE(sum(fa.amount_rub) FILTER (WHERE fa.bucket='deposit'),0) AS deposit
       FROM finance_allocations fa JOIN finance_lots l ON l.id=fa.lot_id
       JOIN financial_operations o ON o.id=l.original_operation_id
       WHERE fa.booking_id=b.id AND o.booking_id=b.id
         AND (o.created_at>=x.started_at OR ${invoiceReceiptExists})
     ) amounts
     WHERE x.booking_id=ANY($1::int[]) AND to_jsonb(x)->>'stopped_at' IS NULL`,
    [bookingIds],
  );
  return new Map(rows.map(({ booking_id, ...state }) => [booking_id, state]));
}

export async function guardCheckoutChange(c: PoolClient, bookingId: number, allowReceipts = false) {
  const state = await checkoutState(c, bookingId);
  if (state?.issuedAt)
    fail(
      409,
      'VEHICLE_ALREADY_ISSUED',
      'Автомобиль уже выдан. Условия этой брони закрыты для изменения.',
    );
  if (!allowReceipts && (state?.hasMoney ?? (await bookingHasInvoiceReceipts(c, bookingId))))
    fail(
      409,
      'CHECKOUT_HAS_MONEY',
      'Сначала оформите возврат или компенсацию проведённых денег по этой брони.',
    );
  return state;
}

export async function checkoutPhases(c: PoolClient, ids: number[]) {
  if (!ids.length || !(await checkoutAvailable(c))) return new Map<number, 'started' | 'issued'>();
  const { rows } = await c.query<{ booking_id: number; phase: 'started' | 'issued' }>(
    `SELECT booking_id,CASE WHEN issued_at IS NULL THEN 'started' ELSE 'issued' END AS phase
     FROM booking_checkouts x WHERE booking_id=ANY($1::int[]) AND to_jsonb(x)->>'stopped_at' IS NULL`,
    [ids],
  );
  return new Map(rows.map(({ booking_id, phase }) => [booking_id, phase]));
}
