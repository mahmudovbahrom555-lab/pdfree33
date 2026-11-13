// Estimator feasibility (TARGET-PREREG step 2, E1): a sample PDF of the pages with the heaviest images, compressed at
// every step through the site's own workers; prints the numbers a predictor needs.
//   node sample.mjs <base-url> <out.jsonl> <pdf>…
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs';
const [base, out, ...files] = process.argv.slice(2);
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
  const t0 = Date.now();
  const r = await page.evaluate(async ([b64, ladder]) => {
    const { preprocessPdfBuffer } = await import('/js/decryptPdf.js');
    const { isLargeDevice } = await import('/js/fileLimits.js');
    const { loadPdfLib } = await import('/js/lazyLibs.js'); await loadPdfLib();
    const { PDFDocument, PDFName, PDFRawStream, PDFDict } = window.PDFLib;
    const original = await preprocessPdfBuffer(Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer);
    const doc = await PDFDocument.load(original, { ignoreEncryption: true, updateMetadata: false });
    // image bytes per page (an image used on several pages counted once, on its first page)
    const seen = new Set(); const perPage = [];
    for (const p of doc.getPages()) {
      let bytes = 0;
      const res = p.node.Resources(); const xo = res?.lookup(PDFName.of('XObject'));
      if (xo instanceof PDFDict) for (const [, ref] of xo.entries()) {
        const obj = doc.context.lookup(ref);
        if (obj instanceof PDFRawStream && String(obj.dict.get(PDFName.of('Subtype'))) === '/Image' && !seen.has(ref.toString())) {
          seen.add(ref.toString()); bytes += obj.contents.length;
        }
      }
      perPage.push(bytes);
    }
    const imageBytes = perPage.reduce((a, b) => a + b, 0);
    const order = perPage.map((b, i) => [b, i]).sort((a, b) => b[0] - a[0]).filter(([b]) => b > 0);
    // the heaviest pages until a third of the image bytes or 6 pages
    const pick = []; let got = 0;
    for (const [b, i] of order) { if (pick.length >= 6 || got >= imageBytes / 3) break; pick.push(i); got += b; }
    const result = { pages: perPage.length, total: original.byteLength, imageBytes, samplePages: pick.length, sampleImageBytes: got, sample: [] };
    if (!pick.length) return result;
    const sampleDoc = await PDFDocument.create();
    for (const pg of await sampleDoc.copyPages(doc, pick.sort((a, b) => a - b))) sampleDoc.addPage(pg);
    const sampleBytes = (await sampleDoc.save()).buffer;
    result.sampleTotal = sampleBytes.byteLength;
    const run = (url, msg, transfer) => new Promise((resolve, reject) => {
      const w = new Worker(url);
      w.onmessage = e => { if (e.data.type !== 'done' && e.data.type !== 'error') return; w.terminate(); e.data.type === 'error' ? reject(new Error(e.data.message)) : resolve(e.data); };
      w.onerror = e => { w.terminate(); reject(new Error(e.message)); };
      w.postMessage(msg, transfer);
    });
    const t = performance.now();
    for (const step of ladder) {
      const manual = step.preset === 'low' ? {} : { targetDpi: step.targetDpi, quality: step.quality };
      let cmykD = null;
      if (step.preset !== 'low') {
        const q = Math.round(manual.quality * 100);
        cmykD = { target: Math.max(300, manual.targetDpi || 0), quality: q >= 75 ? q : 82, maxMegapixels: isLargeDevice() ? 64 : 16,
          rgb: { target: manual.targetDpi, quality: q, maxMegapixels: isLargeDevice() ? 24 : 4 } };
      }
      const copy = sampleBytes.slice(0);
      const prep = await run('/js/compressPrepWorker.js', { file: copy, stripXmp: step.preset !== 'low', cmykFlate: step.preset !== 'low', cmykD }, [copy]);
      const done = await run('/js/worker.js', { tool: 'compress', file: prep.result, options: { preset: step.preset, preserveText: true, removeWatermarks: false, targetDpi: step.targetDpi ?? null, quality: step.quality ?? null } }, [prep.result]);
      result.sample.push(done.compressedSize);
    }
    result.sampleMs = Math.round(performance.now() - t);
    return result;
  }, [fs.readFileSync(file).toString('base64'), LADDER]).catch(e => ({ error: e.message.slice(0, 150) }));
  const row = { file: file.split('/').pop(), ...r, wallS: Math.round((Date.now() - t0) / 1000) };
  fs.appendFileSync(out, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row).slice(0, 300));
}
await browser.close();
