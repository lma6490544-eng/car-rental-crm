import { chromium } from 'playwright';

export async function renderPdf(html: string) {
  const channel = process.env.CRM_PDF_BROWSER === 'chrome' ? 'chrome' : 'msedge';
  const browser = await chromium.launch({ channel, headless: true, timeout: 15000 });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: 'block',
      offline: true,
    });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, {
      timeout: 12000,
      waitUntil: 'load',
    });
    return await page.pdf({ preferCSSPageSize: true, printBackground: true });
  } finally {
    await browser.close();
  }
}
