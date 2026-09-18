// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/formFields.e2e.mjs — real-browser regression test for the
//  "Add Form Fields" tool (js/formFieldsUI.js + js/formFieldsWorker.js).
//
//  This tool's entire value proposition is "the fields it creates are
//  REAL AcroForm fields, not a picture" — so a unit test that only checks
//  in-memory state isn't convincing evidence. This drives the actual
//  browser UI end to end (real clicks on the real rendered canvas, not a
//  simulated event) and then verifies the output two independent ways,
//  per this project's own "verify empirically" standard:
//
//  1. Load the downloaded PDF back through pdf-lib in plain Node (a
//     process with zero shared browser state) and confirm
//     pdf.getForm().getFields() returns real PDFTextField instances at
//     the names placed in the UI.
//  2. Feed that same downloaded PDF into this site's own real Fill tool
//     (/fill/) through a second real browser page, and confirm Fill's
//     own field-detection UI renders inputs for those exact field names
//     — the most convincing proof this is a standards-compliant AcroForm
//     PDF another tool can actually read, not just something that looks
//     right in this tool's own code.
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/formFields.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FLAT_PDF  = path.join(__dirname, '..', 'fixtures', 'normal-1page.pdf');

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

// #ffCanvasScroll now renders the page at full width-derived scale (see
// formFieldsUI.js's own _renderPage comment — this used to also shrink by
// height to avoid #mergeBtn's sticky overlap, which made tall/portrait
// pages render as tiny unusable thumbnails; fixed by scaling on width only
// and instead bounding #ffCanvasScroll itself with max-height+scroll). Two
// things follow: (1) a click target below the fold needs scrolling WITHIN
// the container into view first, same as a real user now does; (2) the
// container's own on-PAGE position is unaffected by that internal scroll —
// when the panel's chrome above the canvas leaves very little real
// headroom before the sticky #mergeBtn, the height-cap's safety floor
// (220px minimum, formFieldsUI.js's own Math.max) can still place the
// container's bottom edge behind the button, confirmed via a real
// document.elementFromPoint() probe. Scroll the OUTER page first so the
// container sits near a fixed, comfortably-clear offset from the viewport
// top, THEN scroll within it — matches how a real user would reposition a
// tall canvas before clicking, not a test-only workaround.
async function clickAtPageFraction(page, wrapLocator, xFrac, yFrac) {
  await page.locator('#ffCanvasScroll').evaluate((el) => {
    window.scrollBy(0, el.getBoundingClientRect().top - 80);
  });
  const box = await wrapLocator.boundingBox();
  await page.evaluate(({ yFracArg, wrapHeight }) => {
    const scrollEl = document.getElementById('ffCanvasScroll');
    if (!scrollEl) return;
    scrollEl.scrollTop = Math.max(0, wrapHeight * yFracArg - scrollEl.clientHeight / 2);
  }, { yFracArg: yFrac, wrapHeight: box.height });
  const box2 = await wrapLocator.boundingBox();
  await page.mouse.click(box2.x + box2.width * xFrac, box2.y + box2.height * yFrac);
}

console.log(`\nformFields E2E — click-to-place produces a real AcroForm PDF (real browser, ${BASE_URL}):`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

let downloadedB64 = null;

await test('click-place-name-save produces a downloaded PDF', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/add-form-fields/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', FLAT_PDF);

    // Wait for the canvas-based editor to render (not the "already has
    // fields" blocked message, not the loading spinner).
    await page.waitForSelector('#ffCanvasWrap', { state: 'visible', timeout: 15000 });
    const wrap = page.locator('#ffCanvasWrap');
    await page.locator('#ffCanvas').waitFor({ state: 'visible' });

    // Place two fields at two different spots on the page via REAL clicks
    // on the REAL rendered canvas overlay (not a synthetic event dispatch).
    // clickAtPageFraction scrolls #ffCanvasScroll so each target point is
    // actually visible first — see its own comment for why that's needed.
    await clickAtPageFraction(page, wrap, 0.25, 0.10);
    await page.waitForTimeout(150);
    // The first field's name input is auto-focused+selected after
    // placement (see formFieldsUI.js's _placeFieldAtEvent) — type over it.
    await page.keyboard.type('Full Name');

    await clickAtPageFraction(page, wrap, 0.25, 0.50);
    await page.waitForTimeout(150);
    await page.keyboard.type('Email Address');

    const fieldBoxCount = await page.locator('.ff-field-box').count();
    expect(fieldBoxCount).toBe(2);

    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');

    let result = null;
    for (let i = 0; i < 60; i++) {
      result = await page.evaluate(() => window.__blob ? { size: window.__blob.size, type: window.__blob.type } : null).catch(() => null);
      if (result) break;
      await page.waitForTimeout(500);
    }
    if (!result) throw new Error('processing did not complete in time');
    expect(result.type).toBe('application/pdf');
    if (!(result.size > 0)) throw new Error(`Expected a non-empty PDF, got size ${result.size}`);

    downloadedB64 = await page.evaluate(async () => {
      const buf = await window.__blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    });
  } finally {
    await context.close();
  }
});

await test('dragging a placed field by its handle actually moves it', async () => {
  // Real regression: a real user reported "impossible to move — inside the
  // text there's a text cursor, outside there's no grab hand" right after
  // this tool first shipped. Root cause: .ff-name-input used flex:1 and
  // filled the ENTIRE field box, leaving zero pixels of the wrapper's own
  // cursor:move area for _onOverlayPointerDown's drag-start check to ever
  // fire on. Fixed with a dedicated .ff-drag-handle positioned outside the
  // box (same pattern as the pre-existing delete/resize handles). This
  // test drags via that handle and asserts the box's on-screen position
  // actually changed — not just that no error was thrown, which the old,
  // broken code also satisfied.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/add-form-fields/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', FLAT_PDF);
    await page.waitForSelector('#ffCanvasWrap', { state: 'visible', timeout: 15000 });
    const wrap = page.locator('#ffCanvasWrap');
    await page.locator('#ffCanvas').waitFor({ state: 'visible' });

    await clickAtPageFraction(page, wrap, 0.25, 0.15);
    await page.waitForTimeout(150);

    const before = await page.locator('.ff-field-box').boundingBox();
    const handle = page.locator('.ff-drag-handle');
    await handle.waitFor({ state: 'visible' });
    const hbox = await handle.boundingBox();

    await page.mouse.move(hbox.x + hbox.width / 2, hbox.y + hbox.height / 2);
    await page.mouse.down();
    await page.mouse.move(hbox.x + hbox.width / 2 + 60, hbox.y + hbox.height / 2 + 40, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await page.locator('.ff-field-box').boundingBox();
    const dx = Math.abs(after.x - before.x);
    const dy = Math.abs(after.y - before.y);
    if (dx < 30 || dy < 20) {
      throw new Error(`field did not move as expected: dx=${dx} dy=${dy} (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`);
    }

    // Renaming must still work after this fix (the name input is no longer
    // the box's only child) — same click target, still a real text field.
    await page.fill('.ff-name-input', 'Renamed After Drag');
    const val = await page.locator('.ff-name-input').inputValue();
    expect(val).toBe('Renamed After Drag');
  } finally {
    await context.close();
  }
});

let nodeVerifiedBuffer = null;

await test('independent check #1 — pdf-lib in plain Node sees 2 real PDFTextField widgets', async () => {
  if (!downloadedB64) throw new Error('no downloaded PDF from previous step');
  nodeVerifiedBuffer = Buffer.from(downloadedB64, 'base64');

  const pdf    = await PDFDocument.load(nodeVerifiedBuffer);
  const form   = pdf.getForm();
  const fields = form.getFields();

  expect(fields.length).toBe(2);
  for (const f of fields) {
    if (!(f instanceof PDFTextField)) throw new Error(`Expected PDFTextField, got ${f.constructor.name}`);
  }
  const names = fields.map(f => f.getName()).sort();
  expect(JSON.stringify(names)).toBe(JSON.stringify(['Email Address', 'Full Name']));

  // Each field must have exactly one widget annotation actually attached
  // to a page (addToPage really ran, not just a bare unattached field).
  for (const f of fields) {
    const widgets = f.acroField.getWidgets();
    if (widgets.length < 1) throw new Error(`Field "${f.getName()}" has no widget annotation`);
  }
});

await test('independent check #2 — this site\'s own real Fill tool detects the fields', async () => {
  if (!nodeVerifiedBuffer) throw new Error('no verified buffer from previous step');

  const tmpPath = path.join(__dirname, '..', 'fixtures', '_e2e_formfields_output.pdf');
  const fs = await import('fs');
  fs.writeFileSync(tmpPath, nodeVerifiedBuffer);

  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/fill/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', tmpPath);

    // fillUI.js renders one <input data-field-name="..."> per detected
    // text field, inside #fillOptions — wait for the real Fill UI to
    // finish analysing and render the form.
    await page.waitForSelector('#fillOptions input[data-field-name]', { state: 'visible', timeout: 15000 });

    const fieldNames = await page.$$eval(
      '#fillOptions input[data-field-name]',
      els => els.map(el => el.dataset.fieldName).sort()
    );
    expect(JSON.stringify(fieldNames)).toBe(JSON.stringify(['Email Address', 'Full Name']));

    // Confirm Fill treats them as genuinely fillable — type into one and
    // read the value back, exactly as a real user filling out the form
    // this tool created would.
    await page.fill('#fillOptions input[data-field-name="Full Name"]', 'Ada Lovelace');
    const typed = await page.inputValue('#fillOptions input[data-field-name="Full Name"]');
    expect(typed).toBe('Ada Lovelace');
  } finally {
    await context.close();
    fs.unlinkSync(tmpPath);
  }
});

await test('checkbox field type: select chip, place, save, verify two independent ways', async () => {
  // Follow-up to the tool's initial text-only MVP: a field-type chip
  // toggle ('Text'/'Checkbox') now selects what the NEXT click places.
  // Same two-independent-check verification standard as the text-field
  // flow above — this isn't a lesser-verified follow-up.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let cbBuffer;
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/add-form-fields/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', FLAT_PDF);
    await page.waitForSelector('#ffCanvasWrap', { state: 'visible', timeout: 15000 });
    const wrap = page.locator('#ffCanvasWrap');
    await page.locator('#ffCanvas').waitFor({ state: 'visible' });

    // Select the Checkbox chip before placing — same click-target pattern
    // as chip groups elsewhere in this codebase (label[data-name][data-value]).
    await page.click('label[data-name="ffType"][data-value="checkbox"]');
    await clickAtPageFraction(page, wrap, 0.25, 0.10);
    await page.waitForTimeout(150);
    await page.keyboard.type('Agree To Terms');

    // Also place a text field in the same run, to confirm both types
    // coexist correctly and the chip toggle doesn't leak state between
    // placements.
    await page.click('label[data-name="ffType"][data-value="text"]');
    await clickAtPageFraction(page, wrap, 0.25, 0.50);
    await page.waitForTimeout(150);
    await page.keyboard.type('Comments');

    expect(await page.locator('.ff-field-box').count()).toBe(2);

    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');
    let result = null;
    for (let i = 0; i < 60; i++) {
      result = await page.evaluate(() => window.__blob ? { size: window.__blob.size } : null).catch(() => null);
      if (result) break;
      await page.waitForTimeout(500);
    }
    if (!result) throw new Error('processing did not complete in time');

    const base64 = await page.evaluate(async () => {
      const buf = await window.__blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    });
    cbBuffer = Buffer.from(base64, 'base64');
  } finally {
    await context.close();
  }

  // Independent check #1 — plain-Node pdf-lib.
  const pdf    = await PDFDocument.load(cbBuffer);
  const fields = pdf.getForm().getFields();
  expect(fields.length).toBe(2);

  const cbField = fields.find(f => f.getName() === 'Agree To Terms');
  if (!cbField) throw new Error('checkbox field "Agree To Terms" not found in saved PDF');
  if (!(cbField instanceof PDFCheckBox)) {
    throw new Error(`Expected PDFCheckBox, got ${cbField.constructor.name}`);
  }
  if (cbField.isChecked()) throw new Error('expected a freshly-placed checkbox to default to unchecked');

  const textField = fields.find(f => f.getName() === 'Comments');
  if (!textField) throw new Error('text field "Comments" not found in saved PDF');
  if (!(textField instanceof PDFTextField)) {
    throw new Error(`Expected the other field to still be PDFTextField, got ${textField.constructor.name}`);
  }

  // Independent check #2 — the site's own real Fill tool.
  const tmpPath = path.join(__dirname, '..', 'fixtures', '_e2e_formfields_checkbox_output.pdf');
  const fs = await import('fs');
  fs.writeFileSync(tmpPath, cbBuffer);
  const context2 = await browser.newContext({ serviceWorkers: 'block' });
  const page2 = await context2.newPage();
  try {
    await page2.goto(`${BASE_URL}/fill/`, { waitUntil: 'load', timeout: 30000 });
    await page2.setInputFiles('#fileInput', tmpPath);
    await page2.waitForSelector('#fillOptions input[data-field-name]', { state: 'visible', timeout: 15000 });

    const checkboxInput = page2.locator('#fillOptions input[type="checkbox"][data-field-name="Agree To Terms"]');
    await checkboxInput.waitFor({ state: 'visible', timeout: 10000 });
    // Fill's own UI must render this as a REAL checkbox input, not a text
    // box — proves the saved PDF is a standards-shaped AcroForm checkbox
    // widget another independent tool correctly reads as one.
    const inputType = await checkboxInput.evaluate(el => el.type);
    expect(inputType).toBe('checkbox');

    const textInput = page2.locator('#fillOptions input[data-field-name="Comments"]');
    await textInput.waitFor({ state: 'visible' });
    const textInputType = await textInput.evaluate(el => el.type);
    if (textInputType === 'checkbox') throw new Error('the text field was mis-detected as a checkbox');
  } finally {
    await context2.close();
    fs.unlinkSync(tmpPath);
  }
});

await test('Cyrillic field name survives sanitization + a real Unicode font (not WinAnsi Helvetica) backs the field', async () => {
  // Project standing rule: any text-touching feature needs a Cyrillic/CJK
  // test up front. This tool's _sanitizeFieldName (formFieldsWorker.js)
  // strips control chars and replaces '.', so it's worth confirming
  // directly that it doesn't also mangle non-ASCII text it has no reason to
  // touch. Separately, confirm formFieldsWorker.js's own actual job — the
  // font it embeds and hands to createTextField/addToPage — really is a
  // Unicode-capable font (LiberationSans, per its own header comment), not
  // one of pdf-lib's built-in WinAnsi-only StandardFonts.
  //
  // NOT tested here: whether a value LATER typed into this field (e.g. via
  // this site's own Fill tool) renders correctly. That's a separate claim
  // about a separate file — investigating it surfaced a real, unrelated bug
  // in js/worker.js's Fill/Flatten field-appearance regeneration (uses
  // StandardFonts.Helvetica unconditionally, which throws on Cyrillic/
  // Greek/etc.), tracked and fixed separately, not part of this tool.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let cyrillicBuffer;
  const CYRILLIC_NAME = 'Имя (Фамилия)';
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.goto(`${BASE_URL}/add-form-fields/`, { waitUntil: 'load', timeout: 30000 });
    await page.setInputFiles('#fileInput', FLAT_PDF);
    await page.waitForSelector('#ffCanvasWrap', { state: 'visible', timeout: 15000 });
    const wrap = page.locator('#ffCanvasWrap');
    await page.locator('#ffCanvas').waitFor({ state: 'visible' });

    await clickAtPageFraction(page, wrap, 0.25, 0.10);
    await page.waitForTimeout(150);
    // The name input is auto-focused+selected after placement — typing
    // Cyrillic here exercises the same real keyboard-input path a real
    // user would use, not a synthetic value assignment.
    await page.keyboard.type(CYRILLIC_NAME);

    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');
    let result = null;
    for (let i = 0; i < 60; i++) {
      result = await page.evaluate(() => window.__blob ? { size: window.__blob.size } : null).catch(() => null);
      if (result) break;
      await page.waitForTimeout(500);
    }
    if (!result) throw new Error('processing did not complete in time');

    const base64 = await page.evaluate(async () => {
      const buf = await window.__blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    });
    cyrillicBuffer = Buffer.from(base64, 'base64');
  } finally {
    await context.close();
  }

  // Check #1 — the sanitizer didn't mangle a name it had no reason to touch
  // (no control chars, no literal '.').
  const pdf   = await PDFDocument.load(cyrillicBuffer);
  const field = pdf.getForm().getTextField(CYRILLIC_NAME); // throws if the name doesn't match exactly
  expect(field.getName()).toBe(CYRILLIC_NAME);
  if (field.acroField.getWidgets().length < 1) throw new Error('Cyrillic-named field has no widget annotation');

  // Check #2 — a real embedded Unicode font backs this field, not one of
  // pdf-lib's 14 built-in StandardFonts. pdf-lib doesn't subset/rename an
  // embedded font unless explicitly asked to (formFieldsWorker.js's
  // `pdf.embedFont(fontBytes)` call passes no subset option), so the raw
  // saved bytes should still carry the font's own name table entry.
  const raw = cyrillicBuffer.toString('latin1');
  if (!raw.includes('LiberationSans')) {
    throw new Error('expected an embedded LiberationSans font in the saved PDF — found none. ' +
      'A Cyrillic/Greek/Vietnamese value typed into this field later would have no working font to render with.');
  }
});

await browser.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
