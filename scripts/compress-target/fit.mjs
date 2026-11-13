// Compress "fit into a size" through the site's UI (TARGET-PREREG.md).
//   node fit.mjs <base-url> <pdf> <target: "4MB" | "500KB" | "chip5"> <out.pdf> [phone]
// chip5 = today's "< 5 MB" chip (for T5 against prod). Prints one JSON line.
import { chromium, devices } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs';
const [base, file, target, out, phone] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext(phone ? { ...devices['Pixel 7'], viewport: { width: 390, height: 664 }, serviceWorkers: 'block' } : { viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
if (phone) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.addInitScript(() => {
  window.__pdf = null; window.__report = null; window.__long = []; window.__labels = new Set();
  const o = URL.createObjectURL.bind(URL);
  URL.createObjectURL = x => { if (x instanceof Blob && x.type === 'application/pdf') window.__pdf = x; return o(x); };
  document.addEventListener('pdfree:success', e => { window.__report = e.detail.compressionReport; });
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  setInterval(() => { const l = document.getElementById('progressLabel')?.textContent; if (l) window.__labels.add(l); }, 200);
});
const row = { file: file.split('/').pop(), inBytes: fs.statSync(file).size, target, phone: !!phone };
await page.goto(base + '/compress-pdf/', { waitUntil: 'load' });
await page.setInputFiles('#fileInput', file);
await page.waitForSelector('.compress-target', { timeout: 60000 });
await page.waitForTimeout(1500);   // the pre-scan may pick a mode; the size is chosen after it
if (target === 'chip5') await page.click('.compress-target [data-target="5"]');
else {
  await page.click('.compress-target [data-target="custom"]');
  const [, n, unit] = target.match(/^([\d.]+)(MB|KB)$/);
  await page.selectOption('#compressTargetUnit', unit);
  await page.fill('#compressTargetValue', n);
}
const from = await page.evaluate(() => performance.now());
const t0 = Date.now();
await page.click('#mergeBtn');
row.result = await page.waitForFunction(() => window.__pdf ? 'saved' : (document.querySelector('#toast')?.innerText.match(/error|couldn|timed out|failed/i) ? 'error: ' + document.querySelector('#toast').innerText.slice(0, 120) : false), null, { timeout: 900000 }).then(h => h.jsonValue(), () => 'timeout');
row.s = Math.round((Date.now() - t0) / 1000);
row.longMs = await page.evaluate(f => Math.round(Math.max(0, ...window.__long.filter(([s]) => s >= f).map(x => x[1]))), from);
if (row.result === 'saved') {
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => window.__report);
  row.outBytes = r?.compressedSize; row.target = target; row.verdict = await page.locator('#targetVerdict').innerText().catch(() => '');
  if (r?.target) Object.assign(row, { met: r.target.met, step: r.target.step, tried: r.target.tried });
  row.progressLabels = (await page.evaluate(() => [...window.__labels])).filter(l => /try|попытка|尝试/i.test(l)).length;
  const b64 = await page.evaluate(async () => { const u = new Uint8Array(await window.__pdf.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
}
console.log(JSON.stringify(row));
await browser.close();
