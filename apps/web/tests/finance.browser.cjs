const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

test(
  'finance preserves drafts, versions, shortfall approval and exactly one refund',
  { timeout: 120000 },
  async () => {
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
      const commands = [];
      let version = 1;
      let posted = 0;
      let releaseFirst;
      const firstGate = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      const summary = () => ({
        bookingId: 11,
        bookingVersion: version,
        status: 'confirmed',
        priceRub: '10000',
        coverageRub: '15000',
        debtRub: '0',
        overpaymentRub: '5000',
        depositRub: '0',
        availableCreditRub: '0',
      });
      const funds = [
        {
          id: 'operating_cash',
          balanceRub: '9007199254740993123',
          initialized: true,
          hasEntries: true,
        },
        { id: 'deposit_pool', balanceRub: '-1000', initialized: true, hasEntries: true },
      ];
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        let data = {};
        if (url.pathname.endsWith('/auth/me'))
          data = { user: { id: 1, fullName: 'Оператор', role: 'manager' }, csrfToken: 'test' };
        else if (url.pathname.endsWith('/booking-customers'))
          data = { items: [{ id: 7, displayName: 'Финансовый клиент', phone: '+79991234567' }] };
        else if (url.pathname.endsWith('/customers/7/finance'))
          data = {
            sources: [
              {
                lotId: 1,
                originalOperationId: 10,
                origin: 'rent',
                method: 'cash',
                bucket: 'rent',
                fund: 'operating_cash',
                bookingId: 11,
                availableRub: '5000',
              },
            ],
            bookings: [summary()],
            items: [],
          };
        else if (url.pathname.endsWith('/finance'))
          data = {
            items: funds,
            depositShortfallRub: '1000',
            initialAllowed: false,
            journal: { items: [] },
          };
        else if (url.pathname.endsWith('/financial-operations')) {
          commands.push({
            body: request.postDataJSON(),
            key: request.headers()['idempotency-key'],
          });
          if (commands.length === 1) {
            await firstGate;
            version = 2;
            return route.fulfill({
              status: 409,
              json: { code: 'BOOKING_VERSION_CONFLICT', message: 'Версия брони изменилась' },
            });
          }
          if (commands.length === 2)
            return route.fulfill({
              status: 409,
              json: {
                code: 'FUND_SHORTFALL_CONFIRMATION',
                message: 'Подтвердите дефицит',
                details: {
                  token: 'shortfall-token',
                  negative: [{ ...funds[1], afterRub: '-2000' }],
                },
              },
            });
          if (commands.length === 3) {
            posted++;
            return route.abort('failed');
          }
          assert.deepEqual(
            commands[3],
            commands[2],
            'retry must reuse the original command and key',
          );
          data = { id: 42 };
        }
        return route.fulfill({ json: data });
      });
      await page.goto(origin + '/payments');
      await page.getByRole('heading', { name: 'Журнал оплат и возвратов' }).waitFor();
      await page.getByText('9 007 199 254 740 993 123 ₽', { exact: true }).waitFor();
      await page.getByText('Дефицит обеспечения залогов: 1 000 ₽', { exact: true }).waitFor();
      if (process.env.FINANCE_VISUAL_MODE) {
        const baseline = path.join(root, '.runtime/finance-refactor-baseline.png');
        if (process.env.FINANCE_VISUAL_MODE === 'record')
          await page.screenshot({ path: baseline, animations: 'disabled' });
        else
          assert.deepEqual(
            await page.screenshot({ animations: 'disabled' }),
            readFileSync(baseline),
          );
      }
      await page.getByRole('combobox', { name: 'Клиент для денежной операции' }).fill('Финансовый');
      await page.getByText('Финансовый клиент · +79991234567', { exact: true }).click();
      await page.getByRole('button', { name: 'Возврат и доступные средства', exact: true }).click();
      await page.getByRole('combobox', { name: 'Бронь для оплаты' }).click();
      await page.getByTitle('№11 · Бронь · плановая стоимость 10 000 ₽', { exact: true }).click();
      await page
        .getByLabel('Сумма из источника 1:rent:11:operating_cash', { exact: true })
        .fill('1000');
      const reason = page.getByRole('textbox', { name: 'Причина денежной операции' });
      await reason.fill('Возврат переплаты');
      const submit = page.getByRole('button', { name: 'Провести денежную операцию', exact: true });
      const firstRequest = page.waitForRequest((request) =>
        request.url().endsWith('/financial-operations'),
      );
      await submit.dblclick();
      await firstRequest;
      assert.equal(commands.length, 1, 'double click must send one operation');
      assert.ok(
        await page.getByRole('combobox', { name: 'Клиент для денежной операции' }).isDisabled(),
      );
      releaseFirst();
      await page.getByText('Версия брони изменилась', { exact: true }).waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByText('Условия брони изменились. Ввод сохранён.', { exact: true }).waitFor();
      assert.equal(await reason.inputValue(), 'Возврат переплаты');
      assert.equal(
        await page
          .getByLabel('Сумма из источника 1:rent:11:operating_cash', { exact: true })
          .inputValue(),
        '1000',
      );
      assert.ok(await submit.isDisabled());
      await page.getByRole('button', { name: 'Принять актуальные условия' }).click();
      await submit.click();
      await page.getByText('Физический остаток станет отрицательным', { exact: true }).waitFor();
      assert.equal(commands[0].body.expectedVersion, 1);
      assert.equal(commands[1].body.expectedVersion, 2);
      assert.ok(await submit.isDisabled());
      await page
        .getByRole('checkbox', { name: 'Подтверждаю проведение с указанным дефицитом и причиной' })
        .check();
      await submit.click();
      await page.getByText('Результат пока неизвестен', { exact: true }).waitFor();
      assert.equal(commands[2].body.warningToken, 'shortfall-token');
      assert.equal(commands[2].body.shortfallAcknowledged, true);
      assert.deepEqual(commands[2].body.sources, [
        { lotId: 1, bucket: 'rent', fund: 'operating_cash', bookingId: 11, amountRub: '1000' },
      ]);
      assert.equal(await reason.inputValue(), 'Возврат переплаты');
      assert.ok(await reason.isDisabled());
      await page.getByRole('button', { name: 'Повторить с тем же ключом', exact: true }).click();
      await page
        .getByRole('button', { name: 'Возврат и доступные средства', exact: true })
        .waitFor();
      assert.equal(commands.length, 4);
      assert.ok(commands[2].key);
      assert.equal(posted, 1);
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      server.kill();
    }
  },
);
