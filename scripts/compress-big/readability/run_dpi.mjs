// Each PDF through the site's real js/worker.js (handleCompress, Maximum, quality 72) at several
// targetDpi values, in Chromium; writes <out>/<name>.dpi<N>.pdf and results.jsonl.
// The pre-pass (compressPrepWorker) is not run: on image-only scans it changes nothing measured here.
// Usage: node run_dpi.mjs <base-url> <out-dir> <dpis comma> <pdf>...
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs'; import path from 'path';
const [base, out, dpis, ...files] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
await page.goto(base + '/compress-pdf/', { waitUntil: 'load' });
for (const f of files) for (const dpi of dpis.split(',').map(Number)) {
  const name = path.basename(f, '.pdf'), b64 = fs.readFileSync(f).toString('base64');
  const t0 = Date.now();
  const r = await page.evaluate(async ({ b64, dpi }) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const w = new Worker('/js/worker.js');
    try {
      return await new Promise((res) => {
        const timer = setTimeout(() => res({ err: 'timeout' }), 300000);
        w.onmessage = e => {
          if (e.data.type === 'done') { clearTimeout(timer); const u = new Uint8Array(e.data.result); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); res({ b64: btoa(s) }); }
          else if (e.data.type === 'error') { clearTimeout(timer); res({ err: String(e.data.message || e.data.error).slice(0, 120) }); }
        };
        w.postMessage({ tool: 'compress', file: bytes.buffer, options: { preset: 'high', preserveText: true, removeWatermarks: false, targetDpi: dpi, quality: 0.72, targetSizeMb: null } }, [bytes.buffer]);
      });
    } finally { w.terminate(); }
  }, { b64, dpi });
  const row = { name, dpi, inBytes: fs.statSync(f).size, ms: Date.now() - t0 };
  if (r.b64) { const buf = Buffer.from(r.b64, 'base64'); fs.writeFileSync(path.join(out, `${name}.dpi${dpi}.pdf`), buf); row.outBytes = buf.length; }
  else row.err = r.err;
  fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(row) + '\n');
}
await browser.close();
