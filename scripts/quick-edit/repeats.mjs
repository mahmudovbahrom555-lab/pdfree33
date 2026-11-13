// Step 5 (QUICKEDIT-PREREG.md): what the page editor offers as repeated lines, per document.
//   node repeats.mjs <base-url> <out.jsonl> <pdf>… [--phone]
import { chromium, devices } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs';
const args = process.argv.slice(2); const phone = args.includes('--phone');
const [base, out, ...files] = args.filter(a => a !== '--phone');
const browser = await chromium.launch();
for (const file of files) {
  const ctx = await browser.newContext(phone ? { ...devices['Pixel 7'], viewport: { width: 390, height: 664 } } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  if (phone) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => { window.__long = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {} });
  const row = { file: file.split('/').pop() };
  try {
    await page.goto(base + '/quick-edit-pdf/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', file);
    const opened = await page.waitForSelector('.qe-modal--open .qe-page-editor', { timeout: 60000 }).then(() => true, () => false);
    row.mode = opened ? 'page' : 'other';
    if (opened) {
      const t0 = Date.now(); const from = await page.evaluate(() => performance.now());
      const shown = await page.waitForSelector('[data-repeats]:not([hidden])', { timeout: 30000 }).then(() => true, () => false);
      row.offerS = shown ? +((Date.now() - t0) / 1000).toFixed(1) : null;
      row.longMs = await page.evaluate(f => Math.round(Math.max(0, ...window.__long.filter(([s]) => s >= f).map(x => x[1]))), from);
      row.pages = await page.evaluate(async () => (await import('/js/quickEditUI.js')) && document.querySelector('[data-page-label]')?.textContent);
      row.offers = await page.locator('.qe-repeat__text').allInnerTexts();
    }
  } catch (e) { row.error = e.message.slice(0, 120); }
  fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row));
  await ctx.close();
}
await browser.close();
