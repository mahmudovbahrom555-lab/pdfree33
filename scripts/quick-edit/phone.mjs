// Quick Edit step 0, phone case: open → edit → save on a phone-sized, CPU-throttled Chromium; heap sampled.
//   node phone.mjs <base-url> <pdf> [cpuRate=4]
import { chromium, devices } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
const [base, file, rate = '4'] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 664 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(rate) });
let crashed = false; page.on('crash', () => { crashed = true; });
const errors = []; page.on('pageerror', e => errors.push(e.message.slice(0, 100)));
await page.addInitScript(() => {
  window.__pdf = null; window.__heap = 0;
  const o = URL.createObjectURL.bind(URL);
  URL.createObjectURL = x => { if (x instanceof Blob && x.type === 'application/pdf') window.__pdf = x; return o(x); };
  setInterval(() => { const m = performance.memory?.usedJSHeapSize || 0; if (m > window.__heap) window.__heap = m; }, 1000);
});
const row = { file: file.split('/').pop(), cpu: rate };
await page.goto(base + '/quick-edit-pdf/', { waitUntil: 'load', timeout: 120000 });
let t = Date.now();
await page.setInputFiles('#fileInput', file);
row.open = await page.waitForFunction(() => !!document.querySelector('.qe-modal--open .qe-editable-run'), null, { timeout: 300000 }).then(() => 'opened', () => crashed ? 'crashed' : 'timeout');
row.openS = Math.round((Date.now() - t) / 1000);
row.heapAfterOpenMB = Math.round((await page.evaluate(() => window.__heap).catch(() => 0)) / 1e6);
if (row.open === 'opened') {
  row.runs = await page.locator('.qe-editable-run').count();
  const target = page.locator('.qe-editable-run').nth(await page.evaluate(() => [...document.querySelectorAll('.qe-editable-run')].findIndex(s => /\p{L}{2}/u.test(s.textContent))));
  await target.tap(); await page.waitForTimeout(300);
  await page.keyboard.press('End'); await page.keyboard.type(' PDFREE'); await page.keyboard.press('Enter');
  t = Date.now();
  await page.click('#qeModalSaveBtn');
  row.save = await page.waitForFunction(() => {
    if (window.__pdf) return 'saved';
    const toast = document.querySelector('#toast'); const txt = toast && !toast.hidden ? toast.innerText : '';
    return /error|fail|couldn|cannot|can't|unsupported/i.test(txt) ? 'error: ' + txt.slice(0, 120) : false;
  }, null, { timeout: 300000 }).then(h => h.jsonValue(), () => crashed ? 'crashed' : 'timeout');
  row.saveS = Math.round((Date.now() - t) / 1000);
}
row.heapPeakMB = Math.round((await page.evaluate(() => window.__heap).catch(() => 0)) / 1e6);
if (errors.length) row.pageErrors = errors.slice(0, 3);
console.log(JSON.stringify(row));
await browser.close();
