const assert = require('node:assert/strict');
const normalize = (v) =>
  JSON.parse(JSON.stringify(v, (key, value) => (key === 'evaluatedAt' ? undefined : value)));
module.exports = async function preparationRegression({
  db,
  request,
  rpc,
  waitForPause,
  solverTracePath,
  parallelWindows,
}) {
  const rows = (
    await db.query(
      "SELECT b.*,s.vehicle_id,array(SELECT model_id FROM booking_eligible_models WHERE booking_id=b.id ORDER BY model_id) AS models FROM bookings b LEFT JOIN schedule_blocks s ON s.booking_id=b.id AND s.retired_at IS NULL WHERE b.status='confirmed' ORDER BY b.id",
    )
  ).rows;
  const inputs = rows
    .filter((b, i) => i < 3 || (!b.vehicle_id && i < 30))
    .map((b) => ({
      name: 'stored-' + b.id,
      input: {
        id: b.id,
        target: {
          type: b.target_type,
          id: b.target_vehicle_id ?? b.target_model_id ?? b.target_group_id ?? b.target_brand_id,
        },
        models: b.models,
        startAt: b.start_at.toISOString(),
        endAt: b.end_at.toISOString(),
        vehicleId: b.vehicle_id,
      },
    }));
  const initial = (inputs.find((v) => v.input.models.length > 1) ?? inputs[0]).input;
  for (const vehicleId of [undefined, null, 0])
    inputs.push({
      name: 'new-root-' + String(vehicleId),
      input: {
        ...initial,
        id: undefined,
        vehicleId,
        models: [...initial.models].reverse().concat(initial.models),
      },
    });
  const actor = rows[0].created_by,
    customer = rows[0].customer_id;
  const model = (
    await db.query(
      "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) SELECT brand_id,'Preparation precision',pricing_group_id FROM vehicle_models ORDER BY id LIMIT 1 RETURNING id",
    )
  ).rows[0].id;
  const vehicle = (
    await db.query(
      "INSERT INTO vehicles(model_id,plate,year,body_type,is_ready) VALUES ($1,'PREP-READY',2020,'sedan',true) RETURNING id",
      [model],
    )
  ).rows[0].id;
  const archived = (
    await db.query(
      "INSERT INTO vehicles(model_id,plate,year,body_type,is_ready,archived_at) VALUES ($1,'PREP-ARCHIVED',2020,'sedan',true,now()) RETURNING id",
      [model],
    )
  ).rows[0].id;
  const notReady = (
    await db.query(
      "INSERT INTO vehicles(model_id,plate,year,body_type,is_ready,readiness_reason) VALUES ($1,'PREP-NOT-READY',2020,'sedan',false,'Synthetic preparation') RETURNING id",
      [model],
    )
  ).rows[0].id;
  const technical = (
    await db.query(
      "INSERT INTO schedule_blocks(vehicle_id,kind,start_at,end_at,reason,created_by) VALUES ($1,'technical','2085-01-01T10:00:00.123+03','2085-01-01T11:00:00.456+03','Precision block',$2) RETURNING id",
      [vehicle, actor],
    )
  ).rows[0].id;
  const base = { target: { type: 'model', id: model }, models: [model], vehicleId: null };
  inputs.push({
    name: 'empty-internal-models',
    input: { ...base, models: [], startAt: '2085-02-01T00:00:00Z', endAt: '2085-02-02T00:00:00Z' },
    expectedStatus: 'deficit',
  });
  for (const [name, startAt, endAt, expectedStatus] of [
    ['touch-before', '2085-01-01T09:00:00+03:00', '2085-01-01T10:00:00.123+03:00', 'feasible'],
    ['touch-after-utc', '2085-01-01T08:00:00.456Z', '2085-01-01T12:00:00+03:00', 'feasible'],
    [
      'one-millisecond-overlap',
      '2085-01-01T10:00:00.122+03:00',
      '2085-01-01T10:00:00.124+03:00',
      'deficit',
    ],
  ])
    inputs.push({ name, input: { ...base, startAt, endAt }, expectedStatus });
  for (const id of [archived, notReady])
    inputs.push({
      name: 'ineligible-specific-' + id,
      input: {
        ...base,
        target: { type: 'vehicle', id },
        vehicleId: id,
        startAt: '2085-02-01T00:00:00Z',
        endAt: '2085-02-02T00:00:00Z',
      },
      expectedStatus: 'deficit',
    });
  async function booking(start, end) {
    const b = (
      await db.query(
        "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,$2,$3,'model',$4,$5) RETURNING id",
        [customer, start, end, model, actor],
      )
    ).rows[0].id;
    await db.query('INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)', [
      b,
      model,
    ]);
    return b;
  }
  const assigned = await booking('2086-01-01T09:00:00Z', '2086-01-01T10:00:00Z');
  await db.query(
    "INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES ($1,$2,'assignment','2086-01-01T09:00:00Z','2086-01-01T10:00:00Z','Root old assignment',$3)",
    [vehicle, assigned, actor],
  );
  await booking('2086-01-01T09:30:00Z', '2086-01-01T10:30:00Z');
  inputs.push({
    name: 'root-old-assignment-excluded-for-other-demand',
    input: {
      ...base,
      id: assigned,
      startAt: '2086-01-01T10:30:00Z',
      endAt: '2086-01-01T11:00:00Z',
    },
    expectedStatus: 'feasible',
  });
  const chain = (
    await db.query(
      "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) SELECT $1,'2089-01-01'::timestamptz+n*interval '12 hours','2089-01-02'::timestamptz+n*interval '12 hours','model',$2,$3 FROM generate_series(0,500) n RETURNING id",
      [customer, model, actor],
    )
  ).rows.map((b) => b.id);
  await db.query(
    'INSERT INTO booking_eligible_models(booking_id,model_id) SELECT unnest($1::int[]),$2',
    [chain, model],
  );
  inputs.push({
    name: 'whole-outside-window-chain-unknown',
    input: {
      ...base,
      id: chain[0],
      startAt: '2089-01-01T00:00:00Z',
      endAt: '2089-01-02T00:00:00Z',
    },
    expectedStatus: 'unknown',
  });
  const checked = await rpc('preparation-cases', { inputs, solverTracePath });
  assert.ok(!checked.error, checked.error);
  assert.equal(checked.cases, inputs.length);
  assert.equal(checked.solverCalls, inputs.length);
  assert.equal(checked.ordinaryCalls, inputs.length);
  for (const value of checked.results) {
    const expected = inputs.find((v) => v.name === value.name).expectedStatus;
    if (expected) assert.equal(value.status, expected, value.name);
  }
  await parallelWindows([
    { from: '2055-01-01T00:00:00Z', to: '2055-01-31T00:00:00Z' },
    { from: '2086-01-01T00:00:00Z', to: '2086-01-02T00:00:00Z' },
  ]);
  const before = (await request()).data;
  const paused = waitForPause();
  const pending = request('current', true);
  pending.catch(() => {});
  await paused;
  const writer = await db.connect();
  try {
    await writer.query('BEGIN');
    await writer.query(
      "UPDATE vehicles SET is_ready=false,version=version+1,readiness_reason='Concurrent preparation change' WHERE id=$1",
      [vehicle],
    );
    await writer.query(
      "UPDATE schedule_blocks SET end_at=end_at+interval '1 millisecond' WHERE id=$1",
      [technical],
    );
    await writer.query('COMMIT');
  } catch (error) {
    await writer.query('ROLLBACK');
    throw error;
  } finally {
    writer.release();
    await rpc('resume');
  }
  assert.deepEqual(
    normalize((await pending).data),
    normalize(before),
    'prepared indices retain the active RR snapshot',
  );
  const fresh = await request();
  assert.equal(fresh.data.vehicles.find((v) => v.id === vehicle).is_ready, false);
  assert.deepEqual(
    normalize(fresh.data),
    normalize((await request('before-preparation')).data),
    'next request observes committed readiness and exact block bounds',
  );
  console.log(
    'preparation edge cases, concurrent GETs and snapshot passed:',
    inputs.length,
    'cases',
  );
};
