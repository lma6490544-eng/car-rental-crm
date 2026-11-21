const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

test('calendar status filters and sticky nested group headers', { timeout: 120000 }, async () => {
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
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.clock.setFixedTime(new Date('2026-11-13T22:00:00.000Z'));
    const vehicles = Array.from({ length: 60 }, (_, i) => ({
      id: 1200 + i,
      brand_name: i < 40 ? 'Марка А' : 'Марка Б',
      model_name: i < 20 ? 'Модель 1' : 'Модель 2',
      pricing_group_name: i < 40 ? 'Тариф А' : 'Тариф Б',
      plate: 'TEST' + i,
      is_ready: i % 2 === 0,
      needs_wash: i % 3 === 0,
      current_mileage_km: i % 5 === 0 ? null : 100,
      next_maintenance_due_km: 100,
    }));
    const events = [
      {
        id: 1,
        vehicle_id: 1200,
        booking_id: 1,
        kind: 'assignment',
        start_at: '2026-11-14T00:00:00+03:00',
        end_at: '2026-11-16T00:00:00+03:00',
        customer_name: 'Клиент',
        financialSummary: {
          priceRub: '10000',
          coverageRub: '0',
          debtRub: '10000',
          overpaymentRub: '0',
          depositRub: '0',
        },
      },
      {
        id: 2,
        vehicle_id: 1200,
        kind: 'technical',
        start_at: '2026-11-14T00:00:00+03:00',
        end_at: '2026-11-15T00:00:00+03:00',
        reason: 'Ремонт',
      },
    ];
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({
        json: route.request().url().includes('/auth/me')
          ? { user: { id: 1, fullName: 'Тест', role: 'manager' }, csrfToken: 'test' }
          : { vehicles, events, unassignedBookings: [], problems: [] },
      }),
    );
    const open = async (query = '') => {
      await page.goto(origin + '/calendar?date=2026-11-14' + query);
      await page.waitForFunction(() => document.querySelectorAll('[data-vehicle-id]').length > 0);
    };
    const calendarRequests = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/calendar?')) calendarRequests.push(new URL(r.url()));
    });
    await open();
    await page.waitForFunction(
      () => document.querySelector('.calendar-grid').scrollLeft === 15 * 96,
    );
    assert.equal(calendarRequests.at(-1).searchParams.get('from'), '2026-10-29T21:00:00.000Z');
    assert.equal(calendarRequests.at(-1).searchParams.get('to'), '2026-12-13T21:00:00.000Z');
    assert.equal(await page.locator('.calendar-days>div').count(), 45);
    assert.equal(await page.locator('.calendar-days [aria-current="date"]').count(), 1);
    assert.equal(await page.locator('.calendar-days [aria-current="date"]').innerText(), '14 сб');
    assert.ok((await page.locator('.calendar-months>div').count()) >= 2);
    assert.ok(
      await page.locator('.calendar-months>div>span').evaluateAll((nodes) =>
        nodes.some((node) => {
          const rect = node.getBoundingClientRect(),
            grid = document.querySelector('.calendar-grid').getBoundingClientRect();
          return rect.left >= grid.left && rect.right <= grid.right;
        }),
      ),
    );
    assert.equal(await page.locator('.current-time-indicator').count(), 1);
    assert.equal(await page.locator('.current-time-indicator').getAttribute('data-time'), '01:00');
    assert.ok(
      await page.locator('.current-time-indicator').evaluate((line) => {
        const today = document.querySelector('.calendar-day-today').getBoundingClientRect();
        return Math.abs(line.getBoundingClientRect().left - today.left - today.width / 24) < 1;
      }),
    );
    assert.ok(
      await page.locator('.current-time-indicator-dot').evaluate((dot) => {
        const rect = dot.getBoundingClientRect();
        const header = document.querySelector('.calendar-head').getBoundingClientRect();
        return rect.top < header.bottom && rect.bottom > header.bottom;
      }),
    );
    assert.equal(await page.locator('.calendar-event.booking').count(), 1);
    const conflictBorders = page.locator('[data-vehicle-id="1200"] .calendar-conflict-border');
    assert.equal(await conflictBorders.count(), 2);
    for (const [eventId, eventClass, widthRatio] of [
      ['1', 'booking', 0.5],
      ['2', 'technical', 1],
    ]) {
      const border = await page
        .locator(`.calendar-conflict-border[data-event-id="${eventId}"]`)
        .boundingBox();
      const card = await page.locator(`.calendar-event.${eventClass}`).boundingBox();
      assert.ok(border && card);
      assert.ok(Math.abs(border.y - card.y) < 1, 'conflict must sit on the card top edge');
      assert.ok(Math.abs(border.x - card.x) < 1);
      assert.ok(Math.abs(border.width - card.width * widthRatio) < 1);
      assert.equal(
        await page
          .locator(`.calendar-conflict-border[data-event-id="${eventId}"]`)
          .evaluate((el) => getComputedStyle(el).borderTopColor),
        'rgb(214, 70, 80)',
      );
    }
    assert.notEqual(
      await page
        .locator('.calendar-event.booking')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgb(118, 175, 208)',
    );
    assert.equal(
      await page
        .locator('.calendar-event.booking')
        .evaluate((el) => getComputedStyle(el).borderTopColor),
      'rgb(185, 155, 83)',
    );
    assert.equal(
      await page.locator('.current-time-indicator').evaluate((el) => getComputedStyle(el).width),
      '2px',
    );
    await page.screenshot({ path: path.join(root, '.runtime/calendar-today.png') });
    if (process.env.CALENDAR_VISUAL_MODE) {
      const baseline = path.join(root, '.runtime/calendar-refactor-baseline.png');
      const actual = await page.locator('.calendar-shell').screenshot({ animations: 'disabled' });
      if (process.env.CALENDAR_VISUAL_MODE === 'record') {
        await page
          .locator('.calendar-shell')
          .screenshot({ path: baseline, animations: 'disabled' });
      } else {
        assert.deepEqual(
          actual,
          readFileSync(baseline),
          'calendar pixels must match the pre-refactor baseline',
        );
      }
    }
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollLeft = 1700;
    });
    assert.ok(
      await page
        .locator('[data-vehicle-id="1200"] .calendar-conflict-border')
        .first()
        .evaluate((strip) => {
          const label = strip.closest('.calendar-row').querySelector('.calendar-label'),
            s = strip.getBoundingClientRect(),
            l = label.getBoundingClientRect();
          const x = Math.max(l.left + 8, s.left + 8),
            y = s.top + s.height / 2;
          return (
            x < Math.min(l.right - 8, s.right) && label.contains(document.elementFromPoint(x, y))
          );
        }),
      'conflict border must stay behind the fixed vehicle column',
    );
    assert.ok(
      await page.locator('[data-vehicle-id="1200"] .calendar-event.booking').evaluate((event) => {
        const label = event.closest('.calendar-row').querySelector('.calendar-label'),
          s = event.getBoundingClientRect(),
          l = label.getBoundingClientRect();
        const x = Math.max(l.left + 8, s.left + 8),
          y = s.top + s.height / 2;
        return (
          x < Math.min(l.right - 8, s.right) && label.contains(document.elementFromPoint(x, y))
        );
      }),
      'booking strip must stay behind the fixed vehicle column',
    );
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollLeft = 15 * 96;
    });
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollLeft = 8 * 96;
    });
    assert.equal(
      await page.getByLabel('Дата календаря', { exact: true }).inputValue(),
      '14.11.2026',
    );
    await page.evaluate(() => {
      window.loaderDate = undefined;
      const observer = new MutationObserver(() => {
        if (document.querySelector('.calendar-loading')) {
          window.loaderDate = document.querySelector('input[aria-label="Дата календаря"]').value;
          observer.disconnect();
        }
      });
      observer.observe(document.querySelector('.calendar-shell'), {
        childList: true,
        subtree: true,
      });
    });
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollLeft = 96;
    });
    await page.waitForFunction(
      () =>
        document.querySelector('input[aria-label="Дата календаря"]').value === '30.10.2026' &&
        document.querySelector('.calendar-grid').scrollLeft === 16 * 96,
    );
    assert.equal(
      await page.evaluate(() => window.loaderDate),
      '14.11.2026',
      'loader must appear before the date range changes',
    );
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForFunction(
      () => document.querySelector('input[aria-label="Дата календаря"]').value === '14.11.2026',
    );
    await page.getByRole('button', { name: 'Сегодня', exact: true }).click();
    await page.waitForFunction(
      (date) =>
        document.querySelector('input[aria-label="Дата календаря"]').value === date &&
        document.querySelector('.calendar-grid').scrollLeft === 15 * 96,
      '14.11.2026',
    );
    await page.getByRole('button', { name: 'Фильтры' }).click();
    await page.getByLabel('Масштаб', { exact: true }).first().click();
    await page.getByTitle('Полсуток', { exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.calendar-grid').scrollLeft === 15 * 192,
    );
    await page.getByLabel('Масштаб', { exact: true }).first().click();
    await page.getByTitle('Сутки', { exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.calendar-grid').scrollLeft === 15 * 96,
    );
    await page.getByRole('button', { name: 'Фильтры' }).click();
    await page.getByRole('button', { name: 'Следующий месяц', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('input[aria-label="Дата календаря"]').value === '14.12.2026' &&
        document.querySelector('.calendar-grid').scrollLeft === 15 * 96,
    );
    assert.equal(await page.locator('.calendar-day-today,.current-time-indicator').count(), 0);
    await open('&status=ready,wash');
    assert.equal(await page.locator('[data-vehicle-id]').count(), 10);
    await page.reload();
    await page.locator('[data-vehicle-id]').first().waitFor();
    assert.equal(await page.locator('[data-vehicle-id]').count(), 10);
    await open('&status=notReady');
    assert.equal(await page.locator('[data-vehicle-id]').count(), 30);
    await open('&status=ready,notReady,maintenance');
    assert.equal(await page.locator('[data-vehicle-id]').count(), 48);
    await open();
    assert.equal(await page.locator('[data-vehicle-id]').count(), 60);
    await page.getByRole('button', { name: 'Фильтры' }).click();
    await page.getByLabel('Состояние автомобилей', { exact: true }).first().click();
    await page
      .locator('.ant-select-item-option-content')
      .filter({ hasText: 'Нужна мойка' })
      .click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('[data-vehicle-id]').length === 20);
    assert.ok(page.url().includes('status=wash'));
    await open();
    const firstRow = page.locator('[data-vehicle-id="1200"]');
    const bookingBounds = await firstRow.locator('.calendar-event.booking').boundingBox();
    const technicalBounds = await firstRow.locator('.calendar-event.technical').boundingBox();
    assert.ok(bookingBounds && technicalBounds);
    assert.notEqual(
      bookingBounds.y,
      technicalBounds.y,
      'overlapping events must occupy distinct lanes',
    );
    const brandGroup = page.getByRole('button', { name: 'Группа Марка А', exact: true });
    await brandGroup.click();
    assert.equal(await brandGroup.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-vehicle-id]').count(), 20);
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollLeft = 1600;
    });
    await page.getByRole('button', { name: /Бронь$/ }).click();
    await page.locator('.booking-create-drawer').waitFor();
    await page.locator('.booking-create-drawer .ant-drawer-close').click();
    await page.waitForFunction(() => !document.querySelector('.ant-drawer-open'));
    assert.equal(await brandGroup.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('.calendar-grid').evaluate((el) => el.scrollLeft), 1600);
    await brandGroup.click();
    assert.equal(await page.locator('[data-vehicle-id]').count(), 60);
    const checkSticky = async (brand, model) => {
      const result = await page.evaluate(
        ({ brand, model }) => {
          const grid = document.querySelector('.calendar-grid').getBoundingClientRect();
          const b = document
            .querySelector('[aria-label="' + brand + '"]')
            .parentElement.getBoundingClientRect();
          const m = model
            ? document
                .querySelector('[aria-label="' + model + '"]')
                .parentElement.getBoundingClientRect()
            : null;
          return { brand: b.top - grid.top, model: m ? m.top - grid.top : null };
        },
        { brand, model },
      );
      assert.ok(Math.abs(result.brand - 51) < 2, JSON.stringify(result));
      if (model) assert.ok(Math.abs(result.model - 79) < 2, JSON.stringify(result));
    };
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollTop = 400;
    });
    await checkSticky('Группа Марка А', 'Модель Марка А Модель 1');
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollTop = 1700;
      el.scrollLeft = 300;
    });
    await checkSticky('Группа Марка А', 'Модель Марка А Модель 2');
    await page.screenshot({ path: path.join(root, '.runtime/calendar-sticky-groups.png') });
    await page.getByRole('button', { name: 'Фильтры' }).click();
    await page.getByText('По тарифу', { exact: true }).click();
    await page.getByRole('button', { name: 'Группа Тариф А', exact: true }).waitFor();
    await page.locator('.calendar-grid').evaluate((el) => {
      el.scrollTop = 400;
    });
    await checkSticky('Группа Тариф А');
    await page.getByRole('button', { name: 'Свернуть меню', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('.sidebar').getBoundingClientRect().width === 64,
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.sidebar .ant-menu-item-icon')].every((icon) => {
        const r = icon.getBoundingClientRect(),
          s = icon.closest('.sidebar').getBoundingClientRect();
        return Math.abs((r.left + r.right - s.left - s.right) / 2) < 1;
      }),
    );
    const centers = await page.locator('.sidebar .ant-menu-item-icon').evaluateAll((icons) =>
      icons.map((icon) => {
        const r = icon.getBoundingClientRect(),
          s = icon.closest('.sidebar').getBoundingClientRect(),
          item = icon.closest('.ant-menu-item').getBoundingClientRect();
        return {
          offset: (r.left + r.right - s.left - s.right) / 2,
          itemLeft: item.left,
          itemWidth: item.width,
        };
      }),
    );
    assert.ok(
      centers.every((v) => Math.abs(v.offset) < 1),
      JSON.stringify(centers),
    );
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
});
