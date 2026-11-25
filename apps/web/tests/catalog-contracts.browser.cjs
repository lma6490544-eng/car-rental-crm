const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

test('catalog polling, scroll, history and command contracts', { timeout: 120000 }, async () => {
  const root = path.resolve(__dirname, '../../..');
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
  const origin = 'http://127.0.0.1:' + port;
  const server = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: path.join(root, 'apps/web'), windowsHide: true, stdio: 'ignore' },
  );
  let browser;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin)).ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const html = (await (await fetch(origin)).text()).replace(
      '/src/main.tsx',
      '/tests/fixtures/catalog-harness.tsx',
    );
    await page.route('**/__catalog_test', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    const requests = [];
    const gates = new Map();
    let failPoll = false;
    const commands = [];
    let releaseCommand;
    let commandMode = 'retry';
    const commandGate = new Promise((resolve) => {
      releaseCommand = resolve;
    });
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith('/contract/history'))
        return route.fulfill({
          json: {
            total: 51,
            terms: [],
            items: [
              {
                id: 1,
                action: 'customers.created',
                author: 'Оператор',
                createdAt: '2026-11-18T09:00:00Z',
                details: { before: {}, after: {} },
              },
              {
                id: 2,
                action: 'unknown.action',
                author: null,
                createdAt: '2026-11-18T09:00:00Z',
                details: { before: {}, after: {} },
              },
            ],
          },
        });
      if (url.pathname.endsWith('/contract/save')) {
        commands.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
        if (commandMode === 'recover') return route.abort('failed');
        if (commands.length === 1) {
          await commandGate;
          return route.fulfill({ status: 500, json: { message: 'Lost response' } });
        }
        return route.fulfill({ json: { id: 42 } });
      }
      if (url.pathname.endsWith('/operations/by-key'))
        return route.fulfill({ json: { result: { id: 43 } } });
      requests.push(url.pathname);
      if (gates.has(url.pathname)) await gates.get(url.pathname);
      if (failPoll) return route.fulfill({ status: 503, json: { message: 'Poll unavailable' } });
      return route.fulfill({ json: { value: url.pathname.split('/').at(-1) } });
    });
    const waitPoll = (value, loading = false) =>
      page.waitForFunction(
        ({ value, loading }) => {
          const state = JSON.parse(document.querySelector('[data-testid=poll]').textContent);
          return state.value === value && state.loading === loading && state.stable;
        },
        { value, loading },
      );
    await page.goto(origin + '/__catalog_test');
    await waitPoll('a');
    await page.getByText('Клиент создан', { exact: true }).waitFor();
    await page.getByText('unknown.action', { exact: true }).waitFor();
    await page.getByText('Тестовое заполнение', { exact: false }).waitFor();
    const historyRequest = page.waitForRequest((request) =>
      request.url().includes('/contract/history?page=2'),
    );
    await page.locator('.ant-pagination-item-2').click();
    await historyRequest;
    let releaseA;
    gates.set(
      '/api/v1/contract/a',
      new Promise((resolve) => {
        releaseA = resolve;
      }),
    );
    const count = requests.length;
    const reloadRequest = page.waitForRequest((request) => request.url().endsWith('/contract/a'));
    await page.getByRole('button', { name: 'Reload data', exact: true }).click();
    await reloadRequest;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    assert.equal(requests.length, count + 1, 'refresh requests must not overlap');
    await page.getByRole('button', { name: 'Reload data', exact: true }).click();
    let releaseQueued;
    gates.set(
      '/api/v1/contract/a',
      new Promise((resolve) => {
        releaseQueued = resolve;
      }),
    );
    assert.equal(await page.getByTestId('completed-reloads').textContent(), '0');
    const queuedRequest = page.waitForRequest((request) => request.url().endsWith('/contract/a'));
    releaseA();
    await queuedRequest;
    await page.waitForFunction(
      () => document.querySelector('[data-testid=completed-reloads]').textContent === '1',
    );
    releaseQueued();
    await page.waitForFunction(
      () => document.querySelector('[data-testid=completed-reloads]').textContent === '2',
    );
    await page.waitForFunction(
      () => JSON.parse(document.querySelector('[data-testid=poll]').textContent).value === 'a',
    );
    gates.delete('/api/v1/contract/a');
    let releaseB;
    gates.set(
      '/api/v1/contract/b',
      new Promise((resolve) => {
        releaseB = resolve;
      }),
    );
    await page.getByRole('button', { name: 'Keep data', exact: true }).click();
    await waitPoll('a');
    await page.getByRole('button', { name: 'Path B', exact: true }).click();
    await waitPoll('a', true);
    const stale = page.waitForResponse((response) => response.url().endsWith('/contract/b'));
    await page.getByRole('button', { name: 'Path C', exact: true }).click();
    await waitPoll('c');
    releaseB();
    await (await stale).finished();
    await waitPoll('c');
    failPoll = true;
    await page.getByRole('button', { name: 'Reload data', exact: true }).click();
    await page.getByText('Poll unavailable', { exact: true }).waitFor();
    failPoll = false;
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await page.getByText('Poll unavailable', { exact: true }).waitFor({ state: 'hidden' });
    const periodic = page.waitForRequest((request) => request.url().endsWith('/contract/c'));
    await periodic;
    await page.getByRole('button', { name: 'Scroll ready', exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 700));
    await page.waitForFunction(() => window.scrollY === 700);
    await page.getByRole('button', { name: 'Scroll key', exact: true }).click();
    await page.waitForFunction(() => window.scrollY === 0);
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForFunction(() => window.scrollY === 300);
    await page.getByRole('button', { name: 'Scroll key', exact: true }).click();
    await page.waitForFunction(() => window.scrollY === 700);
    await page.getByRole('button', { name: 'Open command', exact: true }).click();
    await page.getByLabel('Contract name', { exact: true }).fill('draft');
    await page.getByRole('button', { name: 'Remote version', exact: true }).click();
    await page
      .getByText('Запись изменена другим сотрудником. Ваш ввод сохранён.', { exact: true })
      .waitFor();
    assert.ok(await page.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Сохранить мой ввод поверх новой версии' }).click();
    const post = page.waitForRequest((request) => request.url().endsWith('/contract/save'));
    await page.getByRole('button', { name: 'Сохранить', exact: true }).dblclick();
    await post;
    assert.equal(commands.length, 1);
    releaseCommand();
    await page.getByText('Результат пока неизвестен', { exact: true }).waitFor();
    assert.equal(await page.locator('.ant-modal-close').count(), 0);
    assert.equal(await page.getByLabel('Contract name', { exact: true }).inputValue(), 'draft');
    assert.ok(await page.getByLabel('Contract name', { exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Повторить отправку', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid=result]').textContent === '42',
    );
    assert.deepEqual(commands[1], commands[0]);
    assert.ok(commands[0].key);
    assert.deepEqual(commands[0].body, { name: 'draft', expectedVersion: 2, prepared: true });
    commandMode = 'recover';
    await page.getByRole('button', { name: 'Open command', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.getByText('Результат пока неизвестен', { exact: true }).waitFor();
    const lookup = page.waitForRequest((request) =>
      request.url().includes('/operations/by-key?command=contract.save'),
    );
    await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
    assert.equal(new URL((await lookup).url()).searchParams.get('key'), commands[2].key);
    await page.waitForFunction(
      () => document.querySelector('[data-testid=result]').textContent === '43',
    );
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
});
