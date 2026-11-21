const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

test(
  'booking drawer hierarchy, disclosures and existing actions',
  { timeout: 120000 },
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
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const booking = {
        id: 9,
        version: 1,
        status: 'confirmed',
        created_at: '2026-11-14T12:00:00Z',
        customer_id: 1,
        customer_name: 'Лебедева Ксения',
        vehicle_id: 1,
        target_type: 'vehicle',
        target_vehicle_id: 1,
        start_at: '2026-11-19T07:00:00Z',
        end_at: '2026-11-20T07:00:00Z',
        terms: [{ snapshot: { finalTotalRub: '2200', eligibleModels: [1] } }],
        vehicleOptions: [
          { id: 1, modelId: 1, pricingGroupId: 1, isReady: true, busy: false },
          { id: 2, modelId: 2, pricingGroupId: 2, isReady: true, busy: false },
          { id: 3, modelId: 3, pricingGroupId: 1, isReady: true, busy: false },
        ],
        alternatives: [],
        problemReasons: ['Нет свободного автомобиля на весь период'],
        replacementReason: 'Подробная причина',
        conflicts: [],
      };
      const summary = {
        bookingId: 9,
        customerId: 1,
        bookingVersion: 1,
        status: 'confirmed',
        priceRub: '2200',
        coverageRub: '0',
        debtRub: '2200',
        overpaymentRub: '0',
        depositRub: '0',
        availableCreditRub: '0',
        suggestedDepositRub: null,
        paidPercent: '0',
      };
      let moveBody;
      await page.route('**/api/v1/**', (route) => {
        const url = new URL(route.request().url()),
          p = url.pathname;
        let data = {};
        if (p.endsWith('/auth/me'))
          data = { user: { id: 1, fullName: 'Оператор', role: 'manager' }, csrfToken: 'test' };
        else if (p.endsWith('/bookings/9/move/preview'))
          data = {
            bookingId: 9,
            expectedVersion: booking.version,
            oldStartAt: booking.start_at,
            oldEndAt: booking.end_at,
            oldVehicleId: booking.vehicle_id,
            oldPriceRub: booking.terms[0].snapshot.finalTotalRub,
            startAt: booking.start_at,
            endAt: booking.end_at,
            vehicleId: 2,
            vehiclePlate: 'А111ХМ778',
            priceRub: '3000',
            quoteToken: 'quote-test',
            blocked: false,
            availability: { status: 'feasible', token: 'a'.repeat(64) },
          };
        else if (p.endsWith('/bookings/9/move')) {
          moveBody = route.request().postDataJSON();
          booking.vehicle_id = 2;
          booking.target_vehicle_id = 2;
          booking.version = 2;
          booking.terms = [{ snapshot: { finalTotalRub: '3000', eligibleModels: [2] } }];
          data = { id: 9, version: 2 };
        } else if (p.endsWith('/bookings/9')) data = booking;
        else if (p.endsWith('/booking-options'))
          data = {
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
              {
                id: 2,
                modelId: 2,
                brandId: 2,
                modelName: 'Sedan',
                plate: 'А111ХМ778',
                isReady: true,
                label: 'Lada Sedan · А111ХМ778',
              },
              {
                id: 3,
                modelId: 3,
                brandId: 1,
                modelName: 'Sprinter',
                plate: 'А222ХМ778',
                isReady: true,
                label: 'Mercedes Sprinter · А222ХМ778',
              },
            ],
            models: [
              { id: 1, pricingGroupId: 1 },
              { id: 2, pricingGroupId: 2 },
              { id: 3, pricingGroupId: 1 },
            ],
            brands: [],
            groups: [],
          };
        else if (p.endsWith('/customers/1/finance'))
          data = { sources: [], bookings: [summary], items: [] };
        else if (p.endsWith('/history'))
          data = {
            total: 1,
            items: [
              {
                id: 1,
                action: 'bookings.created',
                author: 'Оператор',
                createdAt: booking.created_at,
                details: {},
              },
            ],
          };
        else if (p.endsWith('/calendar'))
          data = {
            vehicles: [
              {
                id: 1,
                model_id: 1,
                plate: 'А857ХМ778',
                brand_name: 'Lada',
                model_name: 'Largus',
                pricing_group_name: 'Стандарт',
                is_ready: true,
              },
              {
                id: 2,
                model_id: 2,
                plate: 'А111ХМ778',
                brand_name: 'Lada',
                model_name: 'Sedan',
                pricing_group_name: 'Комфорт',
                is_ready: true,
              },
            ],
            events: [],
            bookings: [],
            unassignedBookings: [],
            problems: [],
          };
        return route.fulfill({ json: data });
      });
      await page.goto(origin + '/calendar?booking=9');
      const drawer = page.locator('.booking-drawer');
      try {
        await drawer.getByText('До выдачи', { exact: true }).waitFor({ timeout: 10000 });
      } catch (e) {
        throw new Error(
          JSON.stringify({ errors, body: await page.locator('body').innerText() }) +
            ' ' +
            e.message,
        );
      }
      await drawer.getByText('Плановая стоимость брони', { exact: true }).waitFor();
      assert.equal(
        await drawer.locator('.booking-drawer-heading .ant-tag').innerText(),
        'До выдачи',
      );
      assert.ok((await drawer.locator('.booking-date-range').innerText()).includes('1 сутки'));
      assert.equal(await drawer.locator('.booking-overview-row').count(), 4);
      assert.equal(await drawer.locator('.booking-financial-cell').count(), 5);
      assert.equal(
        await drawer.evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(15, 30, 46)',
      );
      assert.ok(!(await drawer.locator('.booking-date-range').innerText()).includes('10:00:00'));
      assert.equal(await drawer.locator('.ant-collapse-item-active').count(), 0);
      await drawer
        .getByRole('button', { name: 'Возврат и доступные средства', exact: true })
        .click();
      await drawer
        .getByRole('button', { name: 'Провести денежную операцию', exact: true })
        .waitFor();
      await drawer.getByRole('button', { name: 'Отмена', exact: true }).click();
      await drawer.getByRole('button', { name: 'Действия с бронью', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Отменить бронь', exact: true }).click();
      await page.getByRole('dialog', { name: 'Отменить бронь', exact: true }).waitFor();
      await page
        .getByRole('dialog', { name: 'Отменить бронь', exact: true })
        .getByLabel('Close', { exact: true })
        .click();
      await drawer.getByText('История', { exact: true }).click();
      await drawer.getByText('Бронь создана', { exact: true }).waitFor();
      await drawer.getByRole('button', { name: 'Изменить автомобиль' }).click();
      await page
        .getByRole('dialog', { name: 'Выберите автомобиль' })
        .getByLabel('Назначаемый автомобиль')
        .first()
        .click();
      const optionsText = await page.locator('.ant-select-dropdown:visible').innerText();
      assert.ok(
        optionsText.indexOf('Тот же тариф') < optionsText.indexOf('Sprinter') &&
          optionsText.indexOf('Sprinter') < optionsText.indexOf('Другие автомобили'),
      );
      await page
        .locator('.ant-select-dropdown:visible')
        .getByTitle('Lada Sedan · А111ХМ778')
        .click();
      const moveDialog = page.getByRole('dialog', { name: 'Изменение брони №9' });
      await moveDialog.waitFor();
      assert.match((await moveDialog.innerText()).replace(/\u00a0/g, ' '), /3 000 ₽/);
      await page.getByRole('button', { name: 'Подтвердить изменения' }).click();
      await drawer.getByRole('link', { name: 'Lada Sedan · А111ХМ778' }).waitFor();
      assert.equal(moveBody.quoteToken, 'quote-test');
      assert.equal(moveBody.vehicleId, 2);
      await drawer.getByText('История', { exact: true }).click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('.booking-history .ant-collapse-content-active')
            ?.getBoundingClientRect().height > 65,
      );
      await page.screenshot({ path: path.join(root, '.runtime/booking-card.png') });
      assert.ok(
        await page
          .locator('.ant-drawer-content-wrapper')
          .evaluate((el) => Math.abs(el.getBoundingClientRect().width - 560) < 1),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(
        () =>
          document.querySelector('.ant-drawer-content-wrapper').getBoundingClientRect().width <=
          390,
      );
      assert.ok(
        await drawer.locator('.ant-drawer-body').evaluate((el) => el.scrollWidth <= el.clientWidth),
      );
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      server.kill();
    }
  },
);
