// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/fill.e2e.mjs — real-browser regression test for a Cyrillic-
//  text bug in the Fill tool's field-appearance regeneration.
//
//  Found while responding to an external code review of an unrelated tool
//  (Add Form Fields' checkbox increment) — investigating that review's
//  Cyrillic-font claim led to reproducing a real crash in js/worker.js's
//  handleFill(): form.updateFieldAppearances(font) embedded
//  PDFLib.StandardFonts.Helvetica (WinAnsi-only) unconditionally, which
//  throws the instant ANY field in the form holds non-WinAnsi text
//  (Cyrillic, Greek, Vietnamese beyond WinAnsi, etc.). Worse: that single
//  call updates every dirty field's appearance in one pass, so the throw —
//  caught by a blanket try/catch — silently aborted appearance
//  regeneration for the WHOLE form, not just the field with non-Latin
//  text. Fixed by embedding a Unicode-capable font (LiberationSans, same
//  vendored file + fontkit already used by formFieldsWorker.js/
//  watermarkTextWorker.js) instead.
//
//  This test drives the real Fill UI (real clicks, real typing) against a
//  fixture PDF with TWO text fields — one filled with an ASCII value, one
//  with a Cyrillic value — specifically to prove the fix addresses the
//  "one bad field kills the whole form" blast radius, not just that the
//  Cyrillic field itself no longer throws.
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/fill.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import { PDFDocument, PDFTextField } from 'pdf-lib';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
  };
}

const BLOB_HOOK = () => {
  window.__blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
};

console.log(`\nFill E2E — Cyrillic value no longer aborts appearance regeneration for the whole form (real browser, ${BASE_URL}):`);

// Build a fixture with two plain (font-less) text fields — matches what a
// real-world PDF from any generator looks like; Fill's own worker is
// responsible for embedding a font at fill-time, not the fixture.
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', '_e2e_fill_two_fields.pdf');
{
  const pdf  = await PDFDocument.create();
  const page = pdf.addPage([600, 400]);
  const form = pdf.getForm();
  form.createTextField('Name').addToPage(page, { x: 50, y: 300, width: 200, height: 24 });
  form.createTextField('Comment').addToPage(page, { x: 50, y: 200, width: 300, height: 24 });
  fs.writeFileSync(FIXTURE_PATH, await pdf.save());
}

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

await test('filling one Cyrillic field + one ASCII field: both survive, both get real appearances', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let filledBuffer;
  const ASCII_VALUE    = 'John Smith';
  const CYRILLIC_VALUE = 'Привет, мир! Тест Ř Š č';
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/fill/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', FIXTURE_PATH);
    await page.waitForSelector('#fillOptions input[data-field-name]', { state: 'visible', timeout: 15000 });

    await page.fill('#fillOptions input[data-field-name="Name"]', ASCII_VALUE);
    await page.fill('#fillOptions input[data-field-name="Comment"]', CYRILLIC_VALUE);

    // Uncheck flatten — this test needs the fields to still exist as real
    // AcroForm widgets afterward so pdf-lib can read them back directly;
    // flatten() bakes values into the page content and removes the fields
    // entirely, which is orthogonal to the appearance-regeneration bug
    // under test here.
    const flattenBox = page.locator('#fillFlattenToggle');
    if (await flattenBox.count() > 0 && await flattenBox.isChecked()) {
      await flattenBox.uncheck();
    }

    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');

    let result = null;
    for (let i = 0; i < 60; i++) {
      result = await page.evaluate(() => window.__blob ? { size: window.__blob.size, type: window.__blob.type } : null).catch(() => null);
      if (result) break;
      await page.waitForTimeout(500);
    }
    if (!result) throw new Error('processing did not complete in time — Fill may still be throwing on the Cyrillic value');
    expect(result.type).toBe('application/pdf');
    if (!(result.size > 0)) throw new Error(`Expected a non-empty PDF, got size ${result.size}`);

    const base64 = await page.evaluate(async () => {
      const buf = await window.__blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    });
    filledBuffer = Buffer.from(base64, 'base64');
  } finally {
    await context.close();
  }

  const pdf = await PDFDocument.load(filledBuffer);
  const nameField    = pdf.getForm().getTextField('Name');
  const commentField = pdf.getForm().getTextField('Comment');

  // The actual regression: BEFORE the fix, the Cyrillic field's throw
  // aborted updateFieldAppearances() for the whole form — so even the
  // ASCII field's value, though still set via setText(), never got a
  // freshly rendered appearance stream. Check both fields' /V values...
  expect(nameField.getText()).toBe(ASCII_VALUE);
  expect(commentField.getText()).toBe(CYRILLIC_VALUE);

  // ...and confirm the Unicode font actually made it into the saved PDF
  // (proves _embedUnicodeFont's fontkit path ran, not the Helvetica
  // fallback that would have thrown and been silently swallowed).
  const raw = filledBuffer.toString('latin1');
  if (!raw.includes('LiberationSans')) {
    throw new Error('expected an embedded LiberationSans font in the filled PDF, found none');
  }
});

await browser.close();
fs.unlinkSync(FIXTURE_PATH);

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
