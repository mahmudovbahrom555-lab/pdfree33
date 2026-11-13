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
import fs from 'fs';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';

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
  const defaults = await page.evaluate(() => ({
    checked: document.querySelector('input[name="p2pMode"]:checked')?.value,
    first: document.querySelector('input[name="p2pMode"]')?.value,
  }));
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

  await test('Editable text is the default mode and the first choice (owner, 2026-10-16)', async () => {
    if (defaults.checked !== 'text' || defaults.first !== 'text') throw new Error(JSON.stringify(defaults));
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

// ── "One question per slide" (/worksheet-slides/ in a same-site frame, 2026-11-14) ──
// A teacher frames each question; the PowerPoint has one question per slide,
// with clickable A–E answers that jump to "Correct!" / "Try again" slides.
async function worksheetPdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [index, question] of ['1. What is 3 × 4?', '2. How many sides does this figure have?', '3. What is 15 / 3?'].entries()) {
    const y = 690 - index * 170;
    page.drawText(question, { x: 65, y, font, size: 17 });
    page.drawText(index === 2 ? 'A) 1    B) 2    C) 3    D) 4    E) 5' : 'A) 12    B) 3    C) 4    D) 5', { x: 65, y: y - 32, font, size: 15 });
  }
  page.drawLine({ start: { x: 450, y: 490 }, end: { x: 500, y: 490 } });
  page.drawLine({ start: { x: 500, y: 490 }, end: { x: 475, y: 535 } });
  page.drawLine({ start: { x: 475, y: 535 }, end: { x: 450, y: 490 } });
  return Buffer.from(await pdf.save());
}
async function verifyDeck(archive) {
  assert.match(await archive.file('ppt/presProps.xml').async('string'), /<p:present\b/);
  assert.equal(archive.file(/^ppt\/slides\/slide\d+\.xml$/).length, 10);
  for (const [slide, destinations] of Object.entries({
    1: [4, 5, 6, 6, 6], 2: [4, 8, 7, 8, 8], 3: [4, 10, 10, 10, 10, 9],
    4: [1], 5: [2, 4], 6: [1, 4], 7: [3, 4], 8: [2, 4], 9: [4, 4], 10: [3, 4],
  })) {
    const rels = await archive.file(`ppt/slides/_rels/slide${slide}.xml.rels`).async('string');
    const content = await archive.file(`ppt/slides/slide${slide}.xml`).async('string');
    assert.match(content, /<p:transition advClick="0"/);
    const targets = new Map([...rels.matchAll(/Id="([^"]+)"[^>]*Target="[^"]*slide(\d+)\.xml"/g)].map(m => [m[1], Number(m[2])]));
    const links = [...content.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].flatMap(([shape]) => {
      const ids = [...shape.matchAll(/<a:hlinkClick[^>]*r:id="([^"]+)"/g)].map(m => targets.get(m[1]));
      if (!ids.length) return [];
      assert.ok(ids.every(id => id === ids[0] && Number.isInteger(id)));
      return [ids[0]];
    });
    assert.deepEqual(links, destinations, `answer destinations on slide ${slide}`);
    if (slide === '4') assert.match(content, /<a:hlinkClick[^>]*r:id=""[^>]*action="ppaction:\/\/hlinkshowjump\?jump=endshow"/);
    assert.doesNotMatch(rels, /jump=endshow/);
  }
}

const browser2 = await chromium.launch();
console.log(`\npdf2ppt — one question per slide (${BASE_URL}):`);
try {
  await test('a teacher frames 3 questions, marks the answers, previews them and gets a quiz PowerPoint with working answer links', async () => {
    const page = await browser2.newPage({ viewport: { width: 1440, height: 1180 }, serviceWorkers: 'block' });
    const model = [];
    page.on('request', r => { if (r.url().endsWith('.onnx')) model.push(r.url()); });
    await page.goto(`${BASE_URL}/pdf-to-powerpoint/`);
    const fixture = { name: 'interactive-test.pdf', mimeType: 'application/pdf', buffer: await worksheetPdf() };
    await page.locator('#fileInput').setInputFiles(fixture);
    await page.locator('#p2pWorksheet').click({ timeout: 20000 });
    const editor = page.frameLocator('#pdf2pptOptions dialog iframe');
    await editor.locator('#workspace:enabled').waitFor({ timeout: 30000 });
    assert.equal(await editor.locator('#document-name').innerText(), fixture.name);
    const overlay = editor.locator('#overlay');
    for (let index = 0; index < 3; index++) {
      if (index) await editor.locator('#add-task').click();
      const top = 76 + index * 170;
      await overlay.scrollIntoViewIfNeeded();
      const local = await overlay.evaluate((svg, y) => {
        const bounds = svg.getBoundingClientRect();
        return [[55, y], [530, y + 83]].map(([x, v]) => {
          const point = new DOMPoint(x, v).matrixTransform(svg.getScreenCTM());
          return [point.x - bounds.x, point.y - bounds.y];
        });
      }, top);
      const box = await overlay.boundingBox();
      const [start, end] = local.map(([x, y]) => [x + box.x, y + box.y]);
      await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(...end, { steps: 5 }); await page.mouse.up();
      if (!index) await editor.getByText('Interactive answer', { exact: true }).click();
      await editor.locator('#quiz-enabled').check();
      if (!index) {
        await editor.locator('#export-pptx').click();
        assert.match(await editor.locator('#status').innerText(), /Mark the correct answer/);
      }
      if (index === 2) await editor.locator('#quiz-count').selectOption('5');
      await editor.locator('#quiz-correct').selectOption(['A', 'B', 'E'][index]);
      await editor.locator('#quiz-explanation').fill(['3 × 4 = 12.', 'A triangle has three sides.', '15 ÷ 3 = 5.'][index]);
      await editor.locator('#quiz-explanation').press('Tab');
    }
    await editor.locator('#preview').click();
    await editor.locator('#expand-preview').click();
    await editor.locator('#quiz-answers button').first().click();
    assert.equal(await editor.locator('#quiz-feedback').innerText(), 'Try again');
    await editor.locator('#quiz-answers button').last().click();
    assert.match(await editor.locator('#quiz-feedback').innerText(), /Correct!/);
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await editor.locator('#review-summary').click();
    await editor.locator('#reviewed').check();
    const downloading = page.waitForEvent('download');
    await editor.locator('#export-pptx').click();
    const result = await downloading;
    assert.equal(result.suggestedFilename(), 'worksheet-quiz.pptx');
    await verifyDeck(await JSZip.loadAsync(fs.readFileSync(await result.path())));
    assert.deepEqual(model, []);
    // closing returns to the normal conversion; reopening keeps the frames
    await page.locator('#pdf2pptOptions dialog header > button').click();
    await page.locator('#pdf2pptOptions dialog').waitFor({ state: 'detached' });
    await page.locator('#p2pWorksheet').click();
    await editor.locator('#workspace:enabled').waitFor();
    assert.equal(await editor.locator('#task-list button').count(), 3);
    await page.close();
  });
} finally {
  await browser2.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
