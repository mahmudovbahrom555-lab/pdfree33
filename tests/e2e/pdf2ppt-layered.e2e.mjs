// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/pdf2ppt-layered.e2e.mjs — PDF to PowerPoint, "Editable text":
//  the slide is the page drawn without its text, the text laid back over it
//  as positioned boxes (js/pdf2pptLayered.js, 2026-10-16).
//
//  The mode used to rebuild slides as flowing text plus cropped pictures:
//  charts, logos and photos were lost, tables scattered, Chinese came out in
//  Courier boxes or spaced "從業 評價 職" (a Chinese user's report, and a
//  corpus of 500 real presentations). tests/fixtures/pdf2ppt/slide.pdf
//  (make-slide.mjs): a white title on a dark band, a 3-line paragraph, a red
//  Chinese line, a ruled table, an orange disc.
//  Run: node tests/e2e/pdf2ppt-layered.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
console.log(`\npdf2ppt — editable text over the page picture E2E (${BASE_URL}):`);
let slide;
try {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && b.size > 1000 && /zip|presentation/.test(b.type)) window.__pptx = b; return orig(b); };
  });
  await page.goto(BASE_URL + '/pdf-to-powerpoint/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'pdf2ppt', 'slide.pdf'));
  await page.waitForSelector('input[name="p2pMode"][value="text"]', { state: 'attached', timeout: 30000 });
  await page.evaluate(() => {
    const i = document.querySelector('input[name="p2pMode"][value="text"]');
    i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__pptx, null, { timeout: 120000 });
  slide = await page.evaluate(async () => {
    await (await import('/js/lazyLibs.js')).loadJSZip();
    const zip = await window.JSZip.loadAsync(await window.__pptx.arrayBuffer());
    const xml = await zip.file('ppt/slides/slide1.xml').async('string');
    const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
    const boxes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map(m => ({
      xml: m[0],
      paras: [...m[0].matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map(p => [...p[0].matchAll(/<a:t>([^<]*)/g)].map(x => x[1]).join('')).filter(Boolean),
    })).filter(b => b.paras.length);
    const pics = (xml.match(/<p:pic>/g) || []).length;
    const media = rels.match(/Target="\.\.\/media\/([^"]+)"/)?.[1];
    if (!media) return { pics, disc: null, whiteInTitle: null, boxes };
    // the slide picture, sampled: the disc's centre and the title's area
    const img = await createImageBitmap(await zip.file('ppt/media/' + media).async('blob'));
    const c = new OffscreenCanvas(img.width, img.height), ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const k = img.width / 720;
    const px = (x, y) => [...ctx.getImageData(Math.round(x * k), Math.round((540 - y) * k), 1, 1).data.slice(0, 3)];
    let whiteInTitle = 0;
    const t = ctx.getImageData(Math.round(40 * k), Math.round((540 - 500) * k), Math.round(240 * k), Math.round(28 * k)).data;
    for (let i = 0; i < t.length; i += 4) if (t[i] > 200 && t[i + 1] > 200 && t[i + 2] > 200) whiteInTitle++;
    return { pics, disc: px(600, 360), whiteInTitle, boxes };
  });

  await test('one picture of the page under the text, the vector disc in it, the title text not', async () => {
    if (slide.pics !== 1 || !slide.disc) throw new Error(`${slide.pics} pictures`);
    const [r, g, b] = slide.disc;
    if (!(r > 200 && g > 100 && g < 180 && b < 60)) throw new Error(`disc centre is ${slide.disc}`);
    if (slide.whiteInTitle > 20) throw new Error(`${slide.whiteInTitle} white pixels where the title was drawn`);
  });

  await test('the title is a box of its own: white, bold', async () => {
    const box = slide.boxes.find(b => b.paras.includes('Quarterly Results'));
    if (!box) throw new Error('no title box');
    if (!/<a:srgbClr val="FFFFFF"\/>/.test(box.xml) || !/ b="1"/.test(box.xml)) throw new Error('title not white bold');
  });

  await test("the paragraph's three lines are one box, in order", async () => {
    const box = slide.boxes.find(b => b.paras.some(p => p.startsWith('Revenue grew')));
    if (!box || box.paras.length !== 3 || !box.paras[2].startsWith('against the same')) throw new Error(JSON.stringify(box?.paras));
  });

  await test('Chinese stays unspaced, marked zh-CN, red, and not forced into a Latin typeface', async () => {
    const box = slide.boxes.find(b => b.paras.includes('用户管理：身份证由个人拥有'));
    if (!box) throw new Error(JSON.stringify(slide.boxes.map(b => b.paras)));
    if (!/lang="zh-CN"/.test(box.xml)) throw new Error('not zh-CN');
    if (/typeface="Courier New"/.test(box.xml)) throw new Error('Courier New');
    if (!/<a:srgbClr val="CC0000"\/>/.test(box.xml)) throw new Error('not red');
  });

  await test('each table cell is a box of its own', async () => {
    for (const cell of ['Region', '17,722', '20,813', '6,273']) {
      if (!slide.boxes.some(b => b.paras.length === 1 && b.paras[0] === cell)) {
        throw new Error(`no box with exactly "${cell}": ${JSON.stringify(slide.boxes.map(b => b.paras))}`);
      }
    }
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
