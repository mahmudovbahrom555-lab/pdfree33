// Builds the dark-background Clean Scan fixtures (tests/e2e/clean-scan-dark.e2e.mjs):
// light text on dark or coloured backgrounds, rendered as a phone/scanner would
// give them (JPEG page images in a PDF), plus truth.json — each page's text.
// Run: node tests/fixtures/clean-scan/dark/make.mjs   (needs playwright)
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// --twin <dir>: the same pages as dark text on white paper (the measuring twin, not committed)
const TWIN = process.argv.includes('--twin') ? process.argv[process.argv.indexOf('--twin') + 1] : null;
const OUT = TWIN || HERE;
const EN = [
  'The committee reviewed the annual report and approved the budget for next year.',
  'Applications must be submitted before the end of the month with two references.',
  'All visitors are required to sign in at the front desk and wear a badge.',
  'The warehouse inventory was counted twice and the totals matched the records.',
  'Please keep this certificate as proof of completion of the training course.',
  'Delivery times may vary depending on the region and the weather conditions.',
  'The new library opens on Monday from nine in the morning until six at night.',
  'Students who miss the exam must contact the office within three working days.',
];
const AR = ['تمت الموافقة على الطلب بعد مراجعة جميع المستندات المطلوبة من المكتب', 'يرجى الاحتفاظ بهذه الشهادة دليلا على إتمام الدورة التدريبية بنجاح'];
const lines = n => EN.slice(0, n).map(s => `<p>${s}</p>`).join('');
const PAGES = {
  'navy-white': { bg: '#123c78', fg: '#ffffff', body: lines(8) },
  'black-white': { bg: '#0b0b0b', fg: '#f2f2f2', body: lines(8) },
  'green-cream': { bg: '#1f4d2b', fg: '#f3ecd2', body: lines(8) },
  'maroon-white': { bg: '#5a1a22', fg: '#ffffff', body: lines(8) },
  'gradient': { bg: 'linear-gradient(#141414, #1d4f8c)', fg: '#d8dde4', body: lines(8) },
  'textured': { bg: 'radial-gradient(circle at 20% 30%, #3a3a3a 0, #101820 40%, #24518f 100%)', fg: '#c9d2dc', body: lines(8), noise: 0.18 },
  'cyanotype': { bg: '#1c3f8f', fg: '#e9eefc', body: lines(6), font: 'italic 34px/1.9 "Snell Roundhand", "Apple Chancery", cursive' },
  'arabic-navy': { bg: '#123c78', fg: '#ffffff', body: AR.map(s => `<p>${s}</p>`).join(''), dir: 'rtl', lang: 'ara' },
  'mixed-box': { bg: '#ffffff', fg: '#111111', body: `<p>${EN[0]}</p><div style="background:#0d0d0d;color:#f0f0f0;padding:30px;margin:30px 0">${lines(5)}</div><p>${EN[6]}</p>` },
  'title-band': { bg: '#ffffff', fg: '#111111', body: `<div style="background:#173f7a;color:#fff;padding:24px;font-size:40px">${EN[4]}</div>${lines(6)}` },
  // must be left as it is: a photograph under a title (a book cover, a slide)
  // must be left as it is: white lines over a photograph (a book cover, a
  // slide) — a "photo" of overlapping soft shapes in many greys
  'photo-title': { bg: '#141414', fg: '#ffffff', body: lines(6), photo: true },
  'stamp-dark': { bg: '#123c78', fg: '#ffffff', body: lines(6) + '<div style="width:170px;height:170px;border:8px solid #e0352b;border-radius:50%;color:#e0352b;display:flex;align-items:center;justify-content:center;font-size:30px;margin-left:520px">PAID</div>' },
};
const truth = {};
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
for (const [name, p] of Object.entries(PAGES)) {
  await page.setContent(`<html dir="${p.dir || 'ltr'}"><style>
    body{margin:0;padding:90px;min-height:1754px;box-sizing:border-box;background:${p.bg};color:${p.fg};font:${p.font || '30px/1.7 Georgia, serif'}}
    p{margin:0 0 18px}${TWIN ? '*{background:#fff !important;color:#111 !important;border-color:#111 !important}' : ''}</style><body>${p.body}</body></html>`);
  if (p.photo && !TWIN) await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1240; c.height = 1754;
    const x = c.getContext('2d');
    let s = 11; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    x.filter = 'blur(3px)';
    for (let i = 0; i < 420; i++) {
      const g = 25 + r() * 110 | 0;
      x.fillStyle = `rgb(${g},${g * 0.9 | 0},${g * 0.8 | 0})`;
      x.beginPath(); x.ellipse(r() * 1240, r() * 1754, 15 + r() * 90, 15 + r() * 90, r() * 3, 0, 7); x.fill();
    }
    Object.assign(c.style, { position: 'absolute', left: 0, top: 0, zIndex: -1 });
    document.body.style.position = 'relative';
    document.body.appendChild(c);
  });
  if (p.noise && !TWIN) await page.evaluate(a => {
    const c = document.createElement('canvas'); c.width = 1240; c.height = 1754;
    const x = c.getContext('2d'), im = x.createImageData(1240, 1754);
    let s = 7; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < im.data.length; i += 4) { const v = r() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = a * 255; }
    x.putImageData(im, 0, 0);
    Object.assign(c.style, { position: 'absolute', left: 0, top: 0, mixBlendMode: 'overlay', pointerEvents: 'none' });
    document.body.appendChild(c);
  }, p.noise);
  truth[name] = { lang: p.lang || 'eng', text: await page.evaluate(() => document.body.innerText) };
  const jpg = await page.screenshot({ type: 'jpeg', quality: 70 });
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(jpg);
  doc.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  fs.writeFileSync(path.join(OUT, `${name}.pdf`), await doc.save());
}
await browser.close();
if (!TWIN) fs.writeFileSync(path.join(HERE, 'truth.json'), JSON.stringify(truth, null, 1));
console.log(Object.keys(PAGES).length, 'fixtures');
