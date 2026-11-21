const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTypescript } = require('./helpers/load-typescript.cjs');
const { rub } = loadTypescript(path.resolve(__dirname, '../src/pages/finance/presentation.ts'));
const { sourceKey, availableSources, buildMoneyOperation } = loadTypescript(
  path.resolve(__dirname, '../src/pages/finance/operationData.ts'),
);
const sources = [
  { lotId: 1, bucket: 'rent', bookingId: 11, fund: 'operating_cash', availableRub: '2000' },
  { lotId: 1, bucket: 'deposit', bookingId: 11, fund: 'deposit_pool', availableRub: '3000' },
  { lotId: 2, bucket: 'credit', bookingId: null, fund: null, availableRub: '4000' },
  { lotId: 3, bucket: 'rent', bookingId: 12, fund: 'operating_cash', availableRub: '1000' },
];
const input = {
  kind: 'refund',
  reason: 'Возврат',
  customerId: 7,
  selectedBooking: 11,
  version: 4,
  method: 'cash',
  fund: 'operating_cash',
  amount: '1000',
  available: sources,
  parts: {},
};

test('money formatting preserves exact integer values, signs and Russian grouping', () => {
  assert.equal(rub(undefined), '—');
  assert.equal(rub('0'), '0 ₽');
  assert.equal(rub('-1000'), '-1\u00a0000 ₽');
  assert.equal(
    rub('9007199254740993123'),
    '9\u00a0007\u00a0199\u00a0254\u00a0740\u00a0993\u00a0123 ₽',
  );
  assert.throws(() => rub('1.5'));
});

test('source selection respects booking boundaries and preserves ledger order', () => {
  const before = structuredClone(sources);
  assert.deepEqual(availableSources(sources, 'refund', 11), sources.slice(0, 3));
  assert.deepEqual(availableSources(sources, 'to_credit', 11), sources.slice(0, 2));
  assert.deepEqual(availableSources(sources, 'credit_use', 11), [sources[2]]);
  assert.deepEqual(availableSources(sources, 'refund'), [sources[2]]);
  assert.equal(sourceKey(sources[2]), '2:credit::');
  assert.notEqual(sourceKey(sources[0]), sourceKey(sources[1]));
  assert.deepEqual(sources, before);
});

test('refund keeps source attribution, exact amounts and version snapshot', () => {
  const body = buildMoneyOperation({
    ...input,
    available: availableSources(sources, 'refund', 11),
    parts: {
      [sourceKey(sources[0])]: '0',
      [sourceKey(sources[1])]: '9007199254740993123',
      [sourceKey(sources[2])]: '',
      [sourceKey(sources[3])]: '1000',
    },
  });
  assert.deepEqual(body, {
    kind: 'refund',
    reason: 'Возврат',
    customerId: 7,
    bookingId: 11,
    expectedVersion: 4,
    method: 'cash',
    sources: [
      {
        lotId: 1,
        bucket: 'deposit',
        fund: 'deposit_pool',
        bookingId: 11,
        amountRub: '9007199254740993123',
      },
    ],
  });
  const withoutBooking = buildMoneyOperation({ ...input, selectedBooking: undefined });
  assert.equal('expectedVersion' in withoutBooking, false);
  assert.equal('bookingId' in withoutBooking, false);
  assert.equal('method' in buildMoneyOperation({ ...input, kind: 'to_credit' }), false);
});

test('initial balance and compensation retain their distinct payload contracts', () => {
  assert.deepEqual(buildMoneyOperation({ ...input, kind: 'initial' }), {
    kind: 'initial',
    reason: 'Возврат',
    fund: 'operating_cash',
    amountRub: '1000',
  });
  assert.deepEqual(buildMoneyOperation({ ...input, kind: 'reversal', operationId: 55 }), {
    kind: 'reversal',
    reason: 'Возврат',
    operationId: 55,
  });
  assert.equal(
    buildMoneyOperation({ ...input, kind: 'deposit_receipt', method: 'bank' }).method,
    'cash',
  );
});
