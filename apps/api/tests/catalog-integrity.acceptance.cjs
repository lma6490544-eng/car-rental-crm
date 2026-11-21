const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withFinance, code } = require('./helpers/finance-regression.cjs');

// Reuse only the existing isolated DB, exact public snapshots and real lock-queue observer.
// No financial operation is posted by this profile.
async function withFleet(work) {
  await withFinance(async (f) => {
    const { CatalogService } = require('../dist/catalog/catalog.service');
    const { VehiclesController } = require('../dist/catalog/vehicles.controller');
    const { CommandsService } = require('../dist/platform/commands.service');
    const { SchedulingService } = require('../dist/scheduling/scheduling.service');
    const { BookingService } = require('../dist/scheduling/booking.service');
    const { TechnicalBlockService } = require('../dist/scheduling/technical-block.service');
    const { CalendarService } = require('../dist/scheduling/calendar.service');
    const commands = new CommandsService(f.db);
    const vehicles = new VehiclesController(new CatalogService(f.db, commands));
    const scheduling = new SchedulingService(f.db, commands);
    const bookings = new BookingService(scheduling);
    const technical = new TechnicalBlockService(scheduling);
    const calendar = new CalendarService(f.db, scheduling);
    const model = (await f.db.pool.query('SELECT * FROM vehicle_models ORDER BY id LIMIT 1'))
      .rows[0];
    const data = {
      modelId: model.id,
      plate: 'A123BC78',
      vin: 'WVWZZZ1JZXW000001',
      year: 2024,
      bodyType: 'sedan',
      transmission: 'automatic',
      currentMileageKm: 100,
      nextMaintenanceDueKm: 10000,
      isReady: true,
    };
    const vehicle = await vehicles.create(data, f.request());
    async function booking() {
      const customer = (
        await f.db.pool.query(
          "INSERT INTO customers(type,display_name) VALUES ('individual','Fleet audit') RETURNING id",
        )
      ).rows[0].id;
      const row = (
        await f.db.pool.query(
          "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,'2080-01-01T10:00:00Z','2080-01-03T10:00:00Z','model',$2,$3) RETURNING *",
          [customer, model.id, f.actor],
        )
      ).rows[0];
      await f.db.pool.query(
        'INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)',
        [row.id, model.id],
      );
      await f.terms(row.id, 1, '12345');
      return row;
    }
    const update = (changes, version = 1, request = f.request()) =>
      vehicles.update(
        String(vehicle.id),
        { expectedVersion: version, reason: 'Fleet audit change', data: { ...data, ...changes } },
        request,
      );
    await work({
      ...f,
      vehicles,
      scheduling,
      bookings,
      technical,
      calendar,
      model,
      data,
      vehicle,
      booking,
      update,
    });
  });
}

test('Catalog integrity: vehicle commands roll back references, service rows, events and results on late faults', async () => {
  await withFleet(async (f) => {
    const record = await f.vehicles.addService(
      String(f.vehicle.id),
      { expectedVersion: 1, performedOn: '2025-01-01', procedure: 'ТО', mileageKm: 100 },
      f.request(),
    );
    const newData = {
      ...f.data,
      modelId: undefined,
      brandName: 'Audit new brand',
      modelName: 'Audit new model',
      pricingGroupId: f.model.pricing_group_id,
    };
    const createRequest = f.request();
    const updateRequest = f.request();
    const actions = [
      [
        'vehicles.created',
        () => f.vehicles.create({ ...newData, plate: 'A124BC78', vin: '' }, createRequest),
      ],
      [
        'vehicles.updated',
        () =>
          f.vehicles.update(
            String(f.vehicle.id),
            {
              expectedVersion: 2,
              reason: 'Mileage correction',
              data: { ...newData, currentMileageKm: 101 },
            },
            updateRequest,
          ),
      ],
      [
        'vehicles.archived',
        () =>
          f.vehicles.archive(
            String(f.vehicle.id),
            { expectedVersion: 2, reason: 'Archive audit' },
            f.request(),
          ),
      ],
      [
        'vehicles.serviced',
        () =>
          f.vehicles.addService(
            String(f.vehicle.id),
            {
              expectedVersion: 2,
              performedOn: '2025-01-02',
              procedure: 'ТО',
              mileageKm: 200,
              updateMileage: true,
              nextMaintenanceDueKm: 10200,
            },
            f.request(),
          ),
      ],
      [
        'vehicles.service_updated',
        () =>
          f.vehicles.editService(
            String(f.vehicle.id),
            String(record.id),
            {
              expectedVersion: 2,
              performedOn: '2025-01-02',
              procedure: 'Исправленное ТО',
              mileageKm: 120,
            },
            f.request(),
          ),
      ],
    ];
    await f.db.pool.query(
      "CREATE FUNCTION stage23_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Stage 23 late fault' USING ERRCODE='P0001'; END $$",
    );
    for (const table of ['audit_logs', 'outbox_jobs']) {
      for (const [action, command] of actions) {
        const column = table === 'audit_logs' ? 'action' : 'kind';
        await f.db.pool.query(
          `CREATE TRIGGER stage23_fail BEFORE INSERT ON ${table} FOR EACH ROW WHEN (NEW.${column}='${action}') EXECUTE FUNCTION stage23_fail()`,
        );
        try {
          const before = await f.snapshot();
          for (let attempt = 0; attempt < 2; attempt++) {
            await f.observe(() => assert.rejects(command(), (error) => error.code === 'P0001'));
            assert.ok(f.trace.some((event) => event.sql === 'ROLLBACK' && event.ok));
            assert.ok(
              f.trace.some((event) => /^(INSERT INTO|UPDATE) vehicles/.test(event.sql) && event.ok),
            );
            assert.deepEqual(await f.snapshot(), before, table + '/' + action);
          }
        } finally {
          await f.db.pool.query('DROP TRIGGER stage23_fail ON ' + table);
        }
      }
    }
    const created = await actions[0][1]();
    const updated = await actions[1][1]();
    assert.equal(updated.version, 3);
    const after = await f.snapshot();
    assert.deepEqual(await actions[0][1](), created);
    assert.deepEqual(await actions[1][1](), updated);
    assert.deepEqual(await f.snapshot(), after);
    assert.equal(after.vehicle_brands.filter((row) => row.name === 'Audit new brand').length, 1);
    assert.equal(after.vehicle_models.filter((row) => row.name === 'Audit new model').length, 1);
  });
});

test('Catalog integrity: model change and archive require replacement in active bookings', async (t) => {
  for (const change of ['readiness', 'model', 'archive']) {
    await t.test(change, async () => {
      await withFleet(async (f) => {
        const booking = await f.booking();
        await f.bookings.assign(
          { expectedVersion: 1, vehicleId: f.vehicle.id, reason: 'Initial assignment' },
          f.request(),
          booking.id,
        );
        const before = await f.snapshot();
        const detail = await f.vehicles.get(String(f.vehicle.id));
        assert.deepEqual(detail.activeBookingIds, [booking.id]);
        if (change === 'archive') {
          await assert.rejects(
            f.vehicles.archive(
              String(f.vehicle.id),
              { expectedVersion: 1, reason: 'Archive assigned vehicle' },
              f.request(),
            ),
            code('VEHICLE_HAS_ACTIVE_BOOKINGS', 409),
          );
        } else if (change === 'model') {
          await assert.rejects(
            f.update({
              modelId: undefined,
              brandName: 'Replacement brand',
              modelName: 'Replacement model',
              pricingGroupId: f.model.pricing_group_id,
            }),
            code('VEHICLE_HAS_ACTIVE_BOOKINGS', 409),
          );
        } else await f.update({ isReady: false, note: 'Не готов после назначения' });
        const after = await f.snapshot();
        if (change !== 'readiness') {
          assert.deepEqual(after, before, 'rejected edit leaves vehicle and dictionaries intact');
          const replacement = await f.vehicles.create(
            { ...f.data, plate: 'A124BC78', vin: '' },
            f.request(),
          );
          await f.bookings.assign(
            { expectedVersion: 2, vehicleId: replacement.id, reason: 'Replace vehicle' },
            f.request(),
            booking.id,
          );
          assert.deepEqual((await f.vehicles.get(String(f.vehicle.id))).activeBookingIds, []);
          if (change === 'archive') {
            await f.vehicles.archive(
              String(f.vehicle.id),
              { expectedVersion: 1, reason: 'Archive after replacement' },
              f.request(),
            );
          } else {
            await f.update({
              modelId: undefined,
              brandName: 'Replacement brand',
              modelName: 'Replacement model',
              pricingGroupId: f.model.pricing_group_id,
            });
          }
          return;
        }
        for (const table of [
          'bookings',
          'booking_terms',
          'booking_eligible_models',
          'schedule_blocks',
          ...Object.keys(before).filter(
            (name) => name.startsWith('finance') || name === 'financial_operations',
          ),
        ]) {
          assert.deepEqual(after[table], before[table], table);
        }
        await assert.rejects(
          f.bookings.assign(
            { expectedVersion: 2, vehicleId: f.vehicle.id, reason: 'Revalidate assignment' },
            f.request(),
            booking.id,
          ),
          code('VEHICLE_NOT_READY'),
        );
        assert.deepEqual(await f.snapshot(), after);
        const view = await f.calendar.get({
          from: '2080-01-01T00:00:00Z',
          to: '2080-01-04T00:00:00Z',
        });
        assert.ok(view.events.some((event) => event.booking_id === booking.id));
        assert.ok(view.vehicles.some((vehicle) => vehicle.id === f.vehicle.id));
        assert.ok(
          view.problems.some(
            (problem) =>
              problem.id === booking.id &&
              problem.problemReasons.some((reason) => reason.includes('не готов')),
          ),
        );
      });
    });
  }
});

test('Catalog integrity: real schedule lock serializes readiness edits with assignments and technical blocks', async (t) => {
  for (const action of ['assign', 'technical']) {
    for (const editFirst of [true, false]) {
      await t.test(action + ', edit first=' + editFirst, async () => {
        await withFleet(async (f) => {
          const booking = action === 'assign' ? await f.booking() : undefined;
          const before = await f.snapshot();
          const edit = () => f.update({ isReady: false, note: 'Неготовность' });
          const command =
            action === 'assign'
              ? () =>
                  f.bookings.assign(
                    {
                      expectedVersion: 1,
                      vehicleId: f.vehicle.id,
                      reason: 'Concurrent assignment',
                    },
                    f.request(),
                    booking.id,
                  )
              : () =>
                  f.technical.save(
                    {
                      vehicleId: f.vehicle.id,
                      startAt: '2080-01-01T10:00:00Z',
                      endAt: '2080-01-03T10:00:00Z',
                      reason: 'Repair',
                    },
                    f.request(),
                  );
          const results = await f.orderedRace(
            editFirst ? edit : command,
            editFirst ? command : edit,
          );
          assert.equal(results[editFirst ? 0 : 1].status, 'fulfilled');
          const other = results[editFirst ? 1 : 0];
          if (action === 'assign' && editFirst) {
            assert.equal(other.status, 'rejected');
            code('VEHICLE_NOT_READY')(other.reason);
          } else assert.equal(other.status, 'fulfilled');
          const after = await f.snapshot();
          assert.equal(after.vehicles.find((row) => row.id === f.vehicle.id).is_ready, false);
          assert.equal(after.vehicles.find((row) => row.id === f.vehicle.id).version, 2);
          assert.equal(
            after.schedule_blocks.length - before.schedule_blocks.length,
            action === 'assign' && editFirst ? 0 : 1,
          );
          assert.deepEqual(after.booking_terms, before.booking_terms);
          for (const name of Object.keys(before).filter(
            (name) => name.startsWith('finance') || name === 'financial_operations',
          ))
            assert.deepEqual(after[name], before[name]);
          const trace = f.trace;
          const rowLock = trace.find(
            (event) => event.sql === 'SELECT * FROM vehicles WHERE id=$1 FOR UPDATE',
          );
          const schedule = trace.find(
            (event) =>
              event.pid === rowLock.pid && event.sql.includes("hashtextextended('crm:schedule',0)"),
          );
          assert.ok(schedule.completed < rowLock.completed);
        });
      });
    }
  }
});

test('Catalog integrity: concurrent vehicle edits commit one version and one event set', async () => {
  await withFleet(async (f) => {
    const before = await f.snapshot();
    const request = f.request();
    const results = await f.orderedRace(
      () => f.update({ note: 'Winner' }, 1, request),
      () => f.update({ note: 'Stale' }),
    );
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    code('VERSION_CONFLICT', 409)(results[1].reason);
    const after = await f.snapshot();
    assert.equal(after.vehicles.find((row) => row.id === f.vehicle.id).version, 2);
    for (const table of ['audit_logs', 'outbox_jobs', 'idempotency_records'])
      assert.equal(after[table].length, before[table].length + 1);
    assert.deepEqual(await f.update({ note: 'Winner' }, 1, request), results[0].value);
    assert.deepEqual(await f.snapshot(), after);
  });
});

test('Catalog integrity: dictionary commit during evaluation keeps RR facts and saved model/price snapshots', async () => {
  await withFleet(async (f) => {
    const otherModel = (
      await f.db.pool.query(
        'INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,$2,$3) RETURNING id',
        [f.model.brand_id, 'Second audit model', f.model.pricing_group_id],
      )
    ).rows[0].id;
    const otherVehicle = await f.vehicles.create(
      { ...f.data, modelId: otherModel, plate: 'A125BC78', vin: '' },
      f.request(),
    );
    const group = (
      await f.db.pool.query(
        "INSERT INTO equivalence_groups(name) VALUES ('Audit group') RETURNING id",
      )
    ).rows[0].id;
    await f.db.pool.query(
      'INSERT INTO equivalence_group_models(group_id,model_id) VALUES ($1,$2)',
      [group, f.model.id],
    );
    const booking = await f.booking();
    await f.db.pool.query(
      "UPDATE bookings SET target_type='equivalence_group',target_model_id=NULL,target_group_id=$2 WHERE id=$1",
      [booking.id, group],
    );
    const before = await f.snapshot();
    const pricing = (
      await f.db.pool.query('SELECT id FROM pricing_groups WHERE id<>$1 ORDER BY id LIMIT 1', [
        f.model.pricing_group_id,
      ])
    ).rows[0].id;
    let armed = true;
    let commits = 0;
    const originals = new Map();
    const onAcquire = (client) => {
      if (originals.has(client)) return;
      const original = client.query;
      originals.set(client, original);
      client.query = function (...args) {
        const result = original.apply(this, args);
        if (
          armed &&
          args[0] === 'SELECT model_id AS id FROM equivalence_group_models WHERE group_id=$1'
        ) {
          armed = false;
          return result.then(async (value) => {
            // Real separate writer; Catalog has no public endpoint for editing these references.
            await f.db.transaction(async (writer) => {
              await writer.query('DELETE FROM equivalence_group_models WHERE group_id=$1', [group]);
              await writer.query(
                'INSERT INTO equivalence_group_models(group_id,model_id) VALUES ($1,$2)',
                [group, otherModel],
              );
              await writer.query('UPDATE vehicle_models SET pricing_group_id=$2 WHERE id=$1', [
                f.model.id,
                pricing,
              ]);
            });
            commits++;
            return value;
          });
        }
        return result;
      };
    };
    const input = {
      target: { type: 'equivalence_group', id: group },
      startAt: '2080-01-01T10:00:00Z',
      endAt: '2080-01-03T10:00:00Z',
    };
    f.db.pool.on('acquire', onAcquire);
    try {
      const old = await f.scheduling.evaluateRequest(input);
      assert.equal(commits, 1);
      assert.deepEqual(old.availability.candidates, [f.vehicle.id]);
      const current = await f.scheduling.evaluateRequest(input);
      assert.deepEqual(current.availability.candidates, [otherVehicle.id]);
      const saved = await f.scheduling.evaluateRequest({ ...input, bookingId: booking.id });
      assert.deepEqual(saved.availability.candidates, [f.vehicle.id]);
    } finally {
      f.db.pool.off('acquire', onAcquire);
      for (const [client, query] of originals) client.query = query;
    }
    const after = await f.snapshot();
    assert.deepEqual(after.booking_eligible_models, before.booking_eligible_models);
    assert.deepEqual(after.booking_terms, before.booking_terms);
    assert.deepEqual(after.pricing_quotes, before.pricing_quotes);
    assert.deepEqual(after.bookings, before.bookings);
  });
});
