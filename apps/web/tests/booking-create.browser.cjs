const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

test(
  'booking creation form, inline client search, pricing and fixed footer',
  { timeout: 180000 },
  () => runBookingScenario(false),
);
test(
  'invoice receipts update the booking, calendar and contract before checkout',
  {
    timeout: 90000,
  },
  () => runBookingScenario(true),
);

async function runBookingScenario(invoiceOnly) {
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
    let accountingStatus = 'none';
    let accountingVehicleAssigned = false;
    let companyBooking = false;
    let checkoutStarted = false;
    let received = 0;
    const paymentCommands = [];
    const payment = () => ({
      status: received === 0 ? 'unpaid' : received < 2200 ? 'partial' : 'paid',
      priceRub: '2200',
      receivedRub: String(received),
      remainingRub: String(2200 - received),
    });
    const sentAt = '2026-11-22T13:40:00.000Z';
    const invoiceCommands = [];
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        p = url.pathname;
      let data = {};
      if (p.endsWith('/auth/me'))
        data = { user: { id: 1, fullName: 'Оператор', role: 'manager' }, csrfToken: 'test' };
      else if (p.endsWith('/calendar')) {
        data = { vehicles: [], events: [], unassignedBookings: [], problems: [] };
        if (accountingVehicleAssigned) {
          data.vehicles = [
            {
              id: 1,
              model_id: 1,
              brand_name: 'Lada',
              model_name: 'Largus',
              plate: 'А857ХМ778',
              is_ready: true,
            },
          ];
          data.events = [
            {
              id: 11,
              booking_id: 9,
              vehicle_id: 1,
              kind: 'assignment',
              customer_name: 'ООО Тест',
              start_at: '2026-11-16T13:19:00Z',
              end_at: '2026-11-17T13:19:00Z',
              ...(accountingStatus === 'done' ? {} : { accountingEmailUnsent: true }),
              invoicePayment: payment(),
            },
          ];
        }
      } else if (p.endsWith('/booking-options')) data = fleet;
      else if (p.endsWith('/booking-customers')) {
        const q = url.searchParams.get('q');
        searches.push(q);
        if (q === 'Устаревший') {
          await new Promise((r) => setTimeout(r, 800));
          data = { items: [{ ...client, id: 8, displayName: 'Устаревший ответ' }] };
        } else data = { items: [client] };
      } else if (p.endsWith('/customers/7'))
        data = companyBooking
          ? {
              ...client,
              type: 'company',
              displayName: 'ООО Тест',
              documentReadiness: { ready: false, missing: [], required: [] },
            }
          : client;
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
            effectiveMileageLimitKm: body.pricing.contractDays * body.pricing.dailyMileagePackageKm,
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
          companyBooking = commands.at(-1).body.customer.new?.type === 'company';
          data = commands.at(-1).body.requestAccountingEmail
            ? { id: 9, accountingEmailRequested: true }
            : { id: 9 };
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
      } else if (p.endsWith('/bookings/9/accounting-email')) {
        if (request.method() === 'POST') {
          invoiceCommands.push(request.postDataJSON());
          accountingStatus = 'pending';
          data = { id: 9, accountingEmailRequested: true };
        } else {
          data = {
            status: accountingStatus,
            canRequest: accountingStatus === 'none' && accountingVehicleAssigned,
            isCompany: companyBooking,
            sentAt: accountingStatus === 'done' ? sentAt : null,
          };
        }
      } else if (p.endsWith('/financial-operations/invoice-receipt')) {
        const body = request.postDataJSON();
        paymentCommands.push(body);
        received += Number(body.amountRub);
        data = { id: paymentCommands.length };
      } else if (p.endsWith('/bookings/9/finance')) {
        data = {
          summary: {
            bookingId: 9,
            customerId: 7,
            bookingVersion: accountingVehicleAssigned ? 2 : 1,
            status: 'confirmed',
            paymentsAllowed: checkoutStarted,
            priceRub: '2200',
            coverageRub: String(received),
            debtRub: String(2200 - received),
            depositRub: '0',
            suggestedDepositRub: null,
          },
          invoicePayment: payment(),
        };
      } else if (p.endsWith('/bookings/9/documents')) {
        data = {
          booking: { customerId: 7, version: 2, vehicleId: 1, status: 'confirmed' },
          checkout: checkoutStarted
            ? {
                startedAt: '2026-11-16T14:00:00Z',
                hasChanges: false,
                issuedAt: null,
                actSignedAt: null,
                hasMoney: received > 0,
                rentReceived: received > 0,
                depositReceived: false,
                requiredDepositRub: null,
              }
            : null,
          vehicle: null,
          acts: [],
          photos: [],
          inspections: [],
          inspectionWork: [],
          contracts: [],
          customerVersion: 8,
          storageConfigured: true,
          lessorConfigured: true,
          missing: [],
        };
      } else if (p.endsWith('/bookings/9/checkout/start')) {
        checkoutStarted = true;
        data = { id: 9 };
      } else if (p.endsWith('/bookings/9'))
        data = {
          id: 9,
          version: accountingVehicleAssigned ? 2 : 1,
          status: 'confirmed',
          customer_id: 7,
          customer_name: client.displayName,
          vehicle_id: accountingVehicleAssigned ? 1 : null,
          target_type: 'model',
          target_model_id: 1,
          start_at: '2026-11-16T13:19:00Z',
          end_at: '2026-11-17T13:19:00Z',
          terms: [{ snapshot: { finalTotalRub: '2200', eligibleModels: [1] } }],
          alternatives: [],
          problemReasons: [],
          conflicts: [],
        };
      else if (p.endsWith('/customers/7/finance')) data = { sources: [], bookings: [], items: [] };
      return route.fulfill({ json: data });
    });
    await page.goto(origin + '/calendar');
    const open = async () => {
      await page.getByRole('button', { name: /Бронь$/ }).click();
      await page.locator('.booking-create-drawer').waitFor();
    };
    const drawer = page.locator('.booking-create-drawer');
    if (invoiceOnly) {
      await exerciseInvoiceFlow();
      return;
    }
    await open();
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
    const rentalStart = drawer.getByLabel('Начало аренды', { exact: true });
    await rentalStart.click();
    const rentalPicker = page.locator('.ant-picker-dropdown:visible');
    await rentalPicker.getByTitle('2026-11-19', { exact: true }).click();
    const timeColumns = rentalPicker.locator('.ant-picker-time-panel-column');
    await timeColumns.nth(0).locator('[data-value="10"]').click();
    await timeColumns.nth(1).locator('[data-value="0"]').click();
    await rentalPicker.locator('.ant-picker-ok button').click();
    const updatedPreview = page.waitForResponse(
      (response) =>
        response.url().endsWith('/bookings/preview') &&
        response.request().postDataJSON().pricing.dailyMileagePackageKm === 400,
    );
    await drawer.getByText('400 км', { exact: true }).click();
    await updatedPreview;
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
    await drawer.getByRole('button', { name: 'Повторить с тем же ключом', exact: true }).waitFor();
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
    await drawer.getByRole('combobox', { name: 'Телефон', exact: true }).fill('8 (921) 555-12-34');
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
    await drawer.getByRole('combobox', { name: 'Модель или группа аналогов', exact: true }).click();
    await page.getByTitle('Универсалы · Аналоги', { exact: true }).click();
    await drawer.getByText('Лояльность и скидки', { exact: true }).click();
    await drawer.getByLabel('Собственная цена за сутки, ₽', { exact: true }).fill('1000');
    await drawer
      .getByLabel('Причина условий лояльности', { exact: true })
      .fill('Постоянный клиент');
    await drawer.getByRole('checkbox', { name: 'Подтверждаю ручные условия', exact: true }).check();
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
    await page.getByRole('button', { name: 'Нет, сохранить без счёта', exact: true }).click();
    await drawer.getByText('Тестовая ошибка проверки', { exact: true }).waitFor();
    assert.equal(commands.at(-1).body.customer.new.type, 'company');
    assert.equal(commands.at(-1).body.requestAccountingEmail, false);
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
    await drawer.getByLabel('Комментарий (необязательно)', { exact: true }).fill('Подобрать позже');
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
        document.querySelector('.ant-drawer-content-wrapper').getBoundingClientRect().width <= 390,
    );
    assert.ok(
      await drawer.locator('.ant-drawer-body').evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    assert.ok(
      await drawer.locator('.ant-drawer-footer').evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    allowSuccess = true;
    const before = commands.length;
    await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).dblclick();
    await page.locator('.booking-drawer-heading').getByText('Бронь №9', { exact: true }).waitFor();
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

    async function exerciseInvoiceFlow() {
      allowSuccess = true;
      await open();
      await drawer.getByText('Организация', { exact: true }).click();
      await drawer
        .getByRole('combobox', { name: 'Название организации', exact: true })
        .fill('ООО Тест');
      await drawer.getByRole('combobox', { name: 'Телефон', exact: true }).fill('+79991234567');
      await drawer.getByRole('combobox', { name: 'Марка и модель', exact: true }).click();
      await page.getByTitle('Lada', { exact: true }).click();
      const beforeInvoice = commands.length;
      await drawer.getByRole('button', { name: 'Создать бронь', exact: true }).click();
      const invoiceDialog = page.getByRole('dialog', { name: 'Выставить счёт?' });
      await invoiceDialog
        .getByText(
          'Сохраните бронь, затем назначьте автомобиль и нажмите «Выставить счёт» в карточке брони.',
        )
        .waitFor();
      assert.equal(commands.length, beforeInvoice);
      const yes = invoiceDialog.getByRole('button', { name: 'Да, передать в бухгалтерию' });
      assert.equal(await yes.isDisabled(), true);
      await invoiceDialog.getByRole('button', { name: 'Нет, сохранить без счёта' }).click();
      await page
        .locator('.booking-drawer-heading')
        .getByText('Бронь №9', { exact: true })
        .waitFor();
      assert.equal(commands.at(-1).body.requestAccountingEmail, false);
      const issueInvoice = page.getByRole('button', { name: 'Выставить счёт', exact: true });
      assert.equal(await issueInvoice.count(), 0);
      const emailStatus = page
        .locator('.booking-overview-row')
        .filter({ hasText: 'Данные для счёта' });
      await emailStatus.getByText('Не отправлено', { exact: true }).waitFor();
      accountingVehicleAssigned = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await issueInvoice.waitFor();
      const unsentIcon = page.locator('.calendar-event').getByRole('img', {
        name: 'Данные для счёта не отправлены',
      });
      await unsentIcon.waitFor({ state: 'attached' });
      assert.deepEqual(invoiceCommands, []);
      const statusResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith('/bookings/9/accounting-email') &&
          response.request().method() === 'GET',
      );
      await issueInvoice.click();
      assert.equal((await (await statusResponse).json()).status, 'pending');
      assert.deepEqual(invoiceCommands, [{ expectedVersion: 2 }]);
      const emailNotice = page.getByText('Данные для счёта отправлены в бухгалтерию', {
        exact: true,
      });
      assert.equal(await emailNotice.count(), 0);
      accountingStatus = 'done';
      await emailNotice.waitFor();
      await emailStatus.getByText('Отправлено', { exact: true }).waitFor();
      assert.equal(await emailStatus.locator('time').getAttribute('datetime'), sentAt);
      assert.match(await emailStatus.locator('time').innerText(), /16:40 МСК/);
      await unsentIcon.waitFor({ state: 'detached' });

      const bookingPayment = page.getByRole('region', { name: 'Оплата аренды', exact: true });
      const paymentDialog = page.getByRole('dialog', { name: 'Подтвердить поступление по счёту' });
      const confirmPayment = page.locator('.booking-invoice-payment').getByRole('button', {
        name: 'Подтвердить поступление',
        exact: true,
      });
      const paymentCell = page.locator('.calendar-event');
      await bookingPayment.getByText('Не оплачено', { exact: true }).waitFor();
      await paymentCell
        .getByRole('img', { name: 'Не оплачено', exact: true })
        .waitFor({ state: 'attached' });
      await confirmPayment.click();
      const amount = paymentDialog.getByLabel('Сумма поступления, ₽');
      assert.equal(await amount.inputValue(), '2200');
      await amount.fill('900');
      await paymentDialog.getByLabel('Номер платёжного поручения (если известен)').fill('72');
      await paymentDialog.getByRole('button', { name: 'Подтвердить поступление' }).click();
      await bookingPayment.getByText('Оплачено частично', { exact: true }).waitFor();
      assert.deepEqual(paymentCommands[0], {
        bookingId: 9,
        customerId: 7,
        expectedVersion: 2,
        expectedCoverageRub: '0',
        amountRub: '900',
        paidOn: '2026-11-16',
        reference: '72',
      });
      assert.equal(checkoutStarted, false);
      await paymentCell
        .getByRole('img', { name: 'Оплачено частично' })
        .waitFor({ state: 'attached' });
      await paymentDialog.waitFor({ state: 'hidden' });
      await confirmPayment.click();
      assert.equal(await amount.inputValue(), '1300');
      await paymentDialog.getByRole('button', { name: 'Подтвердить поступление' }).click();
      await bookingPayment.getByText('Оплачено', { exact: true }).waitFor();
      assert.equal(paymentCommands[1].expectedCoverageRub, '900');
      await paymentCell
        .getByRole('img', { name: 'Оплачено', exact: true })
        .waitFor({ state: 'attached' });
      assert.equal(checkoutStarted, false);
      await paymentDialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Действия с бронью' }).click();
      await page.getByRole('menuitem', { name: 'Создать договор' }).click();
      const contractPayment = page.locator('.checkout-section-payment');
      await contractPayment
        .locator('.ant-collapse-header')
        .getByText('Оплачено', { exact: true })
        .waitFor();
      await contractPayment.getByRole('tab', { name: /Оплата/ }).click();
      await contractPayment
        .getByRole('region', { name: 'Оплата аренды' })
        .getByText('Оплачено', { exact: true })
        .waitFor();
      assert.deepEqual(errors, []);
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}
