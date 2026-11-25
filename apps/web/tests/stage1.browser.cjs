const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
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
const { passwordHash } = require('../../api/dist/platform/security');
const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });

test('Stage 1 browser acceptance', { timeout: 180000 }, async (t) => {
  const name = 'crm_stage1_ui_' + randomBytes(8).toString('hex');
  const baseUrl = new URL(process.env.DATABASE_URL);
  const adminPool = new Pool({ connectionString: baseUrl.toString() });
  baseUrl.pathname = '/' + name;
  let pool, browser;
  const children = [];
  const diagnostics = [];
  t.after(async () => {
    if (browser) await browser.close();
    for (const child of children) {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
    }
    if (pool) await pool.end();
    assert.match(name, /^crm_stage1_ui_[a-f0-9]{16}$/);
    await adminPool.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await adminPool.end();
  });
  await adminPool.query('CREATE DATABASE "' + name + '"');
  pool = new Pool({ connectionString: baseUrl.toString() });
  await migrate(drizzle(pool), { migrationsFolder: path.join(root, 'apps/api/drizzle') });
  const password = 'Browser-' + randomBytes(18).toString('base64url');
  const managerPassword = randomBytes(6).toString('base64url');
  await pool.query(
    "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Администратор теста','admin',$1,'admin')",
    [await passwordHash(password)],
  );
  const apiPort = await freePort(),
    webPort = await freePort();
  const origin = 'http://127.0.0.1:' + webPort;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: baseUrl.toString(),
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
    child.stdout.on('data', (data) => diagnostics.push(data.toString()));
    child.stderr.on('data', (data) => diagnostics.push(data.toString()));
    children.push(child);
  }
  for (const url of [origin + '/api/v1/health', origin]) {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(url)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Server startup: ' + diagnostics.join(''));
  }
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const output = path.join(root, '.runtime');
  await fs.mkdir(output, { recursive: true });
  const login = async (p, account, accountPassword = password) => {
    await p.getByLabel('Логин', { exact: true }).fill(account);
    await p.getByLabel('Пароль', { exact: true }).fill(accountPassword);
    await p.getByRole('button', { name: 'Войти', exact: true }).click();
  };
  await t.test('unauthorized deep link, login and desktop layout', async () => {
    await page.goto(origin + '/users');
    await page.getByRole('heading', { name: 'Вход в систему' }).waitFor();
    assert.match(page.url(), /\/login$/);
    await page.screenshot({ path: path.join(output, 'stage1-login.png'), fullPage: true });
    await login(page, 'admin');
    await page.getByRole('heading', { name: 'Сотрудники', exact: true }).waitFor();
    assert.match(page.url(), /\/users$/);
    await page.getByRole('row').filter({ hasText: 'Администратор теста' }).waitFor();
    assert.equal(await page.getByRole('row').filter({ hasText: 'Администратор теста' }).count(), 1);
  });
  await t.test(
    'create manager through the form, recover a lost response without a duplicate',
    async () => {
      await page.getByRole('button', { name: 'Добавить сотрудника' }).click();
      await page.getByLabel('ФИО', { exact: true }).fill('Тестовый менеджер');
      await page.getByLabel('Логин', { exact: true }).fill('manager');
      await page.getByLabel('Пароль', { exact: true }).fill(managerPassword.slice(0, 7));
      await page.getByRole('button', { name: 'Создать сотрудника', exact: true }).click();
      await page.getByText('Не менее 8 символов.', { exact: true }).waitFor();
      await page.getByLabel('Пароль', { exact: true }).fill(managerPassword);
      await page.route('**/api/v1/admin/users', async (route) => {
        if (route.request().method() === 'POST') {
          await route.fetch();
          await route.abort('failed');
        } else await route.continue();
      });
      await page.getByRole('button', { name: 'Создать сотрудника', exact: true }).click();
      await page.getByText('Сервер мог сохранить сотрудника.', { exact: true }).waitFor();
      await page.unroute('**/api/v1/admin/users');
      await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
      await page.getByRole('row').filter({ hasText: 'Тестовый менеджер' }).waitFor();
      assert.equal(
        (await pool.query("SELECT count(*) FROM users WHERE login='manager'")).rows[0].count,
        '1',
      );
      await page.screenshot({ path: path.join(output, 'stage1-users.png'), fullPage: true });
    },
  );
  let managerContext, managerPage;
  await t.test(
    'manager route access denied; blocking invalidates an active browser session',
    async () => {
      managerContext = await browser.newContext({ viewport: { width: 1024, height: 768 } });
      managerPage = await managerContext.newPage();
      await managerPage.goto(origin + '/users');
      await login(managerPage, 'manager', managerPassword);
      await managerPage.getByText('Доступ ограничен', { exact: true }).waitFor();
      assert.equal(
        await managerPage.getByRole('link', { name: 'Сотрудники', exact: true }).count(),
        0,
      );
      const row = page.getByRole('row').filter({ hasText: 'Тестовый менеджер' });
      await row.getByRole('button', { name: 'Заблокировать', exact: true }).click();
      await page.getByRole('button', { name: 'Подтвердить', exact: true }).click();
      await row.getByText('Заблокирован', { exact: true }).waitFor();
      await managerPage.reload();
      await managerPage.getByRole('heading', { name: 'Вход в систему' }).waitFor();
      await login(managerPage, 'manager', managerPassword);
      await managerPage.getByText('Неверный логин или пароль.', { exact: true }).waitFor();
    },
  );
  await t.test('network error has a working retry; logout and mobile layout', async () => {
    await page.route('**/api/v1/admin/users', (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'Обновить список', exact: true }).click();
    await page.getByText('Нет ответа от сервера. Проверьте соединение.', { exact: true }).waitFor();
    await page.unroute('**/api/v1/admin/users');
    await page.screenshot({ path: path.join(output, 'stage1-network-state.png'), fullPage: true });
    await page.getByRole('button', { name: 'Обновить список', exact: true }).click();
    await page.getByRole('row').filter({ hasText: 'Тестовый менеджер' }).waitFor();
    await page.getByRole('button', { name: 'Профиль пользователя', exact: true }).click();
    await page.getByRole('menuitem', { name: /Выйти$/ }).click();
    await page.getByRole('heading', { name: 'Вход в систему' }).waitFor();
    await page.goto(origin + '/users');
    await page.getByRole('heading', { name: 'Вход в систему' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'stage1-login-mobile.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.deepEqual(pageErrors, []);
  });
});
