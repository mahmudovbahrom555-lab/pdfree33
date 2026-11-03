// node run.mjs <base> <outdir> <file.pdf>...  → <outdir>/<name>.<keep|nokeep>.pdf + times.json
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs'; import path from 'path';
const [base, outDir, ...files] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const times = {}, offered = {};
const b = await chromium.launch();
for (const f of files) for (const keep of [true, false]) {
  const tag = `${path.basename(f, '.pdf')}.${keep ? 'keep' : 'nokeep'}`;
  const ctx = await b.newContext({ serviceWorkers: 'block' }), page = await ctx.newPage();
  try {
    await page.addInitScript(() => { const o = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { if (x instanceof Blob && /pdf/.test(x.type)) window.__pdf = x; return o(x); }; });
    await page.goto(base + '/clean-scan/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', f);
    await page.waitForSelector('#csKeepColor', { state: 'attached', timeout: 60000 });
    if (!keep) await page.click('label:has(#csKeepColor)');
    if (process.env.INVERT) {
      await page.waitForFunction(() => document.querySelector('#csAfterImg')?.src, null, { timeout: 60000 });
      await page.waitForTimeout(800);
      if (await page.isVisible('#csDarkHint')) { offered[tag] = 1; await page.click('label:has(#csLightOnDark)'); await page.waitForTimeout(1500); }
    }
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled);
    const t0 = Date.now(); await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__pdf, null, { timeout: 300000 });
    times[tag] = Date.now() - t0;
    const b64 = await page.evaluate(async () => { const u = new Uint8Array(await window.__pdf.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(s); });
    fs.writeFileSync(path.join(outDir, tag + '.pdf'), Buffer.from(b64, 'base64'));
  } catch (e) { times[tag] = 'ERR ' + e.message.split('\n')[0]; }
  await ctx.close();
}
await b.close();
fs.writeFileSync(path.join(outDir, 'times.json'), JSON.stringify(times, null, 1));
fs.writeFileSync(path.join(outDir, 'offered.json'), JSON.stringify(offered, null, 1));
console.log(outDir, Object.keys(times).length, 'runs', Object.values(times).filter(v => typeof v !== 'number').length, 'errors');
