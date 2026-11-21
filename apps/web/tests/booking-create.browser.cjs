const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

test(
  'booking creation form, inline client search, pricing and fixed footer',
  { timeout: 180000 },
  async () => {
    const root = path.resolve(__dirname, '../../..');
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
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
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(ready);
      browser = await chromium.launch({ channel: 'msedge', headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
        errors = [],
        searches = [],
        previews = [],
        commands = [];
      page.setDefaultTimeout(12000);
      page.on('pageerror', (e) => errors.push(e.message));
      await page.clock.setFixedTime(new Date('2026-11-16T13:19:00Z'));
      const client = {
        id: 7,
        type: 'individual',
        displayName: 'Лебедева Ксения',
        phone: '+79215551234',
        email: 'client@example.ru',
        inn: '',
        version: 8,
        details: { lastName: 'Лебедева', firstName: 'Ксения', middleName: 'Сергеевна' },
        isBlocked: false,
      };
      const fleet = {
        brands: [{ id: 1, label: 'Lada' }],
        models: [{ id: 1, brandId: 1, pricingGroupId: 1, label: 'Lada Largus' }],
        groups: [{ id: 1, label: 'Универсалы' }],
        vehicles: [
          {
            id: 1,
            modelId: 1,
            brandId: 1,
            modelName: 'Largus',
            plate: 'А857ХМ778',
            isReady: true,
            label: 'Lada Largus · А857ХМ778',
          },
        ],
      };
      let failOnce = true,
        allowSuccess = false;
      let availabilityScenario = false;
      let availabilityChangedOnce = false;
      let availabilityRevision = 0;
      let refreshedPreviewGate;
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          p = url.pathname;
        let data = {};
        if (p.endsWith('/auth/me'))
          data = { user: { id: 1, fullName: 'Оператор', role: 'manager' }, csrfToken: 'test' };
        else if (p.endsWith('/calendar'))
          data = { vehicles: [], events: [], unassignedBookings: [], problems: [] };
        else if (p.endsWith('/booking-options')) data = fleet;
        else if (p.endsWith('/booking-customers')) {
          const q = url.searchParams.get('q');
          searches.push(q);
          if (q === 'Устаревший') {
            await new Promise((r) => setTimeout(r, 800));
            data = { items: [{ ...client, id: 8, displayName: 'Устаревший ответ' }] };
          } else data = { items: [client] };
        } else if (p.endsWith('/customers/7')) data = client;
        else if (p.endsWith('/availability/evaluate'))
          data = { availability: { status: 'feasible' }, conflicts: [], alternatives: [] };
        else if (p.endsWith('/bookings/preview')) {
          const body = request.postDataJSON();
          previews.push(body);
          const revision = availabilityRevision;
          if (availabilityScenario && revision === 1) await refreshedPreviewGate;
          if (body.pricing.contractDays === 3) {
            await new Promise((resolve) => setTimeout(resolve, 900));
          }
          const price =
            body.pricing.overrides?.customDailyRateRub ?? String(body.pricing.contractDays * 2200);
          data = {
            previewToken: availabilityScenario ? 'preview-' + revision : 'test-token',
            availability: availabilityScenario
              ? { status: 'unknown', token: 'availability-' + revision }
              : { status: 'feasible' },
            conflicts: [],
            calculation: {
              finalTotalRub: price,
              effectiveMileageLimitKm:
                body.pricing.contractDays * body.pricing.dailyMileagePackageKm,
              startAt: body.pricing.startAt,
              agreedReturnAt: new Date(
                Date.parse(body.pricing.startAt) + body.pricing.contractDays * 86400000,
              ).toISOString(),
              overridesToConfirm: body.pricing.overrides ? ['customDailyRateRub'] : [],
            },
          };
        } else if (p.endsWith('/bookings') && request.method() === 'POST') {
          commands.push({ body: request.postDataJSON(), headers: request.headers() });
          if (availabilityChangedOnce) {
            availabilityChangedOnce = false;
            availabilityRevision++;
            return route.fulfill({
              status: 409,
              json: { code: 'AVAILABILITY_CHANGED', message: 'Доступность изменилась' },
            });
          }
          if (allowSuccess) {
            await new Promise((r) => setTimeout(r, 300));
            data = { id: 9 };
          } else if (failOnce) {
            failOnce = false;
            return route.fulfill({
              status: 500,
              json: { message: 'Тестовая ошибка сервера', code: 'INTERNAL_ERROR' },
            });
          } else
            return route.fulfill({
              status: 422,
              json: { message: 'Тестовая ошибка проверки', code: 'TEST_VALIDATION' },
            });
        } else if (p.endsWith('/bookings/9'))
          data = {
            id: 9,
            version: 1,
            status: 'confirmed',
            customer_id: 7,
            customer_name: client.displayName,
            vehicle_id: null,
            target_type: 'model',
            target_model_id: 1,
            start_at: '2026-11-16T13:19:00Z',
            end_at: '2026-11-17T13:19:00Z',
            terms: [{ snapshot: { finalTotalRub: '2200', eligibleModels: [1] } }],
            alternatives: [],
            problemReasons: [],
            conflicts: [],
          };
        else if (p.endsWith('/customers/7/finance'))
          data = { sources: [], bookings: [], items: [] };
        return route.fulfill({ json: data });
      });
      await page.goto(origin + '/calendar');
      const open = async () => {
        await page.getByRole('button', { name: /Бронь$/ }).click();
        await page.locator('.booking-create-drawer').waitFor();
      };
      await open();
      const drawer = page.locator('.booking-create-drawer');
      assert.ok(
        await page
          .locator('.ant-drawer-content-wrapper')
          .evaluate((el) => Math.abs(el.getBoundingClientRect().width - 720) < 1),
      );
      assert.equal(await drawer.locator('.ant-collapse-item-active').count(), 0);
      await drawer
        .getByRole('button', { name: 'Создать бронь', exact: true })
        .isDisabled()
        .then((v) => assert.ok(v));
      await drawer.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('Устаревший');
      await page.waitForRequest(
        (r) =>
          r.url().includes('booking-customers') &&
          new URL(r.url()).searchParams.get('q') === 'Устаревший',
      );
      await drawer.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('Леб');
      await page
        .locator('.ant-select-item-option-content')
        .filter({ hasText: client.displayName })
        .click();
      await drawer.getByLabel('Имя', { exact: true }).waitFor();
      await page.waitForFunction(
        () => document.querySelector('input[aria-label="Имя"]').value === 'Ксения',
      );
      assert.equal(
        await drawer.getByRole('combobox', { name: 'Телефон', exact: true }).inputValue(),
        client.phone,
      );
      assert.equal(await drawer.getByLabel('Email', { exact: true }).inputValue(), client.email);
      const searchCount = searches.length;
      await page.waitForTimeout(450);
      assert.equal(searches.length, searchCount, 'autofill must not search again');
      assert.equal(await page.getByText('Устаревший ответ', { exact: true }).count(), 0);
      assert.equal(
        await drawer.getByText('Выбран существующий клиент.', { exact: false }).count(),
        0,
      );
      await drawer.getByLabel('Email', { exact: true }).fill('edited@example.ru');
      await drawer.getByRole('combobox', { name: 'Марка и модель', exact: true }).click();
      await page.getByTitle('Lada Largus', { exact: true }).click();
      await drawer.getByRole('combobox', { name: 'Автомобиль', exact: true }).click();
      await page
        .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .booking-vehicle-option')
        .click();
      await drawer.getByRole('spinbutton', { name: 'Количество дней', exact: true }).fill('2');
      await drawer.getByLabel('Начало аренды', { exact: true }).fill('19.11.2026, 10:00');
      await drawer.getByLabel('Начало аренды', { exact: true }).press('Enter');
      await drawer.getByText('Автомобиль и аренда', { exact: true }).click();
      await drawer.getByText('400 км', { exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('.booking-create-total strong').textContent.includes('4'),
      );
      assert.equal(previews.at(-1).target.type, 'vehicle');
      assert.equal(previews.at(-1).pricing.contractDays, 2);
      assert.equal(previews.at(-1).pricing.dailyMileagePackageKm, 400);
      assert.equal(previews.at(-1).pricing.startAt, '2026-11-19T07:00:00.000Z');
      const stalePreview = page.waitForResponse(
        (response) =>
          response.url().endsWith('/bookings/preview') &&
          response.request().postDataJSON().pricing.contractDays === 3,
      );
      const staleRequest = page.waitForRequest(
        (request) =>
          request.url().endsWith('/bookings/preview') &&
          request.postDataJSON().pricing.contractDays === 3,
      );
      await drawer.getByRole('spinbutton', { name: 'Количество дней', exact: true }).fill('3');
      await staleRequest;
      await drawer.getByRole('spinbutton', { name: 'Количество дней', exact: true }).fill('4');
      await page.waitForFunction(() =>
        document.querySelector('.booking-create-total strong').textContent.includes('8'),
      );
      await (await stalePreview).finished();
      await page.waitForTimeout(100);
      assert.match(await drawer.locator('.booking-create-total strong').innerText(), /8/);
      await drawer.getByRole('spinbutton', { name: 'Количество дней', exact: true }).fill('2');
      await page.waitForFunction(() =>
        document.querySelector('.booking-create-total strong').textContent.includes('4'),
      );
      await drawer.getByLabel('Email', { exact: true }).fill('invalid');
      await page.waitForFunction(
        () => document.querySelector('.booking-create-submit .ant-btn-primary').disabled,
      );
      await drawer.getByLabel('Email', { exact: true }).fill('edited@example.ru');
      await page.waitForFunction(
        () => !document.querySelector('.booking-create-submit .ant-btn-primary').disabled,
      );
      await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).click();
      await drawer
        .getByRole('button', { name: 'Повторить с тем же ключом', exact: true })
        .waitFor();
      assert.equal(commands[0].body.customer.existingId, 7);
      assert.equal(commands[0].body.customer.expectedVersion, 8);
      assert.equal(commands[0].body.customer.data.email, 'edited@example.ru');
      await drawer.getByRole('button', { name: 'Повторить с тем же ключом', exact: true }).click();
      await drawer.getByText('Тестовая ошибка проверки', { exact: true }).waitFor();
      assert.deepEqual(commands[0], commands[1], 'retry must reuse the original payload and key');
      await drawer.locator('.ant-drawer-close').click();
      await open();
      await drawer.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('Леб');
      await drawer.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('');
      await drawer.getByLabel('Имя', { exact: true }).fill('Ксения');
      await drawer.getByLabel('Имя', { exact: true }).fill('');
      await page.waitForFunction(
        () => document.querySelectorAll('.booking-form .ant-form-item-has-error').length >= 2,
      );
      await drawer
        .getByRole('combobox', { name: 'Телефон', exact: true })
        .fill('8 (921) 555-12-34');
      await page
        .locator('.ant-select-item-option-content')
        .filter({ hasText: client.displayName })
        .click();
      await page.waitForFunction(
        () => document.querySelector('input[aria-label="Имя"]').value === 'Ксения',
      );
      await page.waitForFunction(
        () => document.querySelectorAll('.booking-form .ant-form-item-has-error').length === 0,
      );
      assert.ok(searches.includes('+79215551234'));
      await drawer.getByRole('button', { name: 'Очистить клиента', exact: true }).click();
      await drawer.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('Новый');
      await drawer.getByLabel('Имя', { exact: true }).fill('Клиент');
      await drawer.getByRole('combobox', { name: 'Телефон', exact: true }).fill('+79991234567');
      await drawer.getByLabel('Email', { exact: true }).click();
      await drawer.getByRole('combobox', { name: 'Марка и модель', exact: true }).click();
      await page.getByTitle('Lada Largus', { exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('.booking-create-submit .ant-btn-primary').disabled,
      );
      assert.equal(previews.at(-1).target.type, 'model');
      await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).click();
      await drawer.getByText('Тестовая ошибка проверки', { exact: true }).waitFor();
      assert.equal(commands.at(-1).body.customer.new.displayName, 'Новый Клиент');
      assert.equal(commands.at(-1).body.target.type, 'model');
      await drawer.getByText('Другие варианты бронирования', { exact: true }).click();
      await drawer
        .getByRole('combobox', { name: 'Модель или группа аналогов', exact: true })
        .click();
      await page.getByTitle('Универсалы · Аналоги', { exact: true }).click();
      await drawer.getByText('Лояльность и скидки', { exact: true }).click();
      await drawer.getByLabel('Собственная цена за сутки, ₽', { exact: true }).fill('1000');
      await drawer
        .getByLabel('Причина условий лояльности', { exact: true })
        .fill('Постоянный клиент');
      await drawer
        .getByRole('checkbox', { name: 'Подтверждаю ручные условия', exact: true })
        .check();
      await page.waitForFunction(
        () => !document.querySelector('.booking-create-submit .ant-btn-primary').disabled,
      );
      assert.equal(previews.at(-1).target.type, 'equivalence_group');
      assert.equal(previews.at(-1).pricing.overrides.customDailyRateRub, '1000');
      const footerTop = await drawer
        .locator('.ant-drawer-footer')
        .evaluate((el) => el.getBoundingClientRect().top);
      await drawer.locator('.ant-drawer-body').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      assert.equal(
        await drawer.locator('.ant-drawer-footer').evaluate((el) => el.getBoundingClientRect().top),
        footerTop,
      );
      await drawer.locator('.ant-drawer-body').evaluate((el) => {
        el.scrollTop = 0;
      });
      await drawer.locator('.ant-drawer-close').click();
      await open();
      await drawer.getByText('Организация', { exact: true }).click();
      await drawer
        .getByRole('combobox', { name: 'Название организации', exact: true })
        .fill('ООО Тест');
      await drawer.getByRole('combobox', { name: 'Телефон', exact: true }).fill('+79991234567');
      await drawer.getByRole('combobox', { name: 'Марка и модель', exact: true }).click();
      await page.getByTitle('Lada', { exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('.booking-create-submit .ant-btn-primary').disabled,
      );
      await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).click();
      await drawer.getByText('Тестовая ошибка проверки', { exact: true }).waitFor();
      assert.equal(commands.at(-1).body.customer.new.type, 'company');
      await drawer.locator('.ant-drawer-close').click();
      availabilityScenario = true;
      await open();
      await drawer.getByRole('combobox', { name: 'Фамилия', exact: true }).fill('Леб');
      await page
        .locator('.ant-select-item-option-content')
        .filter({ hasText: client.displayName })
        .click();
      await page.waitForFunction(
        () => document.querySelector('input[aria-label="Имя"]').value === 'Ксения',
      );
      await drawer.getByRole('combobox', { name: 'Марка и модель', exact: true }).click();
      await page.getByTitle('Lada Largus', { exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('.booking-create-submit .ant-btn-primary').disabled,
      );
      await drawer.getByLabel('Email', { exact: true }).fill('preserved@example.ru');
      await drawer.getByText('Лояльность и скидки', { exact: true }).click();
      await drawer.getByLabel('Собственная цена за сутки, ₽', { exact: true }).fill('1500');
      await drawer.getByLabel('Причина условий лояльности', { exact: true }).fill('Особые условия');
      await drawer
        .getByLabel('Комментарий (необязательно)', { exact: true })
        .fill('Подобрать позже');
      const manualConfirmation = drawer.getByRole('checkbox', {
        name: 'Подтверждаю ручные условия',
        exact: true,
      });
      await manualConfirmation.check();
      await page.waitForFunction(
        () => !document.querySelector('.booking-create-submit .ant-btn-primary').disabled,
      );
      let releaseRefreshedPreview;
      refreshedPreviewGate = new Promise((resolve) => {
        releaseRefreshedPreview = resolve;
      });
      const previewCountBeforeConflict = previews.length;
      const refreshedPreviewRequest = page.waitForRequest((request) =>
        request.url().endsWith('/bookings/preview'),
      );
      availabilityChangedOnce = true;
      const commandsBeforeConflict = commands.length;
      await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).click();
      await drawer
        .getByText(/Доступность изменилась\. Проверьте обновлённое предупреждение/)
        .waitFor();
      const refreshRequest = await refreshedPreviewRequest;
      assert.equal(
        commands.length,
        commandsBeforeConflict + 1,
        'conflict must not retry automatically',
      );
      const rejected = commands.at(-1);
      assert.equal(rejected.body.previewToken, 'preview-0');
      assert.deepEqual(rejected.body.riskAcceptance, {
        token: 'availability-0',
        reason: 'Подобрать позже',
      });
      assert.deepEqual(rejected.body.confirmedOverrides, ['customDailyRateRub']);
      assert.deepEqual(
        refreshRequest.postDataJSON(),
        previews[previewCountBeforeConflict - 1],
        'refresh must use the same entered pricing and target',
      );
      assert.ok(
        await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).isDisabled(),
      );
      releaseRefreshedPreview();
      await manualConfirmation.waitFor();
      assert.equal(await manualConfirmation.isChecked(), false, 'manual approval must be reset');
      assert.ok(
        await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).isDisabled(),
        'new preview alone must not restore manual approval',
      );
      assert.equal(
        await drawer.getByLabel('Email', { exact: true }).inputValue(),
        'preserved@example.ru',
      );
      assert.equal(
        await drawer.getByLabel('Собственная цена за сутки, ₽', { exact: true }).inputValue(),
        '1500',
      );
      assert.equal(
        await drawer.getByLabel('Причина условий лояльности', { exact: true }).inputValue(),
        'Особые условия',
      );
      assert.equal(
        await drawer.getByLabel('Комментарий (необязательно)', { exact: true }).inputValue(),
        'Подобрать позже',
      );
      await manualConfirmation.check();
      await page.waitForFunction(
        () => !document.querySelector('.booking-create-submit .ant-btn-primary').disabled,
      );
      await page.screenshot({ path: path.join(root, '.runtime/booking-create.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(
        () =>
          document.querySelector('.ant-drawer-content-wrapper').getBoundingClientRect().width <=
          390,
      );
      assert.ok(
        await drawer.locator('.ant-drawer-body').evaluate((el) => el.scrollWidth <= el.clientWidth),
      );
      assert.ok(
        await drawer
          .locator('.ant-drawer-footer')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      );
      allowSuccess = true;
      const before = commands.length;
      await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).dblclick();
      await page
        .locator('.booking-drawer-heading')
        .getByText('Бронь №9', { exact: true })
        .waitFor();
      assert.equal(commands.length, before + 1, 'double click must create only one booking');
      const retried = commands.at(-1);
      assert.equal(retried.body.previewToken, 'preview-1');
      assert.deepEqual(retried.body.riskAcceptance, {
        token: 'availability-1',
        reason: 'Подобрать позже',
      });
      assert.deepEqual(
        retried.body,
        {
          ...rejected.body,
          previewToken: 'preview-1',
          riskAcceptance: { token: 'availability-1', reason: 'Подобрать позже' },
        },
        'resubmission must preserve all other entered data',
      );
      assert.ok(retried.headers['idempotency-key']);
      assert.notEqual(
        retried.headers['idempotency-key'],
        rejected.headers['idempotency-key'],
        'a command with refreshed tokens must receive a new key',
      );
      assert.equal(await page.locator('.booking-create-footer').count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      server.kill();
    }
  },
);
