const assert = require('node:assert/strict');
const { referenceMove, movePayload } = require('./move-reference.cjs');

module.exports = async function moveRegressions({ t, db, s, controller, request, group, actor }) {
  const { BookingService } = require('../../dist/scheduling/booking.service');
  const { CalendarService } = require('../../dist/scheduling/calendar.service');
  const reference = referenceMove(s, new BookingService(s), new CalendarService(db, s));
  const brand = (
    await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Move regression') RETURNING id")
  ).rows[0].id;
  const comfort = (await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='comfort'"))
    .rows[0].id;
  const models = [];
  const cars = [];
  for (const [index, tariff] of [group, group, comfort].entries()) {
    const model = (
      await db.pool.query(
        'INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,$2,$3) RETURNING id',
        [brand, 'Move model ' + index, tariff],
      )
    ).rows[0].id;
    models.push(model);
    cars.push(
      (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,$2,2020,'sedan',100,10000) RETURNING id",
          [model, 'MREG' + index],
        )
      ).rows[0].id,
    );
  }
  const extraCar = (
    await db.pool.query(
      "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'MREG3',2020,'sedan',100,10000) RETURNING id",
      [models[0]],
    )
  ).rows[0].id;
  const customer = (
    await db.pool.query(
      "INSERT INTO customers(type,display_name,phone) VALUES ('individual','Move regression','+79990000888') RETURNING id",
    )
  ).rows[0].id;
  const financialTables = [
    'financial_operations',
    'finance_charges',
    'finance_external',
    'finance_funds',
    'finance_fund_entries',
    'finance_lots',
    'finance_allocations',
  ];
  const tables = [
    'bookings',
    'booking_terms',
    'booking_eligible_models',
    'booking_risks',
    'schedule_blocks',
    'pricing_quotes',
    'audit_logs',
    'outbox_jobs',
    'idempotency_records',
    ...financialTables,
  ];
  const snapshot = (names = tables) =>
    Promise.all(
      names.map(
        async (table) =>
          (
            await db.pool.query(
              "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t::text),'[]'::jsonb) AS rows FROM " +
                table +
                ' t',
            )
          ).rows[0].rows,
      ),
    );
  let index = 0;
  const make = async (unassigned = false, loyalty = false) => {
    const startAt = new Date(Date.UTC(2055, 0, 1 + index++ * 6, 7)).toISOString();
    const target = { type: 'model', id: models[0] };
    const pricing = {
      startAt,
      contractDays: 2,
      dailyMileagePackageKm: 250,
      ...(loyalty
        ? {
            overrides: {
              customDailyRateRub: '1234',
              mileageLimitKm: 777,
              discountRub: '100',
              reason: 'Согласованные условия',
            },
            nonBillableDays: [{ dayIndex: 2, reason: 'Согласованный Вых' }],
          }
        : {}),
    };
    const preview = await controller.preview({ target, pricing }, request());
    return controller.create(
      {
        target,
        pricing,
        previewToken: preview.previewToken,
        confirmedOverrides: preview.calculation.overridesToConfirm,
        vehicleId: unassigned ? null : cars[0],
        customer: { existingId: customer },
        reason: 'Move regression',
      },
      request(),
    );
  };
  const inspect = async (booking, vehicleId, delta = 2) => {
    const input = {
      startAt: new Date(booking.start_at.getTime() + delta * 86400000).toISOString(),
      vehicleId,
    };
    const before = await snapshot();
    const result = await controller.previewMove(String(booking.id), input, request());
    assert.deepEqual(
      movePayload(result),
      movePayload(await reference.previewMove(String(booking.id), input, request())),
      'complete preview and both tokens match frozen controller',
    );
    assert.deepEqual(
      movePayload(result),
      movePayload(await controller.previewMove(String(booking.id), input, request())),
      'same facts give the same preview',
    );
    // Compare the common preparation twice inside one actual PostgreSQL read snapshot.
    await db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const owner = controller.bookings.inspectMove ? controller.bookings : controller;
      assert.deepEqual(
        movePayload(await owner.inspectMove(c, booking.id, input.startAt, vehicleId, actor)),
        movePayload(await reference.inspectMove(c, booking.id, input.startAt, vehicleId, actor)),
      );
    });
    assert.deepEqual(
      await snapshot(),
      before,
      'preview writes no quote, history, audit, outbox or key',
    );
    return {
      ...input,
      expectedVersion: result.expectedVersion,
      availabilityToken: result.availability.token,
      ...(result.quoteToken ? { quoteToken: result.quoteToken } : {}),
    };
  };
  const errorCode =
    (code, status = 409) =>
    (e) =>
      e.getStatus() === status && e.getResponse().code === code;

  await t.test(
    'move preview, tokens, rollback, assignment history and financial immutability',
    async () => {
      const booking = await make();
      const money = await snapshot(financialTables);
      const input = await inspect(booking, extraCar);
      assert.equal(input.quoteToken, undefined);
      assert.equal(new Date(input.startAt).getTime() - booking.start_at.getTime(), 2 * 86400000);
      const unchanged = await inspect(booking, cars[0], 0);
      await assert.rejects(
        controller.move(String(booking.id), unchanged, request()),
        errorCode('MOVE_UNCHANGED', 422),
      );
      await assert.rejects(
        controller.move(String(booking.id), { ...input, expectedVersion: 99 }, request()),
        errorCode('BOOKING_VERSION_CONFLICT'),
      );
      await assert.rejects(
        controller.move(
          String(booking.id),
          { ...input, availabilityToken: '0'.repeat(64) },
          request(),
        ),
        errorCode('MOVE_PREVIEW_STALE'),
      );
      await assert.rejects(
        controller.move(String(booking.id), { ...input, quoteToken: 'invalid' }, request()),
        errorCode('MOVE_PREVIEW_STALE'),
      );
      const oldBlocks = (
        await db.pool.query('SELECT * FROM schedule_blocks WHERE booking_id=$1 ORDER BY id', [
          booking.id,
        ])
      ).rows;
      const req = request();
      const moved = await controller.move(String(booking.id), input, req);
      assert.deepEqual(
        await controller.move(String(booking.id), input, req),
        JSON.parse(JSON.stringify(moved)),
      );
      assert.equal(moved.version, booking.version + 1);
      assert.equal(
        moved.end_at.getTime() - moved.start_at.getTime(),
        booking.end_at.getTime() - booking.start_at.getTime(),
      );
      assert.equal(moved.target_type, 'model');
      const blocks = (
        await db.pool.query('SELECT * FROM schedule_blocks WHERE booking_id=$1 ORDER BY id', [
          booking.id,
        ])
      ).rows;
      assert.equal(blocks.length, oldBlocks.length + 1);
      assert.ok(blocks[0].retired_at);
      assert.deepEqual({ ...blocks[0], retired_at: null }, oldBlocks[0]);
      assert.equal(blocks[1].vehicle_id, extraCar);
      assert.equal(blocks[1].retired_at, null);
      const terms = (await controller.get(String(booking.id))).terms;
      assert.equal(terms.length, 2);
      assert.equal(terms[0].snapshot.finalTotalRub, terms[1].snapshot.finalTotalRub);
      assert.equal(terms[0].quote_id, terms[1].quote_id);
      await assert.rejects(
        controller.move(String(booking.id), input, request()),
        errorCode('BOOKING_VERSION_CONFLICT'),
      );
      await assert.rejects(
        controller.move(String(booking.id), { ...input, reason: 'changed' }, req),
        errorCode('IDEMPOTENCY_KEY_REUSED'),
      );
      const sameTariffInput = await inspect(moved, cars[1], 0);
      assert.equal(sameTariffInput.quoteToken, undefined);
      const switched = await controller.move(String(booking.id), sameTariffInput, request());
      assert.equal(switched.target_type, 'vehicle');
      assert.deepEqual(
        (
          await db.pool.query('SELECT model_id FROM booking_eligible_models WHERE booking_id=$1', [
            booking.id,
          ])
        ).rows.map((x) => x.model_id),
        [models[1]],
      );
      const priceInput = await inspect(switched, cars[2], 0);
      assert.ok(priceInput.quoteToken);
      await assert.rejects(
        controller.move(String(booking.id), { ...priceInput, quoteToken: 'invalid' }, request()),
        errorCode('MOVE_PREVIEW_STALE'),
      );
      const before = await snapshot();
      const priceRequest = request();
      for (const table of ['audit_logs', 'outbox_jobs']) {
        const field = table === 'audit_logs' ? 'action' : 'kind';
        await db.pool.query(
          'CREATE FUNCTION reject_move() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.' +
            field +
            "='bookings.moved' THEN RAISE EXCEPTION 'move injected failure'; END IF; RETURN NEW; END $$",
        );
        await db.pool.query(
          'CREATE TRIGGER reject_move BEFORE INSERT ON ' +
            table +
            ' FOR EACH ROW EXECUTE FUNCTION reject_move()',
        );
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(
              controller.move(String(booking.id), priceInput, priceRequest),
              /move injected failure/,
            );
            assert.deepEqual(
              await snapshot(),
              before,
              'rollback includes confirmed quote, old assignment and idempotency',
            );
          }
        } finally {
          await db.pool.query('DROP TRIGGER reject_move ON ' + table);
          await db.pool.query('DROP FUNCTION reject_move()');
        }
      }
      const repriced = await controller.move(String(booking.id), priceInput, priceRequest);
      const detail = await controller.get(String(booking.id));
      assert.notEqual(
        detail.terms[0].snapshot.finalTotalRub,
        detail.terms[1].snapshot.finalTotalRub,
      );
      assert.notEqual(detail.terms[0].quote_id, detail.terms[1].quote_id);
      assert.deepEqual(
        await controller.move(String(booking.id), priceInput, priceRequest),
        JSON.parse(JSON.stringify(repriced)),
      );
      assert.equal(
        (
          await db.pool.query('SELECT count(*)::int n FROM outbox_jobs WHERE business_key=$1', [
            'bookings.moved:' + booking.id + ':' + repriced.version,
          ])
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await controller.history(String(booking.id))).items[0].action,
        'bookings.moved',
      );
      const calendar = await controller.calendar({
        from: input.startAt,
        to: repriced.end_at.toISOString(),
      });
      assert.equal(
        calendar.events.find((x) => x.booking_id === booking.id && x.kind === 'assignment')
          .vehicle_id,
        cars[2],
      );
      assert.deepEqual(await snapshot(financialTables), money);
    },
  );

  await t.test(
    'move rejects changed facts and technical conflicts, respects adjacent bounds and moves unassigned demand',
    async () => {
      const booking = await make(true);
      const input = await inspect(booking, extraCar);
      await db.pool.query('UPDATE vehicles SET version=version+1 WHERE id=$1', [extraCar]);
      await assert.rejects(
        controller.move(String(booking.id), input, request()),
        errorCode('MOVE_PREVIEW_STALE'),
      );
      const current = await inspect(booking, extraCar);
      const endAt = new Date(Date.parse(current.startAt) + 2 * 86400000).toISOString();
      const block = await controller.technical(
        {
          vehicleId: extraCar,
          startAt: endAt,
          endAt: new Date(Date.parse(endAt) + 86400000).toISOString(),
          reason: 'Adjacent',
        },
        request(),
      );
      const adjacent = await inspect(booking, extraCar);
      await assert.rejects(
        controller.previewMove(String(booking.id), adjacent, request()),
        errorCode('VALIDATION_ERROR', 400),
      );
      const blocked = await inspect(booking, extraCar, 3);
      await assert.rejects(
        controller.move(String(booking.id), blocked, request()),
        errorCode('VEHICLE_ASSIGNMENT_CONFLICT'),
      );
      const moved = await controller.move(String(booking.id), adjacent, request());
      assert.equal(moved.version, booking.version + 1);
      const calendar = await controller.calendar({
        from: moved.start_at.toISOString(),
        to: block.end_at.toISOString(),
      });
      assert.ok(!calendar.unassignedBookings.some((x) => x.id === booking.id));
      assert.equal(calendar.events.find((x) => x.booking_id === booking.id).vehicle_id, extraCar);
      const problem = await make(true);
      await db.pool.query(
        "UPDATE vehicles SET is_ready=false,readiness_reason='Test repair',version=version+1 WHERE id=ANY($1::int[])",
        [[cars[0], extraCar]],
      );
      try {
        assert.equal((await controller.get(String(problem.id))).availability.status, 'deficit');
        const replacement = await inspect(problem, cars[1]);
        const recovered = await controller.move(String(problem.id), replacement, request());
        assert.equal(recovered.target_vehicle_id, cars[1]);
      } finally {
        await db.pool.query(
          "UPDATE vehicles SET is_ready=true,readiness_reason='',version=version+1 WHERE id=ANY($1::int[])",
          [[cars[0], extraCar]],
        );
      }
    },
  );

  await t.test(
    'move versus cancel and assign commits one result from a shared version',
    async () => {
      for (const kind of ['cancel', 'assign'])
        for (const moveFirst of [true, false]) {
          const booking = await make();
          const input = await inspect(booking, extraCar);
          const move = () => controller.move(String(booking.id), input, request());
          const other = () =>
            kind === 'cancel'
              ? controller.cancel(
                  String(booking.id),
                  { expectedVersion: booking.version, reason: 'Race' },
                  request(),
                )
              : controller.assignment(
                  String(booking.id),
                  { expectedVersion: booking.version, vehicleId: cars[0] },
                  request(),
                );
          const results = await Promise.allSettled(
            moveFirst ? [move(), other()] : [other(), move()],
          );
          assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
          const loser = results.find((x) => x.status === 'rejected').reason;
          assert.ok(['BOOKING_VERSION_CONFLICT', 'NOT_FOUND'].includes(loser.getResponse().code));
          assert.equal(loser.getStatus(), loser.getResponse().code === 'NOT_FOUND' ? 404 : 409);
          const saved = (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [booking.id]))
            .rows[0];
          assert.equal(saved.version, booking.version + 1);
          assert.deepEqual(saved, results.find((x) => x.status === 'fulfilled').value);
          assert.equal(
            (
              await db.pool.query(
                'SELECT count(*)::int n FROM schedule_blocks WHERE booking_id=$1 AND retired_at IS NULL',
                [booking.id],
              )
            ).rows[0].n,
            saved.status === 'cancelled' ? 0 : 1,
          );
        }
    },
  );
  await t.test(
    'move tariff preview preserves agreed overrides and free days in the signed context',
    async () => {
      const booking = await make(false, true);
      const input = await inspect(booking, cars[2]);
      assert.ok(input.quoteToken);
      const money = await snapshot(financialTables);
      await controller.move(String(booking.id), input, request());
      const detail = await controller.get(String(booking.id));
      const current = detail.terms[0].snapshot;
      const previous = detail.terms[1].snapshot;
      assert.deepEqual(current.overrides, previous.overrides);
      assert.equal(current.effectiveMileageLimitKm, 777);
      assert.deepEqual(
        current.nonBillableDays.map(({ dayIndex, reason }) => ({ dayIndex, reason })),
        previous.nonBillableDays.map(({ dayIndex, reason }) => ({ dayIndex, reason })),
      );
      assert.deepEqual(await snapshot(financialTables), money);
    },
  );
};
