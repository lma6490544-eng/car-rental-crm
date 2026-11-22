const { test } = require('node:test');
const { selectOptionsSnapshot } = require('./helpers/select-options.cjs');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
test('Stage 4 PostgreSQL commands and constraints', { timeout: 360000 }, async (t) => {
  const name = 'crm_stage4_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL),
    admin = new Pool({ connectionString: url.toString() });
  url.pathname = '/' + name;
  let db;
  t.after(async () => {
    if (db) await db.pool.end();
    assert.match(name, /^crm_stage4_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  });
  await admin.query('CREATE DATABASE "' + name + '"');
  process.env.DATABASE_URL = url.toString();
  const { DatabaseService } = require('../dist/database.service');
  db = new DatabaseService();
  await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });
  const { CommandsService } = require('../dist/platform/commands.service');
  const { SchedulingService } = require('../dist/scheduling/scheduling.service');
  const { BookingService } = require('../dist/scheduling/booking.service');
  const { CalendarService } = require('../dist/scheduling/calendar.service');
  const { TechnicalBlockService } = require('../dist/scheduling/technical-block.service');
  const { SchedulingController } = require('../dist/scheduling/scheduling.controller');
  const { BookingQueryService } = require('../dist/scheduling/booking-query.service');
  const { PricingController } = require('../dist/pricing/pricing.controller');
  const commands = new CommandsService(db),
    s = new SchedulingService(db, commands),
    controller = new SchedulingController(
      s,
      new BookingService(s),
      new CalendarService(db, s),
      new TechnicalBlockService(s),
      new BookingQueryService(db, s),
    ),
    pricing = new PricingController(db, commands);

  await t.test('empty calendar keeps the response contract', async () => {
    const view = await controller.calendar({
      from: '2070-01-01T00:00:00Z',
      to: '2070-01-02T00:00:00Z',
    });
    assert.deepEqual(Object.keys(view), [
      'vehicles',
      'events',
      'bookings',
      'unassignedBookings',
      'problems',
      'evaluatedAt',
    ]);
    for (const key of ['vehicles', 'events', 'bookings', 'unassignedBookings', 'problems'])
      assert.deepEqual(view[key], []);
    assert.ok(Number.isFinite(Date.parse(view.evaluatedAt)));
  });
  const actor = (
    await db.pool.query(
      "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Test','test','unused','manager') RETURNING id",
    )
  ).rows[0].id;
  await db.pool.query(
    "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,'test',now()+interval '1 hour')",
    [actor],
  );
  const request = (key = randomUUID()) => ({
    headers: { 'idempotency-key': key },
    requestId: randomUUID(),
    auth: { user: { id: actor }, tokenHash: 'test' },
  });
  const group = (await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='economy'"))
    .rows[0].id;
  const brand = (
    await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Тест') RETURNING id")
  ).rows[0].id;
  const model = (
    await db.pool.query(
      "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Модель',$2) RETURNING id",
      [brand, group],
    )
  ).rows[0].id;
  const vehicle = (
    await db.pool.query(
      "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'А001АА178',2020,'sedan',100,10000) RETURNING id",
      [model],
    )
  ).rows[0].id;
  const quote = await pricing.quote(
    {
      operationKind: 'initial',
      pricingGroupId: group,
      startAt: '2026-12-01T10:00:00+03:00',
      contractDays: 2,
      dailyMileagePackageKm: 250,
    },
    request(),
  );
  await pricing.confirm(
    String(quote.id),
    { expectedVersion: 1, confirmedOverrides: [] },
    request(),
  );
  const body = {
    customer: { new: { type: 'individual', displayName: 'Тестовый клиент' } },
    target: { type: 'vehicle', id: vehicle },
    quoteId: quote.id,
    reason: 'Проверка',
  };
  let booking;
  await t.test('booking creation rolls back all effects when booking audit fails', async () => {
    const tables = [
      'customers',
      'bookings',
      'booking_terms',
      'booking_eligible_models',
      'booking_risks',
      'schedule_blocks',
      'pricing_quotes',
      'audit_logs',
      'outbox_jobs',
      'idempotency_records',
    ];
    const counts = async () =>
      Promise.all(
        tables.map(
          async (table) =>
            (await db.pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n,
        ),
      );
    const inlinePricing = {
      startAt: '2026-12-01T10:00:00+03:00',
      contractDays: 2,
      dailyMileagePackageKm: 250,
    };
    const preview = await controller.preview(
      { target: body.target, pricing: inlinePricing },
      request(),
    );
    const inlineBody = {
      target: body.target,
      pricing: inlinePricing,
      previewToken: preview.previewToken,
      customer: {
        new: {
          type: 'individual',
          displayName: 'Тестовый клиент',
          phone: '+79990000001',
          details: { firstName: 'Иван', lastName: 'Тестов' },
        },
      },
      reason: 'Проверка отката автоматического расчёта',
    };
    for (const table of ['audit_logs']) {
      const before = await counts();
      await db.pool.query(
        "CREATE FUNCTION regression_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='bookings.created' THEN RAISE EXCEPTION 'regression injected failure'; END IF; RETURN NEW; END $$",
      );
      await db.pool.query(
        'CREATE TRIGGER regression_fail BEFORE INSERT ON ' +
          table +
          ' FOR EACH ROW EXECUTE FUNCTION regression_fail()',
      );
      try {
        for (const payload of [body, inlineBody]) {
          const req = request();
          await assert.rejects(controller.create(payload, req), /regression injected failure/);
          assert.deepEqual(await counts(), before, table);
          await assert.rejects(controller.create(payload, req), /regression injected failure/);
          assert.deepEqual(await counts(), before, 'retry after rollback');
        }
      } finally {
        await db.pool.query('DROP TRIGGER regression_fail ON ' + table);
        await db.pool.query('DROP FUNCTION regression_fail()');
      }
    }
  });
  await t.test('atomic create, exact quote, independent ID and idempotent retry', async () => {
    const req = request();
    booking = await controller.create(body, req);
    const again = await controller.create(body, req);
    assert.equal(again.id, booking.id);
    const savedRow = (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [booking.id]))
      .rows[0];
    assert.deepEqual(booking, savedRow, 'creation returns the complete booking row');
    assert.deepEqual(again, JSON.parse(JSON.stringify(savedRow)), 'retry returns the saved result');
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n, 1);
    assert.equal(
      (await controller.get(String(booking.id))).terms[0].snapshot.finalTotalRub,
      quote.calculation.finalTotalRub,
    );
  });
  await t.test('conflict and rejected risk leave no extra customer', async () => {
    await assert.rejects(
      controller.create(body, request()),
      (e) => e.getResponse().code === 'VEHICLE_ASSIGNMENT_CONFLICT',
    );
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n, 1);
    let risk;
    try {
      await controller.create(body, request());
    } catch (e) {
      risk = e.getResponse().details;
    }
    assert.ok(risk.conflicts.length);
    await assert.rejects(
      controller.create(body, request()),
      (e) => e.getResponse().code === 'VEHICLE_ASSIGNMENT_CONFLICT',
    );
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n, 1);
  });
  await t.test('database exclusion enforces assignments against technical blocks', async () => {
    await assert.rejects(
      db.pool.query(
        "INSERT INTO schedule_blocks(vehicle_id,kind,start_at,end_at,reason,created_by) VALUES ($1,'technical','2026-12-01T11:00:00+03','2026-12-01T12:00:00+03','test',$2)",
        [vehicle, actor],
      ),
      (e) => e.code === '23P01',
    );
  });
  await t.test('version conflict, cancellation and adjacent technical interval', async () => {
    await assert.rejects(
      controller.cancel(String(booking.id), { expectedVersion: 99, reason: 'test' }, request()),
      (e) => e.getStatus() === 409,
    );
    const adjacent = await controller.technical(
      {
        vehicleId: vehicle,
        startAt: '2026-12-03T10:00:00+03:00',
        endAt: '2026-12-04T10:00:00+03:00',
        reason: 'ТО',
      },
      request(),
    );
    assert.ok(adjacent.id);
    await controller.cancelTechnical(
      String(adjacent.id),
      { expectedVersion: 1, reason: 'Отменено' },
      request(),
    );
    await controller.cancel(
      String(booking.id),
      { expectedVersion: 1, reason: 'Отмена' },
      request(),
    );
    assert.equal(
      (
        await db.pool.query(
          'SELECT count(*)::int AS n FROM schedule_blocks WHERE retired_at IS NULL',
        )
      ).rows[0].n,
      0,
    );
  });
  await t.test('cancellation preserves atomicity, history, retries and finance', async () => {
    const target = { type: 'model', id: model };
    const pricingInput = {
      startAt: '2044-01-01T10:00:00+03:00',
      contractDays: 2,
      dailyMileagePackageKm: 250,
    };
    const make = async (vehicleId) => {
      const preview = await controller.preview({ target, pricing: pricingInput }, request());
      return controller.create(
        {
          target,
          pricing: pricingInput,
          previewToken: preview.previewToken,
          vehicleId,
          customer: { existingId: booking.customer_id },
          reason: 'Проверка отмены',
        },
        request(),
      );
    };
    const tables = [
      'bookings',
      'schedule_blocks',
      'booking_terms',
      'booking_eligible_models',
      'booking_risks',
      'audit_logs',
      'outbox_jobs',
      'idempotency_records',
    ];
    const financialTables = [
      'financial_operations',
      'finance_charges',
      'finance_external',
      'finance_funds',
      'finance_fund_entries',
      'finance_lots',
      'finance_allocations',
    ];
    const snapshot = (names) =>
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
    const created = await make(vehicle);
    const submitted = { expectedVersion: created.version, reason: '  Отмена клиентом  ' };
    const req = request();
    const before = await snapshot(tables);
    const moneyBefore = await snapshot(financialTables);
    for (const reason of [undefined, '', '  ', 123, 'x'.repeat(1001)]) {
      assert.throws(
        () => controller.cancel(String(created.id), { ...submitted, reason }, request()),
        (e) => e.getStatus() === 400 && e.getResponse().code === 'VALIDATION_ERROR',
      );
    }
    await assert.rejects(
      controller.cancel(String(created.id), { ...submitted, expectedVersion: 99 }, request()),
      (e) =>
        e.getStatus() === 409 && e.getResponse().message === 'Бронь изменилась или уже отменена.',
    );
    const unauthorized = request();
    unauthorized.auth.tokenHash = 'revoked';
    await assert.rejects(
      controller.cancel(String(created.id), submitted, unauthorized),
      (e) => e.getStatus() === 401,
    );
    assert.deepEqual(await snapshot(tables), before);
    for (const table of ['audit_logs', 'outbox_jobs']) {
      const field = table === 'audit_logs' ? 'action' : 'kind';
      await db.pool.query(
        'CREATE FUNCTION reject_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.' +
          field +
          "='bookings.cancelled' THEN RAISE EXCEPTION 'cancel injected failure'; END IF; RETURN NEW; END $$",
      );
      await db.pool.query(
        'CREATE TRIGGER reject_cancel BEFORE INSERT ON ' +
          table +
          ' FOR EACH ROW EXECUTE FUNCTION reject_cancel()',
      );
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(
            controller.cancel(String(created.id), submitted, req),
            /cancel injected failure/,
          );
          assert.deepEqual(
            await snapshot(tables),
            before,
            table + ' rolls back every row and command key',
          );
          assert.deepEqual(await snapshot(financialTables), moneyBefore);
        }
      } finally {
        await db.pool.query('DROP TRIGGER reject_cancel ON ' + table);
        await db.pool.query('DROP FUNCTION reject_cancel()');
      }
    }
    const oldBlocks = (
      await db.pool.query('SELECT * FROM schedule_blocks WHERE booking_id=$1 ORDER BY id', [
        created.id,
      ])
    ).rows;
    const cancelled = await controller.cancel(String(created.id), submitted, req);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.version, created.version + 1);
    assert.deepEqual(
      cancelled,
      (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [created.id])).rows[0],
    );
    const retired = (
      await db.pool.query('SELECT * FROM schedule_blocks WHERE booking_id=$1 ORDER BY id', [
        created.id,
      ])
    ).rows;
    assert.equal(retired.length, oldBlocks.length);
    retired.forEach((row, index) => {
      assert.ok(row.retired_at);
      assert.deepEqual({ ...row, retired_at: null }, oldBlocks[index]);
    });
    const committed = await snapshot(tables);
    assert.deepEqual(
      await controller.cancel(String(created.id), submitted, req),
      JSON.parse(JSON.stringify(cancelled)),
    );
    await assert.rejects(
      controller.cancel(String(created.id), { ...submitted, reason: 'Другая' }, req),
      (e) => e.getResponse().code === 'IDEMPOTENCY_KEY_REUSED',
    );
    for (const expectedVersion of [created.version, cancelled.version]) {
      await assert.rejects(
        controller.cancel(String(created.id), { ...submitted, expectedVersion }, request()),
        (e) => e.getStatus() === 409 && e.getResponse().code === 'BOOKING_VERSION_CONFLICT',
      );
    }
    const revokedRetry = { ...req, auth: { ...req.auth, tokenHash: 'revoked' } };
    await assert.rejects(
      controller.cancel(String(created.id), submitted, revokedRetry),
      (e) => e.getStatus() === 401,
    );
    assert.deepEqual(await snapshot(tables), committed);
    const history = await controller.history(String(created.id));
    assert.equal(history.items[0].action, 'bookings.cancelled');
    assert.equal(history.items[0].details.reason, 'Отмена клиентом');
    assert.equal(
      (
        await db.pool.query('SELECT count(*)::int AS n FROM outbox_jobs WHERE business_key=$1', [
          'bookings.cancelled:' + created.id + ':' + cancelled.version,
        ])
      ).rows[0].n,
      1,
    );
    const unassigned = await make(null);
    await controller.cancel(
      String(unassigned.id),
      { expectedVersion: unassigned.version, reason: 'Без машины' },
      request(),
    );
    const displaced = await make(vehicle);
    const technical = {
      vehicleId: vehicle,
      startAt: pricingInput.startAt,
      endAt: '2044-01-03T10:00:00+03:00',
      reason: 'Ремонт',
    };
    const preview = await controller.previewTechnical({
      vehicleId: technical.vehicleId,
      startAt: technical.startAt,
      endAt: technical.endAt,
    });
    await controller.technical(
      {
        ...technical,
        conflictsToken: preview.token,
        displaceBookings: preview.conflicts.map((x) => ({
          id: x.booking_id,
          expectedVersion: x.booking_version,
        })),
      },
      request(),
    );
    const window = { from: '2044-01-01T00:00:00+03:00', to: '2044-01-04T00:00:00+03:00' };
    assert.ok(
      (await controller.calendar(window)).events.some(
        (x) => x.kind === 'displaced' && x.booking_id === displaced.id,
      ),
    );
    const current = (
      await db.pool.query('SELECT version FROM bookings WHERE id=$1', [displaced.id])
    ).rows[0];
    const historyBefore = await snapshot(['schedule_blocks', 'booking_terms', 'booking_risks']);
    await controller.cancel(
      String(displaced.id),
      { expectedVersion: current.version, reason: 'Отмена после снятия' },
      request(),
    );
    assert.deepEqual(
      await snapshot(['schedule_blocks', 'booking_terms', 'booking_risks']),
      historyBefore,
    );
    const calendar = await controller.calendar(window);
    for (const id of [created.id, unassigned.id, displaced.id]) {
      assert.ok(!calendar.events.some((x) => x.booking_id === id));
      for (const key of ['bookings', 'unassignedBookings', 'problems'])
        assert.ok(!calendar[key].some((x) => x.id === id));
    }
    assert.deepEqual(await snapshot(financialTables), moneyBefore);
    // Independent pre/post transcript: do not regenerate the baseline after moving cancel.
    assert.deepEqual(
      JSON.parse(
        JSON.stringify({
          response: { ...cancelled, created_at: '<time>', updated_at: '<time>' },
          retry: {
            ...(await controller.cancel(String(created.id), submitted, req)),
            created_at: '<time>',
            updated_at: '<time>',
          },
          assignments: retired.map((row) => ({
            ...row,
            created_at: '<time>',
            retired_at: '<time>',
          })),
          audit: history.items.map((row) => ({ action: row.action, details: row.details })),
          outbox: (
            await db.pool.query(
              "SELECT business_key,kind,payload FROM outbox_jobs WHERE kind='bookings.cancelled' AND payload->>'id'=$1 ORDER BY id",
              [String(created.id)],
            )
          ).rows,
          financeUnchanged: true,
          calendarIds: calendar.bookings.map((row) => row.id),
        }),
      ),
      require('./fixtures/cancel-before-stage7.json'),
      'cancel matches the independent pre-refactoring transcript',
    );
  });
  await t.test('cancel and assign from the same version commit exactly one command', async () => {
    for (const cancelFirst of [true, false]) {
      const target = { type: 'model', id: model };
      const pricingInput = {
        startAt: '2045-01-01T10:00:00+03:00',
        contractDays: 1,
        dailyMileagePackageKm: 250,
      };
      const preview = await controller.preview({ target, pricing: pricingInput }, request());
      const created = await controller.create(
        {
          target,
          pricing: pricingInput,
          previewToken: preview.previewToken,
          vehicleId: vehicle,
          customer: { existingId: booking.customer_id },
          reason: 'Конкуренция отмены',
        },
        request(),
      );
      const cancel = () =>
        controller.cancel(
          String(created.id),
          { expectedVersion: created.version, reason: 'Отмена' },
          request(),
        );
      const assign = () =>
        controller.assignment(
          String(created.id),
          { expectedVersion: created.version, vehicleId: vehicle },
          request(),
        );
      const results = await Promise.allSettled(
        cancelFirst ? [cancel(), assign()] : [assign(), cancel()],
      );
      assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
      const loser = results.find((x) => x.status === 'rejected').reason;
      assert.equal(loser.getStatus(), 409);
      assert.equal(loser.getResponse().code, 'BOOKING_VERSION_CONFLICT');
      const current = (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [created.id]))
        .rows[0];
      assert.equal(current.version, created.version + 1);
      const winner = results.find((x) => x.status === 'fulfilled').value;
      assert.deepEqual(current, winner);
      assert.equal(
        (
          await db.pool.query(
            'SELECT count(*)::int AS n FROM schedule_blocks WHERE booking_id=$1 AND retired_at IS NULL',
            [created.id],
          )
        ).rows[0].n,
        current.status === 'cancelled' ? 0 : 1,
      );
      if (current.status === 'confirmed')
        await controller.cancel(
          String(created.id),
          { expectedVersion: current.version, reason: 'Завершение проверки' },
          request(),
        );
    }
  });
  await t.test('concurrent commands cannot reserve the same car', async () => {
    const results = await Promise.allSettled([
      controller.create(body, request()),
      controller.create(body, request()),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  });
  await t.test('calendar shows real bookings, never invented finance', async (t) => {
    const connect = db.pool.connect.bind(db.pool);
    let queries = 0;
    db.pool.connect = async () => {
      const client = await connect();
      const query = client.query;
      const release = client.release;
      client.query = function (...args) {
        queries++;
        return query.apply(this, args);
      };
      client.release = function (...args) {
        client.query = query;
        client.release = release;
        return release.apply(this, args);
      };
      return client;
    };
    const started = performance.now();
    let view;
    try {
      view = await controller.calendar({
        from: '2026-12-01T00:00:00+03:00',
        to: '2026-12-10T00:00:00+03:00',
      });
    } finally {
      db.pool.connect = connect;
    }
    t.diagnostic(
      `calendar: ${view.bookings.length} bookings, ${view.vehicles.length} vehicles, ${queries} SQL calls including transaction control, ${(performance.now() - started).toFixed(2)} ms`,
    );
    assert.equal(view.events.length, 1);
    assert.equal(view.events[0].kind, 'assignment');
    assert.equal(view.events[0].paidRatio, undefined);
  });
  await t.test(
    'browser calendar, four panels, context and polling draft',
    { timeout: 240000 },
    async () => {
      const { spawn } = require('node:child_process'),
        net = require('node:net');
      const { chromium } = require('playwright');
      const { passwordHash } = require('../dist/platform/security');
      const password = 'Test-' + randomBytes(16).toString('hex');
      await db.pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [
        await passwordHash(password),
        actor,
      ]);
      const port = () =>
        new Promise((resolve) => {
          const server = net.createServer();
          server.listen(0, '127.0.0.1', () => {
            const p = server.address().port;
            server.close(() => resolve(p));
          });
        });
      const apiPort = await port(),
        webPort = await port(),
        root = path.resolve(__dirname, '../../..'),
        origin = 'http://127.0.0.1:' + webPort;
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: url.toString(),
        API_PORT: String(apiPort),
        APP_ORIGINS: origin,
      };
      const children = [];
      let browser;
      try {
        for (const [file, args, cwd] of [
          [path.join(root, 'apps/api/dist/main.js'), [], path.join(root, 'apps/api')],
          [
            path.join(root, 'node_modules/vite/bin/vite.js'),
            ['--host', '127.0.0.1', '--port', String(webPort)],
            path.join(root, 'apps/web'),
          ],
        ])
          children.push(
            spawn(process.execPath, [file, ...args], {
              cwd,
              env,
              windowsHide: true,
              stdio: 'ignore',
            }),
          );
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            if ((await fetch(origin + '/api/v1/health')).ok) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(ready);
        const denied = await fetch(
          origin + '/api/v1/calendar?from=2070-01-01T00:00:00Z&to=2070-01-02T00:00:00Z',
        );
        assert.equal(denied.status, 401);
        assert.equal((await denied.json()).code, 'UNAUTHENTICATED');
        browser = await chromium.launch({ channel: 'msedge', headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
          errors = [];
        page.setDefaultTimeout(15000);
        page.on('pageerror', (e) => errors.push(e.message));
        const openBooking = async () => {
          await page.getByRole('button', { name: /Бронь$/ }).click();
          await page.locator('.booking-create-drawer').waitFor();
        };
        const waitForBooking = async () => {
          await page.locator('.booking-drawer-heading').waitFor();
          await openHistory();
        };
        const openHistory = async () => {
          const history = page.getByRole('button', { name: /История$/ });
          if ((await history.getAttribute('aria-expanded')) === 'false') await history.click();
        };
        const waitForTotal = async (amount) => {
          await page.waitForFunction(
            (expected) =>
              document
                .querySelector('.booking-create-total strong')
                ?.textContent.replace(/\s/g, '') ===
              expected + '₽',
            amount,
          );
        };
        const setRentalStart = async (value) => {
          if (process.env.RENTAL_DATE_DIAGNOSTICS)
            await page.evaluate(() => {
              window.__rentalDateEvents = [];
              if (window.__rentalDateListener) return;
              window.__rentalDateListener = true;
              for (const type of ['input', 'keydown', 'keyup', 'focusin', 'focusout', 'click'])
                document.addEventListener(
                  type,
                  (event) => {
                    const input = document.querySelector('input[aria-label="Начало аренды"]');
                    if (!input) return;
                    window.__rentalDateEvents.push({
                      type,
                      key: event.key,
                      at: performance.now(),
                      value: input.value,
                      focused: document.activeElement === input,
                      target: event.target.getAttribute?.('class'),
                      selected: document
                        .querySelector('.ant-picker-cell-selected')
                        ?.getAttribute('title'),
                    });
                    if (window.__rentalDateEvents.length > 50) window.__rentalDateEvents.shift();
                  },
                  true,
                );
            });
          const [date, time] = value.split('T');
          await page.waitForFunction(() =>
            /\d/.test(document.querySelector('.booking-create-total strong')?.textContent ?? ''),
          );
          const input = page.getByLabel('Начало аренды', { exact: true });
          await input.click();
          const displayValue = date.split('-').reverse().join('.') + ', ' + time;
          const confirm = page.locator('.ant-picker-dropdown:visible .ant-picker-ok button');
          await confirm.click({ trial: true });
          await input.fill(displayValue);
          // Submit the typed value through rc-picker's input handler. Clicking
          // panel OK can confirm its previous calendar value before text commits.
          await input.press('Enter');
          await page.getByText('Автомобиль и аренда', { exact: true }).click();
          try {
            await page.waitForFunction(
              (expected) =>
                document.querySelector('input[aria-label="Начало аренды"]')?.value === expected,
              displayValue,
            );
          } finally {
            if (process.env.RENTAL_DATE_DIAGNOSTICS)
              console.log(
                'RENTAL_DATE',
                value,
                JSON.stringify(await page.evaluate(() => window.__rentalDateEvents)),
              );
          }
        };
        const setCalendarDate = async (date) => {
          await page.locator('.calendar-grid[aria-busy="false"]').waitFor();
          const input = page.getByLabel('Дата календаря', { exact: true });
          await input.click();
          await input.fill(date.split('-').reverse().join('.'));
          await input.press('Enter');
          await page.waitForURL((url) => url.searchParams.get('date') === date);
          await page.locator('.calendar-grid[aria-busy="false"]').waitFor();
        };

        await page.goto(origin + '/calendar?date=2026-12-01');
        await page.getByLabel('Логин', { exact: true }).fill('test');
        await page.getByLabel('Пароль', { exact: true }).fill(password);
        await page.getByRole('button', { name: 'Войти', exact: true }).click();
        await page.getByRole('heading', { name: 'График', exact: true }).waitFor();
        const brandGroup = page.getByRole('button', { name: 'Группа Тест Модель', exact: true });
        await brandGroup.waitFor();
        assert.equal(
          await page.getByRole('button', { name: 'Модель Тест Модель', exact: true }).count(),
          0,
        );
        await brandGroup.click();
        await page.waitForFunction(
          () => document.querySelectorAll('[data-vehicle-id]').length === 0,
        );
        await page.getByRole('button', { name: /Фильтры/ }).click();
        await page.getByText('По тарифу', { exact: true }).click();
        await page
          .getByRole('button', { name: 'Группа Nexia / Fabia / Logan', exact: true })
          .waitFor();
        await page.getByText('Марка и модель', { exact: true }).click();
        await page.getByRole('button', { name: /Фильтры/ }).click();
        await brandGroup.waitFor();
        assert.equal(await brandGroup.getAttribute('aria-expanded'), 'false');
        await brandGroup.click();
        await page.locator('[data-vehicle-id]').first().waitFor();
        const cell = page.locator('.calendar-cell').nth(15);
        await cell.hover({ position: { x: 10, y: 5 } });
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelectorAll('.calendar-cell')[15]).backgroundColor !==
            'rgba(0, 0, 0, 0)',
        );
        await cell.click({ button: 'right', position: { x: 10, y: 5 } });
        await page.getByRole('menuitem', { name: 'Забронировать', exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Сегодня', exact: true }).click();
        await page.waitForFunction(
          (expected) =>
            document.querySelector('input[aria-label="Дата календаря"]').value === expected,
          new Date(Date.now() + 10800000).toISOString().slice(0, 10).split('-').reverse().join('.'),
        );
        await setCalendarDate('2026-12-01');
        await page.waitForFunction(
          () =>
            document.querySelector('input[aria-label="Дата календаря"]').value === '01.12.2026' &&
            document.querySelector('.calendar-grid').getAttribute('aria-busy') === 'false',
        );
        await page.locator('.calendar-event').first().click();
        await waitForBooking();
        assert.equal(await page.locator('.ant-drawer-content').count(), 1);
        await page.locator('.ant-drawer-close').click();
        await page.getByRole('button', { name: /Проблемы/ }).click();
        await page.getByText('Проблемные бронирования', { exact: true }).waitFor();
        await page.locator('.ant-drawer-close').click();
        await page.locator('button.calendar-label').first().click();
        await page.getByRole('heading', { name: 'Техническая блокировка' }).waitFor();
        await page.locator('.ant-drawer-close').click();
        await openBooking();
        await page
          .getByRole('combobox', { name: 'Фамилия', exact: true })
          .fill('Черновик сохраняется');
        await page.waitForTimeout(5500);
        assert.equal(
          await page.getByRole('combobox', { name: 'Фамилия', exact: true }).inputValue(),
          'Черновик сохраняется',
        );
        await page.locator('.ant-drawer-close').click();
        await page.locator('.ant-drawer-content').waitFor({ state: 'hidden' });
        await page.screenshot({
          path: path.join(root, '.runtime/stage4-calendar.png'),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(500);
        await page.screenshot({
          path: path.join(root, '.runtime/stage4-mobile.png'),
          fullPage: true,
        });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          JSON.stringify(
            await page.evaluate(() =>
              Array.from(document.querySelectorAll('body *'))
                .filter((e) => {
                  const r = e.getBoundingClientRect();
                  return (
                    r.right > innerWidth &&
                    getComputedStyle(e).position !== 'absolute' &&
                    !e.closest('.calendar-grid')
                  );
                })
                .map((e) => ({
                  tag: e.tagName,
                  cls: e.className,
                  w: e.getBoundingClientRect().width,
                }))
                .slice(0, 15),
            ),
          ),
        );
        assert.deepEqual(errors, []);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openBooking();
        assert.equal(await page.getByText('Документы и адреса', { exact: true }).count(), 0);
        assert.equal(
          await page.getByRole('button', { name: 'Рассчитать условия', exact: true }).count(),
          0,
        );
        await page.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('Браузерная');
        await page.getByLabel('Имя', { exact: true }).fill('бронь');
        await page.getByRole('combobox', { name: 'Телефон', exact: true }).fill('+79990000001');
        await page.getByRole('combobox', { name: 'Марка и модель', exact: true }).click();
        await page.getByTitle('Тест', { exact: true }).click();
        assert.equal(
          await page.getByLabel('Согласованная тарифная группа', { exact: true }).count(),
          0,
        );
        await setRentalStart('2026-12-01T10:00');
        await waitForTotal('2000');
        await page
          .getByText('На выбранный период автомобилей не хватает', { exact: true })
          .waitFor();
        assert.equal(await page.getByLabel('Причина принятия риска', { exact: true }).count(), 0);
        assert.equal(await page.getByRole('checkbox').count(), 0);
        await page.route('**/api/v1/bookings', async (route) => {
          await db.pool.query('UPDATE vehicles SET version=version+1 WHERE id=$1', [vehicle]);
          await route.continue();
        });
        await page.getByRole('button', { name: 'Создать бронь', exact: true }).click();
        await page
          .getByText(
            'Доступность изменилась. Проверьте обновлённое предупреждение и сохраните бронь ещё раз. Введённые данные сохранены.',
            { exact: true },
          )
          .waitFor();
        await page.unroute('**/api/v1/bookings');
        assert.equal(
          await page.getByRole('combobox', { name: 'Фамилия', exact: true }).inputValue(),
          'Браузерная',
        );
        assert.equal(
          (
            await db.pool.query(
              "SELECT count(*)::int AS n FROM customers WHERE display_name='Браузерная бронь'",
            )
          ).rows[0].n,
          0,
        );
        await waitForTotal('2000');
        assert.equal(await page.getByText('Дефицит автомобилей', { exact: true }).count(), 0);
        await page.screenshot({
          path: path.join(root, '.runtime/stage4-risk.png'),
          fullPage: true,
        });
        await page.route('**/api/v1/bookings', async (route) => {
          await route.fetch();
          await route.abort('failed');
        });
        await page.getByRole('button', { name: 'Создать бронь', exact: true }).click();
        await page
          .getByText('Результат пока неизвестен. Исходная команда сохранена.', { exact: true })
          .waitFor();
        assert.equal(await page.locator('.ant-drawer-close').count(), 0);
        await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
        await waitForBooking();
        await page.unroute('**/api/v1/bookings');
        assert.equal(
          (
            await db.pool.query(
              "SELECT count(*)::int AS n FROM customers WHERE display_name='Браузерная бронь'",
            )
          ).rows[0].n,
          1,
        );
        await page
          .getByText('Сохранено с предупреждением: на выбранный период автомобилей не хватает.', {
            exact: true,
          })
          .waitFor();
        await page.locator('.ant-drawer-close').click();
        await page.locator('.ant-drawer-content').waitFor({ state: 'hidden' });
        const originalRows = await page.locator('button.calendar-label').count();
        let releaseWindow;
        const gate = new Promise((resolve) => {
          releaseWindow = resolve;
        });
        await page.route('**/api/v1/calendar?**', async (route) => {
          await gate;
          await route.continue();
        });
        await page.locator('.calendar-grid').evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
        });
        await page.locator('.calendar-loading').waitFor();
        assert.equal(await page.locator('.calendar-grid').getAttribute('aria-busy'), 'true');
        assert.equal(await page.locator('button.calendar-label').count(), originalRows);
        assert.ok(originalRows > 0);
        const windowLoaded = page.waitForResponse((r) => r.url().includes('/api/v1/calendar?'));
        releaseWindow();
        await windowLoaded;
        await page.unroute('**/api/v1/calendar?**', { behavior: 'wait' });
        await page.locator('.calendar-loading').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('.calendar-grid').getAttribute('aria-busy'), 'false');
        await openBooking();
        let searches = 0;
        page.on('request', (r) => {
          if (r.url().includes('/booking-customers?')) searches++;
        });
        const search = page.getByRole('combobox', { name: 'Фамилия', exact: true });
        await search.fill('Б');
        await page.waitForTimeout(450);
        assert.equal(searches, 0);
        await search.fill('Браузерная');
        await page
          .locator('.ant-select-item-option-content')
          .filter({ hasText: 'Браузерная бронь' })
          .click();
        await page.getByRole('button', { name: 'Очистить клиента', exact: true }).waitFor();
        assert.equal(
          await page.getByRole('combobox', { name: 'Телефон', exact: true }).inputValue(),
          '+79990000001',
        );
        assert.equal(await page.getByLabel('Имя', { exact: true }).inputValue(), 'бронь');
        const anotherCustomer = (
          await db.pool.query(
            "INSERT INTO customers(type,display_name,phone,email,details) VALUES ('individual','Петров Сергей','+79990000999','second@example.test',$1) RETURNING id",
            [JSON.stringify({ lastName: 'Петров', firstName: 'Сергей', middleName: 'Иванович' })],
          )
        ).rows[0];
        const beforeRepeat = searches;
        await search.fill('П');
        await page.waitForTimeout(450);
        assert.equal(searches, beforeRepeat);
        await search.fill('Пе');
        await page
          .locator('.ant-select-item-option-content')
          .filter({ hasText: 'Петров Сергей' })
          .click();
        await page.waitForFunction(
          () => document.querySelector('input[id$="phone"]')?.value === '+79990000999',
        );
        assert.equal(await page.getByLabel('Имя', { exact: true }).inputValue(), 'Сергей');
        assert.equal(await page.getByLabel('Отчество', { exact: true }).inputValue(), 'Иванович');
        assert.equal(
          await page.getByLabel('Email', { exact: true }).inputValue(),
          'second@example.test',
        );
        await search.fill('Браузерная');
        await page
          .locator('.ant-select-item-option-content')
          .filter({ hasText: 'Браузерная бронь' })
          .click();
        await page.waitForFunction(
          () => document.querySelector('input[id$="phone"]')?.value === '+79990000001',
        );
        assert.equal(await page.getByLabel('Отчество', { exact: true }).inputValue(), '');
        assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), '');
        await page.getByRole('button', { name: 'Очистить клиента', exact: true }).click();
        assert.equal(
          await page.getByRole('combobox', { name: 'Телефон', exact: true }).inputValue(),
          '',
        );
        assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), '');
        await search.fill('Браузерная');
        await page
          .locator('.ant-select-item-option-content')
          .filter({ hasText: 'Браузерная бронь' })
          .click();
        await page.waitForFunction(
          () => document.querySelector('input[id$="phone"]')?.value === '+79990000001',
        );
        await page.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('Изменённая');
        await page.getByRole('combobox', { name: 'Телефон', exact: true }).fill('+79990000005');
        const vehicleLabel =
          'Тест Модель · ' +
          (await db.pool.query('SELECT plate FROM vehicles WHERE id=$1', [vehicle])).rows[0].plate;
        await page.getByRole('combobox', { name: 'Марка и модель', exact: true }).click();
        await page.getByTitle('Тест', { exact: true }).click();
        await page.getByRole('combobox', { name: 'Автомобиль', exact: true }).click();
        await page
          .locator('.ant-select-dropdown:visible')
          .getByTitle(vehicleLabel, { exact: true })
          .last()
          .click();
        await setRentalStart('2026-12-10T10:00');
        await waitForTotal('2000');
        assert.equal(
          await page.locator('.ant-select-selection-item .booking-vehicle-model').innerText(),
          'Модель',
        );
        assert.equal(
          await page.locator('.ant-select-selection-item .booking-vehicle-plate').innerText(),
          '001 AA',
        );
        await page.getByRole('button', { name: 'Создать бронь', exact: true }).click();
        await waitForBooking();
        await page.getByRole('link', { name: vehicleLabel, exact: true }).waitFor();
        await openHistory();
        await page.getByText('Бронь создана', { exact: true }).waitFor();
        assert.equal(await page.getByText('bookings.created', { exact: true }).count(), 0);
        const alternate = (
          await db.pool.query(
            "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'А002АА178',2020,'sedan',100,10000) RETURNING id,plate",
            [model],
          )
        ).rows[0];
        await page.getByRole('button', { name: 'Изменить автомобиль', exact: true }).click();
        assert.equal(
          await page
            .locator('.ant-modal .ant-select-selection-item .booking-vehicle-model')
            .innerText(),
          'Модель',
        );
        assert.equal(
          await page
            .locator('.ant-modal .ant-select-selection-item .booking-vehicle-plate')
            .innerText(),
          '001 AA',
        );
        await page
          .getByRole('combobox', { name: 'Назначаемый автомобиль', exact: true })
          .first()
          .press('ArrowDown');
        await page
          .locator('.ant-select-dropdown:visible')
          .getByTitle('Тест Модель · ' + alternate.plate, { exact: true })
          .last()
          .click();

        assert.equal(
          await page
            .getByRole('button', { name: 'Подтвердить изменения', exact: true })
            .isEnabled(),
          true,
        );
        await page.getByRole('button', { name: 'Подтвердить изменения', exact: true }).click();
        await page
          .getByRole('link', { name: 'Тест Модель · ' + alternate.plate, exact: true })
          .waitFor();
        await openHistory();
        await page.getByText('bookings.moved', { exact: true }).waitFor();
        assert.equal(
          (
            await db.pool.query(
              "SELECT count(*)::int AS n FROM customers WHERE display_name='Изменённая бронь' AND phone='+79990000005'",
            )
          ).rows[0].n,
          1,
        );
        assert.equal(
          (
            await db.pool.query('SELECT display_name FROM customers WHERE id=$1', [
              anotherCustomer.id,
            ])
          ).rows[0].display_name,
          'Петров Сергей',
        );
        await page.screenshot({
          path: path.join(root, '.runtime/booking-compact-saved.png'),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
        await page.locator('.ant-drawer-close').click();
        await page.locator('.ant-drawer-content').waitFor({ state: 'hidden' });
        const company = (
          await db.pool.query(
            "INSERT INTO customers(type,display_name,phone,inn,details) VALUES ('company','ООО Проверка','+79990000006','1234567890',$1) RETURNING id",
            [JSON.stringify({ bank: 'Тестовый банк', legalAddress: 'Тестовый адрес' })],
          )
        ).rows[0];
        await openBooking();
        await page.getByText('Организация', { exact: true }).click();
        await page
          .getByRole('combobox', { name: 'Название организации', exact: true })
          .fill('ООО Провер');
        await page
          .locator('.ant-select-item-option-content')
          .filter({ hasText: 'ООО Проверка' })
          .click();
        await page.getByRole('button', { name: 'Очистить клиента', exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole('combobox', { name: 'Название организации', exact: true })
            .inputValue(),
          'ООО Проверка',
        );
        await page.waitForFunction(
          () => document.querySelector('input[id$="_bank"]')?.value === 'Тестовый банк',
        );
        assert.equal(await page.getByLabel('Банк', { exact: true }).inputValue(), 'Тестовый банк');
        await page
          .getByRole('combobox', { name: 'Название организации', exact: true })
          .fill('ООО Обновлено');
        await page.getByRole('combobox', { name: 'Телефон', exact: true }).fill('+79990000007');
        await page.getByText('Другие варианты бронирования', { exact: true }).click();
        await page
          .getByRole('combobox', { name: 'Модель или группа аналогов', exact: true })
          .click();
        await page.getByTitle('Тест Модель · Модель', { exact: true }).click();
        await setRentalStart('2027-02-01T10:00');
        await waitForTotal('2000');
        await page.getByText('Лояльность и скидки', { exact: true }).click();
        await page.getByText('%', { exact: true }).click();
        await page.getByLabel('Размер скидки, %', { exact: true }).fill('101');
        await page
          .getByText('От 0 до 100, максимум два знака после запятой', { exact: true })
          .waitFor();
        await page.getByLabel('Размер скидки, %', { exact: true }).fill('12.50');
        await page.getByLabel('Причина условий лояльности', { exact: true }).fill('Скидка');
        await waitForTotal('1750');
        await page.getByText('₽', { exact: true }).click();
        assert.equal(await page.getByLabel('Размер скидки, ₽', { exact: true }).inputValue(), '');
        await page.getByLabel('Размер скидки, ₽', { exact: true }).fill('250');
        await waitForTotal('1750');
        await page.getByLabel('Размер скидки, ₽', { exact: true }).fill('');
        await page.getByLabel('Собственная цена за сутки, ₽', { exact: true }).fill('0');
        await page
          .getByLabel('Причина условий лояльности', { exact: true })
          .fill('Согласованная бесплатная аренда');
        await waitForTotal('0');
        assert.equal(
          await page.getByRole('button', { name: 'Создать бронь', exact: true }).isDisabled(),
          true,
        );
        await page
          .getByRole('checkbox', { name: 'Подтверждаю ручные условия', exact: true })
          .check();
        await page.screenshot({
          path: path.join(root, '.runtime/booking-loyalty-company.png'),
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Создать бронь', exact: true }).click();
        await page.getByRole('button', { name: 'Нет, сохранить без счёта', exact: true }).click();
        await waitForBooking();
        const companyAfter = (
          await db.pool.query('SELECT * FROM customers WHERE id=$1', [company.id])
        ).rows[0];
        assert.equal(companyAfter.display_name, 'ООО Обновлено');
        assert.equal(companyAfter.phone, '+79990000007');
        assert.equal(companyAfter.details.bank, 'Тестовый банк');
        assert.deepEqual(errors, []);
        await page.locator('.ant-drawer-close').click();
        await page.locator('.ant-drawer-content').waitFor({ state: 'hidden' });
        await setCalendarDate('2026-12-10');
        await openBooking();
        await page.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('Ожидающая');
        await page.getByLabel('Имя', { exact: true }).fill('Замены');
        await page.getByRole('combobox', { name: 'Телефон', exact: true }).fill('+79990000008');
        await page.getByRole('combobox', { name: 'Марка и модель', exact: true }).click();
        await page.getByTitle('Тест', { exact: true }).click();
        await page.getByRole('combobox', { name: 'Автомобиль', exact: true }).click();
        await page
          .locator('.ant-select-dropdown:visible')
          .getByTitle('Тест Модель · ' + alternate.plate, { exact: true })
          .last()
          .click();
        await setRentalStart('2026-12-10T10:00');
        await page.getByText('Автомобиль занят на выбранный период', { exact: true }).waitFor();
        assert.equal(
          await page.getByRole('button', { name: 'Создать бронь', exact: true }).isDisabled(),
          true,
        );
        await page.getByText(/Пересечение:/).waitFor();
        await page.getByRole('button', { name: 'Сохранить без автомобиля', exact: true }).click();
        await page.getByLabel('Комментарий (необязательно)', { exact: true }).waitFor();
        await page.getByText('Другие варианты бронирования', { exact: true }).click();
        await page.getByRole('combobox', { name: 'Автомобиль', exact: true }).click();
        await page
          .locator('.ant-select-dropdown:visible')
          .getByTitle('Тест Модель · ' + alternate.plate, { exact: true })
          .last()
          .click();
        await page.getByText('Автомобиль занят на выбранный период', { exact: true }).waitFor();
        assert.equal(
          await page.getByLabel('Комментарий (необязательно)', { exact: true }).count(),
          0,
        );
        await page.getByRole('button', { name: 'Сохранить без автомобиля', exact: true }).click();
        await waitForTotal('2000');
        assert.equal(
          await page.getByLabel('Комментарий (необязательно)', { exact: true }).inputValue(),
          '',
        );
        await page.getByRole('button', { name: 'Создать бронь', exact: true }).click();
        await waitForBooking();
        const waiting = (
          await db.pool.query(
            "SELECT b.id,b.version FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE c.display_name='Ожидающая Замены' ORDER BY b.id DESC LIMIT 1",
          )
        ).rows[0];
        await page.locator('.ant-drawer-close').click();
        await page.locator('.ant-drawer-content').waitFor({ state: 'hidden' });
        await page
          .locator('[data-vehicle-id="' + alternate.id + '"] button.calendar-label')
          .click();
        await page.getByRole('heading', { name: 'Техническая блокировка', exact: true }).waitFor();
        await page.getByLabel('Начало (Москва)', { exact: true }).fill('2026-12-10T12:00');
        await page.getByLabel('Окончание (Москва)', { exact: true }).fill('2026-12-11T08:00');
        await page.getByLabel('Причина блокировки', { exact: true }).fill('Покраска автомобиля');
        await page.getByText('Будут сняты назначения: 1', { exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole('button', { name: 'Создать блокировку и снять назначения', exact: true })
            .isDisabled(),
          true,
        );
        await page
          .getByRole('checkbox', {
            name: 'Подтверждаю снятие назначений со всех указанных броней',
            exact: true,
          })
          .check();
        await page
          .getByRole('button', { name: 'Создать блокировку и снять назначения', exact: true })
          .click();
        await page
          .locator('[data-vehicle-id="' + alternate.id + '"] .calendar-event.booking')
          .filter({ hasText: 'Изменённая бронь' })
          .waitFor();
        await page.locator('.ant-drawer-close').click();
        await page.locator('.ant-drawer-content').waitFor({ state: 'hidden' });
        const ghost = page
            .locator('[data-vehicle-id="' + alternate.id + '"] .calendar-event.booking')
            .filter({ hasText: 'Изменённая бронь' }),
          technical = page.locator(
            '[data-vehicle-id="' + alternate.id + '"] .calendar-event.technical',
          );
        const gr = await ghost.boundingBox(),
          tr = await technical.boundingBox();
        assert.ok(gr.y > tr.y);
        assert.equal(await ghost.locator('.calendar-booking-name').innerText(), 'Изменённая бронь');
        const vehicleConflicts = page
            .locator('[data-vehicle-id="' + alternate.id + '"]')
            .getByRole('button', { name: 'Разобрать конфликт', exact: true }),
          unassignedConflicts = page
            .locator('.calendar-unassigned-row')
            .getByRole('button', { name: 'Разобрать конфликт неназначенной брони', exact: true });
        assert.ok((await vehicleConflicts.count()) > 0);
        assert.ok((await page.locator('[data-unassigned-booking]').count()) > 0);
        assert.ok((await unassignedConflicts.count()) > 0);
        assert.equal(await page.locator('.calendar-conflict-zone').count(), 0);
        assert.equal(
          await page
            .getByRole('heading', { name: 'Без назначенного автомобиля', exact: true })
            .count(),
          0,
        );
        const defaultEvent = await page
          .locator('.calendar-event.unassigned')
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor);
        assert.equal(
          await ghost.evaluate((el) => getComputedStyle(el).backgroundColor),
          defaultEvent,
        );
        await ghost.hover();
        await page
          .getByRole('tooltip')
          .filter({
            hasText: 'Требуется замена: Покраска автомобиля',
          })
          .waitFor();
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: path.join(root, '.runtime/stage4-conflict-lanes.png'),
          fullPage: true,
        });
        const otherBlock = await controller.technical(
          {
            vehicleId: vehicle,
            startAt: '2026-12-10T12:00:00+03:00',
            endAt: '2026-12-11T08:00:00+03:00',
            reason: 'Вторая машина на ТО',
          },
          request(),
        );
        await page.waitForResponse((r) => r.url().includes('/api/v1/calendar?') && r.ok());
        await page.getByRole('button', { name: /Проблемы/ }).click();
        await page
          .getByRole('button', { name: 'Подобрать автомобиль', exact: true })
          .first()
          .waitFor();
        await page.getByText(/Автомобиль снят с назначения из-за технической блокировки/).waitFor();
        await page.waitForFunction(
          () =>
            Math.abs(
              document.querySelector('.ant-drawer-content-wrapper').getBoundingClientRect().right -
                innerWidth,
            ) < 1,
        );
        await page.screenshot({
          path: path.join(root, '.runtime/stage4-problems.png'),
          fullPage: true,
        });
        await page
          .locator('.calendar-problem-card')
          .filter({ hasText: 'Автомобиль снят с назначения из-за технической блокировки' })
          .getByRole('button', { name: 'Подобрать автомобиль', exact: true })
          .click();
        await page
          .getByRole('combobox', { name: 'Назначаемый автомобиль', exact: true })
          .press('ArrowDown');
        await page
          .locator('.ant-select-dropdown:visible .ant-select-item-option')
          .first()
          .waitFor();
        const unavailableOptions = await selectOptionsSnapshot(page);
        assert.ok(unavailableOptions.count > 0);
        assert.equal(unavailableOptions.enabledCount, 0);
        await page.keyboard.press('Escape');
        await page.locator('.ant-modal-close').click();
        await page.locator('.ant-drawer-close').click();
        await page.locator('.ant-drawer-content').waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: /Проблемы/ }).click();
        await page.getByRole('button', { name: 'Изменить условия', exact: true }).first().click();
        await page.getByLabel('Количество дней', { exact: true }).waitFor();
        await page.locator('.ant-drawer-close').click();
        await page.locator('.ant-drawer-content').waitFor({ state: 'hidden' });
        await controller.cancelTechnical(
          String(otherBlock.id),
          { expectedVersion: 1, reason: 'ТО завершено' },
          request(),
        );
        await controller.cancel(
          String(waiting.id),
          { expectedVersion: waiting.version, reason: 'Отмена ожидания' },
          request(),
        );
        await page
          .locator('[data-unassigned-booking="' + waiting.id + '"]')
          .waitFor({ state: 'hidden' });
        await ghost.press('Enter');
        await page.getByRole('button', { name: 'Назначить автомобиль', exact: true }).click();
        await page
          .getByRole('combobox', { name: 'Назначаемый автомобиль', exact: true })
          .first()
          .press('ArrowDown');
        await page
          .locator('.ant-select-dropdown:visible')
          .getByTitle(vehicleLabel, { exact: true })
          .last()
          .click();

        const moveResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.endsWith('/move') &&
            response.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Подтвердить изменения', exact: true }).click();
        const moved = await moveResponse;
        assert.ok(moved.ok());
        const movedBooking = await moved.json();
        await page.getByRole('link', { name: vehicleLabel, exact: true }).waitFor();
        await ghost.waitFor({ state: 'hidden' });
        assert.deepEqual(errors, []);

        const session = await page.request.get(origin + '/api/v1/auth/me');
        assert.ok(session.ok());
        const { csrfToken } = await session.json();
        const technicalEndpoint = origin + '/api/v1/schedule-blocks';
        const technicalHeaders = (key) => ({
          origin,
          'x-csrf-token': csrfToken,
          'idempotency-key': key,
        });
        const technicalBody = {
          vehicleId: moved.request().postDataJSON().vehicleId,
          startAt: '2085-01-01T00:00:00Z',
          endAt: '2085-01-02T00:00:00Z',
          reason: '  HTTP repair  ',
        };
        const technicalKey = randomUUID();
        const createdTechnicalResponse = await page.request.post(technicalEndpoint, {
          data: technicalBody,
          headers: technicalHeaders(technicalKey),
        });
        assert.equal(createdTechnicalResponse.status(), 201);
        const createdTechnical = await createdTechnicalResponse.json();
        assert.equal(createdTechnical.reason, 'HTTP repair');
        const savedTechnical = (
          await db.pool.query('SELECT * FROM schedule_blocks WHERE id=$1', [createdTechnical.id])
        ).rows[0];
        assert.deepEqual(createdTechnical, JSON.parse(JSON.stringify(savedTechnical)));
        const retryTechnical = await page.request.post(technicalEndpoint, {
          data: technicalBody,
          headers: technicalHeaders(technicalKey),
        });
        assert.equal(retryTechnical.status(), 201);
        assert.deepEqual(await retryTechnical.json(), createdTechnical);
        const invalidTechnical = await page.request.post(technicalEndpoint, {
          data: { ...technicalBody, reason: '' },
          headers: technicalHeaders(randomUUID()),
        });
        assert.equal(invalidTechnical.status(), 400);
        assert.equal((await invalidTechnical.json()).code, 'VALIDATION_ERROR');
        const updateTechnicalBody = {
          ...technicalBody,
          endAt: '2085-01-03T00:00:00Z',
          expectedVersion: createdTechnical.version,
        };
        const updateTechnicalKey = randomUUID();
        const patchTechnical = (data, key) =>
          page.request.patch(technicalEndpoint + '/' + createdTechnical.id, {
            data,
            headers: technicalHeaders(key),
          });
        const updatedTechnicalResponse = await patchTechnical(
          updateTechnicalBody,
          updateTechnicalKey,
        );
        assert.equal(updatedTechnicalResponse.status(), 200);
        const updatedTechnical = await updatedTechnicalResponse.json();
        assert.equal(updatedTechnical.version, createdTechnical.version + 1);
        const updatedTechnicalRow = (
          await db.pool.query('SELECT * FROM schedule_blocks WHERE id=$1', [createdTechnical.id])
        ).rows[0];
        assert.deepEqual(updatedTechnical, JSON.parse(JSON.stringify(updatedTechnicalRow)));
        const updateTechnicalRetry = await patchTechnical(updateTechnicalBody, updateTechnicalKey);
        assert.equal(updateTechnicalRetry.status(), 200);
        assert.deepEqual(await updateTechnicalRetry.json(), updatedTechnical);
        const staleTechnical = await patchTechnical(updateTechnicalBody, randomUUID());
        assert.equal(staleTechnical.status(), 409);
        const staleTechnicalError = await staleTechnical.json();
        assert.equal(staleTechnicalError.code, 'VERSION_CONFLICT');
        assert.equal(staleTechnicalError.message, 'Блокировка изменилась. Перечитайте данные.');
        const reusedTechnical = await patchTechnical(
          { ...updateTechnicalBody, reason: 'Other' },
          updateTechnicalKey,
        );
        assert.equal(reusedTechnical.status(), 409);
        assert.equal((await reusedTechnical.json()).code, 'IDEMPOTENCY_KEY_REUSED');
        const technicalCancelBody = {
          expectedVersion: updatedTechnical.version,
          reason: '  HTTP cancellation  ',
        };
        const technicalCancelKey = randomUUID();
        const postTechnicalCancel = (data, key = randomUUID()) =>
          page.request.post(technicalEndpoint + '/' + updatedTechnical.id + '/cancel', {
            data,
            headers: technicalHeaders(key),
          });
        const invalidTechnicalCancel = await postTechnicalCancel({
          expectedVersion: updatedTechnical.version,
        });
        assert.equal(invalidTechnicalCancel.status(), 400);
        const invalidTechnicalCancelError = await invalidTechnicalCancel.json();
        assert.equal(invalidTechnicalCancelError.code, 'VALIDATION_ERROR');
        assert.ok(
          invalidTechnicalCancelError.details.fields.some((field) => field.field === 'reason'),
        );
        const cancelledTechnicalResponse = await postTechnicalCancel(
          technicalCancelBody,
          technicalCancelKey,
        );
        assert.equal(cancelledTechnicalResponse.status(), 201);
        const cancelledTechnical = await cancelledTechnicalResponse.json();
        assert.equal(cancelledTechnical.version, updatedTechnical.version + 1);
        assert.ok(cancelledTechnical.retired_at);
        assert.equal(cancelledTechnical.reason, updatedTechnical.reason);
        const cancelledTechnicalRow = (
          await db.pool.query('SELECT * FROM schedule_blocks WHERE id=$1', [updatedTechnical.id])
        ).rows[0];
        assert.deepEqual(cancelledTechnical, JSON.parse(JSON.stringify(cancelledTechnicalRow)));
        const repeatedTechnicalCancel = await postTechnicalCancel(
          technicalCancelBody,
          technicalCancelKey,
        );
        assert.equal(repeatedTechnicalCancel.status(), 201);
        assert.deepEqual(await repeatedTechnicalCancel.json(), cancelledTechnical);
        const staleTechnicalCancel = await postTechnicalCancel(technicalCancelBody);
        assert.equal(staleTechnicalCancel.status(), 409);
        const staleTechnicalCancelError = await staleTechnicalCancel.json();
        assert.equal(staleTechnicalCancelError.code, 'VERSION_CONFLICT');
        assert.equal(staleTechnicalCancelError.message, 'Блокировка изменилась. Обновите данные.');
        const reusedTechnicalCancel = await postTechnicalCancel(
          { ...technicalCancelBody, reason: 'Other' },
          technicalCancelKey,
        );
        assert.equal(reusedTechnicalCancel.status(), 409);
        assert.equal((await reusedTechnicalCancel.json()).code, 'IDEMPOTENCY_KEY_REUSED');
        const technicalPreviewEndpoint = origin + '/api/v1/schedule-blocks/preview';
        const technicalPreviewBody = {
          vehicleId: vehicle,
          startAt: '2091-01-01T00:00:00Z',
          endAt: '2091-01-03T00:00:00Z',
        };
        const postTechnicalPreview = (data) =>
          page.request.post(technicalPreviewEndpoint, {
            data,
            headers: { origin, 'x-csrf-token': csrfToken },
          });
        const technicalPreviewResponse = await postTechnicalPreview(technicalPreviewBody);
        assert.equal(technicalPreviewResponse.status(), 201);
        const technicalPreviewResult = await technicalPreviewResponse.json();
        assert.deepEqual(technicalPreviewResult.conflicts, []);
        assert.match(technicalPreviewResult.token, /^[a-f0-9]{64}$/);
        const repeatedTechnicalPreview = await postTechnicalPreview(technicalPreviewBody);
        assert.equal(repeatedTechnicalPreview.status(), 201);
        assert.deepEqual(await repeatedTechnicalPreview.json(), technicalPreviewResult);
        const invalidTechnicalPreview = await postTechnicalPreview({
          ...technicalPreviewBody,
          startAt: 'invalid',
        });
        assert.equal(invalidTechnicalPreview.status(), 400);
        assert.equal((await invalidTechnicalPreview.json()).code, 'VALIDATION_ERROR');
        const missingTechnicalPreview = await postTechnicalPreview({
          ...technicalPreviewBody,
          vehicleId: 2147483647,
        });
        assert.equal(missingTechnicalPreview.status(), 404);
        const missingTechnicalPreviewError = await missingTechnicalPreview.json();
        assert.equal(missingTechnicalPreviewError.code, 'NOT_FOUND');
        assert.equal(missingTechnicalPreviewError.message, 'Автомобиль не найден.');
        const csrfTechnicalPreview = await page.request.post(technicalPreviewEndpoint, {
          data: technicalPreviewBody,
          headers: { origin, 'x-csrf-token': 'invalid' },
        });
        assert.equal(csrfTechnicalPreview.status(), 403);
        assert.equal((await csrfTechnicalPreview.json()).code, 'CSRF_REJECTED');
        const anonymousTechnicalPreview = await fetch(technicalPreviewEndpoint, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(technicalPreviewBody),
        });
        assert.equal(anonymousTechnicalPreview.status, 401);
        assert.equal((await anonymousTechnicalPreview.json()).code, 'UNAUTHENTICATED');
        const detailEndpoint = origin + '/api/v1/bookings/';
        const bookingDetailResponse = await page.request.get(detailEndpoint + movedBooking.id);
        assert.equal(bookingDetailResponse.status(), 200);
        const bookingDetail = await bookingDetailResponse.json();
        assert.equal(bookingDetail.id, movedBooking.id);
        assert.equal(typeof bookingDetail.customer_name, 'string');
        assert.ok(bookingDetail.terms.length > 0);
        assert.equal(typeof bookingDetail.terms[0].snapshot.finalTotalRub, 'string');
        assert.ok(Array.isArray(bookingDetail.risks));
        assert.ok(Array.isArray(bookingDetail.vehicleOptions));
        assert.match(bookingDetail.availability.token, /^[a-f0-9]{64}$/);
        assert.equal(Object.hasOwn(bookingDetail, 'financialSummary'), false);
        const invalidDetail = await page.request.get(detailEndpoint + 'invalid');
        assert.equal(invalidDetail.status(), 400);
        assert.equal((await invalidDetail.json()).code, 'VALIDATION_ERROR');
        const missingDetail = await page.request.get(detailEndpoint + '2147483647');
        assert.equal(missingDetail.status(), 404);
        const missingDetailError = await missingDetail.json();
        assert.equal(missingDetailError.code, 'NOT_FOUND');
        assert.equal(missingDetailError.message, 'Бронь не найдена.');
        const anonymousDetail = await fetch(detailEndpoint + movedBooking.id);
        assert.equal(anonymousDetail.status, 401);
        assert.equal((await anonymousDetail.json()).code, 'UNAUTHENTICATED');
        const evaluateEndpoint = origin + '/api/v1/availability/evaluate';
        const evaluateBody = {
          target: { type: 'vehicle', id: vehicle },
          startAt: '2090-01-01T00:00:00Z',
          endAt: '2090-01-03T00:00:00Z',
        };
        const postEvaluation = (data) =>
          page.request.post(evaluateEndpoint, {
            data,
            headers: { origin, 'x-csrf-token': csrfToken },
          });
        const evaluationResponse = await postEvaluation(evaluateBody);
        assert.equal(evaluationResponse.status(), 201);
        const evaluationResult = await evaluationResponse.json();
        assert.equal(evaluationResult.status, 'feasible');
        assert.equal(evaluationResult.availability.status, 'feasible');
        assert.equal(evaluationResult.vehicle.id, vehicle);
        assert.equal(evaluationResult.token, evaluationResult.availability.token);
        assert.match(evaluationResult.token, /^[a-f0-9]{64}$/);
        const repeatedEvaluation = await postEvaluation(evaluateBody);
        assert.equal(repeatedEvaluation.status(), 201);
        assert.equal((await repeatedEvaluation.json()).token, evaluationResult.token);
        const invalidEvaluation = await postEvaluation({ ...evaluateBody, startAt: 'invalid' });
        assert.equal(invalidEvaluation.status(), 400);
        const invalidEvaluationError = await invalidEvaluation.json();
        assert.equal(invalidEvaluationError.code, 'VALIDATION_ERROR');
        assert.ok(invalidEvaluationError.details.fields.some((field) => field.field === 'startAt'));
        const missingEvaluation = await postEvaluation({ ...evaluateBody, bookingId: 2147483647 });
        assert.equal(missingEvaluation.status(), 404);
        const missingEvaluationError = await missingEvaluation.json();
        assert.equal(missingEvaluationError.code, 'NOT_FOUND');
        assert.equal(missingEvaluationError.message, 'Бронь не найдена.');
        const emptyEvaluation = await postEvaluation({
          ...evaluateBody,
          target: { type: 'vehicle', id: 2147483647 },
        });
        assert.equal(emptyEvaluation.status(), 422);
        assert.equal((await emptyEvaluation.json()).code, 'EMPTY_TARGET');
        const csrfEvaluation = await page.request.post(evaluateEndpoint, {
          data: evaluateBody,
          headers: { origin, 'x-csrf-token': 'invalid' },
        });
        assert.equal(csrfEvaluation.status(), 403);
        assert.equal((await csrfEvaluation.json()).code, 'CSRF_REJECTED');
        const anonymousEvaluation = await fetch(evaluateEndpoint, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(evaluateBody),
        });
        assert.equal(anonymousEvaluation.status, 401);
        assert.equal((await anonymousEvaluation.json()).code, 'UNAUTHENTICATED');
        const bookingPreviewEndpoint = origin + '/api/v1/bookings/preview';
        const bookingPreviewBody = {
          target: { type: 'vehicle', id: vehicle },
          pricing: {
            startAt: '2090-01-01T00:00:00Z',
            contractDays: 2,
            dailyMileagePackageKm: 250,
          },
        };
        const postBookingPreview = (data) =>
          page.request.post(bookingPreviewEndpoint, {
            data,
            headers: { origin, 'x-csrf-token': csrfToken },
          });
        const bookingPreviewResponse = await postBookingPreview(bookingPreviewBody);
        assert.equal(bookingPreviewResponse.status(), 201);
        const bookingPreview = await bookingPreviewResponse.json();
        assert.equal(bookingPreview.calculation.finalTotalRub, '3400');
        assert.equal(bookingPreview.availability.status, 'feasible');
        assert.match(bookingPreview.previewToken, /^[a-f0-9]{64}$/);
        assert.match(bookingPreview.availability.token, /^[a-f0-9]{64}$/);
        const invalidBookingPreview = await postBookingPreview({
          ...bookingPreviewBody,
          pricing: { ...bookingPreviewBody.pricing, startAt: 'invalid' },
        });
        assert.equal(invalidBookingPreview.status(), 400);
        const invalidBookingPreviewError = await invalidBookingPreview.json();
        assert.equal(invalidBookingPreviewError.code, 'VALIDATION_ERROR');
        assert.ok(
          invalidBookingPreviewError.details.fields.some(
            (field) => field.field === 'pricing.startAt',
          ),
        );
        const missingBookingPreview = await postBookingPreview({
          ...bookingPreviewBody,
          bookingId: 2147483647,
        });
        assert.equal(missingBookingPreview.status(), 404);
        assert.equal((await missingBookingPreview.json()).code, 'NOT_FOUND');
        const missingVehiclePreview = await postBookingPreview({
          ...bookingPreviewBody,
          target: { type: 'vehicle', id: 2147483647 },
        });
        assert.equal(missingVehiclePreview.status(), 422);
        assert.equal((await missingVehiclePreview.json()).code, 'EMPTY_TARGET');
        const csrfBookingPreview = await page.request.post(bookingPreviewEndpoint, {
          data: bookingPreviewBody,
          headers: { origin, 'x-csrf-token': 'invalid' },
        });
        assert.equal(csrfBookingPreview.status(), 403);
        assert.equal((await csrfBookingPreview.json()).code, 'CSRF_REJECTED');
        const anonymousBookingPreview = await fetch(bookingPreviewEndpoint, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(bookingPreviewBody),
        });
        assert.equal(anonymousBookingPreview.status, 401);
        assert.equal((await anonymousBookingPreview.json()).code, 'UNAUTHENTICATED');
        const moveEndpoint = origin + '/api/v1/bookings/' + movedBooking.id + '/move';
        const moveBody = moved.request().postDataJSON();
        const postMove = (suffix, data, key = randomUUID()) =>
          page.request.post(moveEndpoint + suffix, {
            data,
            headers: { origin, 'x-csrf-token': csrfToken, 'idempotency-key': key },
          });
        assert.equal(moved.status(), 201);
        const savedMove = (
          await db.pool.query('SELECT * FROM bookings WHERE id=$1', [movedBooking.id])
        ).rows[0];
        assert.deepEqual(movedBooking, JSON.parse(JSON.stringify(savedMove)));
        const moveRetry = await postMove(
          '',
          moveBody,
          moved.request().headers()['idempotency-key'],
        );
        assert.equal(moveRetry.status(), 201);
        assert.deepEqual(await moveRetry.json(), movedBooking);
        const staleMove = await postMove('', moveBody);
        assert.equal(staleMove.status(), 409);
        const staleMoveError = await staleMove.json();
        assert.equal(staleMoveError.code, 'BOOKING_VERSION_CONFLICT');
        assert.equal(staleMoveError.message, 'Бронь изменилась. Проверьте перенос снова.');
        const invalidMove = await postMove('', { ...moveBody, availabilityToken: 'invalid' });
        assert.equal(invalidMove.status(), 400);
        assert.equal((await invalidMove.json()).code, 'VALIDATION_ERROR');
        const staleAssessment = await postMove('', {
          ...moveBody,
          expectedVersion: movedBooking.version,
          availabilityToken: '0'.repeat(64),
        });
        assert.equal(staleAssessment.status(), 409);
        assert.equal((await staleAssessment.json()).code, 'MOVE_PREVIEW_STALE');
        const previewMoveResponse = await postMove('/preview', {
          startAt: moveBody.startAt,
          vehicleId: moveBody.vehicleId,
        });
        assert.equal(previewMoveResponse.status(), 201);
        const movePreview = await previewMoveResponse.json();
        assert.equal(movePreview.expectedVersion, movedBooking.version);
        assert.equal(movePreview.bookingId, movedBooking.id);
        assert.equal(movePreview.oldStartAt, movedBooking.start_at);
        assert.match(movePreview.availability.token, /^[a-f0-9]{64}$/);
        const submitted = {
          expectedVersion: movedBooking.version,
          vehicleId: moved.request().postDataJSON().vehicleId,
        };
        const endpoint = origin + '/api/v1/bookings/' + movedBooking.id + '/assign-vehicle';
        const postAssignment = (data, key = randomUUID()) =>
          page.request.post(endpoint, {
            data,
            headers: { origin, 'x-csrf-token': csrfToken, 'idempotency-key': key },
          });
        const key = randomUUID();
        const assigned = await postAssignment(submitted, key);
        assert.equal(assigned.status(), 201);
        const assignment = await assigned.json();
        assert.equal(assignment.id, movedBooking.id);
        assert.equal(assignment.version, submitted.expectedVersion + 1);
        assert.equal(assignment.status, 'confirmed');
        const retry = await postAssignment(submitted, key);
        assert.equal(retry.status(), 201);
        assert.deepEqual(await retry.json(), assignment);
        const stale = await postAssignment(submitted);
        assert.equal(stale.status(), 409);
        assert.equal((await stale.json()).code, 'BOOKING_VERSION_CONFLICT');
        const invalid = await postAssignment({ ...submitted, vehicleId: '1' });
        assert.equal(invalid.status(), 400);
        assert.equal((await invalid.json()).code, 'VALIDATION_ERROR');
        const cancelEndpoint = origin + '/api/v1/bookings/' + assignment.id + '/cancel';
        const postCancel = (data, key = randomUUID()) =>
          page.request.post(cancelEndpoint, {
            data,
            headers: { origin, 'x-csrf-token': csrfToken, 'idempotency-key': key },
          });
        const cancelInput = { expectedVersion: assignment.version, reason: '  Отмена HTTP  ' };
        const invalidCancel = await postCancel({ expectedVersion: assignment.version });
        assert.equal(invalidCancel.status(), 400);
        const validation = await invalidCancel.json();
        assert.equal(validation.code, 'VALIDATION_ERROR');
        assert.ok(validation.details.fields.some((field) => field.field === 'reason'));
        const cancelKey = randomUUID();
        const cancelledResponse = await postCancel(cancelInput, cancelKey);
        assert.equal(cancelledResponse.status(), 201);
        const cancelled = await cancelledResponse.json();
        const saved = (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [assignment.id]))
          .rows[0];
        assert.deepEqual(cancelled, JSON.parse(JSON.stringify(saved)));
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.version, assignment.version + 1);
        const repeatedCancel = await postCancel(cancelInput, cancelKey);
        assert.equal(repeatedCancel.status(), 201);
        assert.deepEqual(await repeatedCancel.json(), cancelled);
        const staleCancel = await postCancel(cancelInput);
        assert.equal(staleCancel.status(), 409);
        const conflict = await staleCancel.json();
        assert.equal(conflict.code, 'BOOKING_VERSION_CONFLICT');
        assert.equal(conflict.message, 'Бронь изменилась или уже отменена.');
        const reusedCancel = await postCancel({ ...cancelInput, reason: 'Другая' }, cancelKey);
        assert.equal(reusedCancel.status(), 409);
        assert.equal((await reusedCancel.json()).code, 'IDEMPOTENCY_KEY_REUSED');
      } finally {
        if (browser) {
          const last = browser.contexts()[0]?.pages()[0];
          if (last)
            await last
              .screenshot({ path: path.join(root, '.runtime/stage4-last.png'), fullPage: true })
              .catch(() => {});
          await browser.close();
        }
        for (const child of children)
          if (child.exitCode === null) {
            child.kill();
            await new Promise((resolve) => {
              child.once('exit', resolve);
              setTimeout(resolve, 3000);
            });
          }
      }
    },
  );
  await t.test(
    'unassigned risk, immutable eligible models, blocked customer and outbox rollback',
    async () => {
      const wide = { ...body, target: { type: 'brand', id: brand } };
      let risk;
      try {
        await controller.create(wide, request());
      } catch (e) {
        risk = e.getResponse().details;
      }
      assert.equal(risk.status, 'deficit');
      const checked = await controller.evaluate({
        target: wide.target,
        startAt: quote.calculation.startAt,
        endAt: quote.calculation.agreedReturnAt,
        vehicleId: null,
      });
      assert.equal(checked.token, risk.token);
      const accepted = await controller.create(
        { ...wide, riskAcceptance: { token: checked.token } },
        request(),
      );
      const detail = await controller.get(String(accepted.id));
      assert.equal(detail.vehicle_id, null);
      assert.equal(detail.risks.length, 1);
      assert.equal(detail.risks[0].reason, 'Сохранение брони с предупреждением о доступности');
      const secondModel = (
        await db.pool.query(
          "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Новая модель',$2) RETURNING id",
          [brand, group],
        )
      ).rows[0].id;
      assert.notEqual(secondModel, model);
      const changed = {
        target: wide.target,
        quoteId: quote.id,
        reason: 'Явная редакция',
        expectedVersion: accepted.version,
      };
      let updateRisk;
      try {
        await controller.update(String(accepted.id), changed, request());
      } catch (e) {
        updateRisk = e.getResponse().details;
      }
      await controller.update(
        String(accepted.id),
        { ...changed, riskAcceptance: { token: updateRisk.token, reason: 'Подтверждение' } },
        request(),
      );
      assert.deepEqual(
        (
          await db.pool.query('SELECT model_id FROM booking_eligible_models WHERE booking_id=$1', [
            accepted.id,
          ])
        ).rows.map((r) => r.model_id),
        [model],
      );
      await db.pool.query(
        "UPDATE customers SET is_blocked=true,blocked_reason='Тест' WHERE id=$1",
        [accepted.customer_id],
      );
      await assert.rejects(
        controller.create({ ...wide, customer: { existingId: accepted.customer_id } }, request()),
        (e) => e.getResponse().code === 'CUSTOMER_BLOCKED',
      );
      const before = (await db.pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n;
      await db.pool.query(
        "CREATE FUNCTION reject_booking_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='bookings.created' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_booking_outbox BEFORE INSERT ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION reject_booking_outbox()",
      );
      let fresh;
      try {
        await controller.create(wide, request());
      } catch (e) {
        fresh = e.getResponse().details;
      }
      await assert.rejects(
        controller.create(
          { ...wide, riskAcceptance: { token: fresh.token, reason: 'Проверка отката' } },
          request(),
        ),
      );
      assert.equal(
        (await db.pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n,
        before,
      );
      await db.pool.query(
        'DROP TRIGGER reject_booking_outbox ON outbox_jobs; DROP FUNCTION reject_booking_outbox()',
      );
    },
  );
  await t.test('automatic pricing, customer edit atomicity and optimistic version', async () => {
    const target = { type: 'vehicle', id: vehicle },
      pricing = {
        startAt: '2030-01-01T10:00:00+03:00',
        contractDays: 2,
        dailyMileagePackageKm: 250,
      };
    const customer = {
      type: 'individual',
      displayName: 'Петров Иван',
      phone: '+79990000002',
      details: { lastName: 'Петров', firstName: 'Иван', middleName: '' },
    };
    const countQuotes = async () =>
      (await db.pool.query('SELECT count(*)::int AS n FROM pricing_quotes')).rows[0].n;
    const before = await countQuotes();
    const preview = await controller.preview({ target, pricing }, request());
    assert.equal(await countQuotes(), before);
    assert.equal(preview.calculation.finalTotalRub, '3400');
    const payload = {
      target,
      pricing,
      previewToken: preview.previewToken,
      confirmedOverrides: [],
      customer: { new: customer },
      reason: 'Автоматический расчёт',
    };
    const r = request(),
      created = await controller.create(payload, r);
    assert.equal((await controller.create(payload, r)).id, created.id);
    assert.equal(await countQuotes(), before + 1);
    const original = (
      await db.pool.query('SELECT * FROM customers WHERE id=$1', [created.customer_id])
    ).rows[0];
    const changed = {
      ...customer,
      displayName: 'Сидоров Иван',
      phone: '+79990000003',
      details: { ...customer.details, lastName: 'Сидоров' },
    };
    const edit = {
      ...payload,
      customer: {
        existingId: created.customer_id,
        expectedVersion: original.version,
        data: changed,
      },
      expectedVersion: created.version,
    };
    await db.pool.query('UPDATE customers SET version=version+1 WHERE id=$1', [
      created.customer_id,
    ]);
    await assert.rejects(
      controller.update(String(created.id), edit, request()),
      (e) => e.getResponse().code === 'CUSTOMER_VERSION_CONFLICT',
    );
    assert.equal(await countQuotes(), before + 1);
    const updated = await controller.update(
      String(created.id),
      { ...edit, customer: { ...edit.customer, expectedVersion: original.version + 1 } },
      request(),
    );
    assert.equal(updated.version, 2);
    const current = (
      await db.pool.query('SELECT * FROM customers WHERE id=$1', [created.customer_id])
    ).rows[0];
    assert.equal(current.phone, changed.phone);
    assert.equal(current.details.lastName, 'Сидоров');
    const countBeforeFailure = await countQuotes();
    let risk;
    const conflict = {
      ...payload,
      customer: {
        existingId: current.id,
        expectedVersion: current.version,
        data: { ...changed, phone: '+79990000004' },
      },
    };
    try {
      await controller.create(conflict, request());
    } catch (e) {
      risk = e.getResponse().details;
    }
    await assert.rejects(
      controller.create(conflict, request()),
      (e) => e.getResponse().code === 'VEHICLE_ASSIGNMENT_CONFLICT',
    );
    assert.equal(
      (await db.pool.query('SELECT phone FROM customers WHERE id=$1', [current.id])).rows[0].phone,
      changed.phone,
    );
    assert.equal(await countQuotes(), countBeforeFailure);
    const manualPricing = {
      ...pricing,
      overrides: { customDailyRateRub: '0', reason: 'Бесплатно' },
    };
    const manual = await controller.preview({ target, pricing: manualPricing }, request());
    await assert.rejects(
      controller.create(
        { ...payload, pricing: manualPricing, previewToken: manual.previewToken },
        request(),
      ),
      (e) => e.getResponse().code === 'OVERRIDES_CONFIRMATION_REQUIRED',
    );
    const comfort = (
      await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='comfort'")
    ).rows[0].id;
    await db.pool.query(
      "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Другой тариф',$2)",
      [brand, comfort],
    );
    await assert.rejects(
      controller.preview({ target: { type: 'brand', id: brand }, pricing }, request()),
      (e) => e.getResponse().code === 'TARIFF_AMBIGUOUS',
    );
    assert.equal((await controller.customers({ q: 'С' })).items.length, 0);
    assert.ok((await controller.customers({ q: 'Сидор' })).items.some((c) => c.id === current.id));
  });
  await t.test(
    'assignment and unassignment preserve command, rollback, calendar and finance guarantees',
    async () => {
      const cars = (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'ASSIGN01',2020,'sedan',100,1000),($1,'ASSIGN02',2020,'sedan',100,1000) RETURNING id",
          [model],
        )
      ).rows.map((row) => row.id);
      const target = { type: 'model', id: model };
      const pricingInput = {
        startAt: '2034-01-01T10:00:00+03:00',
        contractDays: 2,
        dailyMileagePackageKm: 250,
      };
      const preview = await controller.preview({ target, pricing: pricingInput }, request());
      const created = await controller.create(
        {
          target,
          pricing: pricingInput,
          previewToken: preview.previewToken,
          vehicleId: cars[0],
          customer: {
            new: {
              type: 'individual',
              displayName: 'Назначение Тест',
              phone: '+79990000007',
              details: { lastName: 'Назначение', firstName: 'Тест' },
            },
          },
          reason: 'Проверка назначения',
        },
        request(),
      );
      const financialTables = [
        'financial_operations',
        'finance_charges',
        'finance_external',
        'finance_funds',
        'finance_fund_entries',
        'finance_lots',
        'finance_allocations',
      ];
      const snapshot = async (names) =>
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
      const moneyBefore = await snapshot(financialTables);
      await assert.rejects(
        controller.assignment(
          String(created.id),
          { expectedVersion: created.version + 1, vehicleId: null },
          request(),
        ),
        (error) => error.getResponse().code === 'BOOKING_VERSION_CONFLICT',
      );
      await db.pool.query(
        "CREATE FUNCTION reject_assignment_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='bookings.assigned' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_assignment_outbox BEFORE INSERT ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION reject_assignment_outbox()",
      );
      const unassignRequest = request();
      await assert.rejects(
        controller.assignment(
          String(created.id),
          { expectedVersion: created.version, vehicleId: null },
          unassignRequest,
        ),
      );
      assert.equal((await controller.get(String(created.id))).vehicle_id, cars[0]);
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='booking' AND entity_id=$1 AND action='bookings.assigned'",
            [created.id],
          )
        ).rows[0].n,
        0,
      );
      await db.pool.query(
        'DROP TRIGGER reject_assignment_outbox ON outbox_jobs; DROP FUNCTION reject_assignment_outbox()',
      );
      const unassigned = await controller.assignment(
        String(created.id),
        { expectedVersion: created.version, vehicleId: null },
        unassignRequest,
      );
      const unassignedRetry = await controller.assignment(
        String(created.id),
        { expectedVersion: created.version, vehicleId: null },
        unassignRequest,
      );
      assert.equal(unassignedRetry.id, unassigned.id);
      assert.equal(unassignedRetry.version, unassigned.version);
      assert.equal((await controller.get(String(created.id))).vehicle_id, null);
      let calendar = await controller.calendar({
        from: '2034-01-01T00:00:00+03:00',
        to: '2034-01-04T00:00:00+03:00',
      });
      assert.ok(calendar.unassignedBookings.some((booking) => booking.id === created.id));
      const assigned = await controller.assignment(
        String(created.id),
        { expectedVersion: unassigned.version, vehicleId: cars[1], reason: 'Выбрана замена' },
        request(),
      );
      assert.equal(assigned.version, unassigned.version + 1);
      calendar = await controller.calendar({
        from: '2034-01-01T00:00:00+03:00',
        to: '2034-01-04T00:00:00+03:00',
      });
      assert.ok(!calendar.unassignedBookings.some((booking) => booking.id === created.id));
      assert.equal(
        calendar.events.find(
          (event) => event.kind === 'assignment' && event.booking_id === created.id,
        ).vehicle_id,
        cars[1],
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='booking' AND entity_id=$1 AND action='bookings.assigned'",
            [created.id],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM outbox_jobs WHERE kind='bookings.assigned' AND payload->>'id'=$1",
            [String(created.id)],
          )
        ).rows[0].n,
        2,
      );
      const concurrent = await Promise.allSettled([
        controller.assignment(
          String(created.id),
          { expectedVersion: assigned.version, vehicleId: null },
          request(),
        ),
        controller.assignment(
          String(created.id),
          { expectedVersion: assigned.version, vehicleId: cars[0] },
          request(),
        ),
      ]);
      assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
      const rejected = concurrent.find((result) => result.status === 'rejected');
      assert.equal(rejected.reason.getResponse().code, 'BOOKING_VERSION_CONFLICT');
      assert.deepEqual(await snapshot(financialTables), moneyBefore);
    },
  );
  await t.test(
    'technical displacement is atomic, versioned and reversible through reassignment',
    async () => {
      const br = (
        await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Конфликты') RETURNING id")
      ).rows[0].id;
      const mo = (
        await db.pool.query(
          "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Фургон',$2) RETURNING id",
          [br, group],
        )
      ).rows[0].id;
      const cars = (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'CONFLICT1',2020,'sedan',100,1000),($1,'CONFLICT2',2020,'sedan',100,1000) RETURNING id",
          [mo],
        )
      ).rows.map((x) => x.id);
      const make = async (vehicleId, startAt, days = 1) => {
        const target = { type: 'vehicle', id: vehicleId },
          p = { startAt, contractDays: days, dailyMileagePackageKm: 250 };
        const v = await controller.preview({ target, pricing: p }, request());
        return controller.create(
          {
            target,
            pricing: p,
            previewToken: v.previewToken,
            customer: {
              new: {
                type: 'individual',
                displayName: 'Конфликт Тест',
                phone: '+79990000009',
                details: { lastName: 'Конфликт', firstName: 'Тест' },
              },
            },
            reason: 'Проверка конфликтов',
          },
          request(),
        );
      };
      const one = await make(cars[0], '2035-01-01T10:00:00+03:00'),
        two = await make(cars[0], '2035-01-02T10:00:00+03:00'),
        busy = await make(cars[1], '2035-01-01T10:00:00+03:00', 2);
      const before = await controller.get(String(one.id));
      const input = {
        vehicleId: cars[0],
        startAt: '2035-01-01T12:00:00+03:00',
        endAt: '2035-01-03T09:00:00+03:00',
        reason: 'Покраска',
      };
      let preview = await controller.previewTechnical({
        vehicleId: input.vehicleId,
        startAt: input.startAt,
        endAt: input.endAt,
      });
      assert.equal(preview.conflicts.length, 2);
      await assert.rejects(
        controller.technical(input, request()),
        (e) => e.getResponse().code === 'TECHNICAL_BOOKINGS_CONFIRMATION_REQUIRED',
      );
      const confirmed = () => ({
        ...input,
        conflictsToken: preview.token,
        displaceBookings: preview.conflicts.map((x) => ({
          id: x.booking_id,
          expectedVersion: x.booking_version,
        })),
      });
      const stale = confirmed();
      await db.pool.query('UPDATE bookings SET version=version+1 WHERE id=$1', [two.id]);
      await assert.rejects(
        controller.technical(stale, request()),
        (e) => e.getResponse().code === 'TECHNICAL_BOOKINGS_CONFIRMATION_REQUIRED',
      );
      preview = await controller.previewTechnical({
        vehicleId: input.vehicleId,
        startAt: input.startAt,
        endAt: input.endAt,
      });
      await db.pool.query(
        "CREATE FUNCTION reject_technical_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='schedule.created' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_technical_outbox BEFORE INSERT ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION reject_technical_outbox()",
      );
      await assert.rejects(controller.technical(confirmed(), request()));
      assert.equal((await controller.get(String(one.id))).vehicle_id, cars[0]);
      assert.equal((await controller.get(String(one.id))).version, one.version);
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE action='bookings.displaced' AND entity_id=ANY($1::int[])",
            [[one.id, two.id]],
          )
        ).rows[0].n,
        0,
      );
      await db.pool.query(
        'DROP TRIGGER reject_technical_outbox ON outbox_jobs; DROP FUNCTION reject_technical_outbox()',
      );
      const req = request(),
        block = await controller.technical(confirmed(), req);
      assert.equal((await controller.technical(confirmed(), req)).id, block.id);
      const removed = await controller.get(String(one.id));
      assert.equal(removed.vehicle_id, null);
      assert.equal(removed.target_type, 'model');
      assert.equal(removed.target_model_id, mo);
      assert.equal(removed.terms[0].snapshot.finalTotalRub, before.terms[0].snapshot.finalTotalRub);
      assert.equal(removed.customer_id, before.customer_id);
      let calendar = await controller.calendar({
        from: '2035-01-01T00:00:00+03:00',
        to: '2035-01-04T00:00:00+03:00',
      });
      assert.ok(calendar.problems.some((x) => x.id === one.id));
      const intersection = calendar.problems
        .find((x) => x.id === one.id)
        .conflicts.find((x) => x.id === block.id);
      assert.ok(intersection);
      assert.equal(new Date(intersection.start_at).toISOString(), '2035-01-01T09:00:00.000Z');
      assert.equal(new Date(intersection.overlap_start).toISOString(), '2035-01-01T09:00:00.000Z');
      assert.equal(new Date(intersection.overlap_end).toISOString(), '2035-01-02T07:00:00.000Z');
      assert.equal(calendar.events.filter((x) => x.kind === 'displaced').length, 2);
      assert.equal(
        calendar.events.filter((x) => x.kind === 'assignment' && x.vehicle_id === cars[0]).length,
        0,
      );
      await assert.rejects(
        controller.technical({ ...input, startAt: '2035-01-01T13:00:00+03:00' }, request()),
        (e) => e.getResponse().code === 'TECHNICAL_BLOCK_CONFLICT',
      );
      await assert.rejects(
        controller.assignment(
          String(one.id),
          { expectedVersion: removed.version, vehicleId: cars[0], reason: 'Нельзя' },
          request(),
        ),
        (e) => e.getResponse().code === 'VEHICLE_ASSIGNMENT_CONFLICT',
      );
      await controller.cancel(
        String(busy.id),
        { expectedVersion: busy.version, reason: 'Освободили замену' },
        request(),
      );
      calendar = await controller.calendar({
        from: '2035-01-01T00:00:00+03:00',
        to: '2035-01-04T00:00:00+03:00',
      });
      assert.ok(
        calendar.problems
          .find((x) => x.id === one.id)
          .problemReasons.includes('Требуется замена автомобиля'),
      );
      assert.equal(calendar.problems.find((x) => x.id === one.id).availability.status, 'feasible');
      assert.ok(calendar.unassignedBookings.some((x) => x.id === one.id));
      await controller.assignment(
        String(one.id),
        { expectedVersion: removed.version, vehicleId: cars[1] },
        request(),
      );
      assert.equal(
        (await controller.history(String(one.id))).items[0].details.reason,
        'Изменение назначения автомобиля',
      );
      calendar = await controller.calendar({
        from: '2035-01-01T00:00:00+03:00',
        to: '2035-01-04T00:00:00+03:00',
      });
      assert.ok(!calendar.problems.some((x) => x.id === one.id));
      assert.ok(!calendar.events.some((x) => x.kind === 'displaced' && x.booking_id === one.id));
      assert.equal(
        calendar.events.find((x) => x.kind === 'assignment' && x.booking_id === one.id).vehicle_id,
        cars[1],
      );
      const updated = await controller.updateTechnical(
        String(block.id),
        { ...input, expectedVersion: block.version, startAt: '2035-01-01T13:00:00+03:00' },
        request(),
      );
      assert.equal(updated.version, 2);
      await db.pool.query(
        "UPDATE vehicles SET is_ready=false,readiness_reason='Поломка' WHERE id=$1",
        [cars[1]],
      );
      calendar = await controller.calendar({
        from: '2035-01-01T00:00:00+03:00',
        to: '2035-01-04T00:00:00+03:00',
      });
      assert.ok(
        calendar.problems
          .find((x) => x.id === one.id)
          .problemReasons.some((x) => x.includes('не готов')),
      );
    },
  );
  await t.test(
    'calendar move keeps agreed price and applies vehicle and dates atomically',
    async () => {
      const cars = (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'MOVE001',2020,'sedan',100,1000),($1,'MOVE002',2020,'sedan',100,1000) RETURNING id",
          [model],
        )
      ).rows.map((x) => x.id);
      const target = { type: 'vehicle', id: cars[0] },
        pricingInput = {
          startAt: '2036-03-01T10:00:00+03:00',
          contractDays: 2,
          dailyMileagePackageKm: 250,
        };
      const p = await controller.preview({ target, pricing: pricingInput }, request());
      const created = await controller.create(
        {
          target,
          pricing: pricingInput,
          previewToken: p.previewToken,
          customer: {
            new: {
              type: 'individual',
              displayName: 'Перенос',
              phone: '+79990000008',
              details: { lastName: 'Тест', firstName: 'Перенос' },
            },
          },
          reason: 'Проверка переноса',
        },
        request(),
      );
      const before = await controller.get(String(created.id)),
        startAt = '2036-03-04T10:00:00+03:00';
      const preview = await controller.previewMove(
        String(created.id),
        { startAt, vehicleId: cars[1] },
        request(),
      );
      assert.equal(preview.blocked, false);
      assert.equal(preview.priceRub, before.terms[0].snapshot.finalTotalRub);
      const input = {
        startAt,
        vehicleId: cars[1],
        expectedVersion: preview.expectedVersion,
        availabilityToken: preview.availability.token,
      };
      await assert.rejects(
        controller.move(
          String(created.id),
          { ...input, availabilityToken: '0'.repeat(64) },
          request(),
        ),
        (e) => e.getResponse().code === 'MOVE_PREVIEW_STALE',
      );
      const req = request(),
        moved = await controller.move(String(created.id), input, req);
      assert.equal((await controller.move(String(created.id), input, req)).version, moved.version);
      const after = await controller.get(String(created.id));
      assert.equal(after.vehicle_id, cars[1]);
      assert.equal(after.start_at.toISOString(), new Date(startAt).toISOString());
      assert.equal(after.terms[0].snapshot.finalTotalRub, before.terms[0].snapshot.finalTotalRub);
      assert.equal(after.terms[0].snapshot.dayLines[0].startAt, new Date(startAt).toISOString());
      assert.equal(
        (
          await db.pool.query(
            'SELECT count(*)::int AS n FROM schedule_blocks WHERE booking_id=$1 AND retired_at IS NULL',
            [created.id],
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        controller.move(String(created.id), input, request()),
        (e) => e.getResponse().code === 'BOOKING_VERSION_CONFLICT',
      );
      const comfort = (
        await db.pool.query("SELECT id FROM pricing_groups WHERE tariff_code='comfort'")
      ).rows[0].id;
      const otherModel = (
        await db.pool.query(
          "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Легковая',$2) RETURNING id",
          [brand, comfort],
        )
      ).rows[0].id;
      const otherCar = (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'MOVE003',2020,'sedan',100,1000) RETURNING id",
          [otherModel],
        )
      ).rows[0].id;
      const repriced = await controller.previewMove(
        String(created.id),
        { startAt, vehicleId: otherCar },
        request(),
      );
      assert.equal(repriced.blocked, false);
      assert.ok(repriced.quoteToken);
      assert.notEqual(repriced.priceRub, repriced.oldPriceRub);
      await controller.move(
        String(created.id),
        {
          startAt,
          vehicleId: otherCar,
          expectedVersion: repriced.expectedVersion,
          availabilityToken: repriced.availability.token,
          quoteToken: repriced.quoteToken,
        },
        request(),
      );
      const changed = await controller.get(String(created.id));
      assert.equal(changed.vehicle_id, otherCar);
      assert.equal(changed.target_type, 'vehicle');
      assert.equal(changed.target_vehicle_id, otherCar);
      assert.deepEqual(changed.terms[0].snapshot.eligibleModels, [otherModel]);
      assert.equal(changed.terms[0].snapshot.finalTotalRub, repriced.priceRub);
      assert.equal(
        (
          await db.pool.query(
            'SELECT count(*)::int AS n FROM finance_charges WHERE booking_id=$1',
            [created.id],
          )
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test(
    'terms edit preserves atomicity, versions, command result and financial rows',
    async () => {
      const ownModel = (
        await db.pool.query(
          "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Регрессия редакции',$2) RETURNING id",
          [brand, group],
        )
      ).rows[0].id;
      const ownVehicle = (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'Р333ТТ178',2020,'sedan',100,10000) RETURNING id",
          [ownModel],
        )
      ).rows[0].id;
      const target = { type: 'vehicle', id: ownVehicle };
      const pricingInput = {
        startAt: '2045-02-01T10:00:00+03:00',
        contractDays: 2,
        dailyMileagePackageKm: 250,
      };
      const customer = {
        type: 'individual',
        displayName: 'Тестов Иван',
        phone: '+79990000333',
        details: { firstName: 'Иван', lastName: 'Тестов' },
      };
      const preview = await controller.preview({ target, pricing: pricingInput }, request());
      const created = await controller.create(
        {
          target,
          pricing: pricingInput,
          previewToken: preview.previewToken,
          customer: { new: customer },
          reason: 'Подготовка проверки редакции',
        },
        request(),
      );
      const originalTerms = (await controller.get(String(created.id))).terms;
      const client = (
        await db.pool.query('SELECT * FROM customers WHERE id=$1', [created.customer_id])
      ).rows[0];
      const changedPricing = {
        ...pricingInput,
        contractDays: 3,
        overrides: { customDailyRateRub: '0', reason: 'Ручная цена' },
      };
      const next = await controller.preview(
        { target, pricing: changedPricing, bookingId: created.id },
        request(),
      );
      const payload = {
        target,
        pricing: changedPricing,
        previewToken: next.previewToken,
        confirmedOverrides: next.calculation.overridesToConfirm,
        customer: {
          existingId: client.id,
          expectedVersion: client.version,
          data: { ...customer, phone: '+79990000334' },
        },
        expectedVersion: created.version,
        reason: 'Редакция с новым телефоном и ценой',
      };
      const tables = [
        'customers',
        'bookings',
        'booking_terms',
        'booking_eligible_models',
        'booking_risks',
        'schedule_blocks',
        'pricing_quotes',
        'audit_logs',
        'outbox_jobs',
        'idempotency_records',
      ];
      const financialTables = [
        'financial_operations',
        'finance_charges',
        'finance_external',
        'finance_funds',
        'finance_fund_entries',
        'finance_lots',
        'finance_allocations',
      ];
      const snapshot = async (names) =>
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
      const before = await snapshot(tables);
      const moneyBefore = await snapshot(financialTables);
      const code = (expected) => (e) =>
        e.getStatus() ===
          (expected === 'OVERRIDES_CONFIRMATION_REQUIRED' || expected === 'CUSTOMER_FIXED'
            ? 422
            : 409) && e.getResponse().code === expected;
      await assert.rejects(
        controller.update(String(created.id), { ...payload, expectedVersion: 99 }, request()),
        code('BOOKING_VERSION_CONFLICT'),
      );
      await assert.rejects(
        controller.update(
          String(created.id),
          { ...payload, customer: { new: customer } },
          request(),
        ),
        code('CUSTOMER_FIXED'),
      );
      await assert.rejects(
        controller.update(String(created.id), { ...payload, confirmedOverrides: [] }, request()),
        code('OVERRIDES_CONFIRMATION_REQUIRED'),
      );
      assert.deepEqual(await snapshot(tables), before);
      const req = request();
      for (const table of ['audit_logs', 'outbox_jobs']) {
        await db.pool.query(
          "CREATE FUNCTION stage3_reject_terms() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(to_jsonb(NEW)->>'action',to_jsonb(NEW)->>'kind')='bookings.terms' THEN RAISE EXCEPTION 'stage3 injected terms failure'; END IF; RETURN NEW; END $$",
        );
        await db.pool.query(
          'CREATE TRIGGER stage3_reject_terms BEFORE INSERT ON ' +
            table +
            ' FOR EACH ROW EXECUTE FUNCTION stage3_reject_terms()',
        );
        try {
          await assert.rejects(
            controller.update(String(created.id), payload, req),
            /stage3 injected terms failure/,
          );
          assert.deepEqual(
            await snapshot(tables),
            before,
            table + ' rollback includes old assignment, client, quote and history',
          );
          assert.deepEqual(await snapshot(financialTables), moneyBefore);
        } finally {
          await db.pool.query('DROP TRIGGER stage3_reject_terms ON ' + table);
          await db.pool.query('DROP FUNCTION stage3_reject_terms()');
        }
      }
      const edited = await controller.update(String(created.id), payload, req);
      assert.equal(edited.version, created.version + 1);
      assert.deepEqual(
        edited,
        (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [created.id])).rows[0],
      );
      assert.deepEqual(
        await controller.update(String(created.id), payload, req),
        JSON.parse(JSON.stringify(edited)),
      );
      await assert.rejects(
        controller.update(String(created.id), { ...payload, reason: 'Другое тело' }, req),
        code('IDEMPOTENCY_KEY_REUSED'),
      );
      const detail = await controller.get(String(created.id));
      assert.deepEqual(detail.terms.slice(1), originalTerms);
      assert.equal(detail.terms[0].snapshot.finalTotalRub, '0');
      assert.equal(
        (await db.pool.query('SELECT phone FROM customers WHERE id=$1', [client.id])).rows[0].phone,
        '+79990000334',
      );
      assert.equal(
        (
          await db.pool.query(
            "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='booking' AND entity_id=$1 AND action='bookings.terms'",
            [created.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.pool.query('SELECT count(*)::int AS n FROM outbox_jobs WHERE business_key=$1', [
            'bookings.terms:' + created.id + ':' + edited.version,
          ])
        ).rows[0].n,
        1,
      );
      const race = await Promise.allSettled(
        [4, 5].map(async (contractDays) => {
          const pricing = { ...pricingInput, contractDays };
          const p = await controller.preview({ target, pricing, bookingId: created.id }, request());
          return controller.update(
            String(created.id),
            {
              target,
              pricing,
              previewToken: p.previewToken,
              expectedVersion: edited.version,
              reason: 'Гонка редакций',
            },
            request(),
          );
        }),
      );
      assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
      const rejected = race.find((x) => x.status === 'rejected');
      assert.ok(code('BOOKING_VERSION_CONFLICT')(rejected.reason));
      const current = await controller.get(String(created.id));
      assert.equal(current.version, edited.version + 1);
      assert.equal(current.terms.length, 3);
      assert.deepEqual(await snapshot(financialTables), moneyBefore);
      await controller.cancel(
        String(created.id),
        { expectedVersion: current.version, reason: 'Проверка состояния' },
        request(),
      );
      const cancelledState = await snapshot(tables);
      await assert.rejects(
        controller.update(
          String(created.id),
          { ...payload, expectedVersion: current.version + 1 },
          request(),
        ),
        code('BOOKING_VERSION_CONFLICT'),
      );
      assert.deepEqual(await snapshot(tables), cancelledState);
      assert.deepEqual(await snapshot(financialTables), moneyBefore);
    },
  );

  await t.test(
    'calendar follows whole connected pools beyond the viewport and preserves unknown',
    async (t) => {
      const models = [];
      for (const label of ['Календарь A', 'Календарь B'])
        models.push(
          (
            await db.pool.query(
              'INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,$2,$3) RETURNING id',
              [brand, label, group],
            )
          ).rows[0].id,
        );
      const cars = (
        await db.pool.query(
          "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'CALENDAR-A',2020,'sedan',100,10000),($2,'CALENDAR-B',2020,'sedan',100,10000) RETURNING id",
          models,
        )
      ).rows;
      assert.equal(cars.length, 2);
      const customerId = (
        await db.pool.query(
          "INSERT INTO customers(type,display_name) VALUES ('individual','Календарный клиент') RETURNING id",
        )
      ).rows[0].id;
      const groupId = (
        await db.pool.query(
          "INSERT INTO equivalence_groups(name) VALUES ('Календарная цепочка') RETURNING id",
        )
      ).rows[0].id;
      for (const m of models)
        await db.pool.query(
          'INSERT INTO equivalence_group_models(group_id,model_id) VALUES ($1,$2)',
          [groupId, m],
        );
      const make = async (startAt, endAt, eligible, type, targetId) => {
        const row = (
          await db.pool.query(
            'INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,target_group_id,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              customerId,
              startAt,
              endAt,
              type,
              type === 'model' ? targetId : null,
              type === 'equivalence_group' ? targetId : null,
              actor,
            ],
          )
        ).rows[0];
        for (const m of eligible)
          await db.pool.query(
            'INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)',
            [row.id, m],
          );
        await db.pool.query(
          "INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) VALUES ($1,1,$2,$3,'Тест чтения',$4)",
          [
            row.id,
            quote.id,
            JSON.stringify({ ...quote.calculation, startAt, agreedReturnAt: endAt }),
            actor,
          ],
        );
        return row;
      };
      const one = await make(
        '2070-01-01T00:00:00Z',
        '2070-01-01T02:00:00Z',
        [models[0]],
        'model',
        models[0],
      );
      const two = await make(
        '2070-01-01T01:00:00Z',
        '2070-01-01T04:00:00Z',
        models,
        'equivalence_group',
        groupId,
      );
      const three = await make(
        '2070-01-01T03:00:00Z',
        '2070-01-01T05:00:00Z',
        [models[1]],
        'model',
        models[1],
      );
      const query = { from: '2070-01-01T00:00:00Z', to: '2070-01-01T00:30:00Z' };
      const measured = async (input, label) => {
        const connect = db.pool.connect.bind(db.pool);
        let queries = 0;
        db.pool.connect = async () => {
          const c = await connect(),
            query = c.query,
            release = c.release;
          c.query = function (...args) {
            queries++;
            return query.apply(this, args);
          };
          c.release = function (...args) {
            c.query = query;
            c.release = release;
            return release.apply(this, args);
          };
          return c;
        };
        const started = performance.now();
        let view;
        try {
          view = await controller.calendar(input);
        } finally {
          db.pool.connect = connect;
        }
        t.diagnostic(
          label +
            ': ' +
            queries +
            ' SQL calls including transaction control, ' +
            (performance.now() - started).toFixed(2) +
            ' ms',
        );
        return view;
      };
      const { referenceCalendar, calendarPayload } = require('./helpers/calendar-reference.cjs');
      const reference = referenceCalendar(db, commands, s);
      const view = await measured(query, 'outside-window deficit');
      assert.deepEqual(calendarPayload(view), calendarPayload(await reference.get(query)));
      assert.deepEqual(view.bookings, [
        {
          id: one.id,
          version: 1,
          start_at: one.start_at,
          end_at: one.end_at,
          vehicle_id: null,
          models: [models[0]],
        },
      ]);
      assert.equal(view.events.length, 0);
      assert.equal(view.unassignedBookings.length, 1);
      const problem = view.problems[0];
      assert.equal(problem.id, one.id);
      assert.equal(problem.availability.status, 'deficit');
      assert.deepEqual(problem.availability.bookingIds, [one.id, two.id, three.id]);
      assert.equal(problem.start_at.toISOString(), '2070-01-01T00:00:00.000Z');
      assert.equal(problem.end_at.toISOString(), '2070-01-01T02:00:00.000Z');
      assert.ok(problem.conflicts.some((x) => x.booking_id === two.id));
      assert.equal(problem.financialSummary.priceRub, quote.calculation.finalTotalRub);
      assert.equal(problem.financialSummary.paymentsAllowed, false);
      assert.equal(problem.financialSummary.debtRub, '0');
      assert.match(problem.availability.token, /^[a-f0-9]{64}$/);
      const all = await controller.calendar({ ...query, to: '2070-01-01T06:00:00Z' });
      assert.deepEqual(
        all.bookings.map((b) => b.id),
        [one.id, two.id, three.id],
      );
      const boundary = await controller.calendar({
        from: '2070-01-01T02:00:00Z',
        to: '2070-01-01T02:30:00Z',
      });
      assert.deepEqual(
        boundary.bookings.map((b) => b.id),
        [two.id],
      );
      const beforeStart = await controller.calendar({
        from: '2069-12-31T23:00:00Z',
        to: '2070-01-01T00:00:00Z',
      });
      assert.deepEqual(beforeStart.bookings, []);
      await assert.rejects(
        controller.calendar({ from: query.from, to: query.from }),
        (e) => e.getStatus() === 400,
      );
      const longChain = (
        await db.pool.query(
          "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) SELECT $1,'2080-01-01T00:00:00Z'::timestamptz+n*interval '12 hours','2080-01-02T00:00:00Z'::timestamptz+n*interval '12 hours','model',$2,$3 FROM generate_series(0,500) n RETURNING id",
          [customerId, models[0], actor],
        )
      ).rows.map((b) => b.id);
      await db.pool.query(
        'INSERT INTO booking_eligible_models(booking_id,model_id) SELECT unnest($1::int[]),$2',
        [longChain, models[0]],
      );
      await db.pool.query(
        "INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) SELECT unnest($1::int[]),1,$2,$3,'Тест лимита',$4",
        [longChain, quote.id, JSON.stringify(quote.calculation), actor],
      );
      const unknown = await measured(
        { from: '2080-01-01T00:00:00Z', to: '2080-01-01T01:00:00Z' },
        'outside-window unknown',
      );
      assert.deepEqual(
        calendarPayload(unknown),
        calendarPayload(
          await reference.get({
            from: '2080-01-01T00:00:00Z',
            to: '2080-01-01T01:00:00Z',
          }),
        ),
      );
      assert.equal(unknown.bookings.length, 1);
      assert.equal(unknown.problems[0].availability.status, 'unknown');
      assert.equal(unknown.problems[0].availability.bookingIds.length, 501);
      assert.deepEqual(unknown.problems[0].availability.bookingIds, longChain);
      assert.ok(unknown.problems[0].problemReasons.includes('Доступность не подтверждена'));
      const [parallelDeficit, parallelUnknown] = await Promise.all([
        controller.calendar(query),
        controller.calendar({ from: '2080-01-01T00:00:00Z', to: '2080-01-01T01:00:00Z' }),
      ]);
      assert.deepEqual(calendarPayload(parallelUnknown), calendarPayload(unknown));
      assert.deepEqual(
        calendarPayload(parallelDeficit),
        calendarPayload(await reference.get(query)),
        'parallel calendar requests cannot reuse another request’s roots or facts',
      );
    },
  );
  await require('./helpers/move-regressions.cjs')({ t, db, s, controller, request, group, actor });
});
