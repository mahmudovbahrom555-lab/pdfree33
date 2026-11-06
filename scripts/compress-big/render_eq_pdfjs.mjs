// pdf.js (the site's vendored 4.10.38) in Chromium: base-X vs L-X, first 6 pages at scale 0.7 — identical RGBA?
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import { readFileSync } from 'fs';
const REPO = '/Users/murodjon/pdfree33/pdfree33/js/vendor/pdfjs-4.10.38/';
const [dir, ...names] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.route('https://x.test/**', r => {
  const p = new URL(r.request().url()).pathname;
  if (p === '/') return r.fulfill({ body: '<html></html>', contentType: 'text/html' });
  if (p.startsWith('/pdfjs/')) return r.fulfill({ body: readFileSync(REPO + p.slice(7)), contentType: 'text/javascript' });
  return r.fulfill({ body: readFileSync(dir + p), contentType: 'application/pdf' });
});
await page.goto('https://x.test/');
const render = url => page.evaluate(async url => {
  const lib = await import('https://x.test/pdfjs/pdf.min.js');   // an ES module, as the site loads it
  lib.GlobalWorkerOptions.workerPort ??= new Worker('https://x.test/pdfjs/pdf.worker.min.js', { type: 'module' });
  const doc = await lib.getDocument(url).promise, out = [];
  for (let i = 1; i <= Math.min(6, doc.numPages); i++) {
    const pg = await doc.getPage(i), vp = pg.getViewport({ scale: 0.7 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d'); await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const h = await crypto.subtle.digest('SHA-256', d); out.push([...new Uint8Array(h)].slice(0, 8).join('.'));
  }
  return out;
}, url);
for (const n of names) {
  try {
    const a = await render(`https://x.test/base-${n}`), b = await render(`https://x.test/L-${n}`);
    console.log(n.padEnd(24), `pdf.js ${JSON.stringify(a) === JSON.stringify(b) && a.length ? 'same' : 'DIFF'}(${a.length}p)`);
  } catch (e) { console.log(n.padEnd(24), 'pdf.js ERR', String(e.message).slice(0, 80)); }
}
await browser.close();
