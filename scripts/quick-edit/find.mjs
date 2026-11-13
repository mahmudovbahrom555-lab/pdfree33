// Quick Edit step 4 (QUICKEDIT-PREREG.md): Find & replace through the site's UI.
//   node find.mjs <base-url> <pdf> <find> <replace|''> <out.pdf> [phone]
// phone = 390×664 mobile, CPU 4×. Prints one JSON line: found text, timings, longest main-thread block.
import { chromium, devices } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs';
const [base, file, query, replacement, out, phone] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext(phone ? { ...devices['Pixel 7'], viewport: { width: 390, height: 664 }, serviceWorkers: 'block' } : { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
if (phone) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.addInitScript(() => {
  window.__pdf = null; window.__long = [];
  const o = URL.createObjectURL.bind(URL);
  URL.createObjectURL = x => { if (x instanceof Blob && x.type === 'application/pdf') window.__pdf = x; return o(x); };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
});
const longSince = from => page.evaluate(f => Math.round(Math.max(0, ...window.__long.filter(([s]) => s >= f).map(x => x[1]))), from);
const now = () => page.evaluate(() => performance.now());
const row = { file: file.split('/').pop(), query, replacement, phone: !!phone };
await page.goto(base + '/quick-edit-pdf/', { waitUntil: 'load' });
await page.setInputFiles('#fileInput', file);
await page.waitForSelector('.qe-modal--open [data-find-text]', { timeout: 120000 });
await page.fill('[data-find-text]', query);
await page.fill('[data-replace-text]', replacement);
let t = Date.now(), f = await now();
await page.click('.qe-find button[type=submit]');
await page.waitForFunction(() => { const s = document.querySelector('[data-find-status]').textContent; return s && !/…$/.test(s); }, null, { timeout: 300000 });
row.findS = +((Date.now() - t) / 1000).toFixed(1); row.findLongMs = await longSince(f);
row.status = await page.locator('[data-find-status]').innerText();
if (await page.locator('[data-replace-all]').isEnabled()) {
  await page.click('[data-replace-all]');
  row.replaced = await page.locator('[data-find-status]').innerText();
  t = Date.now(); f = await now();
  await page.click('#qeModalSaveBtn');
  row.save = await page.waitForFunction(() => {
    if (window.__pdf) return 'saved';
    const toast = document.querySelector('#toast'); const txt = toast && !toast.hidden ? toast.innerText : '';
    return /error|fail|couldn|cannot|can't|too long|unexpected|No file/i.test(txt) ? 'error: ' + txt.slice(0, 160) : false;
  }, null, { timeout: 300000 }).then(h => h.jsonValue(), () => 'timeout');
  row.saveS = +((Date.now() - t) / 1000).toFixed(1); row.saveLongMs = await longSince(f);
  await page.waitForTimeout(300);
  const toast = await page.locator('#toast').innerText().catch(() => '');
  if (/pages|страниц|页/.test(toast)) row.left = toast.slice(0, 200);
  if (row.save === 'saved') {
    const b64 = await page.evaluate(async () => { const u = new Uint8Array(await window.__pdf.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  }
}
console.log(JSON.stringify(row));
await browser.close();
