const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { financeInput: before } = require('./helpers/finance-dto-stage16-baseline.cjs');
const { financeInput: after } = require('../dist/finance/finance.dto');
const { hash, parse } = require('../dist/platform/security');

const source = { lotId: 1, bucket: 'deposit', fund: 'deposit_pool', bookingId: 2, amountRub: '1' };
const booking = { customerId: 1, bookingId: 2, expectedVersion: 3 };
const seeds = [
  { kind: 'rent_payment', ...booking, amountRub: '1', method: 'cash' },
  { kind: 'deposit_receipt', ...booking, amountRub: '1', method: 'cash' },
  { kind: 'to_credit', ...booking, sources: [source] },
  { kind: 'credit_use', ...booking, sources: [source] },
  { kind: 'refund', customerId: 1, method: 'bank', sources: [source] },
  { kind: 'initial', fund: 'operating_cash', amountRub: '0' },
  { kind: 'reversal', operationId: 1 },
].map((input) => ({ ...input, reason: ' \tПричина\n ' }));

function keys(value) {
  if (Array.isArray(value)) return value.map(keys);
  if (value && typeof value === 'object')
    return { keys: Object.keys(value), children: Object.values(value).map(keys) };
  return null;
}

function thrown(work) {
  try {
    work();
  } catch (error) {
    return error;
  }
  assert.fail('Expected validation error');
}

function compare(input) {
  const oldResult = before.safeParse(input);
  const newResult = after.safeParse(input);
  assert.equal(newResult.success, oldResult.success);
  if (oldResult.success) {
    const parsed = after.parse(input);
    const original = before.parse(input);
    assert.deepEqual(newResult.data, oldResult.data);
    assert.deepEqual(parsed, original);
    assert.deepEqual(parsed, newResult.data);
    assert.deepEqual(keys(parsed), keys(original));
    const json = JSON.stringify(original);
    assert.deepEqual(Buffer.from(JSON.stringify(parsed)), Buffer.from(json));
    // Same SHA-256 used by CommandsService fingerprint and permanent request_hash.
    assert.equal(hash(JSON.stringify(parsed)), createHash('sha256').update(json).digest('hex'));
    const oldBody = { ...original };
    const newBody = { ...parsed };
    for (const body of [oldBody, newBody]) {
      delete body.warningToken;
      delete body.shortfallAcknowledged;
    }
    assert.equal(JSON.stringify(newBody), JSON.stringify(oldBody));
    assert.equal(hash(JSON.stringify(newBody)), hash(JSON.stringify(oldBody)));
    assert.deepEqual(parse(after, input), parse(before, input));
  } else {
    const oldError = thrown(() => before.parse(input));
    const newError = thrown(() => after.parse(input));
    assert.equal(newError.name, oldError.name);
    assert.equal(newError.message, oldError.message);
    assert.deepEqual(newError.issues, oldError.issues);
    assert.deepEqual(newResult.error.issues, oldResult.error.issues);
    assert.deepEqual(newError.issues, newResult.error.issues);
    assert.equal(JSON.stringify(newError.issues), JSON.stringify(oldError.issues));
    const oldHttp = thrown(() => parse(before, input));
    const newHttp = thrown(() => parse(after, input));
    assert.equal(newHttp.getStatus(), 400);
    assert.deepEqual(newHttp.getResponse(), oldHttp.getResponse());
  }
  return oldResult.success;
}

function corpus(seed) {
  const cases = [seed, Object.fromEntries(Object.entries(seed).reverse())];
  for (const field of Object.keys(seed)) {
    const omitted = { ...seed };
    delete omitted[field];
    cases.push(omitted);
    for (const value of [undefined, null, true, false, '', 0, -1, 1.5, '1', [], {}])
      cases.push({ ...seed, [field]: value });
  }
  for (const reason of [
    '',
    ' \n\t',
    'x'.repeat(1000),
    'x'.repeat(1001),
    ' ' + 'я'.repeat(1000) + ' ',
  ])
    cases.push({ ...seed, reason });
  for (const warningToken of [undefined, null, '', ' token ', 1, false])
    for (const shortfallAcknowledged of [undefined, null, false, true, 'true', 1])
      cases.push({ ...seed, warningToken, shortfallAcknowledged });
  cases.push({ ...seed, unknown: 1 }, { ...seed, z: 1, a: 2, reason: ' ' });
  for (const field of ['customerId', 'bookingId', 'expectedVersion', 'operationId']) {
    if (!(field in seed) && !(seed.kind === 'refund' && field !== 'operationId')) continue;
    for (const value of [
      undefined,
      null,
      0,
      -1,
      1,
      2147483647,
      2147483648,
      1.1,
      NaN,
      Infinity,
      '1',
    ])
      cases.push({ ...seed, [field]: value });
  }
  if (seed.kind === 'refund') {
    cases.push({ ...seed, bookingId: 2 }, { ...seed, expectedVersion: 3 }, { ...seed, ...booking });
  }
  if ('method' in seed)
    for (const method of ['cash', 'bank', 'credit', null]) cases.push({ ...seed, method });
  const amounts = [
    '0',
    '1',
    '9007199254740993',
    '9223372036854775806',
    '9223372036854775807',
    '9223372036854775808',
    '9999999999999999999',
    '10000000000000000000',
    '00',
    '01',
    '-1',
    '1.0',
    '1e3',
    ' 1',
    '1 ',
    '1\n',
    '',
    'abc',
    null,
    1,
  ];
  if ('amountRub' in seed) for (const amountRub of amounts) cases.push({ ...seed, amountRub });
  if ('fund' in seed)
    for (const fund of ['operating_cash', 'deposit_pool', null, 'bank'])
      cases.push({ ...seed, fund });
  if ('sources' in seed) {
    for (const length of [0, 1, 2, 50, 51])
      cases.push({ ...seed, sources: Array.from({ length }, () => ({ ...source })) });
    const second = { ...source, lotId: 2, bucket: 'credit', bookingId: null, fund: null };
    cases.push({ ...seed, sources: [source, second] }, { ...seed, sources: [second, source] });
    for (const field of Object.keys(source)) {
      const omitted = { ...source };
      delete omitted[field];
      cases.push({ ...seed, sources: [omitted] });
      const values =
        field === 'amountRub'
          ? amounts
          : [undefined, null, 0, -1, 1, 1.5, 2147483647, 2147483648, '1', true, [], {}];
      for (const value of values) cases.push({ ...seed, sources: [{ ...source, [field]: value }] });
    }
    for (const bucket of ['rent', 'deposit', 'credit', 'unknown'])
      for (const fund of ['operating_cash', 'deposit_pool', null, 'unknown'])
        for (const bookingId of [2, null])
          cases.push({ ...seed, sources: [{ ...source, bucket, fund, bookingId }] });
    cases.push(
      { ...seed, sources: [{ ...source, extra: true }] },
      { ...seed, sources: [null, { lotId: 0, bucket: 'bad', extra: 1 }] },
    );
  }
  return cases;
}

test('Finance DTO Stage 16: frozen pre-move parse/safeParse compatibility', async (t) => {
  for (const seed of seeds) {
    await t.test(seed.kind, () => {
      let valid = 0;
      const cases = corpus(seed);
      for (let index = 0; index < cases.length; index++) {
        try {
          if (compare(cases[index])) valid++;
        } catch (error) {
          error.message = `${seed.kind} corpus case ${index}: ${error.message}`;
          throw error;
        }
      }
      assert.ok(valid > 0 && valid < cases.length);
      t.diagnostic(
        `${seed.kind}: ${cases.length} cases (${valid} valid / ${cases.length - valid} invalid)`,
      );
    });
  }
  await t.test('discriminator, re-export and preserved permissive DTO boundaries', () => {
    for (const input of [
      undefined,
      null,
      [],
      '',
      1,
      {},
      { kind: 'charge' },
      { kind: 'refund', sources: null },
      { kind: null },
    ])
      compare(input);
    assert.equal(require('../dist/finance/finance.service').financeInput, after);
    assert.deepEqual(
      after.options.map((option) => option.shape.kind.value),
      seeds.map((input) => input.kind),
    );
    for (const seed of seeds) assert.equal(after.parse(seed).reason, 'Причина');
    // These remain service rules; the DTO must not acquire cross-field/unique checks.
    assert.equal(after.safeParse({ ...seeds[4], bookingId: 2 }).success, true);
    assert.equal(after.safeParse({ ...seeds[4], sources: [source, source] }).success, true);
    assert.equal(after.safeParse({ ...seeds[5], amountRub: '0' }).success, true);
    assert.equal(after.safeParse({ ...seeds[0], amountRub: '0' }).success, false);
    assert.equal(after.safeParse({ ...seeds[0], amountRub: '9223372036854775807' }).success, true);
    assert.equal(after.safeParse({ ...seeds[0], amountRub: '9223372036854775808' }).success, false);
    const ordered = after.parse({ ...seeds[4], sources: [source, { ...source, lotId: 2 }] });
    assert.deepEqual(
      ordered.sources.map((item) => item.lotId),
      [1, 2],
    );
  });
});
