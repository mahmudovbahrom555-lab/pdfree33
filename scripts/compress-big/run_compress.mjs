// node run_compress.mjs <base> <out-dir> <pdf>…  — each file through the real Compress page:
// the preset the site picks (auto), then low / medium / high. Writes <out>/<doc>.<preset>.pdf + results.jsonl
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs'; import path from 'path';
const [base, out, ...files] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch();
for (const f of files) for (const preset of ['auto', 'low', 'medium', 'high']) {
  const doc = path.basename(f, '.pdf'), dst = path.join(out, `${doc}.${preset}.pdf`);
  const row = { doc, preset, inBytes: fs.statSync(f).size };
  const ctx = await b.newContext({ serviceWorkers: 'block' }), page = await ctx.newPage();
  try {
    await page.addInitScript(() => { window.__blob = null; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { if (x instanceof Blob && x.type === 'application/pdf') window.__blob = x; return o(x); }; });
    await page.goto(base + '/compress-pdf/', { waitUntil: 'load', timeout: 60000 });
    await page.setInputFiles('#fileInput', f);
    await page.waitForFunction(() => document.querySelector('#compressScanBanner:not(.compress-scan--info)') || document.querySelector('#compressQualityNote'), null, { timeout: 240000 }).catch(() => {});
    await page.waitForTimeout(1500);
    row.auto = await page.evaluate(() => document.querySelector('input[name="compressPreset"]:checked')?.value);
    if (preset !== 'auto') await page.click(`label[data-preset="${preset}"]`);
    await page.waitForTimeout(500);
    const t0 = Date.now(); await page.click('#mergeBtn');
    // only an error toast (or Light's "found nothing to remove") ends the wait — "Large file … may take 1–2 min" is information
    const r = await page.waitForFunction(() => {
      if (window.__blob) return true;
      const t = document.querySelector('#toast');
      const txt = t && !t.hidden ? t.innerText : '';
      return /Error ID|could not|failed|cannot|can't|too large|refus|nothing to remove/i.test(txt) ? txt : false;
    }, null, { timeout: 1800000 }).then(h => h.jsonValue()).catch(() => 'TIMEOUT');
    row.ms = Date.now() - t0;
    if (typeof r === 'string') { row.toast = r.slice(0, 120); }
    else {
      const b64 = await page.evaluate(async () => { const u = new Uint8Array(await window.__blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
      const buf = Buffer.from(b64, 'base64'); fs.writeFileSync(dst, buf); row.outBytes = buf.length; row.ratio = +(buf.length / row.inBytes).toFixed(3);
    }
  } catch (e) { row.err = e.message.split('\n')[0].slice(0, 120); }
  await ctx.close();
  fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}
await b.close();
