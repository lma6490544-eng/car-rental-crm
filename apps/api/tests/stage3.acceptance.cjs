const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net'),
  path = require('node:path'),
  fs = require('node:fs/promises');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const { passwordHash } = require('../dist/platform/security');
const port = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

test('Stage 3 PostgreSQL, HTTP and browser acceptance', { timeout: 240000 }, async (t) => {
  const name = 'crm_stage3_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL),
    admin = new Pool({ connectionString: url.toString() });
  url.pathname = '/' + name;
  let pool, browser;
  const children = [],
    logs = [];
  t.after(async () => {
    if (browser) await browser.close();
    for (const child of children)
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      }
    if (pool) await pool.end();
    assert.match(name, /^crm_stage3_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  });
  await admin.query('CREATE DATABASE "' + name + '"');
  pool = new Pool({ connectionString: url.toString() });
  await migrate(drizzle(pool), { migrationsFolder: path.join(root, 'apps/api/drizzle') });
  const password = 'Test-' + randomBytes(18).toString('base64url');
  const actor = (
    await pool.query(
      "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Тестовый менеджер','manager',$1,'manager') RETURNING id",
      [await passwordHash(password)],
    )
  ).rows[0].id;
  const apiPort = await port(),
    webPort = await port(),
    origin = 'http://127.0.0.1:' + webPort;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    API_PORT: String(apiPort),
    APP_ORIGINS: origin,
  };
  for (const [script, args, cwd] of [
    [path.join(root, 'apps/api/dist/main.js'), [], path.join(root, 'apps/api')],
    [
      path.join(root, 'node_modules/vite/bin/vite.js'),
      ['--host', '127.0.0.1', '--port', String(webPort)],
      path.join(root, 'apps/web'),
    ],
  ]) {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdout.on('data', (d) => logs.push(d.toString()));
    child.stderr.on('data', (d) => logs.push(d.toString()));
  }
  for (const address of [origin + '/api/v1/health', origin]) {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(address)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready, logs.join(''));
  }
  let session;
  async function req(
    route,
    { method = 'GET', body, key = randomUUID(), headers = {}, anonymous = false } = {},
  ) {
    const response = await fetch(origin + '/api/v1' + route, {
      method,
      headers: {
        ...(method === 'GET'
          ? {}
          : { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key }),
        ...(!anonymous && session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf } : {}),
        ...headers,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    return { status: response.status, data: await response.json(), response };
  }
  const login = await req('/auth/login', { method: 'POST', body: { login: 'manager', password } });
  assert.equal(login.status, 200);
  session = {
    cookie: login.response.headers.get('set-cookie').split(';')[0],
    csrf: login.data.csrfToken,
  };
  const catalog = (await req('/pricing/catalog')).data;
  const economy = catalog.items.find((g) => g.code === 'economy').id,
    comfort = catalog.items.find((g) => g.code === 'comfort').id;
  const initial = {
    operationKind: 'initial',
    pricingGroupId: economy,
    startAt: '2026-11-01T10:00:00+03:00',
    contractDays: 7,
    dailyMileagePackageKm: 250,
  };
  const post = (body, key) => req('/pricing/quote', { method: 'POST', body, key });
  const confirm = (q, confirmedOverrides = []) =>
    req('/pricing/quotes/' + q.id + '/confirm', {
      method: 'POST',
      body: { expectedVersion: q.version, confirmedOverrides },
    });
  let seven, ten, eight;
  await t.test('protected routes, CSRF, strict DTO, unconfigured groups', async () => {
    assert.equal(catalog.items.length, 5);
    assert.equal((await req('/pricing/catalog', { anonymous: true })).status, 401);
    assert.equal(
      (
        await req('/pricing/quote', {
          method: 'POST',
          body: initial,
          headers: { 'X-CSRF-Token': 'wrong' },
        })
      ).status,
      403,
    );
    assert.equal((await post({ ...initial, dailyMileagePackageKm: 99 })).status, 400);
    assert.equal((await post({ ...initial, contractDays: 1.5 })).status, 400);
    assert.equal((await post({ ...initial, finalTotalRub: '1' })).status, 400);
    const legacy = (
      await pool.query("INSERT INTO pricing_groups(name) VALUES ('Старая без ставки') RETURNING id")
    ).rows[0].id;
    assert.equal(
      (await post({ ...initial, pricingGroupId: legacy })).data.code,
      'TARIFF_NOT_CONFIGURED',
    );
  });
  await t.test('concurrent idempotency, snapshot, audit, outbox and lookup', async () => {
    const key = randomUUID(),
      both = await Promise.all([post(initial, key), post(initial, key)]);
    assert.equal(both[0].status, 201);
    assert.equal(both[1].status, 201);
    assert.equal(both[0].data.id, both[1].data.id);
    seven = both[0].data;
    assert.equal(seven.calculation.finalTotalRub, '11900');
    assert.equal((await post({ ...initial, contractDays: 8 }, key)).status, 409);
    assert.equal(
      (await req('/operations/by-key?command=pricing.quote&key=' + key)).data.result.id,
      seven.id,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE entity_type='pricing_quote' AND entity_id=$1",
          [seven.id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM outbox_jobs WHERE business_key=$1', [
          'pricing.quoted:' + seven.id,
        ])
      ).rows[0].n,
      1,
    );
  });
  await t.test('atomic rollback if outbox insert fails', async () => {
    const before = (await req('/pricing/quotes')).data.total;
    await pool.query(
      "CREATE FUNCTION reject_pricing_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='pricing.quoted' THEN RAISE EXCEPTION 'test outbox failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_pricing_job BEFORE INSERT ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION reject_pricing_job()",
    );
    try {
      const key = randomUUID();
      assert.equal((await post(initial, key)).status, 500);
      assert.equal((await req('/pricing/quotes')).data.total, before);
      assert.equal((await req('/operations/by-key?command=pricing.quote&key=' + key)).status, 404);
    } finally {
      await pool.query(
        'DROP TRIGGER reject_pricing_job ON outbox_jobs; DROP FUNCTION reject_pricing_job()',
      );
    }
  });
  await t.test(
    'confirmation race, no duplicate confirmation, 7+3 =>8 and immutable sources',
    async () => {
      const original = structuredClone(seven.calculation);
      const races = await Promise.all([confirm(seven), confirm(seven)]);
      assert.deepEqual(races.map((r) => r.status).sort(), [201, 409]);
      seven = races.find((r) => r.status === 201).data;
      assert.deepEqual(seven.calculation, original);
      ten = (
        await post({
          operationKind: 'extension',
          baseQuoteId: seven.id,
          expectedTermsVersion: 2,
          addedDays: 3,
        })
      ).data;
      assert.equal(ten.calculation.finalTotalRub, '16700');
      ten = (await confirm(ten)).data;
      eight = (
        await post({
          operationKind: 'early_return',
          baseQuoteId: ten.id,
          expectedTermsVersion: 2,
          actualReturnAt: '2026-11-09T10:00:00+03:00',
        })
      ).data;
      assert.equal(eight.calculation.finalTotalRub, '13900');
      assert.equal(eight.calculation.effectiveMileageLimitKm, 2000);
      assert.deepEqual((await req('/pricing/quotes/' + seven.id)).data.calculation, original);
      assert.equal(
        (
          await post({
            operationKind: 'extension',
            baseQuoteId: eight.id,
            expectedTermsVersion: 1,
            addedDays: 1,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await post({
            operationKind: 'extension',
            baseQuoteId: seven.id,
            expectedTermsVersion: 1,
            addedDays: 1,
          })
        ).status,
        409,
      );
    },
  );
  await t.test(
    'manual zeros, explicit confirmation, stale quotes, exact money and no business operations',
    async () => {
      const q = (
        await post({
          ...initial,
          overrides: { customDailyRateRub: '0', mileageLimitKm: 0, reason: 'Согласовано' },
        })
      ).data;
      assert.equal((await confirm(q)).data.code, 'OVERRIDES_CONFIRMATION_REQUIRED');
      const yes = await confirm(q, ['price', 'mileage']);
      assert.equal(yes.status, 201);
      assert.equal(yes.data.calculation.finalTotalRub, '0');
      const snapshot = (await pool.query('SELECT snapshot FROM pricing_quotes WHERE id=$1', [q.id]))
        .rows[0].snapshot;
      assert.equal(snapshot.overrides.reason, 'Согласовано');
      const old = (await post(initial)).data;
      await pool.query(
        "UPDATE pricing_quotes SET expires_at=now()-interval '1 second' WHERE id=$1",
        [old.id],
      );
      assert.equal((await confirm(old)).data.code, 'QUOTE_STALE');
      const big = (
        await post({
          ...initial,
          contractDays: 1,
          overrides: { customDailyRateRub: '9007199254740993', reason: 'Точность' },
        })
      ).data;
      assert.equal(
        (await req('/pricing/quotes/' + big.id)).data.calculation.finalTotalRub,
        '9007199254740993',
      );
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('rentals','receivables')",
          )
        ).rows[0].n,
        0,
      );
      for (const table of [
        'financial_operations',
        'finance_charges',
        'finance_external',
        'finance_allocations',
      ])
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n,
          0,
          table + ' is not populated by standalone Pricing',
        );
    },
  );
  await t.test(
    'extension rejects edits to signed days and preserves the confirmed source in PostgreSQL',
    async () => {
      const created = await post({
        ...initial,
        contractDays: 4,
        nonBillableDays: [{ dayIndex: 2, reason: 'Подарили' }],
        overrides: { customDailyRateRub: '1200', discountBps: 1000, reason: 'Цена и скидка' },
      });
      assert.equal(created.status, 201);
      const source = (await confirm(created.data, ['price', 'discount'])).data;
      const original = structuredClone(source.calculation);
      const bad = await post({
        operationKind: 'extension',
        baseQuoteId: source.id,
        expectedTermsVersion: 2,
        addedDays: 7,
        nonBillableDays: [],
      });
      assert.equal(bad.status, 422);
      assert.equal(bad.data.code, 'AGREED_DAYS_LOCKED');
      const extended = await post({
        operationKind: 'extension',
        baseQuoteId: source.id,
        expectedTermsVersion: 2,
        addedDays: 7,
      });
      assert.equal(extended.status, 201);
      assert.equal(extended.data.calculation.finalTotalRub, '11640');
      assert.deepEqual(extended.data.calculation.dayLines.slice(0, 4), source.calculation.dayLines);
      assert.equal((await confirm(extended.data, ['price', 'discount'])).status, 201);
      assert.deepEqual((await req('/pricing/quotes/' + source.id)).data.calculation, original);
      const explicit = await post({
        operationKind: 'non_billable_day',
        baseQuoteId: source.id,
        expectedTermsVersion: 2,
        nonBillableDays: [],
      });
      assert.equal(explicit.status, 201);
      assert.equal(explicit.data.calculation.finalTotalRub, '4320');
    },
  );
  await t.test(
    'early return uses full days plus MAX(hours,mileage) and preserves source snapshot',
    async () => {
      const q = (
        await post({
          ...initial,
          contractDays: 11,
          overrides: { customDailyRateRub: '1200', reason: 'Цена' },
        })
      ).data;
      const source = (await confirm(q, ['price'])).data;
      const body = {
        operationKind: 'early_return',
        baseQuoteId: source.id,
        expectedTermsVersion: 2,
        actualReturnAt: '2026-11-07T13:00:00+03:00',
      };
      const early = await post(body);
      assert.equal(early.status, 201);
      assert.equal(early.data.calculation.contractDays, 6);
      assert.equal(early.data.calculation.finalTotalRub, '7200');
      assert.equal(early.data.calculation.lateCandidateRub, '900');
      assert.equal(early.data.calculation.totalWithExtrasRub, '8100');
      assert.equal(early.data.calculation.refundOrCreditIfFullyPaidRub, '5100');
      assert.equal((await confirm(early.data, ['price'])).status, 201);
      const mileage = await post({
        ...body,
        usages: [
          {
            key: 'Автомобиль 1',
            bodyType: 'sedan',
            odometerOutKm: 1000,
            odometerInKm: 2700,
            fuelOutEighths: 8,
            fuelInEighths: 8,
          },
        ],
      });
      assert.equal(mileage.data.calculation.selectedSurchargeRub, '1400');
      assert.equal(mileage.data.calculation.totalWithExtrasRub, '8600');
      const usage = (km) => ({
        key: 'Автомобиль 1',
        bodyType: 'sedan',
        odometerOutKm: 1000,
        odometerInKm: 1000 + km,
        fuelOutEighths: 8,
        fuelInEighths: 8,
      });
      const sameDay = await post({
        ...body,
        actualReturnAt: '2026-11-01T13:00:00+03:00',
        usages: [usage(250)],
      });
      assert.equal(sameDay.status, 201);
      assert.equal(sameDay.data.calculation.contractDays, 0);
      assert.equal(sameDay.data.calculation.totalWithExtrasRub, '900');
      assert.equal(sameDay.data.calculation.calculatedMileageLimitKm, 250);
      assert.equal(sameDay.data.calculation.effectiveMileageLimitKm, 250);
      assert.equal(sameDay.data.calculation.mileageCandidateRub, '0');
      const extra = await post({
        ...body,
        actualReturnAt: '2026-11-01T13:00:00+03:00',
        usages: [usage(400)],
      });
      assert.equal(extra.data.calculation.mileageCandidateRub, '1050');
      assert.equal(extra.data.calculation.selectedSurchargeRub, '1050');
      assert.deepEqual(
        (await req('/pricing/quotes/' + source.id)).data.calculation,
        source.calculation,
      );
    },
  );
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }),
    page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const output = path.join(root, '.runtime');
  await fs.mkdir(output, { recursive: true });
  await page.goto(origin + '/pricing');
  await page.getByLabel('Логин', { exact: true }).fill('manager');
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await t.test(
    'browser calculates, preserves input under polling, confirms and previews extension',
    async () => {
      await page.getByRole('heading', { name: 'Расчёт цены', exact: true }).waitFor();
      if (process.env.PRICING_VISUAL_MODE) {
        const screenshotOptions = {
          animations: 'disabled',
          mask: [page.getByLabel('Начало (Москва)', { exact: true })],
        };
        const baseline = path.join(output, 'pricing-refactor-baseline.png');
        const layout = page.locator('.ant-row').first();
        if (process.env.PRICING_VISUAL_MODE === 'record') {
          await layout.screenshot({ ...screenshotOptions, path: baseline });
        } else {
          assert.deepEqual(
            await layout.screenshot(screenshotOptions),
            await fs.readFile(baseline),
            'pricing editor must match the pre-refactor visual baseline',
          );
        }
      }
      await page.getByLabel('Тарифная группа', { exact: true }).click();
      await page.getByTitle('Nexia / Fabia / Logan', { exact: true }).click();
      await page.getByLabel('Договорные сутки (по 24 часа)', { exact: true }).fill('7');
      await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
      await page.getByText('11 900 ₽', { exact: true }).first().waitFor();
      await page.getByRole('button', { name: 'Подтвердить снимок расчёта', exact: true }).click();
      await page.getByText('Снимок подтверждён', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Продление', exact: true }).click();
      await page.getByLabel('Добавить суток', { exact: true }).fill('3');
      await new Promise((r) => setTimeout(r, 5200));
      assert.equal(await page.getByLabel('Добавить суток', { exact: true }).inputValue(), '3');
      assert.match(await page.locator('button[type=submit]').ariaSnapshot(), /button "Рассчитать"/);
      await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
      await page.getByText('16 700 ₽', { exact: true }).first().waitFor();
      await page.getByText(/Первые 7 суток сохранены/).waitFor();
      await page.screenshot({ path: path.join(output, 'stage3-extension.png'), fullPage: true });
    },
  );
  await t.test(
    'browser daily price multiplies paid days without a separate late rate',
    async () => {
      await page.getByRole('button', { name: 'Новый расчёт', exact: true }).click();
      await page.getByLabel('Тарифная группа', { exact: true }).click();
      await page.getByTitle('Nexia / Fabia / Logan', { exact: true }).click();
      await page
        .getByRole('checkbox', { name: 'Задать ручные условия этой редакции', exact: true })
        .check();
      await page.getByLabel('Собственная цена за сутки, ₽', { exact: true }).fill('1200');
      await page
        .getByLabel('Причина ручных условий', { exact: true })
        .fill('Индивидуальная цена за сутки');
      assert.equal(
        await page
          .getByLabel('Согласованная суточная ставка опоздания, ₽', { exact: true })
          .count(),
        0,
      );
      const response = page.waitForResponse(
        (r) => r.url().endsWith('/pricing/quote') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
      const result = await (await response).json();
      assert.equal(result.calculation.finalTotalRub, '3600');
      assert.equal(result.calculation.lateDailyRateRub, '1200');
      await page.getByText('3 600 ₽', { exact: true }).first().waitFor();
      await page.screenshot({ path: path.join(output, 'stage3-daily-price.png'), fullPage: true });
    },
  );
  await t.test(
    'browser extension keeps agreed free days when no new free days are entered',
    async () => {
      await page.getByRole('button', { name: 'Новый расчёт', exact: true }).click();
      await page.getByLabel('Тарифная группа', { exact: true }).click();
      await page.getByTitle('Polo / Solaris / Almera', { exact: true }).click();
      await page.getByLabel('Договорные сутки (по 24 часа)', { exact: true }).fill('4');
      await page.getByLabel('Сутки «Вых»', { exact: true }).fill('2');
      await page.getByLabel('Причина новых «Вых»', { exact: true }).fill('Подарили');
      await page
        .getByRole('checkbox', { name: 'Задать ручные условия этой редакции', exact: true })
        .check();
      await page.getByLabel('Собственная цена за сутки, ₽', { exact: true }).fill('1200');
      await page.getByLabel('Причина ручных условий', { exact: true }).fill('Согласованная цена');
      const initialResponse = page.waitForResponse(
        (r) => r.url().endsWith('/pricing/quote') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
      const source = await (await initialResponse).json();
      await page.getByRole('checkbox', { name: /Подтверждаю ручные условия:/ }).check();
      await page.getByRole('button', { name: 'Подтвердить снимок расчёта', exact: true }).click();
      await page.getByText('Снимок подтверждён', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Продление', exact: true }).click();
      await page.getByLabel('Добавить суток', { exact: true }).fill('7');
      assert.equal(
        await page.getByLabel('«Вых» среди добавленных суток', { exact: true }).inputValue(),
        '',
      );
      await page.getByText('Согласованные «Вых»: №2 — Подарили.', { exact: true }).waitFor();
      const extensionResponse = page.waitForResponse(
        (r) => r.url().endsWith('/pricing/quote') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
      const extended = await (await extensionResponse).json();
      assert.equal(extended.calculation.finalTotalRub, '12000');
      assert.deepEqual(extended.calculation.dayLines.slice(0, 4), source.calculation.dayLines);
      await page.getByRole('checkbox', { name: /Подтверждаю ручные условия:/ }).check();
      await page.getByRole('button', { name: 'Подтвердить снимок расчёта', exact: true }).click();
      await page.getByText('Снимок подтверждён', { exact: true }).waitFor();
      assert.deepEqual(
        (await req('/pricing/quotes/' + source.id)).data.calculation,
        source.calculation,
      );
      await page.screenshot({
        path: path.join(output, 'stage3-protected-extension.png'),
        fullPage: true,
      });
    },
  );
  await t.test(
    'browser early return shows six days, three hours and refund/credit reduction',
    async () => {
      await page.getByRole('button', { name: 'Новый расчёт', exact: true }).click();
      await page.getByLabel('Тарифная группа', { exact: true }).click();
      await page.getByTitle('Polo / Solaris / Almera', { exact: true }).click();
      await page.getByLabel('Начало (Москва)', { exact: true }).fill('2026-11-13T12:06');
      await page.getByLabel('Договорные сутки (по 24 часа)', { exact: true }).fill('11');
      await page
        .getByRole('checkbox', { name: 'Задать ручные условия этой редакции', exact: true })
        .check();
      await page.getByLabel('Собственная цена за сутки, ₽', { exact: true }).fill('1200');
      await page.getByLabel('Причина ручных условий', { exact: true }).fill('Цена за сутки');
      await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
      await page.getByRole('checkbox', { name: /Подтверждаю ручные условия:/ }).check();
      await page.getByRole('button', { name: 'Подтвердить снимок расчёта', exact: true }).click();
      await page.getByText('Снимок подтверждён', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Досрочный возврат', exact: true }).click();
      await page
        .getByLabel('Фактический возврат (Москва)', { exact: true })
        .fill('2026-11-19T15:06');
      const response = page.waitForResponse(
        (r) => r.url().endsWith('/pricing/quote') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
      const q = await (await response).json();
      assert.equal(q.calculation.contractDays, 6);
      assert.equal(q.calculation.lateCandidateRub, '900');
      assert.equal(q.calculation.totalWithExtrasRub, '8100');
      assert.equal(q.calculation.refundOrCreditIfFullyPaidRub, '5100');
      await page.getByText('Доплата за часы', { exact: true }).waitFor();
      await page.getByText('8 100 ₽', { exact: true }).first().waitFor();
      await page.getByText('5 100 ₽', { exact: true }).first().waitFor();
      await page.screenshot({ path: path.join(output, 'stage3-early-hours.png'), fullPage: true });
      await page
        .getByLabel('Фактический возврат (Москва)', { exact: true })
        .fill('2026-11-13T15:06');
      const sameDayResponse = page.waitForResponse(
        (r) => r.url().endsWith('/pricing/quote') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
      const sameDay = await (await sameDayResponse).json();
      assert.equal(sameDay.calculation.contractDays, 0);
      assert.equal(sameDay.calculation.calculatedMileageLimitKm, 250);
      assert.equal(sameDay.calculation.effectiveMileageLimitKm, 250);
      assert.equal(sameDay.calculation.finalTotalRub, '0');
      assert.equal(sameDay.calculation.totalWithExtrasRub, '900');
      await page
        .getByText('Полных суток ещё нет: сохраняется минимум один суточный пакет 250 км.', {
          exact: false,
        })
        .waitFor();
      await page.screenshot({
        path: path.join(output, 'stage3-early-minimum-mileage.png'),
        fullPage: true,
      });
    },
  );
  await t.test('browser manual zeros and lost response recover by same key', async (t) => {
    const attemptedQuotes = [];
    let releaseRetry;
    const retryGate = new Promise((resolve) => {
      releaseRetry = resolve;
    });
    const recoveryTrace = [];
    const failedQuote = (request) => {
      if (request.url().endsWith('/pricing/quote'))
        recoveryTrace.push({ event: 'requestfailed', failure: request.failure()?.errorText });
    };
    page.on('requestfailed', failedQuote);
    t.after(() => page.off('requestfailed', failedQuote));
    const quotesBefore = Number(
      (await pool.query('SELECT count(*) AS n FROM pricing_quotes WHERE created_by=$1', [actor]))
        .rows[0].n,
    );
    await page.getByRole('button', { name: 'Новый расчёт', exact: true }).click();
    await page.getByLabel('Тарифная группа', { exact: true }).click();
    await page.getByTitle('Nexia / Fabia / Logan', { exact: true }).click();
    await page
      .getByRole('checkbox', { name: 'Задать ручные условия этой редакции', exact: true })
      .check();
    await page.getByLabel('Собственная цена за сутки, ₽', { exact: true }).fill('0');
    await page.getByLabel('Индивидуальный общий лимит, км', { exact: true }).fill('0');
    await page
      .getByLabel('Причина ручных условий', { exact: true })
      .fill('Бесплатная тестовая аренда');
    assert.match(await page.locator('button[type=submit]').ariaSnapshot(), /button "Рассчитать"/);
    await page.route('**/api/v1/pricing/quote', async (route) => {
      attemptedQuotes.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      const response = await route.fetch();
      recoveryTrace.push({ event: 'committed-response', status: response.status() });
      if (attemptedQuotes.length === 2) await retryGate;
      await route.abort('failed');
      recoveryTrace.push({ event: 'aborted-response' });
    });
    await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
    await page.getByText('Результат пока неизвестен', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Повторить отправку', exact: true }).click();
    try {
      await page.locator('.ant-alert-warning .ant-btn-loading').first().waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Проверить результат', exact: true }).count(),
        1,
        'recovery action must keep its accessible name while retry is pending',
      );
      assert.equal(
        await page.getByRole('button', { name: 'Повторить отправку', exact: true }).count(),
        1,
        'retry action must keep its accessible name while retry is pending',
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Проверить результат', exact: true })
          .getAttribute('aria-busy'),
        'true',
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Повторить отправку', exact: true })
          .getAttribute('aria-busy'),
        'true',
      );
    } finally {
      releaseRetry();
    }
    await page
      .getByRole('button', { name: 'Повторить отправку', exact: true })
      .and(page.locator('[aria-busy="false"]'))
      .waitFor();
    assert.deepEqual(
      recoveryTrace
        .filter((event) => event.event === 'committed-response')
        .map((event) => event.status),
      [201, 201],
      'both lost responses must follow successful server commits',
    );
    assert.equal(attemptedQuotes.length, 2);
    assert.ok(attemptedQuotes[0].key);
    assert.deepEqual(
      attemptedQuotes[1],
      attemptedQuotes[0],
      'retry must preserve the payload and idempotency key',
    );
    try {
      await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
    } catch (error) {
      t.diagnostic(
        JSON.stringify({
          recoveryTrace,
          warning: await page
            .locator('.ant-alert-warning')
            .evaluateAll((alerts) => alerts.map((alert) => alert.textContent)),
          buttons: await page.locator('.ant-alert-warning button').evaluateAll((buttons) =>
            buttons.map((button) => ({
              text: button.textContent,
              html: button.outerHTML,
            })),
          ),
        }),
      );
      throw error;
    } finally {
      page.off('requestfailed', failedQuote);
    }
    await page.getByText('Результат пока неизвестен', { exact: true }).waitFor({ state: 'hidden' });
    await page.unroute('**/api/v1/pricing/quote');
    assert.equal(
      Number(
        (await pool.query('SELECT count(*) AS n FROM pricing_quotes WHERE created_by=$1', [actor]))
          .rows[0].n,
      ),
      quotesBefore + 1,
      'two lost responses and recovery must create exactly one quote',
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM idempotency_records WHERE actor_id=$1 AND command='pricing.quote' AND key=$2",
          [actor, attemptedQuotes[0].key],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      await page
        .getByRole('button', { name: 'Подтвердить снимок расчёта', exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole('checkbox', { name: /Подтверждаю ручные условия:/ }).check();
    await page.getByRole('button', { name: 'Подтвердить снимок расчёта', exact: true }).click();
    await page.getByText('Снимок подтверждён', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'stage3-zero.png'), fullPage: true });
  });
  await t.test('browser mobile layout and no runtime errors', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'stage3-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
  });
});
