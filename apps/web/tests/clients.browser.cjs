const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');

test(
  'clients: filters, forms, version conflicts and note commands',
  { timeout: 120000 },
  async () => {
    const root = path.resolve(__dirname, '../../..');
    const port = await new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        server.close(() => resolve(address.port));
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
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          if ((await fetch(origin)).ok) {
            ready = true;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'Vite starts');
      browser = await chromium.launch({
        channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
        headless: true,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(10000);
      const errors = [],
        commands = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let client = {
        id: 7,
        type: 'individual',
        displayName: 'Иванов Иван',
        phone: '+79215551234',
        email: '',
        inn: '',
        details: { passportSeries: '1234', passportNumber: '123456' },
        version: 1,
        isBlocked: false,
        blockedReason: '',
        documentReadiness: { ready: false, missing: ['birthDate'] },
      };
      let notes = [];
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        const endpoint = url.pathname.replace('/api/v1', '');
        let data = {};
        if (endpoint === '/auth/me')
          data = { user: { id: 1, fullName: 'Оператор', role: 'manager' }, csrfToken: 'test' };
        else if (request.method() !== 'GET') {
          const body = request.postDataJSON();
          commands.push({ endpoint, method: request.method(), body });
          if (endpoint === '/customers') {
            client = { ...client, ...body, id: 7, version: 1 };
            data = { id: 7 };
          } else if (endpoint === '/customers/7') {
            client = { ...client, ...body.data, version: client.version + 1 };
            data = client;
          } else if (endpoint === '/customers/7/notes') {
            notes = [
              {
                id: 9,
                text: body.text,
                isActive: true,
                author: 'Оператор',
                createdAt: '2026-11-17T09:00:00Z',
                resolvedBy: null,
                resolvedAt: null,
              },
            ];
            client = { ...client, version: client.version + 1 };
          } else if (endpoint === '/customers/7/notes/9/resolve') {
            notes = notes.map((note) => ({
              ...note,
              isActive: false,
              resolvedBy: 'Оператор',
              resolvedAt: '2026-11-17T10:00:00Z',
            }));
            client = { ...client, version: client.version + 1 };
          } else if (endpoint === '/customers/7/block' || endpoint === '/customers/7/unblock') {
            client = {
              ...client,
              isBlocked: endpoint.endsWith('/block'),
              blockedReason: body.reason || '',
              version: client.version + 1,
            };
          }
        } else if (endpoint === '/customers') data = { items: [client], total: 40 };
        else if (endpoint === '/customers/7') data = client;
        else if (endpoint === '/customers/7/notes') data = { items: notes };
        else if (endpoint.endsWith('/history')) data = { items: [], total: 0 };
        else if (endpoint.endsWith('/finance')) data = { sources: [], bookings: [], items: [] };
        await route.fulfill({ json: data });
      });

      await page.goto(origin + '/clients?page=2&type=individual');
      await page.getByRole('link', { name: client.displayName, exact: true }).waitFor();
      await page.getByRole('searchbox', { name: 'Поиск клиентов' }).fill('Иванов');
      await page.waitForURL(
        (url) => url.searchParams.get('page') === '1' && url.searchParams.get('q') === 'Иванов',
      );
      assert.equal(new URL(page.url()).searchParams.get('page'), '1');
      assert.equal(new URL(page.url()).searchParams.get('type'), 'individual');
      await page.getByTitle('2', { exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('page') === '2');
      assert.equal(new URL(page.url()).searchParams.get('page'), '2');
      const listUrl = page.url();
      await page.getByRole('link', { name: client.displayName, exact: true }).click();
      await page.getByRole('heading', { name: client.displayName, exact: true }).waitFor();
      await page.getByRole('link', { name: '← К списку клиентов' }).click();
      assert.equal(page.url(), listUrl);

      await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('ФИО', { exact: true }).fill('Петров Пётр');
      await dialog.getByLabel('Телефон', { exact: true }).fill('89215551234');
      await dialog.getByLabel('Серия паспорта', { exact: true }).fill('12');
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await dialog.getByText('Введите ровно 4 цифр.', { exact: true }).waitFor();
      assert.equal(commands.length, 0);
      await dialog.getByLabel('Серия паспорта', { exact: true }).fill('1234');
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByRole('heading', { name: 'Петров Пётр', exact: true }).waitFor();
      assert.equal(commands[0].method, 'POST');
      assert.equal(commands[0].body.phone, '+79215551234');
      assert.equal(commands[0].body.inn, '');
      assert.equal(commands[0].body.details.passportSeries, '1234');
      assert.equal(commands[0].body.email, '');
      assert.equal('data' in commands[0].body, false);

      await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('ФИО', { exact: true }).fill('Мой ввод');
      client = { ...client, displayName: 'Изменено другим сотрудником', version: 2 };
      await page
        .getByText('Запись изменена другим сотрудником. Ваш ввод сохранён.', { exact: true })
        .waitFor();
      assert.equal(await dialog.getByLabel('ФИО', { exact: true }).inputValue(), 'Мой ввод');
      assert.ok(await dialog.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled());
      await dialog
        .getByRole('button', { name: 'Сохранить мой ввод поверх новой версии', exact: true })
        .click();
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByRole('heading', { name: 'Мой ввод', exact: true }).waitFor();
      assert.equal(commands.at(-1).method, 'PATCH');
      assert.equal(commands.at(-1).body.expectedVersion, 2);
      assert.equal(commands.at(-1).body.data.displayName, 'Мой ввод');

      await page.getByRole('tab', { name: 'Заметки', exact: true }).click();
      await page.getByRole('button', { name: 'Добавить заметку', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Текст заметки', { exact: true }).fill('Проверить документы');
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByText('Проверить документы', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Закрыть заметку', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Сохранить', exact: true })
        .click();
      await page.getByText('Закрыта', { exact: true }).waitFor();
      assert.equal(commands.at(-1).endpoint, '/customers/7/notes/9/resolve');

      await page.getByRole('button', { name: 'Заблокировать', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Причина блокировки', { exact: true }).fill('Проверка');
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByText('Причина блокировки: Проверка', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Разблокировать', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Сохранить', exact: true })
        .click();
      await page.getByRole('button', { name: 'Заблокировать', exact: true }).waitFor();

      await page.getByRole('link', { name: '← К списку клиентов' }).click();
      await page.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.locator('.ant-select-selector').click();
      await page.getByTitle('Организация', { exact: true }).click();
      await dialog.getByLabel('Название организации', { exact: true }).fill('ООО Прокат');
      await dialog.getByLabel('ИНН', { exact: true }).fill('1234567890');
      await dialog.getByLabel('БИК', { exact: true }).fill('123456789');
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByRole('heading', { name: 'ООО Прокат', exact: true }).waitFor();
      assert.equal(commands.at(-1).body.type, 'company');
      assert.equal(commands.at(-1).body.inn, '1234567890');
      assert.equal(commands.at(-1).body.details.bik, '123456789');
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      if (server.exitCode === null) {
        const exited = once(server, 'exit');
        server.kill();
        await exited;
      }
    }
  },
);
