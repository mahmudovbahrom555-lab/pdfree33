// C4: batch compress follows the single-file rules. node c4_batch.mjs <base> <out-dir> <preset> <pdf>…
// Saves the ZIP's entries to <out-dir>/<preset>/; the checks are in c4_check.py.
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs'; import path from 'path';
const [base, out, preset, ...files] = process.argv.slice(2);
const dir = path.join(out, preset); fs.mkdirSync(dir, { recursive: true });
const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block', acceptDownloads: true }); const page = await ctx.newPage();
await page.addInitScript(() => { window.__zip = null; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { if (x instanceof Blob && /zip/.test(x.type)) window.__zip = x; return o(x); }; });
await page.goto(base + '/compress-pdf/', { waitUntil: 'load', timeout: 60000 });
await page.setInputFiles('#fileInput', files);
await page.waitForTimeout(15000);
await page.click(`label[data-preset="${preset}"]`); await page.waitForTimeout(500);
const t0 = Date.now(); await page.click('#mergeBtn');
const r = await page.waitForFunction(() => window.__zip ? true : (() => { const t = document.querySelector('#toast'); const s = t && !t.hidden ? t.innerText : ''; return /Error ID|could not|failed|cannot|refus/i.test(s) ? s : false; })(), null, { timeout: 1800000 }).then(h => h.jsonValue()).catch(() => 'TIMEOUT');
if (r !== true) { console.log(JSON.stringify({ preset, error: r })); await b.close(); process.exit(1); }
const b64 = await page.evaluate(async () => { const u = new Uint8Array(await window.__zip.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
const zp = path.join(dir, 'batch.zip'); fs.writeFileSync(zp, Buffer.from(b64, 'base64'));
const summary = await page.evaluate(() => document.querySelector('#successCard')?.innerText.replace(/\s+/g, ' ').slice(0, 300));
console.log(JSON.stringify({ preset, ms: Date.now() - t0, zip: zp, summary }));
await b.close();
