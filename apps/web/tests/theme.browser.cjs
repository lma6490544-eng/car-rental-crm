const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

test(
  'settings switch persists theme and updates calendar and drawer',
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
      const page = await browser.newPage({
          viewport: { width: 1440, height: 960 },
          colorScheme: 'light',
        }),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const vehicle = {
        id: 1,
        model_id: 1,
        brand_name: 'Lada',
        model_name: 'Largus',
        plate: 'А857ХМ778',
        is_ready: true,
      };
      await page.route('**/api/v1/**', (route) => {
        const p = new URL(route.request().url()).pathname;
        const data = p.endsWith('/auth/me')
          ? { user: { id: 1, fullName: 'Оператор', role: 'manager' }, csrfToken: 'test' }
          : p.endsWith('/calendar')
            ? { vehicles: [vehicle], events: [], unassignedBookings: [], problems: [] }
            : p.endsWith('/booking-options')
              ? { vehicles: [], models: [], brands: [], groups: [] }
              : {};
        return route.fulfill({ json: data });
      });
      await page.goto(origin + '/settings');
      const toggle = page.getByRole('switch', { name: 'Тёмная тема', exact: true });
      await toggle.waitFor();
      assert.equal(
        await toggle.getAttribute('aria-checked'),
        'true',
        'default must be dark even when the OS theme is light',
      );
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await toggle.click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      assert.equal(
        await page.locator('.sidebar').evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(255, 255, 255)',
      );
      await page.reload();
      await toggle.waitFor();
      assert.equal(
        await toggle.getAttribute('aria-checked'),
        'false',
        'light theme must survive reload',
      );
      await page.getByRole('link', { name: 'График', exact: true }).click();
      await page.locator('[data-vehicle-id="1"]').waitFor();
      assert.equal(
        await page.locator('.calendar-grid').evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(255, 255, 255)',
      );
      assert.equal(
        await page
          .locator('[data-vehicle-id="1"] .calendar-label')
          .evaluate((el) => getComputedStyle(el).color),
        'rgb(23, 43, 64)',
      );
      await page.screenshot({ path: path.join(root, '.runtime/theme-light-calendar.png') });
      await page.getByRole('button', { name: /Бронь$/ }).click();
      await page.locator('.booking-create-drawer').waitFor();
      assert.equal(
        await page
          .locator('.booking-create-drawer')
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(244, 246, 248)',
      );
      assert.equal(
        await page
          .locator('.booking-create-drawer .ant-drawer-footer')
          .evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(244, 246, 248)',
      );
      await page.screenshot({ path: path.join(root, '.runtime/theme-light-booking.png') });
      await page.locator('.booking-create-drawer .ant-drawer-close').click();
      await page.getByRole('link', { name: 'Настройки', exact: true }).click();
      await toggle.click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.reload();
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      await page.getByRole('link', { name: 'График', exact: true }).click();
      await page.locator('[data-vehicle-id="1"]').waitFor();
      assert.equal(
        await page.locator('.calendar-grid').evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(17, 31, 46)',
      );
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      server.kill();
    }
  },
);
