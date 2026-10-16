// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/pdf2word-forms.e2e.mjs — PDF to Word keeps what was typed into
//  a form (2026-10-15).
//
//  A filled-in form's answers live in widget annotations, which pdf.js's
//  getTextContent() never returns: every answer was missing from the .docx
//  (found by the nightly corpus detectors on a real Dutch form — 3.7k of
//  its 6.4k characters). tests/fixtures/pdf2word/filled-form.pdf: a
//  one-line answer, a two-line answer, a hidden field, an empty field;
//  freetext.pdf (make-freetext.mjs): a FreeText annotation's typed text
//  (2026-10-16).
//  Run: node tests/e2e/pdf2word-forms.e2e.mjs   (dist/ served on :8934)
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
console.log(`\npdf2word — filled forms E2E (${BASE_URL}):`);
try {
  await test('typed answers are in the .docx, near their labels; a hidden field is not', async () => {
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /officedocument/.test(b.type)) window.__docx = b; return orig(b); };
    });
    await page.goto(BASE_URL + '/pdf-to-word/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'pdf2word', 'filled-form.pdf'));
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__docx, null, { timeout: 90000 });
    const paras = await page.evaluate(async () => {
      await (await import('/js/lazyLibs.js')).loadJSZip();
      const zip = await window.JSZip.loadAsync(await window.__docx.arrayBuffer());
      const xml = await zip.file('word/document.xml').async('string');
      return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(m => [...m[0].matchAll(/<w:t[^>]*>([^<]*)/g)].map(t => t[1]).join(''));
    });
    const all = paras.join('\n');
    for (const s of ['Stichting De Brug', 'Line one of the answer', 'Line two of the answer']) if (!all.includes(s)) throw new Error(`missing "${s}": ${all}`);
    if (all.includes('SECRET HIDDEN VALUE')) throw new Error('hidden field shown');
    if (!paras.some(p => p.includes('Name of the organisation') && p.includes('Stichting De Brug'))) throw new Error(`answer not next to its label: ${all}`);
    if (all.indexOf('Line one') > all.indexOf('Line two')) throw new Error('multi-line answer out of order');
  });

  await test('a FreeText annotation (typewriter text) is in the .docx, after the text above it', async () => {
    // a Japanese slide's typed note was in no output (presentations corpus, 2026-10-16)
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (b instanceof Blob && /officedocument/.test(b.type)) window.__docx = b; return orig(b); };
    });
    await page.goto(BASE_URL + '/pdf-to-word/', { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(__dirname, '..', 'fixtures', 'pdf2word', 'freetext.pdf'));
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__docx, null, { timeout: 90000 });
    const all = await page.evaluate(async () => {
      await (await import('/js/lazyLibs.js')).loadJSZip();
      const zip = await window.JSZip.loadAsync(await window.__docx.arrayBuffer());
      return [...(await zip.file('word/document.xml').async('string')).matchAll(/<w:t[^>]*>([^<]*)/g)].map(t => t[1]).join(' ');
    });
    if (!all.includes('Leave the parcel at the back door')) throw new Error(`missing the note: ${all}`);
    if (all.indexOf('Delivery instructions') > all.indexOf('Leave the parcel')) throw new Error('note before the heading');
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
