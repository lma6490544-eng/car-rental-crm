import type { Source } from './types';
export const sourceKey = (s: Source) => [s.lotId, s.bucket, s.bookingId, s.fund].join(':');

export function availableSources(sources: Source[], kind: string, selectedBooking?: number) {
  return sources.filter((source) => {
    if (kind === 'credit_use') return source.bucket === 'credit';
    if (kind === 'to_credit')
      return source.bookingId === selectedBooking && source.bucket !== 'credit';
    return source.bucket === 'credit' || source.bookingId === selectedBooking;
  });
}
type OperationInput = {
  kind: string;
  reason: string;
  fund: string;
  amount: string;
  method: string;
  operationId?: number;
  customerId?: number;
  selectedBooking?: number;
  version?: number;
  parts: Record<string, string>;
  available: Source[];
};
export function buildMoneyOperation({
  kind,
  reason,
  fund,
  amount,
  method,
  operationId,
  customerId,
  selectedBooking,
  version,
  parts,
  available,
}: OperationInput) {
  const common = { kind, reason };
  if (kind === 'initial') return { ...common, fund, amountRub: amount };
  if (kind === 'reversal') return { ...common, operationId };
  const target = {
    customerId,
    ...(selectedBooking ? { bookingId: selectedBooking, expectedVersion: version } : {}),
  };
  if (kind === 'rent_payment' || kind === 'deposit_receipt')
    return {
      ...common,
      ...target,
      amountRub: amount,
      method: kind === 'deposit_receipt' ? 'cash' : method,
    };
  const sources = available
    .filter((s) => parts[sourceKey(s)] && parts[sourceKey(s)] !== '0')
    .map((s) => ({
      lotId: s.lotId,
      bucket: s.bucket,
      fund: s.fund,
      bookingId: s.bookingId,
      amountRub: parts[sourceKey(s)],
    }));
  return { ...common, ...target, sources, ...(kind === 'refund' ? { method } : {}) };
}
