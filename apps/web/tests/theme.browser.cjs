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
      await page.clock.setFixedTime(new Date('2026-11-24T09:00:00.000Z'));
      const vehicle = {
        id: 1,
        model_id: 1,
        brand_name: 'Lada',
        model_name: 'Largus',
        plate: 'А857ХМ778',
        is_ready: true,
      };
      const events = [
        { name: 'Анна Волкова', paidRatio: 1, paidPercent: '100' },
        { name: 'Иван Соколов', paidRatio: 0, paidPercent: '0' },
        { name: 'Ольга Павлова', paidRatio: 0.6, paidPercent: '60' },
        { name: 'Пётр Орлов', paidPercent: '100', checkoutPhase: 'started' },
        { name: 'Мария Смирнова', paidRatio: 0.005, paidPercent: '0' },
      ].map(({ name, paidRatio, paidPercent, checkoutPhase = 'issued' }, index) => ({
        id: index + 1,
        vehicle_id: vehicle.id,
        booking_id: index + 1,
        kind: 'assignment',
        checkoutPhase,
        start_at: new Date(Date.UTC(2026, 10, 24 + index * 2)).toISOString(),
        end_at: new Date(Date.UTC(2026, 10, 26 + index * 2)).toISOString(),
        customer_name: name,
        financialSummary: { paidPercent },
        paidRatio,
      }));
      await page.route('**/api/v1/**', (route) => {
        const p = new URL(route.request().url()).pathname;
        const data = p.endsWith('/auth/me')
          ? {
              user: { id: 1, login: 'operator', fullName: 'Оператор', role: 'admin' },
              csrfToken: 'test',
            }
          : p.endsWith('/calendar')
            ? { vehicles: [vehicle], events, unassignedBookings: [], problems: [] }
            : p.endsWith('/booking-options')
              ? { vehicles: [], models: [], brands: [], groups: [] }
              : {};
        return route.fulfill({ json: data });
      });
      const backgroundImage = (selector) =>
        page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundImage);
      const assertShellGradients = async () => {
        assert.match(await backgroundImage('html'), /^radial-gradient\(/);
        assert.match(await backgroundImage('.app-content'), /^linear-gradient\(/);
        assert.match(
          await backgroundImage('.sidebar .ant-menu-item-selected'),
          /^linear-gradient\(/,
        );
        for (const selector of ['.app-shell', '.sidebar', '.sidebar .ant-menu']) {
          assert.equal(await backgroundImage(selector), 'none');
          assert.equal(
            await page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor),
            'rgba(0, 0, 0, 0)',
          );
        }
      };
      const assertHomeGradients = async (mode) => {
        await page.goto(origin);
        const primary = page.getByRole('button', { name: 'Управление сотрудниками' });
        await primary.waitFor();
        await assertShellGradients();
        const selector = '.app-content .ant-btn-primary';
        const normal = await backgroundImage(selector);
        assert.match(normal, /^linear-gradient\(/);
        await primary.hover();
        const hover = await backgroundImage(selector);
        assert.match(hover, /^linear-gradient\(/);
        assert.notEqual(hover, normal);
        await page.mouse.down();
        const active = await backgroundImage(selector);
        assert.match(active, /^linear-gradient\(/);
        assert.notEqual(active, hover);
        await page.mouse.move(0, 0);
        await page.mouse.up();
        await page.getByRole('link', { name: 'Управление сотрудниками' }).focus();
        await page.keyboard.press('Tab');
        assert.equal(
          await primary.evaluate(
            (el) => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid',
          ),
          true,
        );
        assert.equal(
          await backgroundImage('.app-content a[href="/clients"] .ant-btn-default'),
          'none',
        );
        await page.screenshot({ path: path.join(root, `.runtime/theme-${mode}-home.png`) });
      };
      const assertBookingGradients = async () => {
        const paid = await backgroundImage('.calendar-event.booking-paid');
        const unpaid = await backgroundImage('.calendar-event.booking-unpaid');
        assert.match(paid, /^linear-gradient\(/);
        assert.match(unpaid, /^linear-gradient\(/);
        assert.notEqual(paid, unpaid);
        const rental = (name) => page.locator('.calendar-event').filter({ hasText: name });
        for (const [name, ratio] of [
          ['Ольга Павлова', 0.6],
          ['Мария Смирнова', 0.005],
        ]) {
          const partial = await rental(name).evaluate((el) => {
            const style = getComputedStyle(el);
            return {
              image: style.backgroundImage,
              width: parseFloat(style.backgroundSize),
              stripWidth: el.getBoundingClientRect().width,
            };
          });
          assert.equal(partial.image, `${paid}, ${unpaid}`);
          assert.ok(Math.abs(partial.width - partial.stripWidth * ratio) < 0.1);
        }
        const prepayment = await rental('Пётр Орлов').evaluate((el) => {
          const style = getComputedStyle(el);
          return [style.backgroundImage, style.backgroundColor];
        });
        assert.deepEqual(prepayment, ['none', 'rgb(217, 188, 116)']);
        assert.equal(await backgroundImage('.calendar-grid'), 'none');
      };
      await assertHomeGradients('dark');
      await page.goto(origin + '/settings');
      const toggle = page.getByRole('switch', { name: 'Тёмная тема', exact: true });
      await toggle.waitFor();
      assert.equal(
        await toggle.getAttribute('aria-checked'),
        'true',
        'default must be dark even when the OS theme is light',
      );
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await assertShellGradients();
      await page.screenshot({ path: path.join(root, '.runtime/theme-dark-settings.png') });
      await toggle.click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
      await assertShellGradients();
      assert.equal(
        await page.locator('.app-content').evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(255, 255, 255)',
      );
      await page.reload();
      await toggle.waitFor();
      assert.equal(
        await toggle.getAttribute('aria-checked'),
        'false',
        'light theme must survive reload',
      );
      await page.screenshot({ path: path.join(root, '.runtime/theme-light-settings.png') });
      await assertHomeGradients('light');
      await page.getByRole('link', { name: 'График', exact: true }).click();
      await page.locator('[data-vehicle-id="1"]').waitFor();
      await assertShellGradients();
      await assertBookingGradients();
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
        await backgroundImage('.booking-create-submit .ant-btn-primary:disabled'),
        'none',
      );
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
      await assertShellGradients();
      await assertBookingGradients();
      await page.screenshot({ path: path.join(root, '.runtime/theme-dark-calendar.png') });
      const workspace = await page.locator('.app-content').evaluate((el) => {
        const bounds = el.getBoundingClientRect();
        const sidebar = el.previousElementSibling.getBoundingClientRect();
        const styles = getComputedStyle(el);
        return {
          background: styles.backgroundColor,
          border: styles.borderTopWidth,
          radius: styles.borderTopLeftRadius,
          gap: bounds.left - sidebar.right,
          rightInset: window.innerWidth - bounds.right,
          bottomInset: window.innerHeight - bounds.bottom,
          pageScrollHeight: document.documentElement.scrollHeight,
        };
      });
      assert.deepEqual(workspace, {
        background: 'rgb(16, 34, 53)',
        border: '1px',
        radius: '12px',
        gap: 10,
        rightInset: 12,
        bottomInset: 12,
        pageScrollHeight: 960,
      });
      assert.equal(
        await page.locator('.calendar-grid').evaluate((el) => getComputedStyle(el).backgroundColor),
        'rgb(17, 31, 46)',
      );
      await page.getByRole('button', { name: /Бронь$/ }).click();
      const disabledPrimary = page.locator('.booking-create-submit .ant-btn-primary:disabled');
      await disabledPrimary.waitFor();
      assert.equal(
        await disabledPrimary.evaluate((el) => getComputedStyle(el).backgroundImage),
        'none',
      );
      await page.locator('.booking-create-drawer .ant-drawer-close').click();

      await page.getByRole('button', { name: 'Свернуть меню' }).click();
      const sidebar = page.locator('.sidebar');
      await sidebar
        .locator('.ant-menu-item')
        .filter({ has: page.locator('a[href="/settings"]') })
        .click({ timeout: 5000 });
      await page.waitForURL('**/settings', { timeout: 5000 });

      const calendarLink = sidebar.getByRole('link', { name: 'График', exact: true });
      await calendarLink.press('Enter');
      await page.waitForURL('**/calendar', { timeout: 5000 });
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      server.kill();
    }
  },
);
