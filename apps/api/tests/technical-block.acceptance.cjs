const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
const { DatabaseService } = require('../dist/database.service');
const { CommandsService } = require('../dist/platform/commands.service');
const { SchedulingService } = require('../dist/scheduling/scheduling.service');
const { BookingService } = require('../dist/scheduling/booking.service');
const { CalendarService } = require('../dist/scheduling/calendar.service');
const { SchedulingController } = require('../dist/scheduling/scheduling.controller');
const { TechnicalBlockService } = require('../dist/scheduling/technical-block.service');
const { BookingQueryService } = require('../dist/scheduling/booking-query.service');
const ReferenceController = require('./helpers/technical-reference.cjs');
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
const normalized = (value) =>
  JSON.parse(
    JSON.stringify(value, (key, item) =>
      [
        'created_at',
        'updated_at',
        'retired_at',
        'next_attempt_at',
        'expires_at',
        'confirmed_at',
        'evaluatedAt',
      ].includes(key) && item !== null
        ? '<time>'
        : item,
    ),
  );
const snapshot = async (db, names = tables, normalize = false) =>
  Promise.all(
    names.map(async (table) => {
      const rows = (
        await db.pool.query(
          "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t::text),'[]'::jsonb) AS rows FROM " +
            table +
            ' t',
        )
      ).rows[0].rows;
      if (!normalize) return rows;
      return normalized(rows)
        .map((row) => {
          if (['audit_logs', 'outbox_jobs'].includes(table) && typeof row.id === 'string')
            row.id = '<generated uuid>';
          return row;
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }),
  );
const errorCode =
  (code, status = 409) =>
  (error) =>
    error.getStatus() === status && error.getResponse().code === code;

test(
  'Technical blocks: real PostgreSQL differential commands and concurrency',
  { timeout: 360000 },
  async (t) => {
    const adminUrl = new URL(process.env.DATABASE_URL);
    const admin = new Pool({ connectionString: adminUrl.toString() });
    const contexts = [];
    const names = [];
    t.after(async () => {
      for (const { db } of contexts) await db.pool.end();
      for (const name of names) {
        assert.match(name, /^crm_technical_test_[a-f0-9]{16}$/);
        await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      }
      await admin.end();
    });
    for (const legacy of [true, false]) {
      const name = 'crm_technical_test_' + randomBytes(8).toString('hex');
      names.push(name);
      await admin.query('CREATE DATABASE "' + name + '"');
      const url = new URL(adminUrl);
      url.pathname = '/' + name;
      process.env.DATABASE_URL = url.toString();
      const db = new DatabaseService();
      const commands = new CommandsService(db);
      const s = new SchedulingService(db, commands);
      const bookings = new BookingService(s);
      const calendar = new CalendarService(db, s);
      const context = { db, s, bookings, calendar };
      contexts.push(context);
      await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
      context.controller = legacy
        ? new ReferenceController(s, bookings, calendar)
        : new SchedulingController(
            s,
            bookings,
            calendar,
            new TechnicalBlockService(s),
            new BookingQueryService(db, s),
          );
      const actor = (
        await db.pool.query(
          "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Technical manager','technical','unused','manager') RETURNING id",
        )
      ).rows[0].id;
      await db.pool.query(
        "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,'technical-session',now()+interval '1 hour')",
        [actor],
      );
      context.request = (label) => {
        const key = ('stage9-' + label).padEnd(16, '_');
        const hash = createHash('sha256').update(key).digest('hex');
        return {
          headers: { 'idempotency-key': key },
          requestId: hash.slice(0, 8) + '-0000-4000-8000-' + hash.slice(8, 20),
          auth: { user: { id: actor }, tokenHash: 'technical-session' },
        };
      };
      const group = (
        await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'")
      ).rows[0].id;
      const brand = (
        await db.pool.query(
          "INSERT INTO vehicle_brands(name) VALUES ('Technical fixture') RETURNING id",
        )
      ).rows[0].id;
      context.model = (
        await db.pool.query(
          "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Technical model',$2) RETURNING id",
          [brand, group],
        )
      ).rows[0].id;
      context.cars = (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'TECH001',2020,'sedan',100,10000),($1,'TECH002',2020,'sedan',100,10000),($1,'TECH003',2020,'sedan',100,10000) RETURNING id",
          [context.model],
        )
      ).rows.map((row) => row.id);
      const customer = (
        await db.pool.query(
          "INSERT INTO customers(type,display_name,phone) VALUES ('individual','Technical customer','+79990000999') RETURNING id",
        )
      ).rows[0].id;
      context.makeBooking = async (label, startAt, vehicleId = context.cars[0], broad = false) => {
        const target = { type: broad ? 'model' : 'vehicle', id: broad ? context.model : vehicleId };
        const pricing = { startAt, contractDays: 1, dailyMileagePackageKm: 250 };
        const preview = await context.controller.preview(
          { target, pricing },
          context.request(label + '-preview'),
        );
        return context.controller.create(
          {
            target,
            pricing,
            previewToken: preview.previewToken,
            vehicleId,
            customer: { existingId: customer },
            reason: 'Technical fixture',
          },
          context.request(label),
        );
      };
      context.bookingsInitial = [
        await context.makeBooking('booking-one', '2050-01-01T10:00:00+03:00'),
        await context.makeBooking(
          'booking-two',
          '2050-01-02T10:00:00+03:00',
          context.cars[0],
          true,
        ),
        await context.makeBooking('booking-three', '2050-01-05T10:00:00+03:00'),
      ];
      // Historical operation is a SQL fixture, never an application payment before issuance.
      await db.pool.query(
        "INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason) VALUES ('stage9-historical',repeat('a',64),'initial',$1,$2,$3,'Historical fixture')",
        [customer, context.bookingsInitial[0].id, actor],
      );
    }
    contexts[1].s.tokenKey = contexts[0].s.tokenKey; // Shared only for exact HMAC comparison; never logged.

    const scenario = async ({ db, controller: c, request, cars, bookingsInitial, model }) => {
      const transcript = [];
      const money = await snapshot(db, financialTables);
      const capture = async (response) =>
        transcript.push({
          response: normalized(response),
          state: await snapshot(db, tables, true),
        });
      const input = {
        vehicleId: cars[0],
        startAt: '2050-01-01T12:00:00+03:00',
        endAt: '2050-01-03T09:00:00+03:00',
        reason: '  Repair  ',
      };
      const preview = (body, blockId) =>
        c.previewTechnical({
          vehicleId: body.vehicleId,
          startAt: body.startAt,
          endAt: body.endAt,
          ...(blockId ? { blockId } : {}),
        });
      const confirm = async (body, blockId) => {
        const p = await preview(body, blockId);
        return {
          ...body,
          conflictsToken: p.token,
          displaceBookings: p.conflicts
            .filter((x) => x.booking_id)
            .map((x) => ({ id: x.booking_id, expectedVersion: x.booking_version })),
        };
      };
      const empty = await c.technical({ ...input, vehicleId: cars[1] }, request('empty-create'));
      await capture(empty);
      const before = await snapshot(db);
      for (const reason of [undefined, '', ' ', 'x'.repeat(1001)])
        assert.throws(
          () => c.technical({ ...input, reason }, request('bad-reason')),
          errorCode('VALIDATION_ERROR', 400),
        );
      await assert.rejects(
        c.technical(input, request('no-confirmation')),
        errorCode('TECHNICAL_BOOKINGS_CONFIRMATION_REQUIRED'),
      );
      const confirmed = await confirm(input);
      confirmed.displaceBookings.reverse(); // Input order is irrelevant to confirmation.
      for (const changed of [
        { ...confirmed, conflictsToken: '0'.repeat(64) },
        { ...confirmed, displaceBookings: confirmed.displaceBookings.slice(1) },
        {
          ...confirmed,
          displaceBookings: confirmed.displaceBookings.map((x, i) =>
            i ? x : { ...x, expectedVersion: x.expectedVersion + 1 },
          ),
        },
      ])
        await assert.rejects(
          c.technical(changed, request('bad-confirmation')),
          errorCode('TECHNICAL_BOOKINGS_CONFIRMATION_REQUIRED'),
        );
      const revoked = request('revoked');
      revoked.auth.tokenHash = 'revoked';
      await assert.rejects(c.technical(confirmed, revoked), errorCode('UNAUTHENTICATED', 401));
      assert.deepEqual(await snapshot(db), before);
      const commandRequest = request('multi-create');
      const inject = async (table, action, run) => {
        const field = table === 'audit_logs' ? 'action' : 'kind';
        await db.pool.query(
          'CREATE FUNCTION reject_technical_stage9() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.' +
            field +
            "='" +
            action +
            "' THEN RAISE EXCEPTION 'technical injected failure'; END IF; RETURN NEW; END $$",
        );
        await db.pool.query(
          'CREATE TRIGGER reject_technical_stage9 BEFORE INSERT ON ' +
            table +
            ' FOR EACH ROW EXECUTE FUNCTION reject_technical_stage9()',
        );
        const state = await snapshot(db);
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            await assert.rejects(run(), /technical injected failure/);
            assert.deepEqual(
              await snapshot(db),
              state,
              'all bookings, assignments, terms, events, key and money roll back',
            );
          }
        } finally {
          await db.pool.query('DROP TRIGGER reject_technical_stage9 ON ' + table);
          await db.pool.query('DROP FUNCTION reject_technical_stage9()');
        }
      };
      for (const table of ['audit_logs', 'outbox_jobs'])
        await inject(table, 'schedule.created', () => c.technical(confirmed, commandRequest));
      const oldAssignments = (
        await db.pool.query("SELECT * FROM schedule_blocks WHERE kind='assignment' ORDER BY id")
      ).rows;
      const oldTerms = (await db.pool.query('SELECT * FROM booking_terms ORDER BY id')).rows;
      const block = await c.technical(confirmed, commandRequest);
      const submitted = confirmed;
      assert.deepEqual(
        await c.technical(submitted, commandRequest),
        JSON.parse(JSON.stringify(block)),
      );
      await assert.rejects(
        c.technical({ ...submitted, reason: 'Other' }, commandRequest),
        errorCode('IDEMPOTENCY_KEY_REUSED'),
      );
      const revokedRetry = request('multi-create');
      revokedRetry.auth.tokenHash = 'revoked';
      await assert.rejects(c.technical(submitted, revokedRetry), errorCode('UNAUTHENTICATED', 401));
      for (const [index, booking] of bookingsInitial.slice(0, 2).entries()) {
        const detail = await c.get(String(booking.id));
        assert.equal(detail.status, 'confirmed');
        assert.equal(detail.version, booking.version + 1);
        assert.equal(detail.vehicle_id, null);
        assert.equal(detail.target_type, 'model');
        const originalTerm = oldTerms.find((row) => row.booking_id === booking.id);
        assert.equal(detail.terms[0].quote_id, originalTerm.quote_id);
        assert.deepEqual(
          detail.terms[0].snapshot,
          index === 0
            ? { ...originalTerm.snapshot, target: { type: 'model', id: model } }
            : originalTerm.snapshot,
        );
        assert.equal(detail.terms.length, index === 0 ? 2 : 1);
        const row = (
          await db.pool.query('SELECT * FROM schedule_blocks WHERE id=$1', [
            oldAssignments[index].id,
          ])
        ).rows[0];
        assert.ok(row.retired_at);
        assert.deepEqual(
          { ...row, retired_at: null, version: row.version - 1 },
          oldAssignments[index],
        );
      }
      const window = { from: '2050-01-01T00:00:00+03:00', to: '2050-01-08T00:00:00+03:00' };
      let calendar = await c.calendar(window);
      assert.equal(calendar.events.filter((x) => x.kind === 'displaced').length, 2);
      assert.ok(
        calendar.problems
          .find((x) => x.id === bookingsInitial[0].id)
          .problemReasons.includes('Требуется замена автомобиля'),
      );
      await capture({
        block,
        calendar: normalized(calendar),
        preview: await preview({ ...input, vehicleId: cars[2] }),
      });
      await assert.rejects(
        c.technical(input, request('other-technical')),
        errorCode('TECHNICAL_BLOCK_CONFLICT'),
      );
      for (const invalid of [
        { ...input, expectedVersion: 99 },
        { ...input, vehicleId: cars[2], expectedVersion: block.version },
        input,
      ]) {
        await assert.rejects(
          c.updateTechnical(String(block.id), invalid, request('invalid-update')),
          errorCode('VERSION_CONFLICT'),
        );
      }
      const update = {
        ...input,
        endAt: '2050-01-06T09:00:00+03:00',
        expectedVersion: block.version,
      };
      const confirmedUpdate = await confirm(update, block.id);
      await db.pool.query('UPDATE bookings SET version=version+1 WHERE id=$1', [
        bookingsInitial[2].id,
      ]);
      await assert.rejects(
        c.updateTechnical(String(block.id), confirmedUpdate, request('stale-booking-version')),
        errorCode('TECHNICAL_BOOKINGS_CONFIRMATION_REQUIRED'),
      );
      const refreshed = await confirm(update, block.id);
      const updateRequest = request('update-third');
      for (const table of ['audit_logs', 'outbox_jobs'])
        await inject(table, 'schedule.updated', () =>
          c.updateTechnical(String(block.id), refreshed, updateRequest),
        );
      const updated = await c.updateTechnical(String(block.id), refreshed, updateRequest);
      assert.equal(updated.version, block.version + 1);
      assert.deepEqual(
        await c.updateTechnical(String(block.id), refreshed, updateRequest),
        JSON.parse(JSON.stringify(updated)),
      );
      await capture(updated);
      const stale = {
        ...refreshed,
        displaceBookings: refreshed.displaceBookings,
        expectedVersion: updated.version,
      };
      await assert.rejects(
        c.updateTechnical(String(block.id), stale, request('composition-disappeared')),
        errorCode('TECHNICAL_PREVIEW_STALE'),
      );
      const reassign = await c.assignment(
        String(bookingsInitial[0].id),
        { expectedVersion: 2, vehicleId: cars[2] },
        request('reassign'),
      );
      assert.equal(reassign.version, 3);
      calendar = await c.calendar(window);
      assert.ok(
        !calendar.events.some((x) => x.kind === 'displaced' && x.booking_id === reassign.id),
      );
      assert.deepEqual(await snapshot(db, financialTables), money);
      await capture({ updated, calendar: normalized(calendar) });
      return transcript;
    };
    await t.test(
      'create/update displacement, full effects, retries and rollback match frozen controller',
      async () => {
        assert.deepEqual(await scenario(contexts[1]), await scenario(contexts[0]));
      },
    );

    await require('./helpers/technical-cancel-regressions.cjs')({
      t,
      contexts,
      snapshot,
      normalized,
      tables,
      financialTables,
      errorCode,
    });
    await t.test(
      'assignment versus technical displacement commits one command from the same booking version',
      async () => {
        const { db, controller: c, request, makeBooking, cars } = contexts[1];
        for (const technicalFirst of [true, false]) {
          const day = technicalFirst ? '20' : '23';
          const booking = await makeBooking(
            'race-booking-' + day,
            '2050-01-' + day + 'T10:00:00+03:00',
            cars[1],
            true,
          );
          const input = {
            vehicleId: cars[1],
            startAt: booking.start_at.toISOString(),
            endAt: booking.end_at.toISOString(),
            reason: 'Race',
          };
          const preview = await c.previewTechnical({
            vehicleId: input.vehicleId,
            startAt: input.startAt,
            endAt: input.endAt,
          });
          const technical = () =>
            c.technical(
              {
                ...input,
                conflictsToken: preview.token,
                displaceBookings: [{ id: booking.id, expectedVersion: booking.version }],
              },
              request('race-technical-' + day),
            );
          const assign = () =>
            c.assignment(
              String(booking.id),
              { expectedVersion: booking.version, vehicleId: cars[2] },
              request('race-assign-' + day),
            );
          const results = await Promise.allSettled(
            technicalFirst ? [technical(), assign()] : [assign(), technical()],
          );
          assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
          const loser = results.find((x) => x.status === 'rejected').reason;
          assert.equal(loser.getStatus(), 409);
          assert.ok(
            ['BOOKING_VERSION_CONFLICT', 'TECHNICAL_PREVIEW_STALE'].includes(
              loser.getResponse().code,
            ),
          );
          const current = (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [booking.id]))
            .rows[0];
          assert.equal(current.version, booking.version + 1);
          const active = (
            await db.pool.query(
              'SELECT * FROM schedule_blocks WHERE booking_id=$1 AND retired_at IS NULL',
              [booking.id],
            )
          ).rows;
          assert.ok(
            active.length === 0 || (active.length === 1 && active[0].vehicle_id === cars[2]),
          );
        }
      },
    );
    await t.test(
      'concurrent edits of adjacent blocks cannot both occupy the same interval',
      async () => {
        const { db, controller: c, request, cars } = contexts[1];
        const first = await c.technical(
          {
            vehicleId: cars[0],
            startAt: '2051-01-01T00:00:00Z',
            endAt: '2051-01-02T00:00:00Z',
            reason: 'First',
          },
          request('adjacent-first'),
        );
        const second = await c.technical(
          {
            vehicleId: cars[0],
            startAt: '2051-01-02T00:00:00Z',
            endAt: '2051-01-03T00:00:00Z',
            reason: 'Second',
          },
          request('adjacent-second'),
        );
        const results = await Promise.allSettled(
          [first, second].map((block) =>
            c.updateTechnical(
              String(block.id),
              {
                vehicleId: cars[0],
                startAt: '2051-01-04T00:00:00Z',
                endAt: '2051-01-05T00:00:00Z',
                reason: 'Same interval',
                expectedVersion: block.version,
              },
              request('edit-' + block.id),
            ),
          ),
        );
        assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
        assert.ok(
          errorCode('TECHNICAL_BLOCK_CONFLICT')(
            results.find((x) => x.status === 'rejected').reason,
          ),
        );
        assert.deepEqual(
          (
            await db.pool.query(
              'SELECT version FROM schedule_blocks WHERE id=ANY($1::int[]) ORDER BY version',
              [[first.id, second.id]],
            )
          ).rows.map((x) => x.version),
          [1, 2],
        );
      },
    );
  },
);
