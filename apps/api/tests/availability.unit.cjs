const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateAvailability: evaluate } = require('../dist/scheduling/availability');
const d = (id, start, end, candidates) => ({ id, start, end, candidates });
test('adjacent half-open intervals can share a vehicle', () => {
  assert.equal(evaluate([d(1, 0, 1, [1]), d(2, 1, 2, [1])], 1).status, 'feasible');
});
test('overlapping model and brand demand cannot consume the same vehicle twice', () => {
  assert.equal(evaluate([d(1, 0, 2, [1]), d(2, 1, 3, [1])], 1).status, 'deficit');
});
test('one candidate must cover the whole booking, not a new assignment each day', () => {
  assert.equal(
    evaluate([d(1, 0, 3, [1, 2]), d(2, 0, 1, [1]), d(3, 2, 3, [2])], 1).status,
    'deficit',
  );
});
test('follows overlapping pools beyond the visible root interval', () => {
  const result = evaluate([d(1, 0, 2, [1]), d(2, 1, 4, [1, 2]), d(3, 3, 5, [2])], 1);
  assert.deepEqual(result.bookingIds, [1, 2, 3]);
  assert.equal(result.status, 'deficit');
});
test('backtracks to find a globally feasible allocation', () => {
  assert.equal(
    evaluate([d(1, 0, 4, [1, 2]), d(2, 0, 2, [1]), d(3, 2, 4, [1])], 1).status,
    'feasible',
  );
});
test('empty candidate set is a deficit; computational limit is unknown', () => {
  assert.equal(evaluate([d(1, 0, 1, [])], 1).status, 'deficit');
  assert.equal(evaluate([d(1, 0, 1, [1])], 1, 0).status, 'unknown');
});
test('rejects invalid intervals and duplicate IDs', () => {
  assert.throws(() => evaluate([d(1, 1, 1, [1])], 1));
  assert.throws(() => evaluate([d(1, 0, 1, [1]), d(1, 1, 2, [1])], 1));
});
test('blocked demand remains in its overlapping pool component', () => {
  const result = evaluate(
    [
      { ...d(1, 0, 2, [2]), pool: [1, 2] },
      { ...d(2, 0, 2, []), pool: [1] },
    ],
    1,
  );
  assert.equal(result.status, 'deficit');
  assert.deepEqual(result.bookingIds, [1, 2]);
});
