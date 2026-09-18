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
//  Editor UI lives in a full-viewport modal (js/formFieldsUI.js's
//  _openModal), not inline in the options panel — earlier versions of
//  this file had a lot of page-scroll-positioning logic here to reach a
//  click target reliably; none of that is needed anymore since the modal
//  is a fixed-position overlay with its own bounded, scrollable canvas
//  stage. See form_field_creation_tool_2026_09 memory for the full history
//  of why the modal replaced the inline canvas.
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
const FLAT_3PG  = path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf');

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

// Opens the tool, uploads FLAT_PDF, and waits for the editor modal to be
// ready. Returns the #ffCanvasWrap locator, already confirmed visible.
async function openEditor(page, pdfPath = FLAT_PDF) {
  await page.goto(`${BASE_URL}/add-form-fields/`, { waitUntil: 'load', timeout: 30000 });
  await page.setInputFiles('#fileInput', pdfPath);
  await page.waitForSelector('.ff-modal--open', { timeout: 15000 });
  const wrap = page.locator('#ffCanvasWrap');
  await page.locator('#ffCanvas').waitFor({ state: 'visible' });
  return wrap;
}

// Clicks at a fraction of the canvas wrap's own bounds. #ffCanvasScroll
// (the modal's stage) can be shorter than the full-resolution rendered
// page — its own bounding rect is fixed within the modal, but the WRAP
// inside it (and the overlay covering it) can extend well past that
// visible window on a page tall enough to need internal scrolling. A
// click computed against the wrap's full (un-clipped) height can land on
// whatever's laid out AFTER the scroll area in the modal — confirmed via
// document.elementFromPoint(): a naive click at 50% of a page whose
// visible stage covers only ~43% landed on the modal's OWN footer save
// button instead of the canvas. Scroll #ffCanvasScroll (simple internal
// scroll only — no outer page involved, unlike the old inline-canvas
// version of this helper) to bring the target into its visible window
// first, same as a real user would for a page taller than the modal.
async function clickAtPageFraction(page, wrapLocator, xFrac, yFrac) {
  const box = await wrapLocator.boundingBox();
  await page.evaluate(({ yFracArg, wrapHeight }) => {
    const scrollEl = document.getElementById('ffCanvasScroll');
    if (!scrollEl) return;
    scrollEl.scrollTop = Math.max(0, wrapHeight * yFracArg - scrollEl.clientHeight / 2);
  }, { yFracArg: yFrac, wrapHeight: box.height });
  const box2 = await wrapLocator.boundingBox();
  await page.mouse.click(box2.x + box2.width * xFrac, box2.y + box2.height * yFrac);
}

// Waits for and captures the downloaded blob after clicking the in-modal
// save button (#ffModalSaveBtn) — the natural user action now that the
// editor lives in a modal, not the shared #mergeBtn directly (though that
// still works too — clicking #ffModalSaveBtn just closes the modal and
// forwards to it, see _openModal's own comment).
async function saveAndCapture(page) {
  await page.evaluate(() => { window.__blob = null; });
  await page.click('#ffModalSaveBtn');
  let result = null;
  for (let i = 0; i < 60; i++) {
    result = await page.evaluate(() => window.__blob ? { size: window.__blob.size, type: window.__blob.type } : null).catch(() => null);
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
  return { result, buffer: Buffer.from(base64, 'base64') };
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
    const wrap = await openEditor(page);

    // Place two fields at two different spots on the page via REAL clicks
    // on the REAL rendered canvas overlay (not a synthetic event dispatch).
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

    const { result, buffer } = await saveAndCapture(page);
    expect(result.type).toBe('application/pdf');
    if (!(result.size > 0)) throw new Error(`Expected a non-empty PDF, got size ${result.size}`);
    downloadedB64 = buffer.toString('base64');

    // The modal should be gone once processing kicks off — see
    // _openModal's own comment on why (so the shared progress bar/success
    // card, which live in the main page, are visible right away).
    expect(await page.locator('.ff-modal').count()).toBe(0);
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
    const wrap = await openEditor(page);

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

await test('Escape closes the modal, "Continue editing" reopens it with fields intact', async () => {
  // Real feature added the same day as the modal itself: closing (X /
  // Escape / backdrop click) must NOT discard placed fields — the outer
  // options panel shows a compact "N fields placed" summary with a
  // reopen button, and _fields/_pdfDoc state survives the round trip.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    const wrap = await openEditor(page);
    await clickAtPageFraction(page, wrap, 0.25, 0.15);
    await page.waitForTimeout(150);
    await page.keyboard.type('Survives Close');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await page.locator('.ff-modal').count()).toBe(0);

    const triggerText = (await page.locator('#formFieldsOptions').textContent()).trim();
    if (!triggerText.includes('1 field placed')) {
      throw new Error(`Expected the trigger panel to report 1 field placed, got: "${triggerText}"`);
    }

    await page.click('#ffReopenBtn');
    await page.waitForSelector('.ff-modal--open', { timeout: 5000 });
    expect(await page.locator('.ff-field-box').count()).toBe(1);
    const val = await page.locator('.ff-name-input').inputValue();
    expect(val).toBe('Survives Close');
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
    const wrap = await openEditor(page);

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

    const { buffer } = await saveAndCapture(page);
    cbBuffer = buffer;
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
    const wrap = await openEditor(page);

    await clickAtPageFraction(page, wrap, 0.25, 0.10);
    await page.waitForTimeout(150);
    // The name input is auto-focused+selected after placement — typing
    // Cyrillic here exercises the same real keyboard-input path a real
    // user would use, not a synthetic value assignment.
    await page.keyboard.type(CYRILLIC_NAME);

    const { buffer } = await saveAndCapture(page);
    cyrillicBuffer = buffer;
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

await test('field-list sidebar lists every placed field and navigates to one on another page', async () => {
  // Competitive-parity feature vs iLovePDF's own PDF-Forms "Form Field List"
  // (checked live 2026-09-17). The sidebar's whole reason to exist is finding
  // a field in a document with many of them WITHOUT hunting across pages, so
  // the load-bearing assertion here is the cross-page jump — a same-page-only
  // list would pass a weaker version of this test while being useless.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    const wrap = await openEditor(page, FLAT_3PG);

    await clickAtPageFraction(page, wrap, 0.30, 0.15);
    await page.waitForTimeout(150);
    await page.keyboard.type('On Page One');

    // Move to page 2 and place a second field there.
    await page.click('#ffNextBtn');
    await page.waitForTimeout(600);
    expect((await page.locator('#ffPageLabel').innerText()).trim()).toBe('2 / 3');
    await clickAtPageFraction(page, wrap, 0.30, 0.60);
    await page.waitForTimeout(150);
    await page.keyboard.type('On Page Two');

    // The list spans ALL pages, not just the one on screen.
    expect(await page.locator('.ff-fieldlist__item').count()).toBe(2);
    const listText = await page.locator('#ffFieldList').innerText();
    for (const needle of ['On Page One', 'Page 1', 'On Page Two', 'Page 2']) {
      if (!listText.includes(needle)) throw new Error(`field list missing "${needle}" — got: ${JSON.stringify(listText)}`);
    }

    // Go back to page 1, then click the page-2 entry: it must switch pages
    // AND highlight AND scroll the field into the stage's visible window.
    await page.click('#ffPrevBtn');
    await page.waitForTimeout(600);
    expect((await page.locator('#ffPageLabel').innerText()).trim()).toBe('1 / 3');

    await page.locator('.ff-fieldlist__item', { hasText: 'On Page Two' }).click();
    await page.waitForTimeout(800);
    expect((await page.locator('#ffPageLabel').innerText()).trim()).toBe('2 / 3');

    // Exactly one box on the canvas, and it's the highlighted one.
    expect(await page.locator('.ff-field-box').count()).toBe(1);
    expect(await page.locator('.ff-field-box--active').count()).toBe(1);
    expect(await page.locator('.ff-fieldlist__item--active').count()).toBe(1);
    expect(await page.locator('.ff-name-input').inputValue()).toBe('On Page Two');

    // Really scrolled into view: the box's centre must sit inside the
    // stage's own visible rect, not merely exist somewhere in the DOM.
    const visible = await page.evaluate(() => {
      const s = document.getElementById('ffCanvasScroll').getBoundingClientRect();
      const b = document.querySelector('.ff-field-box').getBoundingClientRect();
      const cy = b.top + b.height / 2, cx = b.left + b.width / 2;
      return { inside: cy >= s.top && cy <= s.bottom && cx >= s.left && cx <= s.right, s, b };
    });
    if (!visible.inside) throw new Error(`revealed field is outside the visible stage: ${JSON.stringify(visible)}`);

    // Renaming updates the list entry live (no re-open, no extra click).
    await page.fill('.ff-name-input', 'Renamed Live');
    await page.waitForTimeout(100);
    if (!(await page.locator('#ffFieldList').innerText()).includes('Renamed Live')) {
      throw new Error('renaming a field did not update the sidebar list');
    }

    // Deleting removes it from the list too.
    await page.click('.ff-delete-btn');
    await page.waitForTimeout(200);
    expect(await page.locator('.ff-fieldlist__item').count()).toBe(1);
  } finally {
    await context.close();
  }
});

await test('zoom controls really rescale the canvas, and placed fields stay aligned', async () => {
  // The claim this tool's own code comment makes — "fields are stored as
  // page fractions, so zooming needs no placement math at all" — is exactly
  // the kind of plausible-sounding claim CLAUDE.md says to verify against a
  // real browser rather than accept. So: measure each field box's CENTRE as
  // a fraction of the canvas wrap before and after zooming. If the fractions
  // survive, the boxes are still over the same page content.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    const wrap = await openEditor(page);
    await clickAtPageFraction(page, wrap, 0.30, 0.15);
    await page.waitForTimeout(150);
    await clickAtPageFraction(page, wrap, 0.30, 0.55);
    await page.waitForTimeout(250);

    const measure = () => page.evaluate(() => {
      const w = document.getElementById('ffCanvasWrap').getBoundingClientRect();
      return {
        canvasCssW: document.getElementById('ffCanvas').style.width,
        wrapW: w.width,
        boxes: [...document.querySelectorAll('.ff-field-box')].map(el => {
          const r = el.getBoundingClientRect();
          return { cx: (r.left + r.width / 2 - w.left) / w.width, cy: (r.top + r.height / 2 - w.top) / w.height };
        }),
      };
    });

    const before = await measure();
    expect(await page.locator('#ffZoomLabel').innerText()).toBe('100%');

    await page.click('#ffZoomInBtn');
    await page.waitForTimeout(700);
    const after = await measure();

    expect(await page.locator('#ffZoomLabel').innerText()).toBe('125%');
    if (!(after.wrapW > before.wrapW * 1.2)) {
      throw new Error(`canvas did not actually grow: ${before.wrapW} → ${after.wrapW} (css ${before.canvasCssW} → ${after.canvasCssW})`);
    }
    expect(after.boxes.length).toBe(before.boxes.length);
    for (let i = 0; i < before.boxes.length; i++) {
      const dx = Math.abs(after.boxes[i].cx - before.boxes[i].cx);
      const dy = Math.abs(after.boxes[i].cy - before.boxes[i].cy);
      if (dx > 0.005 || dy > 0.005) {
        throw new Error(`field ${i} drifted relative to the page when zoomed: dx=${dx} dy=${dy} ` +
          `(${JSON.stringify(before.boxes[i])} → ${JSON.stringify(after.boxes[i])})`);
      }
    }

    // Zooming all the way in stops at the top of the ladder (the backing
    // canvas is separately clamped to MAX_DIMENSION inside _renderPage).
    for (let i = 0; i < 10; i++) {
      if (await page.locator('#ffZoomInBtn').isDisabled()) break;
      await page.click('#ffZoomInBtn');
      await page.waitForTimeout(300);
    }
    expect(await page.locator('#ffZoomLabel').innerText()).toBe('400%');
    expect(await page.locator('#ffZoomInBtn').isDisabled()).toBe(true);

    // A canvas wider than the stage must be scrollable to BOTH edges —
    // .ff-modal__stage deliberately avoids justify-content:center for this
    // reason (a centered flex item's overflow is unreachable at the start
    // edge). Assert the real numbers, don't assume overflow:auto is enough.
    const overflow = await page.evaluate(() => {
      const s = document.getElementById('ffCanvasScroll');
      s.scrollLeft = 0;
      const sr = s.getBoundingClientRect();
      const wr = document.getElementById('ffCanvasWrap').getBoundingClientRect();
      return { scrollW: s.scrollWidth, clientW: s.clientWidth, leftGap: Math.round(wr.left - sr.left) };
    });
    if (!(overflow.scrollW > overflow.clientW)) throw new Error(`expected horizontal overflow at 400%, got ${JSON.stringify(overflow)}`);
    if (overflow.leftGap < 0) throw new Error(`canvas left edge is clipped out of reach at 400%: ${JSON.stringify(overflow)}`);

    // Reset returns to the fit scale and disables itself there.
    await page.click('#ffZoomFitBtn');
    await page.waitForTimeout(700);
    expect(await page.locator('#ffZoomLabel').innerText()).toBe('100%');
    expect(await page.locator('#ffZoomFitBtn').isDisabled()).toBe(true);
    const reset = await measure();
    if (Math.abs(reset.wrapW - before.wrapW) > 1) {
      throw new Error(`reset did not return to the original scale: ${before.wrapW} → ${reset.wrapW}`);
    }
  } finally {
    await context.close();
  }
});

await test('modal traps focus, starts focus inside, makes the page behind inert, and restores focus on close', async () => {
  // A modal that looks right but lets Tab walk out behind the backdrop is
  // the classic half-done dialog. Only a real browser can settle it — code
  // review cannot tell you what document.activeElement actually becomes.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    const wrap = await openEditor(page);

    // Focus must already be inside the modal the moment it opens.
    const opened = await page.evaluate(() => {
      const a = document.activeElement;
      return { id: a?.id, inside: !!document.querySelector('.ff-modal')?.contains(a) };
    });
    if (!opened.inside) throw new Error(`focus was not inside the modal on open (activeElement id="${opened.id}")`);

    // Everything else on the page must be inert + aria-hidden while it's up.
    const bg = await page.evaluate(() => [...document.body.children]
      .filter(el => !el.classList.contains('ff-modal'))
      .map(el => ({ tag: el.tagName, inert: el.hasAttribute('inert'), hidden: el.getAttribute('aria-hidden') })));
    const leaked = bg.filter(e => !e.inert || e.hidden !== 'true');
    if (leaked.length) throw new Error(`page content behind the modal is still exposed: ${JSON.stringify(leaked)}`);

    // Place two fields first so the trap has to cycle past real, dynamically
    // created focusables (name inputs, delete buttons, list entries), not
    // just the three static chrome buttons.
    await clickAtPageFraction(page, wrap, 0.30, 0.15);
    await page.waitForTimeout(150);
    await clickAtPageFraction(page, wrap, 0.30, 0.55);
    await page.waitForTimeout(250);

    const walk = async (shift) => {
      const seen = [];
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
        const step = await page.evaluate(() => {
          const a = document.activeElement;
          const m = document.querySelector('.ff-modal');
          return { inside: !!(m && a && m.contains(a)), id: a?.id || a?.className || a?.tagName };
        });
        seen.push(step);
      }
      return seen;
    };

    for (const shift of [false, true]) {
      const seen = await walk(shift);
      const escaped = seen.filter(s => !s.inside);
      if (escaped.length) {
        throw new Error(`${shift ? 'Shift+Tab' : 'Tab'} escaped the modal ${escaped.length}/30 times: ` +
          JSON.stringify(seen.map(s => (s.inside ? '' : '!') + s.id)));
      }
      // A trap that pins focus on ONE element would also never "escape" —
      // confirm it genuinely cycles through several distinct controls.
      const distinct = new Set(seen.map(s => s.id));
      if (distinct.size < 4) throw new Error(`focus barely moved (${distinct.size} distinct targets): ${JSON.stringify([...distinct])}`);
    }

    // Closing must hand focus to something meaningful — the "Continue
    // editing" button that now represents this editor — not <body>.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await page.locator('.ff-modal').count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('ffReopenBtn');

    // …and the page behind must be interactive again.
    const stillInert = await page.evaluate(() => [...document.body.children]
      .filter(el => el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true').length);
    expect(stillInert).toBe(0);
  } finally {
    await context.close();
  }
});

await browser.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
