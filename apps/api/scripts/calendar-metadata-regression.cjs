// Synthetic stored-state regressions in the benchmark's disposable database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const normalize = (v) =>
  JSON.parse(JSON.stringify(v, (key, value) => (key === 'evaluatedAt' ? undefined : value)));
module.exports = async function metadataRegression({ db, request, rpc, waitForPause, getBooking }) {
  const compare = async () => {
    const actual = await request('current', false, false, true);
    const before = await request('before-labels', false, false, true);
    assert.deepEqual(
      normalize(actual.data),
      normalize(before.data),
      'metadata changes preserve the entire pre-5.2 response',
    );
    assert.equal(actual.solverCalls * 2, before.solverCalls);
    assert.deepEqual(
      normalize(actual.evaluations),
      normalize(before.evaluations.filter((_, i) => i % 2 === 0)),
      'primary evaluation preserves snapshots and signatures',
    );
    return actual.data;
  };
  const ordinaryMatches = async (view, id) => {
    const ordinary = await getBooking(id);
    const problem = view.problems.find((b) => b.id === id);
    for (const field of [
      'availability',
      'conflicts',
      'alternatives',
      'problemReasons',
      'replacementReason',
      'targetLabel',
      'vehicle',
    ])
      assert.deepEqual(
        normalize({ value: ordinary[field] }),
        normalize({ value: problem[field] }),
        'ordinary inspect preserves ' + field,
      );
  };
  const unassigned = (
    await db.query(
      `SELECT b.*,array(SELECT model_id FROM booking_eligible_models WHERE booking_id=b.id ORDER BY model_id) AS models
     FROM bookings b WHERE b.status='confirmed' AND NOT EXISTS(SELECT 1 FROM schedule_blocks s WHERE s.booking_id=b.id AND s.retired_at IS NULL) ORDER BY b.id`,
    )
  ).rows;
  const chosen = unassigned.slice(0, 4);
  assert.equal(chosen.length, 4);
  const vehicles = (await db.query('SELECT * FROM vehicles ORDER BY id')).rows;
  const audit = async (
    c,
    booking,
    details,
    action = 'bookings.displaced',
    type = 'booking',
    at = '2050-01-01',
  ) => {
    await c.query(
      'INSERT INTO audit_logs(actor_id,entity_type,entity_id,action,request_id,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [booking.created_by, type, booking.id, action, randomUUID(), JSON.stringify(details), at],
    );
  };
  const reasons = ['Последнее снятие по ID', null, undefined, ''];
  const previous = [];
  for (let i = 0; i < chosen.length; i++) {
    const booking = chosen[i];
    const car = vehicles.find((v) => booking.models.includes(v.model_id));
    previous.push(car.id);
    await audit(
      db,
      booking,
      { previousVehicleId: car.id, reason: 'Более новое время, меньший ID' },
      'bookings.displaced',
      'booking',
      '2059-01-01',
    );
    await audit(db, booking, { previousVehicleId: car.id, reason: 'То же время, меньший ID' });
    const details = { previousVehicleId: car.id };
    if (i !== 2) details.reason = reasons[i];
    await audit(db, booking, details);
    await audit(
      db,
      booking,
      { previousVehicleId: car.id, reason: 'Другое действие' },
      'bookings.updated',
    );
    await audit(
      db,
      booking,
      { previousVehicleId: car.id, reason: 'Другой тип сущности' },
      'bookings.displaced',
      'vehicle',
    );
  }
  let view = await compare();
  const prefix = 'Автомобиль снят с назначения из-за технической блокировки: ';
  for (let i = 0; i < chosen.length; i++) {
    const problem = view.problems.find((b) => b.id === chosen[i].id);
    assert.equal(problem.replacementReason, prefix + reasons[i]);
    assert.ok(problem.problemReasons.includes('Требуется замена автомобиля'));
    const ghosts = view.events.filter(
      (e) => e.kind === 'displaced' && e.booking_id === chosen[i].id,
    );
    assert.equal(ghosts.length, 1);
    assert.equal(ghosts[0].vehicle_id, previous[i]);
    assert.equal(
      ghosts[0].reason,
      reasons[i] ?? null,
      'SQL extraction retains null while inspect reads raw missing reason',
    );
    await ordinaryMatches(view, chosen[i].id);
  }
  const absent = (
    await db.query(
      `SELECT b.id FROM bookings b WHERE b.status='confirmed' AND b.start_at<'2055-01-18' AND NOT EXISTS(SELECT 1 FROM schedule_blocks s WHERE s.booking_id=b.id AND s.retired_at IS NULL)
     AND NOT EXISTS(SELECT 1 FROM audit_logs a WHERE a.entity_type='booking' AND a.entity_id=b.id AND a.action='bookings.displaced') ORDER BY b.id LIMIT 1`,
    )
  ).rows[0];
  assert.ok(absent);
  const problem = view.problems.find((b) => b.id === absent.id);
  assert.ok(problem);
  assert.equal(problem.availability.status, 'deficit');
  assert.ok(problem.problemReasons.length > 0);
  assert.equal(problem.replacementReason, undefined);

  // The third unassigned fixture booking starts the feasible chain after repairs.
  const chain = chosen[2];
  const inserted = [];
  for (const [plate, ready, archived] of [
    ['AAA-LABEL-READY', true, false],
    ['ZZZ-LABEL-READY', true, false],
    ['LABEL-NOT-READY', false, false],
    ['LABEL-ARCHIVED', true, true],
  ]) {
    inserted.push(
      (
        await db.query(
          `INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km,is_ready,readiness_reason,archived_at)
       VALUES ($1,$2,2020,'sedan',100,10000,$3,$4,CASE WHEN $5 THEN now() ELSE NULL END) RETURNING id`,
          [chain.models[0], plate, ready, ready ? '' : 'Причина неготовности', archived],
        )
      ).rows[0].id,
    );
  }
  await db.query(
    "UPDATE vehicles SET is_ready=false,readiness_reason='Новая причина',version=version+1 WHERE id=$1",
    [previous[2]],
  );
  view = await compare();
  const chainProblem = view.problems.find((b) => b.id === chain.id);
  const expected = (
    await db.query(
      'SELECT id FROM vehicles WHERE model_id=$1 AND archived_at IS NULL AND is_ready ORDER BY plate',
      [chain.models[0]],
    )
  ).rows.map((v) => v.id);
  assert.deepEqual(
    chainProblem.alternatives.map((v) => v.id),
    expected,
  );
  assert.ok(!view.vehicles.some((v) => v.id === inserted[3]));
  assert.ok(
    !chainProblem.alternatives.some((v) => [inserted[2], inserted[3], previous[2]].includes(v.id)),
  );
  await ordinaryMatches(view, chain.id);

  const paused = waitForPause();
  const pending = request('current', true);
  pending.catch(() => {});
  await paused;
  const writer = await db.connect();
  try {
    await writer.query('BEGIN');
    await writer.query(
      "UPDATE vehicles SET is_ready=false,readiness_reason='Параллельное изменение',version=version+1 WHERE id=$1",
      [inserted[0]],
    );
    await audit(writer, chosen[0], {
      previousVehicleId: previous[0],
      reason: 'Снятие после начала чтения',
    });
    const firstDisplacement = unassigned.find((b) => b.id === absent.id);
    await audit(writer, firstDisplacement, {
      previousVehicleId: vehicles.find((v) => firstDisplacement.models.includes(v.model_id)).id,
      reason: 'Первое снятие после начала чтения',
    });
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
    normalize(view),
    'labels and audit share the original RR snapshot',
  );
  view = await compare();
  assert.equal(
    view.problems.find((b) => b.id === chosen[0].id).replacementReason,
    prefix + 'Снятие после начала чтения',
  );
  assert.equal(
    view.problems.find((b) => b.id === absent.id).replacementReason,
    prefix + 'Первое снятие после начала чтения',
  );
  await ordinaryMatches(view, chosen[0].id);
  await ordinaryMatches(view, absent.id);
  assert.ok(
    !view.problems.find((b) => b.id === chain.id).alternatives.some((v) => v.id === inserted[0]),
  );

  // Commands themselves are protected by S4; here compare stored read projections.
  const reassigned = chosen[0];
  const replacement = (
    await db.query(
      `SELECT v.id FROM vehicles v WHERE v.archived_at IS NULL AND v.is_ready AND v.model_id=ANY($1::int[])
     AND NOT EXISTS(SELECT 1 FROM schedule_blocks s WHERE s.vehicle_id=v.id AND s.retired_at IS NULL AND s.start_at<$3 AND s.end_at>$2) ORDER BY v.id LIMIT 1`,
      [reassigned.models, reassigned.start_at, reassigned.end_at],
    )
  ).rows[0];
  assert.ok(replacement);
  await db.query(
    "INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by) VALUES ($1,$2,'assignment',$3,$4,'Synthetic replacement',$5)",
    [replacement.id, reassigned.id, reassigned.start_at, reassigned.end_at, reassigned.created_by],
  );
  view = await compare();
  assert.ok(!view.events.some((e) => e.kind === 'displaced' && e.booking_id === reassigned.id));
  assert.ok(
    !view.problems
      .find((b) => b.id === reassigned.id)
      ?.problemReasons.includes('Требуется замена автомобиля'),
  );
  await ordinaryMatches(view, chain.id);
  await db.query("UPDATE bookings SET status='cancelled',version=version+1 WHERE id=$1", [
    chosen[1].id,
  ]);
  view = await compare();
  assert.ok(!view.bookings.some((b) => b.id === chosen[1].id));
  assert.ok(!view.problems.some((b) => b.id === chosen[1].id));
  assert.ok(!view.events.some((e) => e.kind === 'displaced' && e.booking_id === chosen[1].id));
};
