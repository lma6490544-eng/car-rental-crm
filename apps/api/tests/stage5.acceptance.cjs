const { test } = require('node:test');
const { selectOptionsSnapshot } = require('./helpers/select-options.cjs');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
test(
  'Stage 5 finance: migrations, commands, concurrency and browser',
  { timeout: 360000 },
  async (t) => {
    const name = 'crm_stage5_test_' + randomBytes(8).toString('hex'),
      root = path.resolve(__dirname, '../../..');
    const url = new URL(process.env.DATABASE_URL),
      admin = new Pool({ connectionString: url.toString() });
    url.pathname = '/' + name;
    let db;
    t.after(async () => {
      if (db) await db.pool.end();
      assert.match(name, /^crm_stage5_test_[a-f0-9]{16}$/);
      await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      await admin.end();
    });
    await admin.query('CREATE DATABASE "' + name + '"');
    process.env.DATABASE_URL = url.toString();
    const { DatabaseService } = require('../dist/database.service');
    db = new DatabaseService();
    const migrations = path.resolve(__dirname, '../drizzle'),
      baseline = path.join(root, '.runtime', name + '-migrations');
    fs.mkdirSync(path.join(baseline, 'meta'), { recursive: true });
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrations, 'meta/_journal.json'), 'utf8'),
    );
    for (const entry of journal.entries.filter((e) => e.idx < 10))
      fs.copyFileSync(
        path.join(migrations, entry.tag + '.sql'),
        path.join(baseline, entry.tag + '.sql'),
      );
    fs.writeFileSync(
      path.join(baseline, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.idx < 10) }),
    );
    await migrate(drizzle(db.pool), { migrationsFolder: baseline });
    const { CommandsService } = require('../dist/platform/commands.service'),
      commands = new CommandsService(db);
    const { PricingController } = require('../dist/pricing/pricing.controller'),
      pricing = new PricingController(db, commands);
    const { FinanceService, financeInput } = require('../dist/finance/finance.service'),
      finance = new FinanceService(db, commands);
    const { FinanceController } = require('../dist/finance/finance.controller'),
      controller = new FinanceController(finance);
    const { OperationsController } = require('../dist/identity/operations.controller'),
      operations = new OperationsController(db, commands);
    const { bookingSummary, sources, funds } = require('../dist/finance/ledger');
    const actor = (
      await db.pool.query(
        "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Finance manager','finance','unused','manager') RETURNING id",
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
      await db.pool.query("INSERT INTO vehicle_brands(name) VALUES ('Finance brand') RETURNING id")
    ).rows[0].id;
    const model = (
      await db.pool.query(
        "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) VALUES ($1,'Finance model',$2) RETURNING id",
        [brand, group],
      )
    ).rows[0].id;
    await db.pool.query(
      "INSERT INTO vehicles(model_id,plate,year,body_type,current_mileage_km,next_maintenance_due_km) VALUES ($1,'Ф001ФФ178',2020,'sedan',NULL,NULL)",
      [model],
    );
    const customer = (
      await db.pool.query(
        "INSERT INTO customers(type,display_name,phone) VALUES ('individual','Финансовый тест','70000000000') RETURNING id",
      )
    ).rows[0].id;
    const other = (
      await db.pool.query(
        "INSERT INTO customers(type,display_name) VALUES ('individual','Другой') RETURNING id",
      )
    ).rows[0].id;
    const quote = await pricing.quote(
      {
        operationKind: 'initial',
        pricingGroupId: group,
        startAt: '2026-12-01T10:00:00+03:00',
        contractDays: 5,
        dailyMileagePackageKm: 250,
        overrides: { customDailyRateRub: '2000', reason: 'test' },
      },
      request(),
    );
    await pricing.confirm(
      String(quote.id),
      { expectedVersion: 1, confirmedOverrides: quote.calculation.overridesToConfirm },
      request(),
    );
    async function makeBooking(client = customer, price = '10000', sync = true) {
      const b = (
        await db.pool.query(
          "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,'2026-12-01T10:00:00+03','2026-12-06T10:00:00+03','model',$2,$3) RETURNING *",
          [client, model, actor],
        )
      ).rows[0];
      await db.pool.query(
        'INSERT INTO booking_eligible_models(booking_id,model_id) VALUES ($1,$2)',
        [b.id, model],
      );
      await db.pool.query(
        'INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by) VALUES ($1,1,$2,$3,$4,$5)',
        [
          b.id,
          quote.id,
          JSON.stringify({
            ...quote.calculation,
            finalTotalRub: price,
            eligibleModels: [model],
            target: { type: 'model', id: model },
          }),
          'test',
          actor,
        ],
      );
      return b.id;
    }
    const existing = await makeBooking(customer, '10000', false);
    const oldTables = (
      await db.pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows.map((x) => x.tablename);
    async function fingerprint(table) {
      const rowData = table === 'vehicles' ? "(to_jsonb(t) - 'has_casco')::text" : 't::text';
      return (
        await db.pool.query(
          `SELECT md5(coalesce(string_agg(${rowData},E'\n' ORDER BY ${rowData}),'')) AS hash FROM "${table}" t`,
        )
      ).rows[0].hash;
    }
    const fingerprints = {};
    for (const table of oldTables) fingerprints[table] = await fingerprint(table);
    await migrate(drizzle(db.pool), { migrationsFolder: migrations });
    const summary = (id) => db.transaction((c) => bookingSummary(c, id)),
      src = () => db.transaction((c) => sources(c, customer)),
      fundState = () => db.transaction((c) => funds(c));
    const post = (input, r = request()) => controller.post(input, r);
    const target = (id) => ({ customerId: customer, bookingId: id, expectedVersion: 1 });
    const selected = (s, amountRub) => ({
      lotId: s.lotId,
      bucket: s.bucket,
      fund: s.fund,
      bookingId: s.bookingId,
      amountRub,
    });
    const code = (expected) => (e) => e.getResponse?.().code === expected;
    await t.test(
      'migration preserves prior rows; legacy charge is not a receipt or contract debt',
      async () => {
        for (const table of oldTables) {
          if (['audit_logs', 'outbox_jobs'].includes(table)) continue;
          assert.equal(await fingerprint(table), fingerprints[table], table);
        }
        const s = await summary(existing);
        assert.equal(s.priceRub, '10000');
        assert.equal(s.debtRub, '0');
        assert.equal(s.paymentsAllowed, false);
        assert.ok(
          (await db.pool.query("SELECT 1 FROM financial_operations WHERE kind='charge'")).rowCount,
        );
        assert.deepEqual((await controller.get({})).journal.items, []);
      },
    );
    await t.test('receipts and deposits denied before checkout; credit use denied', async () => {
      const before = (await db.pool.query('SELECT count(*)::int n FROM financial_operations'))
        .rows[0].n;
      for (const input of [
        { kind: 'rent_payment', amountRub: '500', method: 'cash' },
        { kind: 'rent_payment', amountRub: '500', method: 'bank' },
        { kind: 'deposit_receipt', amountRub: '10000', method: 'cash' },
        {
          kind: 'credit_use',
          sources: [{ lotId: 1, bucket: 'credit', fund: null, bookingId: null, amountRub: '500' }],
        },
      ]) {
        const body = { ...target(existing), reason: 'До начала оформления', ...input };
        await assert.rejects(controller.preview(body), code('RENTAL_NOT_ISSUED'));
        await assert.rejects(post(body), code('RENTAL_NOT_ISSUED'));
      }
      assert.equal(
        (await db.pool.query('SELECT count(*)::int n FROM financial_operations')).rows[0].n,
        before,
      );
      for (const table of [
        'finance_external',
        'finance_lots',
        'finance_allocations',
        'finance_fund_entries',
      ])
        assert.equal((await db.pool.query('SELECT count(*)::int n FROM ' + table)).rows[0].n, 0);
    });
    await t.test('initial balance remains separate from payment journal', async () => {
      await post({
        kind: 'initial',
        fund: 'operating_cash',
        amountRub: '0',
        reason: 'Учётный старт',
      });
      await assert.rejects(
        post({ kind: 'initial', fund: 'operating_cash', amountRub: '1', reason: 'Повтор' }),
        code('INITIAL_LOCKED'),
      );
      assert.deepEqual((await controller.get({})).journal.items, []);
    });
    // Synthetic historical receipts only, never new receipts via the current application.
    async function historical(method, bucket, amountRub) {
      return db.transaction(async (c) => {
        const op = (
          await c.query(
            "INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason) VALUES ($1,'fixture',$2,$3,$4,$5,'Существующий платёж') RETURNING id",
            [
              randomUUID(),
              bucket === 'rent' ? 'rent_payment' : 'deposit_receipt',
              customer,
              existing,
              actor,
            ],
          )
        ).rows[0];
        const lot = (
          await c.query(
            'INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,$3,$4) RETURNING id',
            [customer, op.id, bucket, method],
          )
        ).rows[0];
        const fund =
          method === 'bank' ? null : bucket === 'rent' ? 'operating_cash' : 'deposit_pool';
        await c.query(
          'INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,$3,$4,$5,$6)',
          [op.id, lot.id, bucket, existing, amountRub, fund],
        );
        await c.query(
          'INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,$2,$3)',
          [op.id, method, amountRub],
        );
        if (fund)
          await c.query(
            'INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,$2,$3)',
            [op.id, fund, amountRub],
          );
        return op.id;
      });
    }
    let bank;
    await t.test(
      'existing money preserved in all views, internal rows filtered before limit',
      async () => {
        bank = await historical('bank', 'rent', '12000');
        await historical('cash', 'deposit', '10000');
        // More than 200 legacy price changes must not hide real money from the journal.
        await db.pool.query(
          "INSERT INTO financial_operations(command_id,request_hash,kind,booking_id,reason) SELECT 'historical:'||n,'fixture','charge',$1,'История цены' FROM generate_series(1,205) n",
          [existing],
        );
        const journal = (await controller.get({})).journal.items;
        assert.equal(journal.length, 2);
        assert.ok(journal.every((o) => o.external.length > 0));
        assert.equal((await controller.customer(String(customer))).items.length, 2);
        assert.equal((await controller.booking(String(existing))).items.length, 2);
        const s = await summary(existing);
        assert.equal(s.coverageRub, '12000');
        assert.equal(s.depositRub, '10000');
        assert.equal(s.overpaymentRub, '2000');
        assert.equal(s.debtRub, '0');
      },
    );
    await t.test(
      'existing sources can be released and refunded; provenance, retries and compensation preserved',
      async () => {
        const deposit = (await src()).find((s) => s.bucket === 'deposit');
        await post({
          kind: 'to_credit',
          ...target(existing),
          reason: 'Освобождение прежнего залога',
          sources: [selected(deposit, '1000')],
        });
        assert.equal((await controller.get({})).journal.items.length, 2); // Internal allocation is not money received.
        const credit = (await src()).find((s) => s.bucket === 'credit');
        const body = {
            kind: 'refund',
            customerId: customer,
            method: 'cash',
            reason: 'Возврат прежних денег',
            sources: [selected(credit, '500')],
          },
          req = request();
        const [a, b] = await Promise.all([post(body, req), post(body, req)]);
        assert.equal(a.id, b.id);
        assert.equal(
          (await fundState()).items.find((x) => x.id === 'deposit_pool').balanceRub,
          '9500',
        );
        await db.pool.query(
          "DELETE FROM idempotency_records WHERE command='finance.post' AND key=$1",
          [req.headers['idempotency-key']],
        );
        assert.equal((await post(body, req)).id, a.id);
        await assert.rejects(
          post({ ...body, reason: 'Другое тело' }, req),
          code('IDEMPOTENCY_KEY_REUSED'),
        );
        const bankSource = (await src()).find((s) => s.method === 'bank');
        await assert.rejects(
          post({
            kind: 'refund',
            ...target(existing),
            method: 'cash',
            reason: 'Нельзя',
            sources: [selected(bankSource, '100')],
          }),
          code('REFUND_METHOD_MISMATCH'),
        );
        await assert.rejects(
          post({ ...body, sources: [selected(credit, '99999')] }),
          code('INSUFFICIENT_SOURCE'),
        );
        await post({ kind: 'reversal', operationId: a.id, reason: 'Исправление возврата' });
        assert.equal(
          (await fundState()).items.find((x) => x.id === 'deposit_pool').balanceRub,
          '10000',
        );
        const items = (await controller.get({})).journal.items;
        assert.equal(items.length, 4);
        assert.ok(items.every((o) => o.external.length > 0));
        for (const table of [
          'financial_operations',
          'finance_external',
          'finance_lots',
          'finance_allocations',
          'finance_fund_entries',
          'finance_charges',
        ])
          await assert.rejects(
            db.pool.query('DELETE FROM ' + table + ' WHERE false'),
            (e) => e.code === '23514',
          );
      },
    );
    await t.test(
      'new and changed bookings record price only in terms/history, without financial operations',
      async () => {
        const { SchedulingService } = require('../dist/scheduling/scheduling.service'),
          { SchedulingController } = require('../dist/scheduling/scheduling.controller');
        const schedulingService = new SchedulingService(db, commands);
        const { BookingService } = require('../dist/scheduling/booking.service');
        const { CalendarService } = require('../dist/scheduling/calendar.service');
        const { TechnicalBlockService } = require('../dist/scheduling/technical-block.service');
        const { BookingQueryService } = require('../dist/scheduling/booking-query.service');
        const scheduling = new SchedulingController(
          schedulingService,
          new BookingService(schedulingService),
          new CalendarService(db, schedulingService),
          new TechnicalBlockService(schedulingService),
          new BookingQueryService(db, schedulingService),
        );
        const targetModel = { type: 'model', id: model },
          pricingInput = {
            startAt: '2027-02-01T10:00:00+03:00',
            contractDays: 2,
            dailyMileagePackageKm: 250,
          };
        const before = (await db.pool.query('SELECT count(*)::int n FROM financial_operations'))
          .rows[0].n;
        const preview = await scheduling.preview(
          { target: targetModel, pricing: pricingInput },
          request(),
        );
        const b = await scheduling.create(
          {
            target: targetModel,
            pricing: pricingInput,
            previewToken: preview.previewToken,
            customer: { existingId: customer },
            reason: 'Новая бронь',
          },
          request(),
        );
        assert.equal((await summary(b.id)).priceRub, preview.calculation.finalTotalRub);
        assert.equal((await summary(b.id)).debtRub, '0');
        const changed = { ...pricingInput, contractDays: 3 },
          next = await scheduling.preview(
            { target: targetModel, pricing: changed, bookingId: b.id },
            request(),
          );
        await scheduling.update(
          String(b.id),
          {
            target: targetModel,
            pricing: changed,
            previewToken: next.previewToken,
            expectedVersion: 1,
            reason: 'Изменение цены',
          },
          request(),
        );
        const details = await scheduling.get(String(b.id));
        assert.equal(details.terms.length, 2);
        assert.equal(details.terms[0].snapshot.finalTotalRub, next.calculation.finalTotalRub);
        assert.equal((await summary(b.id)).priceRub, next.calculation.finalTotalRub);
        const history = await scheduling.history(String(b.id));
        assert.equal(history.terms.length, 2);
        assert.equal(history.terms[0].priceRub, next.calculation.finalTotalRub);
        await scheduling.cancel(String(b.id), { expectedVersion: 2, reason: 'Отмена' }, request());
        assert.equal(
          (await db.pool.query('SELECT count(*)::int n FROM financial_operations')).rows[0].n,
          before,
        );
        assert.equal(
          (
            await db.pool.query('SELECT count(*)::int n FROM finance_charges WHERE booking_id=$1', [
              b.id,
            ])
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'browser exposes refunds but no receipt/deposit/credit-use, including mobile',
      { timeout: 150000 },
      async () => {
        const { spawn } = require('node:child_process'),
          net = require('node:net'),
          { chromium } = require('playwright');
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
          origin = 'http://127.0.0.1:' + webPort,
          env = {
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
          browser = await chromium.launch({ channel: 'msedge', headless: true });
          const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
            errors = [];
          const waitForOperationOptions = () => selectOptionsSnapshot(page, 2);
          page.on('pageerror', (e) => errors.push(e.message));
          await page.goto(origin + '/payments');
          await page.getByLabel('Логин', { exact: true }).fill('finance');
          await page.getByLabel('Пароль', { exact: true }).fill(password);
          await page.getByRole('button', { name: 'Войти', exact: true }).click();
          await page
            .getByRole('heading', { name: 'Журнал оплат и возвратов', exact: true })
            .waitFor();
          assert.equal(await page.getByText('Изменение начисления', { exact: true }).count(), 0);
          await page
            .getByRole('combobox', { name: 'Клиент для денежной операции' })
            .fill('Финансовый');
          await page.getByText('Финансовый тест · 70000000000', { exact: true }).click();
          await page
            .getByRole('button', { name: 'Возврат и доступные средства', exact: true })
            .click();
          await page.getByRole('combobox', { name: 'Денежная операция', exact: true }).focus();
          await page.keyboard.press('ArrowDown');
          const paymentOptions = await waitForOperationOptions();
          assert.equal(paymentOptions.count, 2);
          assert.equal(
            await page.getByRole('option', { name: 'Оплата аренды', exact: true }).count(),
            0,
          );
          assert.equal(
            await page.getByRole('option', { name: 'Получение залога', exact: true }).count(),
            0,
          );
          await page.keyboard.press('Escape');
          await page
            .getByRole('textbox', { name: 'Причина денежной операции' })
            .fill('Сохранить ввод');
          await page.waitForTimeout(5500);
          assert.equal(
            await page.getByRole('textbox', { name: 'Причина денежной операции' }).inputValue(),
            'Сохранить ввод',
          );
          await page.screenshot({
            path: path.join(root, '.runtime/stage5-payments.png'),
            fullPage: true,
          });
          await page.goto(origin + '/calendar?date=2026-12-01&booking=' + existing);
          await page.getByText('Бронь №' + existing, { exact: true }).waitFor();
          assert.equal(await page.getByText('До выдачи', { exact: true }).count(), 0);
          await page.getByText('Денежные операции', { exact: true }).click();
          await page.getByText('Плановая стоимость брони', { exact: true }).waitFor();
          assert.equal(await page.getByText('К оплате', { exact: true }).count(), 0);
          await page
            .getByRole('button', { name: 'Возврат и доступные средства', exact: true })
            .click();
          await page.getByRole('combobox', { name: 'Денежная операция', exact: true }).focus();
          await page.keyboard.press('ArrowDown');
          const bookingPaymentOptions = await waitForOperationOptions();
          assert.equal(bookingPaymentOptions.count, 2);
          await page.keyboard.press('Escape');
          await page.setViewportSize({ width: 390, height: 844 });
          await page.waitForFunction(() => {
            const r = document.querySelector('.ant-drawer-content-wrapper').getBoundingClientRect();
            return r.x >= 0 && r.right <= innerWidth + 1;
          });
          await page.screenshot({
            path: path.join(root, '.runtime/stage5-mobile.png'),
            fullPage: true,
          });
          assert.deepEqual(errors, []);
        } finally {
          if (browser) await browser.close();
          for (const child of children) child.kill();
        }
      },
    );
  },
);
