// Ground truth for the estimator (TARGET-PREREG step 2): the full file compressed at each ladder step, through the
// site's own workers (compressPrepWorker + worker.js), mirroring processor.js _compressAttempt/_cmykDOptions.
//   node steps.mjs <base-url> <out.jsonl> <pdf>… [--steps 0,3,9]
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs';
const args = process.argv.slice(2);
const si = args.indexOf('--steps');
const steps = si >= 0 ? args.splice(si, 2)[1].split(',').map(Number) : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const [base, out, ...files] = args;
const LADDER = [
  { preset: 'low' }, { preset: 'medium', targetDpi: 300, quality: 0.85 }, { preset: 'medium', targetDpi: 200, quality: 0.80 },
  { preset: 'medium', targetDpi: 150, quality: 0.75 }, { preset: 'medium', targetDpi: 150, quality: 0.65 },
  { preset: 'medium', targetDpi: 120, quality: 0.60 }, { preset: 'medium', targetDpi: 96, quality: 0.55 },
  { preset: 'medium', targetDpi: 96, quality: 0.45 }, { preset: 'medium', targetDpi: 72, quality: 0.40 },
  { preset: 'medium', targetDpi: 72, quality: 0.30 },
];
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + '/compress-pdf/', { waitUntil: 'load' });
for (const file of files) {
  const b64 = fs.readFileSync(file).toString('base64');
  for (const s of steps) {
    const t0 = Date.now();
    const size = await page.evaluate(async ([b64, step]) => {
      const { preprocessPdfBuffer } = await import('/js/decryptPdf.js');
      const { isLargeDevice } = await import('/js/fileLimits.js');
      const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
      const original = await preprocessPdfBuffer(raw);
      const manual = step.preset === 'low' ? {} : { targetDpi: step.targetDpi, quality: step.quality };
      // _cmykDOptions
      let cmykD = null;
      if (step.preset !== 'low') {
        const q = manual.quality ? Math.round(manual.quality * 100) : null;
        cmykD = { target: Math.max(300, manual.targetDpi || 0), quality: q && q >= 75 ? q : 82,
          maxMegapixels: isLargeDevice() ? 64 : 16,
          rgb: { target: manual.targetDpi, quality: q || 82, maxMegapixels: isLargeDevice() ? 24 : 4 } };
      }
      const run = (url, msg, transfer) => new Promise((resolve, reject) => {
        const w = new Worker(url);
        w.onmessage = e => { if (e.data.type !== 'done' && e.data.type !== 'error') return; w.terminate(); e.data.type === 'error' ? reject(new Error(e.data.message)) : resolve(e.data); };
        w.onerror = e => { w.terminate(); reject(new Error(e.message)); };
        w.postMessage(msg, transfer);
      });
      const copy = original.slice(0);
      const prep = await run('/js/compressPrepWorker.js', { file: copy, stripXmp: step.preset !== 'low', cmykFlate: step.preset !== 'low', cmykD }, [copy]);
      const done = await run('/js/worker.js', { tool: 'compress', file: prep.result, options: {
        preset: step.preset, preserveText: true, removeWatermarks: false, targetDpi: step.targetDpi ?? null, quality: step.quality ?? null } }, [prep.result]);
      return done.compressedSize;
    }, [b64, LADDER[s]]).catch(e => 'error: ' + e.message.slice(0, 100));
    const row = { file: file.split('/').pop(), inBytes: fs.statSync(file).size, step: s, size, s: Math.round((Date.now() - t0) / 1000) };
    fs.appendFileSync(out, JSON.stringify(row) + '\n');
    console.log(JSON.stringify(row));
  }
}
await browser.close();
