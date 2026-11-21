// Explicitly enabled, read-only browser diagnostics for the S4/S5 acceptance runs.
// Reference mode restores only the two changed methods from the frozen pre-5.4 source.
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../../..');
const isAcceptance = process.argv.some((p) => /stage[45]\.acceptance\.cjs$/.test(p));
const isApi = process.argv.some((p) => /[/\\]dist[/\\]main(?:\.js)?$/.test(p));
if (process.env.CALENDAR_PREPARATION_REFERENCE === '1' && (isAcceptance || isApi)) {
  const Module = require('node:module');
  const ts = require('typescript');
  const snapshot = require('../tests/fixtures/calendar-before-stage5-4.json');
  const filename = path.join(root, 'apps/api/dist/scheduling/browser-reference.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(
    ts.transpileModule(snapshot.schedulingSource, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    }).outputText,
    filename,
  );
  const original = loaded.exports.SchedulingService.prototype;
  const current = require('../dist/scheduling/scheduling.service').SchedulingService.prototype;
  for (const name of ['evaluate', 'createCalendarInspector']) current[name] = original[name];
}
if (isAcceptance && process.env.CALENDAR_BROWSER_DIAGNOSTICS) {
  const { chromium } = require('playwright');
  const directory = path.join(
    root,
    'outputs/backend-refactoring-stage-5-4/browser-diagnostics',
    process.env.CALENDAR_PREPARATION_REFERENCE === '1' ? 'reference' : 'current',
  );
  fs.mkdirSync(directory, { recursive: true });
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async function (...args) {
    const browser = await launch(...args);
    let serial = 0;
    const pages = new Map();
    const attach = async (page) => {
      if (pages.has(page)) return;
      const state = { id: ++serial, events: [] };
      pages.set(page, state);
      page.on('pageerror', (error) =>
        state.events.push({ kind: 'pageerror', message: error.message }),
      );
      page.on('requestfailed', (request) =>
        state.events.push({
          kind: 'requestfailed',
          url: new URL(request.url()).pathname,
          error: request.failure(),
        }),
      );
      page.on('response', (response) => {
        if (response.url().includes('/api/v1/')) {
          state.events.push({
            kind: 'response',
            url: new URL(response.url()).pathname,
            status: response.status(),
            at: Date.now(),
          });
          if (state.events.length > 100) state.events.shift();
        }
      });
      await page.addInitScript(() => {
        const entries = [];
        window.__preparationDropdownDiagnostics = entries;
        const capture = (reason) => {
          const dropdowns = Array.from(document.querySelectorAll('.ant-select-dropdown')).map(
            (el) => {
              const r = el.getBoundingClientRect(),
                s = getComputedStyle(el);
              return {
                className: el.className,
                display: s.display,
                visibility: s.visibility,
                width: r.width,
                height: r.height,
                options: el.querySelectorAll('.ant-select-item-option').length,
                disabled: el.querySelectorAll('.ant-select-item-option-disabled').length,
              };
            },
          );
          const active = document.activeElement;
          entries.push({
            at: performance.now(),
            reason,
            dropdowns,
            active: {
              tag: active?.tagName,
              label: active?.getAttribute('aria-label'),
              expanded: active?.getAttribute('aria-expanded'),
            },
          });
          if (entries.length > 200) entries.shift();
        };
        const start = () => {
          new MutationObserver((mutations) => {
            if (
              mutations.some(
                (m) =>
                  m.target instanceof Element &&
                  (m.target.closest('.ant-select,.ant-select-dropdown') ||
                    Array.from(m.addedNodes).some(
                      (n) =>
                        n instanceof Element &&
                        (n.matches('.ant-select-dropdown') ||
                          n.querySelector('.ant-select-dropdown')),
                    )),
              )
            )
              capture('mutation');
          }).observe(document.body, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'aria-expanded'],
          });
          for (const type of ['click', 'focusin', 'focusout', 'keydown'])
            document.addEventListener(type, () => capture(type), true);
        };
        if (document.body) start();
        else document.addEventListener('DOMContentLoaded', start, { once: true });
      });
    };
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      await attach(page);
      return page;
    };
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      context.on('page', (page) => {
        attach(page).catch(() => {});
      });
      return context;
    };
    const close = browser.close.bind(browser);
    browser.close = async (...args) => {
      for (const [page, state] of pages) {
        try {
          state.url = new URL(page.url()).pathname;
          state.dropdown = await page.evaluate(() => window.__preparationDropdownDiagnostics ?? []);
          await page.screenshot({
            path: path.join(directory, process.pid + '-' + state.id + '.png'),
            fullPage: true,
          });
        } catch (error) {
          state.captureError = error.message;
        }
        fs.writeFileSync(
          path.join(directory, process.pid + '-' + state.id + '.json'),
          JSON.stringify(state, null, 2),
        );
      }
      return close(...args);
    };
    return browser;
  };
}
