const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium, devices } = require('playwright');

test(
  'calendar drag highlights forbidden cars and confirms one atomic move',
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
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const start = '2026-11-16T10:00:00+03:00',
        end = '2026-11-18T10:00:00+03:00';
      const vehicles = [
        ...[1, 2, 3].map((id) => ({
          id,
          model_id: id === 3 ? 2 : 1,
          brand_name: 'Тест',
          model_name: id === 3 ? 'Другая модель' : 'Модель',
          pricing_group_name: 'Тариф',
          plate: 'CAR' + id,
          is_ready: true,
        })),
        ...Array.from({ length: 83 }, (_, i) => ({
          id: 100 + i,
          model_id: 1,
          brand_name: 'Ярмарка',
          model_name: 'Модель',
          pricing_group_name: 'Тариф',
          plate: 'FLEET' + i,
          is_ready: true,
        })),
      ];
      const booking = {
        id: 10,
        version: 1,
        start_at: start,
        end_at: end,
        vehicle_id: 1,
        models: [1],
      };
      const events = [
        {
          id: 101,
          vehicle_id: 1,
          booking_id: 10,
          kind: 'assignment',
          start_at: start,
          end_at: end,
          customer_name: 'Клиент',
          accountingEmailUnsent: true,
          invoicePayment: {
            status: 'partial',
            priceRub: '5000',
            receivedRub: '400',
            remainingRub: '4600',
          },
        },
        {
          id: 102,
          vehicle_id: 2,
          booking_id: 11,
          kind: 'assignment',
          start_at: start,
          end_at: end,
          customer_name: 'Занят',
        },
      ];
      let previewBody, moveBody;
      const serveCalendar = (route) => {
        const u = route.request().url();
        if (u.includes('/bookings/10/move/preview')) {
          previewBody = route.request().postDataJSON();
          return route.fulfill({
            json: {
              bookingId: 10,
              expectedVersion: 1,
              oldStartAt: start,
              oldEndAt: end,
              oldVehicleId: 1,
              oldPriceRub: '4000',
              startAt: previewBody.startAt,
              endAt: new Date(Date.parse(previewBody.startAt) + 2 * 86400000).toISOString(),
              vehicleId: previewBody.vehicleId,
              vehiclePlate: 'CAR' + previewBody.vehicleId,
              priceRub: '4000',
              blocked: false,
              eligible: true,
              conflicts: [],
              availability: { status: 'feasible', token: 'a'.repeat(64) },
            },
          });
        }
        if (u.includes('/bookings/10/move')) {
          moveBody = route.request().postDataJSON();
          return route.fulfill({ json: { id: 10, version: 2 } });
        }
        if (u.includes('/auth/me'))
          return route.fulfill({
            json: { user: { id: 1, fullName: 'Тест', role: 'manager' }, csrfToken: 'test' },
          });
        return route.fulfill({
          json: { vehicles, events, bookings: [booking], unassignedBookings: [], problems: [] },
        });
      };
      await page.route('**/api/v1/**', serveCalendar);
      await page.goto(origin + '/calendar?date=2026-11-16');
      await page.locator('[data-vehicle-id="3"]').waitFor();
      await page.evaluate(() => {
        window.calendarDateFormats = 0;
        const original = Date.prototype.toLocaleDateString;
        Date.prototype.toLocaleDateString = function (...args) {
          window.calendarDateFormats++;
          return original.apply(this, args);
        };
      });
      const source = await page.locator('[data-vehicle-id="1"] .calendar-event').boundingBox(),
        target = await page.locator('[data-vehicle-id="3"] .calendar-track').boundingBox();
      await page.mouse.move(source.x + 30, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(source.x + 126, target.y + target.height / 2, { steps: 5 });
      const targetRow = page.locator('[data-vehicle-id="3"].calendar-drop-target');
      await targetRow.waitFor();
      assert.notEqual(
        await targetRow.locator('.calendar-label').evaluate((el) => getComputedStyle(el).boxShadow),
        'none',
      );
      assert.ok(
        await page
          .locator('[data-vehicle-id="2"]')
          .evaluate((el) => el.classList.contains('calendar-drop-unavailable')),
      );
      assert.ok(
        await page
          .locator('[data-vehicle-id="3"]')
          .evaluate((el) => el.classList.contains('calendar-drop-available')),
      );
      assert.equal(
        await page
          .locator('[data-vehicle-id="2"] .calendar-track')
          .evaluate((el) => getComputedStyle(el).boxShadow),
        'none',
      );
      assert.ok(
        (await page.evaluate(() => window.calendarDateFormats)) < 100,
        'drag must not re-render every day cell',
      );
      assert.equal(
        await page.locator('[data-vehicle-id="1"] .calendar-booking-start').innerText(),
        '16.11 10:00',
      );
      assert.equal(
        await page.locator('.calendar-drag-ghost .calendar-booking-start').innerText(),
        '17.11 10:00',
      );
      const ghost = page.locator('.calendar-drag-ghost');
      assert.equal(await ghost.locator('.calendar-booking-name').innerText(), 'Клиент');
      assert.ok(await ghost.locator('.calendar-accounting-email-icon').isVisible());
      assert.ok(await ghost.locator('.calendar-booking-debt-ribbon').isVisible());
      assert.equal(
        await ghost.locator('.calendar-booking-debt-amount').textContent(),
        await page.locator('[data-vehicle-id="1"] .calendar-booking-debt-amount').textContent(),
      );
      assert.doesNotMatch(await ghost.innerText(), /Другая модель|CAR3/);
      assert.equal(
        await page
          .locator('[data-vehicle-id="1"] .calendar-event')
          .evaluate((el) => getComputedStyle(el).opacity),
        '0.35',
      );
      await page.screenshot({ path: path.join(root, '.runtime/calendar-drag-copy.png') });
      await page.mouse.up();
      assert.equal(await page.locator('.calendar-drag-source').count(), 0);
      assert.equal(await targetRow.count(), 0);
      assert.equal(await ghost.isVisible(), false);
      await page.getByText('Изменение брони №10').waitFor();
      assert.equal(previewBody.vehicleId, 3);
      assert.equal(previewBody.startAt, '2026-11-17T07:00:00.000Z');
      await page.getByRole('button', { name: 'Подтвердить изменения' }).click();
      await page.waitForFunction(() => !document.body.textContent.includes('Изменение брони №10'));
      assert.equal(moveBody.vehicleId, 3);
      assert.equal(moveBody.expectedVersion, 1);
      assert.equal(moveBody.availabilityToken, 'a'.repeat(64));
      assert.deepEqual(errors, []);
      const second = await page.locator('[data-vehicle-id="1"] .calendar-event').boundingBox();
      await page.mouse.move(second.x + 30, second.y + second.height / 2);
      await page.mouse.down();
      await page.mouse.move(second.x + 34, second.y + second.height / 2, { steps: 3 });
      await page.mouse.up();
      await page.getByText('Изменение брони №10').waitFor();
      assert.equal(previewBody.startAt, '2026-11-16T08:00:00.000Z');
      await page.getByRole('button', { name: 'Отмена' }).click();
      const mobile = await browser.newPage(devices['iPhone 13']);
      await mobile.route('**/api/v1/**', serveCalendar);
      await mobile.goto(origin + '/calendar?date=2026-11-16');
      const mobileGrid = mobile.locator('.calendar-grid');
      const mobileBooking = mobile.locator('[data-vehicle-id="1"] .calendar-event');
      await mobileBooking.waitFor();
      const client = await mobile.context().newCDPSession(mobile);
      const touch = (type, x, y) =>
        client.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
        });
      const startTouch = async () => {
        const bounds = await mobileBooking.boundingBox();
        const x = Math.min(bounds.x + 32, mobile.viewportSize().width - 12);
        const y = bounds.y + bounds.height / 2;
        await touch('touchStart', x, y);
        return { x, y };
      };
      previewBody = undefined;
      const initialScroll = await mobileGrid.evaluate((grid) => grid.scrollLeft);
      const swipe = await startTouch();
      await touch('touchMove', swipe.x - 35, swipe.y);
      await touch('touchMove', swipe.x - 70, swipe.y);
      await touch('touchEnd');
      await mobile.waitForFunction(
        (initial) => document.querySelector('.calendar-grid').scrollLeft > initial,
        initialScroll,
      );
      assert.equal(previewBody, undefined);
      assert.equal(await mobile.locator('.calendar-drag-ready, .ant-drawer-open').count(), 0);
      await mobile.reload();
      await mobileBooking.waitFor();
      const holdWithDrift = async () => {
        const { x, y } = await startTouch();
        const heldX = x + 6;
        await touch('touchMove', heldX, y);
        await mobile.locator('.calendar-drag-ready').waitFor();
        return { x: heldX, y };
      };
      await holdWithDrift();
      await Promise.all([
        assert.rejects(
          mobile.waitForRequest((request) => request.url().endsWith('/bookings/10/move/preview'), {
            timeout: 1000,
          }),
          { name: 'TimeoutError' },
          'releasing a hold without dragging must not request a move preview',
        ),
        touch('touchEnd'),
      ]);
      assert.equal(await mobile.locator('.calendar-drag-ready, .ant-drawer-open').count(), 0);
      assert.equal(await mobile.getByText('Изменение брони №10').count(), 0);

      const hold = await holdWithDrift();
      await touch('touchMove', hold.x + 16, hold.y);
      await mobile.locator('.calendar-drag-ghost:not([hidden])').waitFor();
      await touch('touchEnd');
      await mobile.getByText('Изменение брони №10').waitFor();
      assert.equal(previewBody.vehicleId, 1);
      assert.equal(previewBody.startAt, '2026-11-16T11:00:00.000Z');
      await mobile.close();
      // A booking displaced by a technical block must be movable from its old row.
      events[0].kind = 'displaced';
      booking.vehicle_id = null;
      events.push({
        id: 103,
        vehicle_id: 1,
        kind: 'technical',
        start_at: start,
        end_at: end,
        reason: 'Срочный ремонт',
      });
      await page.reload();
      const displaced = page.locator('[data-vehicle-id="1"] .calendar-event.booking');
      await displaced.waitFor();
      const conflictSource = await displaced.boundingBox(),
        freeRow = await page.locator('[data-vehicle-id="3"] .calendar-track').boundingBox();
      await page.mouse.move(conflictSource.x + 30, conflictSource.y + conflictSource.height / 2);
      await page.mouse.down();
      await page.mouse.move(conflictSource.x + 30, freeRow.y + freeRow.height / 2, { steps: 5 });
      await page.locator('.calendar-drag-ghost:not([hidden])').waitFor();
      assert.equal(
        await page.locator('.calendar-drag-ghost .calendar-booking-start').innerText(),
        '16.11 10:00',
      );
      await page.mouse.move(conflictSource.x + 34, freeRow.y + freeRow.height / 2, { steps: 3 });
      await page.waitForFunction(() =>
        document
          .querySelector('.calendar-drag-ghost .calendar-booking-start')
          ?.textContent.includes('11:00'),
      );
      await page.mouse.up();
      await page.getByText('Изменение брони №10').waitFor();
      assert.equal(previewBody.vehicleId, 3);
      assert.equal(previewBody.startAt, '2026-11-16T08:00:00.000Z');
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      server.kill();
    }
  },
);
