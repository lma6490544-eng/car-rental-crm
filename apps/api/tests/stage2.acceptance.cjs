const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const { passwordHash } = require('../dist/platform/security');
const { seedCatalog } = require('../dist/catalog/seed');
const port = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
test('Stage 2 PostgreSQL, HTTP and browser acceptance', { timeout: 240000 }, async (t) => {
  const name = 'crm_stage2_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Pool({ connectionString: url.toString() });
  url.pathname = '/' + name;
  let pool, browser;
  const children = [];
  const logs = [];
  t.after(async () => {
    if (browser) await browser.close();
    for (const child of children)
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      }
    if (pool) await pool.end();
    assert.match(name, /^crm_stage2_test_[a-f0-9]{16}$/);
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  });
  await admin.query('CREATE DATABASE "' + name + '"');
  pool = new Pool({ connectionString: url.toString() });
  await migrate(drizzle(pool), { migrationsFolder: path.join(root, 'apps/api/drizzle') });
  const seedClient = await pool.connect();
  try {
    await seedClient.query('BEGIN');
    await seedCatalog(seedClient, true);
    await seedCatalog(seedClient, true);
    await seedClient.query('COMMIT');
  } finally {
    seedClient.release();
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM vehicles')).rows[0].n, 4);
  const password = 'Test-' + randomBytes(18).toString('base64url');
  await pool.query(
    "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Тестовый менеджер','manager',$1,'manager')",
    [await passwordHash(password)],
  );
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
  const base = origin + '/api/v1';
  let session;
  async function req(
    route,
    { method = 'GET', body, key = randomUUID(), headers = {}, anonymous = false } = {},
  ) {
    const response = await fetch(base + route, {
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
  let customer, vehicle, model;
  await t.test('manager access, protected reads, strict DTO and minimal customer', async () => {
    assert.equal((await req('/customers', { anonymous: true })).status, 401);
    assert.equal((await req('/admin/users')).status, 403);
    assert.equal(
      (
        await req('/customers', {
          method: 'POST',
          body: { type: 'individual', displayName: 'Тест', role: 'admin' },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req('/customers', {
          method: 'POST',
          headers: { 'X-CSRF-Token': 'wrong' },
          body: { type: 'individual', displayName: 'Тест' },
        })
      ).status,
      403,
    );
    const created = await req('/customers', {
      method: 'POST',
      body: { type: 'individual', displayName: 'Проверка клиента' },
    });
    assert.equal(created.status, 201);
    customer = created.data;
    const detail = await req('/customers/' + customer.id);
    assert.equal(detail.data.documentReadiness.ready, false);
    assert.equal(detail.data.phone, '');
    assert.equal((await req('/customers?q=Проверка')).data.items[0].details, undefined);
    assert.equal(
      (
        await req('/customers', {
          method: 'POST',
          body: { type: 'individual', displayName: 'Проверка клиента' },
        })
      ).status,
      201,
    );
  });
  await t.test('concurrent idempotency and payload mismatch; lookup owned by manager', async () => {
    const key = randomUUID(),
      body = { type: 'company', displayName: 'Тест повторов', inn: '1234567890' };
    const values = await Promise.all([
      req('/customers', { method: 'POST', body, key }),
      req('/customers', { method: 'POST', body, key }),
    ]);
    assert.equal(values[0].status, 201);
    assert.equal(values[0].data.id, values[1].data.id);
    assert.equal(
      (await req('/customers', { method: 'POST', body: { ...body, displayName: 'Другой' }, key }))
        .status,
      409,
    );
    assert.equal(
      (await req('/operations/by-key?command=customers.create&key=' + key)).data.result.id,
      values[0].data.id,
    );
  });
  await t.test('version race, block reason, notes and preserved history', async () => {
    const results = await Promise.all(
      ['Первый', 'Второй'].map((displayName) =>
        req('/customers/' + customer.id, {
          method: 'PATCH',
          body: { expectedVersion: 1, data: { type: 'individual', displayName } },
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await req('/customers/' + customer.id + '/block', {
          method: 'POST',
          body: { expectedVersion: 2, reason: '' },
        })
      ).status,
      400,
    );
    const blocked = await req('/customers/' + customer.id + '/block', {
      method: 'POST',
      body: { expectedVersion: 2, reason: 'Тестовая причина' },
    });
    assert.equal(blocked.status, 201);
    const note = await req('/customers/' + customer.id + '/notes', {
      method: 'POST',
      body: { expectedVersion: 3, text: 'Предупреждение' },
    });
    assert.equal(note.status, 201);
    assert.equal(
      (
        await req('/customers/' + customer.id + '/notes/' + note.data.id + '/resolve', {
          method: 'POST',
          body: { expectedVersion: 4 },
        })
      ).status,
      201,
    );
    assert.equal((await req('/customers/' + customer.id + '/notes')).data.items[0].isActive, false);
    assert.equal(
      (
        await req('/customers/' + customer.id + '/unblock', {
          method: 'POST',
          body: { expectedVersion: 5 },
        })
      ).status,
      201,
    );
    assert.equal((await req('/customers/' + customer.id + '/history')).data.items.length, 6);
  });
  await t.test('outbox failure rolls back entity, audit and key result', async () => {
    await pool.query(
      "CREATE FUNCTION stage2_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='customers.created' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      'CREATE TRIGGER stage2_fail BEFORE INSERT ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION stage2_fail()',
    );
    const key = randomUUID();
    try {
      assert.equal(
        (
          await req('/customers', {
            method: 'POST',
            key,
            body: { type: 'individual', displayName: 'Откат' },
          })
        ).status,
        500,
      );
    } finally {
      await pool.query('DROP TRIGGER stage2_fail ON outbox_jobs');
    }
    assert.equal((await req('/customers?q=Откат')).data.total, 0);
    assert.equal((await req('/operations/by-key?command=customers.create&key=' + key)).status, 404);
  });
  await t.test(
    'vehicle references, canonical uniqueness, body and mileage validation',
    async () => {
      model = (await req('/vehicle-models')).data.items[0];
      assert.ok(model.pricingGroupName);
      assert.equal((await req('/equivalence-groups')).data.items[0].modelIds.length, 2);
      vehicle = {
        modelId: model.id,
        plate: 'а 123 вс 78',
        vin: '',
        year: 2024,
        bodyType: 'sedan',
        transmission: 'automatic',
        currentMileageKm: 100,
        nextMaintenanceDueKm: 10000,
        isReady: true,
        needsWash: false,
      };
      const created = await req('/vehicles', { method: 'POST', body: vehicle });
      assert.equal(created.status, 201);
      vehicle.id = created.data.id;
      const { id, ...data } = vehicle;
      assert.equal(
        (await req('/vehicles', { method: 'POST', body: { ...data, plate: 'A123BC78' } })).status,
        409,
      );
      assert.equal(
        (
          await req('/vehicles', {
            method: 'POST',
            body: { ...data, plate: 'TEST999', bodyType: 'bus' },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await req('/vehicles', {
            method: 'POST',
            body: { ...data, plate: 'TEST999', currentMileageKm: -1 },
          })
        ).status,
        400,
      );
      assert.equal((await req('/vehicles/' + id)).data.tankLiters, 40);
      assert.equal((await req('/vehicles/' + id)).data.transmission, 'automatic');
      assert.equal(
        (await req('/vehicles', { method: 'POST', body: { ...data, transmission: 'other' } }))
          .status,
        400,
      );
      assert.equal((await req('/vehicles?bodyType=cargo_minibus')).data.items[0].tankLiters, 80);
    },
  );
  await t.test('vehicle history, version conflict, archive and unique reservation', async () => {
    const { id, ...data } = vehicle;
    const update = { ...data, currentMileageKm: 150, nextMaintenanceDueKm: 11000 };
    assert.equal(
      (
        await req('/vehicles/' + id, {
          method: 'PATCH',
          body: { data: update, expectedVersion: 1, reason: 'Уточнение показания' },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req('/vehicles/' + id, {
          method: 'PATCH',
          body: { data: update, expectedVersion: 1, reason: 'Старая версия' },
        })
      ).status,
      409,
    );
    const history = (await req('/vehicles/' + id + '/history')).data.items;
    assert.equal(history[0].details.before.current_mileage_km, 100);
    assert.equal(history[0].details.after.currentMileageKm, 150);
    assert.equal(
      (
        await req('/vehicles/' + id + '/archive', {
          method: 'POST',
          body: { expectedVersion: 2, reason: 'Тест архива' },
        })
      ).status,
      201,
    );
    assert.ok((await req('/vehicles/' + id)).data.archivedAt);
    assert.equal((await req('/vehicles?archived=true')).data.total, 1);
    assert.equal((await req('/vehicles', { method: 'POST', body: data })).status, 409);
  });
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const output = path.join(root, '.runtime');
  await fs.mkdir(output, { recursive: true });
  await page.goto(origin + '/clients');
  await page.getByLabel('Логин', { exact: true }).fill('manager');
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await t.test(
    'browser creates minimal client, lost response recovers without duplicate',
    async () => {
      await page.getByRole('button', { name: 'Добавить клиента' }).click();
      await page.getByLabel('ФИО', { exact: true }).fill('Браузерный клиент');
      await page.getByLabel('Телефон', { exact: true }).fill('8 (999) 123-45-67');
      await page.route('**/api/v1/customers', async (route) => {
        if (route.request().method() === 'POST') {
          await route.fetch();
          await route.abort('failed');
        } else await route.continue();
      });
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      try {
        await page.getByText('Результат пока неизвестен', { exact: true }).waitFor();
      } catch (e) {
        await page.screenshot({
          path: path.join(output, 'stage2-create-failure.png'),
          fullPage: true,
        });
        throw e;
      }
      await page.getByRole('button', { name: 'Проверить результат' }).click();
      await page.getByRole('heading', { name: 'Браузерный клиент', exact: true }).waitFor();
      await page.unroute('**/api/v1/customers');
      assert.equal((await req('/customers?q=Браузерный клиент')).data.total, 1);
      assert.equal(
        (await req('/customers?q=Браузерный клиент')).data.items[0].phone,
        '+79991234567',
      );
    },
  );
  await t.test('polling detects other operator and preserves open form', async () => {
    const id = page.url().split('/').pop();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.getByLabel('ФИО', { exact: true }).fill('Несохранённый ввод');
    assert.equal(
      (
        await req('/customers/' + id, {
          method: 'PATCH',
          body: {
            expectedVersion: 1,
            data: { type: 'individual', displayName: 'Другой оператор' },
          },
        })
      ).status,
      200,
    );
    await page
      .getByText('Запись изменена другим сотрудником. Ваш ввод сохранён.', { exact: true })
      .waitFor({ timeout: 12000 });
    assert.equal(await page.getByLabel('ФИО', { exact: true }).inputValue(), 'Несохранённый ввод');
    assert.equal(
      await page.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({ path: path.join(output, 'stage2-conflict.png'), fullPage: true });
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('heading', { name: 'Другой оператор', exact: true }).waitFor();
  });
  await t.test('fleet list, card, history and return keep filter', async () => {
    await page.goto(origin + '/fleet?bodyType=cargo_minibus&sort=maintenance');
    await page.getByRole('link', { name: /Тест Ford Грузовой/ }).click();
    await page.getByText('80 л', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'История изменений', exact: true }).click();
    await page.getByText('Автомобиль добавлен', { exact: true }).waitFor();
    await page.getByRole('link', { name: '← К автопарку' }).click();
    await page.getByRole('heading', { name: 'Автопарк', exact: true }).waitFor();
    assert.match(page.url(), /bodyType=cargo_minibus/);
    await page.screenshot({ path: path.join(output, 'stage2-fleet.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + '/clients');
    await page.getByRole('heading', { name: 'Клиенты', exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'stage2-mobile.png'), fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  });
  await t.test('browser edits company details, adds note and blocks client', async () => {
    await page.setViewportSize({ width: 1440, height: 960 });
    const company = (await req('/customers?type=company')).data.items[0];
    await page.goto(origin + '/clients/' + company.id);
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.getByLabel('Банк', { exact: true }).fill('Тестовый банк');
    await page.getByLabel('Расчётный счёт', { exact: true }).fill('12345678901234567890');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Тестовый банк', { exact: true }).waitFor();
    assert.equal(
      (await req('/customers/' + company.id)).data.details.account,
      '12345678901234567890',
    );
    await page.getByRole('tab', { name: 'Заметки', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить заметку' }).click();
    await page.getByLabel('Текст заметки').fill('Заметка из браузера');
    const versionBeforeNote = (await req('/customers/' + company.id)).data.version;
    const customerPath = '**/api/v1/customers/' + company.id;
    const releaseCard = Promise.withResolvers();
    const heldCard = Promise.withResolvers();
    const blockRequests = [];
    const recordBlock = (request) => {
      if (
        request.method() === 'POST' &&
        request.url() === base + '/customers/' + company.id + '/block'
      )
        blockRequests.push(request.postDataJSON());
    };
    page.on('request', recordBlock);
    // Notes and the customer card poll independently. Reproduce the ordering
    // where the note is already visible but the card still has its old version.
    await page.route(customerPath, async (route) => {
      const response = await route.fetch();
      const customer = await response.json();
      if (customer.version > versionBeforeNote) {
        heldCard.resolve(customer);
        await releaseCard.promise;
      }
      await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByText('Заметка из браузера', { exact: true }).waitFor();
      const refreshed = await heldCard.promise;
      assert.equal(refreshed.version, versionBeforeNote + 1);
      await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Блокировка клиента', exact: true });
      const expectedVersion = dialog.locator('input[id="expectedVersion"]');
      assert.equal(await expectedVersion.inputValue(), String(versionBeforeNote));
      await page.getByLabel('Причина блокировки').fill('Проверка блокировки');
      releaseCard.resolve();
      await dialog
        .getByText('Запись изменена другим сотрудником. Ваш ввод сохранён.', { exact: true })
        .waitFor();
      t.diagnostic(
        JSON.stringify({
          snapshotVersion: await expectedVersion.inputValue(),
          refreshedVersion: refreshed.version,
          saveDisabled: await dialog
            .getByRole('button', { name: 'Сохранить', exact: true })
            .isDisabled(),
          reason: await page.getByLabel('Причина блокировки').inputValue(),
        }),
      );
      assert.equal(
        await dialog.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(),
        true,
      );
      assert.equal(await expectedVersion.inputValue(), String(versionBeforeNote));
      assert.equal(await page.getByLabel('Причина блокировки').inputValue(), 'Проверка блокировки');
      assert.equal((await req('/customers/' + company.id)).data.isBlocked, false);
      assert.equal(blockRequests.length, 0);
      // Review explicitly, as required for a changed version. Never force-click
      // Save or replace the snapshot/version through test-side DOM mutations.
      await dialog
        .getByRole('button', { name: 'Сохранить мой ввод поверх новой версии', exact: true })
        .click();
      assert.equal(await expectedVersion.inputValue(), String(refreshed.version));
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByText('Причина блокировки: Проверка блокировки', { exact: true }).waitFor();
      assert.deepEqual(blockRequests, [
        { expectedVersion: refreshed.version, reason: 'Проверка блокировки' },
      ]);
      const blocked = (await req('/customers/' + company.id)).data;
      assert.equal(blocked.version, refreshed.version + 1);
      assert.equal(blocked.isBlocked, true);
      assert.equal(blocked.blockedReason, 'Проверка блокировки');
      const notes = (await req('/customers/' + company.id + '/notes')).data.items;
      assert.equal(notes.filter((note) => note.text === 'Заметка из браузера').length, 1);
    } finally {
      releaseCard.resolve();
      await page.unroute(customerPath);
      page.off('request', recordBlock);
    }
  });
  await t.test('browser creates vehicle and corrects mileage with history', async () => {
    await page.goto(origin + '/fleet');
    await page.getByRole('button', { name: 'Добавить автомобиль' }).click();
    await page.getByLabel('Марка', { exact: true }).fill('Браузерная марка');
    await page.getByLabel('Модель', { exact: true }).fill('Модель из формы');
    await page.getByLabel('Тарифная группа', { exact: true }).click();
    await page.getByTitle('Легковые — тест', { exact: true }).click();
    await page.getByLabel('Коробка', { exact: true }).click();
    await page.getByTitle('АКПП', { exact: true }).click();
    await page.getByLabel('Госномер', { exact: true }).fill('А777АА');
    await page.getByLabel('Код региона', { exact: true }).fill('198');
    await page.getByLabel('Следующее ТО, км', { exact: true }).fill('20000');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByRole('heading', { name: /A777AA198/ }).waitFor();
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.getByLabel('Текущий пробег, км', { exact: true }).fill('500');
    await page
      .getByLabel('Комментарий к изменению пробега / ТО', { exact: true })
      .fill('Сверка одометра');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('500 км', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'История изменений', exact: true }).click();
    await page.getByText('Сверка одометра', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'stage2-vehicle.png'), fullPage: true });
  });
  await t.test(
    'new validations, automatic reference deduplication and service transactions',
    async () => {
      for (const data of [
        { phone: '+123' },
        { details: { passportSeries: '123' } },
        { details: { passportNumber: '12345' } },
      ])
        assert.equal(
          (
            await req('/customers', {
              method: 'POST',
              body: { type: 'individual', displayName: 'Проверка', ...data },
            })
          ).status,
          400,
        );
      const phone = await req('/customers', {
        method: 'POST',
        body: { type: 'individual', displayName: 'Телефон', phone: '8 (999) 123-45-67' },
      });
      assert.equal(phone.data.phone, '+79991234567');
      const pricingGroupId = (await req('/pricing-groups')).data.items[0].id;
      const data = {
        brandName: 'Новая марка',
        modelName: 'Новая модель',
        pricingGroupId,
        plate: 'В321КК198',
        year: 2024,
        bodyType: 'sedan',
        currentMileageKm: 1000,
        nextMaintenanceDueKm: 10000,
        note: 'Пометка',
      };
      assert.equal(
        (await req('/vehicles', { method: 'POST', body: { ...data, plate: 'BAD123' } })).status,
        400,
      );
      const results = await Promise.all([
        req('/vehicles', { method: 'POST', body: data }),
        req('/vehicles', {
          method: 'POST',
          body: {
            ...data,
            brandName: '  новая   МАРКА ',
            modelName: 'новая модель',
            plate: 'В322КК198',
          },
        }),
      ]);
      assert.deepEqual(
        results.map((v) => v.status),
        [201, 201],
      );
      const id = results[0].data.id;
      const models = (await req('/vehicle-models')).data.items.filter(
        (v) => v.name.toLowerCase() === 'новая модель',
      );
      assert.equal(models.length, 1);
      const key = randomUUID(),
        body = {
          expectedVersion: 1,
          performedOn: '2025-01-01',
          procedure: 'Замена ремня ГРМ',
          mileageKm: 500,
          note: 'С помпой',
        };
      const service = await Promise.all([
        req('/vehicles/' + id + '/service-records', { method: 'POST', key, body }),
        req('/vehicles/' + id + '/service-records', { method: 'POST', key, body }),
      ]);
      assert.equal(service[0].status, 201);
      assert.equal(service[0].data.id, service[1].data.id);
      assert.equal((await req('/vehicles/' + id)).data.currentMileageKm, 1000);
      assert.equal((await req('/vehicles/' + id + '/service-records')).data.total, 1);
      const current = {
        ...body,
        expectedVersion: 2,
        updateMileage: true,
        mileageKm: 1500,
        nextMaintenanceDueKm: 12000,
      };
      assert.equal(
        (await req('/vehicles/' + id + '/service-records', { method: 'POST', body: current }))
          .status,
        201,
      );
      assert.equal((await req('/vehicles/' + id)).data.currentMileageKm, 1500);
      assert.equal((await req('/vehicles/' + id)).data.nextMaintenanceDueKm, 12000);
      assert.equal(
        (await req('/vehicles/' + id + '/service-records', { method: 'POST', body: current }))
          .status,
        409,
      );
      assert.equal(
        (await req('/operations/by-key?command=vehicles.service&key=' + key)).status,
        200,
      );
      const editKey = randomUUID(),
        editBody = {
          expectedVersion: 3,
          performedOn: '2025-01-02',
          procedure: 'ГРМ и помпа',
          mileageKm: 550,
          note: 'Исправлено описание',
        };
      const route = '/vehicles/' + id + '/service-records/' + service[0].data.id;
      assert.equal(
        (await req(route, { method: 'PATCH', key: editKey, body: editBody })).status,
        200,
      );
      assert.equal(
        (await req(route, { method: 'PATCH', key: editKey, body: editBody })).status,
        200,
      );
      assert.equal((await req(route, { method: 'PATCH', body: editBody })).status, 409);
      assert.equal((await req('/vehicles/' + id)).data.currentMileageKm, 1500);
      assert.equal((await req('/vehicles/' + id)).data.nextMaintenanceDueKm, 12000);
      const revised = (await req('/vehicles/' + id + '/service-records')).data.items.find(
        (v) => v.id === service[0].data.id,
      );
      assert.equal(revised.mileageKm, 550);
      assert.equal(revised.note, 'Исправлено описание');
      const history = (await req('/vehicles/' + id + '/history')).data.items[0];
      assert.equal(history.action, 'vehicles.service_updated');
      assert.equal(history.details.before.mileageKm, 500);
    },
  );
  await t.test('browser service journal preserves performed mileage', async () => {
    await page.getByRole('tab', { name: 'Обслуживание', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить процедуру' }).click();
    const due = page.getByLabel('Новый порог следующего ТО, км', { exact: true });
    assert.equal(await due.count(), 0);
    await page.getByLabel('Процедура', { exact: true }).fill('ТО');
    assert.equal(await due.inputValue(), '10500');
    await page.getByLabel('Пробег при выполнении, км', { exact: true }).fill('400');
    assert.equal(await due.inputValue(), '10400');
    await due.fill('11500');
    await page.getByLabel('Пробег при выполнении, км', { exact: true }).fill('450');
    assert.equal(await due.inputValue(), '11500');
    await page.getByLabel('Процедура', { exact: true }).fill('Замена ремня ГРМ');
    assert.equal(await due.count(), 0);
    await page.getByLabel('Процедура', { exact: true }).fill('ТО');
    assert.equal(await due.inputValue(), '11500');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить процедуру' }).click();
    await page.getByLabel('Процедура', { exact: true }).fill('Развал-схождение');
    await page.getByLabel('Пробег при выполнении, км', { exact: true }).fill('400');
    await page.getByLabel('Пометка', { exact: true }).fill('Проверены углы');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Проверены углы', { exact: true }).waitFor();
    assert.equal(
      (await req('/vehicles/' + page.url().split('/').pop())).data.nextMaintenanceDueKm,
      20000,
    );
    await page
      .getByRole('row')
      .filter({ hasText: 'Проверены углы' })
      .getByRole('button', { name: 'Редактировать', exact: true })
      .click();
    await page.getByLabel('Пометка', { exact: true }).fill('Исправленная пометка');
    await page.getByLabel('Пробег при выполнении, км', { exact: true }).fill('420');
    assert.equal(
      await page.getByLabel('Новый порог следующего ТО, км', { exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Исправленная пометка', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'stage2-service.png'), fullPage: true });
  });
  await t.test(
    'unknown mileage and maintenance survive API and browser without zero defaults',
    async () => {
      const { id, ...data } = vehicle;
      const created = await req('/vehicles', {
        method: 'POST',
        body: { ...data, plate: 'А999АА178', currentMileageKm: null, nextMaintenanceDueKm: null },
      });
      assert.equal(created.status, 201);
      const current = (await req('/vehicles/' + created.data.id)).data;
      assert.equal(current.currentMileageKm, null);
      assert.equal(current.nextMaintenanceDueKm, null);
      await page.goto(origin + '/fleet/' + created.data.id);
      await page.getByText('Пробег / ТО неизвестны', { exact: true }).first().waitFor();
      assert.equal(await page.getByText('Неизвестен', { exact: true }).count(), 2);
      await page.getByRole('tab', { name: 'Обслуживание', exact: true }).click();
      await page.getByRole('button', { name: 'Добавить процедуру', exact: true }).click();
      await page.getByLabel('Процедура', { exact: true }).fill('ТО');
      assert.equal(
        await page.getByLabel('Новый порог следующего ТО, км', { exact: true }).inputValue(),
        '',
      );
      await page.getByLabel('Пробег при выполнении, км', { exact: true }).fill('0');
      assert.equal(
        await page.getByLabel('Новый порог следующего ТО, км', { exact: true }).inputValue(),
        '10000',
      );
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      await page.goto(origin + '/fleet?q=' + encodeURIComponent('А999АА178'));
      await page.getByText('Расстояние до ТО неизвестно', { exact: true }).waitFor();
      await page.screenshot({
        path: path.join(output, 'fleet-unknown-mileage.png'),
        fullPage: true,
      });
    },
  );
  await t.test(
    'assigned vehicle warns before model change and archive and opens replacement',
    async () => {
      const { id: originalId, ...data } = vehicle;
      assert.ok(originalId);
      const created = await req('/vehicles', {
        method: 'POST',
        body: { ...data, plate: 'А998АА178', vin: '' },
      });
      assert.equal(created.status, 201);
      const vehicleId = created.data.id;
      const customer = (
        await pool.query(
          "INSERT INTO customers(type,display_name) VALUES ('individual','Замена') RETURNING id",
        )
      ).rows[0].id;
      const booking = (
        await pool.query(
          `INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by)
         SELECT $1,'2080-01-01','2080-01-03','model',v.model_id,u.id
         FROM vehicles v CROSS JOIN users u WHERE v.id=$2 AND u.login='manager' RETURNING id`,
          [customer, vehicleId],
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO booking_eligible_models(booking_id,model_id)
       SELECT $1,model_id FROM vehicles WHERE id=$2`,
        [booking, vehicleId],
      );
      await pool.query(
        `INSERT INTO schedule_blocks(vehicle_id,booking_id,kind,start_at,end_at,reason,created_by)
       SELECT $1,id,'assignment',start_at,end_at,'Назначение для проверки замены',created_by
       FROM bookings WHERE id=$2`,
        [vehicleId, booking],
      );
      await page.goto(origin + '/fleet/' + vehicleId);
      await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
      const edit = page.getByRole('dialog', { name: 'Редактирование автомобиля' });
      assert.equal(
        await edit.getByRole('button', { name: 'Сохранить', exact: true }).isEnabled(),
        true,
      );
      await edit.getByLabel('Модель', { exact: true }).fill('Новая модель');
      const label = 'Заменить автомобиль в брони №' + booking;
      await edit.getByRole('link', { name: label }).waitFor();
      assert.equal(
        await edit.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(),
        true,
      );
      await edit.getByRole('button', { name: 'Отмена', exact: true }).click();
      await page.getByRole('button', { name: 'В архив', exact: true }).click();
      const archive = page.getByRole('dialog', { name: 'Архивировать автомобиль' });
      const replace = archive.getByRole('link', { name: label });
      await replace.waitFor();
      assert.equal(
        await archive.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(),
        true,
      );
      await replace.click();
      await page.waitForURL('**/calendar?booking=' + booking + '&action=assign');
      await page.getByRole('combobox', { name: 'Назначаемый автомобиль', exact: true }).waitFor();
    },
  );
  assert.deepEqual(errors, []);
});
