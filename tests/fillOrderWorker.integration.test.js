// ============================================================
//  tests/fillOrderWorker.integration.test.js
//
//  Integration tests for js/fillOrderWorker.js's handleFillOrder().
//  Same harness pattern as tests/resizeWorker.integration.test.js — see
//  that file's header comment for why we test the handler function
//  directly instead of the real Worker (postMessage doesn't exist in
//  Node).
//
//  No AcroForm-bearing fixture exists in tests/fixtures/, and there's no
//  real customer PDF available for this feature (see the implementation
//  plan) — every form here is built synthetically with pdf-lib's own
//  high-level API.
//
//  Standalone, not wired into `npm test` (matches the precedent —
//  worker.integration.test.js / resizeWorker.integration.test.js aren't
//  in package.json's test script either). Run:
//    node tests/fillOrderWorker.integration.test.js
// ============================================================

const PDFLib = await import('pdf-lib');
const { PDFDocument, PDFName, PDFRef, degrees } = PDFLib;

const messages = [];
global.self = {
  postMessage: (msg) => messages.push(msg),
  onmessage:   null,
  PDFLib,
};
global.PDFLib = PDFLib;

const { readFileSync } = await import('fs');
const { join, dirname } = await import('path');
const { fileURLToPath } = await import('url');
const __dir = dirname(fileURLToPath(import.meta.url));

const workerSrc = readFileSync(join(__dir, '../js/fillOrderWorker.js'), 'utf8')
  .replace(/importScripts\([^)]+\);?/g, '')
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const workerModule = new AsyncFunction(workerSrc + '\nreturn { handleFillOrder };');
const { handleFillOrder } = await workerModule();

// ── Test runner ───────────────────────────────────────────────

let passed = 0, failed = 0;

async function test(name, fn) {
  messages.length = 0;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.stack || e.message}`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe:            (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:         (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy:      ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeInstanceOf:  (T) => { if (!(actual instanceof T)) throw new Error(`Expected instanceof ${T.name}`); },
  };
}

function lastDone() { return messages.findLast(m => m.type === 'done'); }

async function toBuffer(pdfDoc) {
  const bytes = await pdfDoc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// Returns the field name (via refInfo-equivalent lookup) for each ref
// currently sitting in a page's /Annots array, in physical order —
// the same thing the worker itself reorders. Built independently from
// handleFillOrder's own logic so the test isn't just re-asserting the
// implementation against itself.
function annotsFieldOrder(pdfDoc, pageIndex) {
  const page = pdfDoc.getPages()[pageIndex];
  const annots = page.node.Annots();
  if (!annots) return [];
  const form = pdfDoc.getForm();
  const nameByRef = new Map();
  for (const field of form.getFields()) {
    const acroField = field.acroField;
    const kids = acroField.Kids ? acroField.Kids() : undefined;
    const refs = kids ? kids.asArray().filter(o => o instanceof PDFRef) : [acroField.ref];
    for (const ref of refs) nameByRef.set(ref, field.getName());
  }
  return annots.asArray()
    .filter(r => r instanceof PDFRef && nameByRef.has(r))
    .map(r => nameByRef.get(r));
}

function tabsOf(pdfDoc, pageIndex) {
  const page = pdfDoc.getPages()[pageIndex];
  const v = page.node.get(PDFName.of('Tabs'));
  return v ? v.asString?.() ?? String(v) : null;
}

// ══════════════════════════════════════════════════════════════
// Manual mode — basic reorder
// ══════════════════════════════════════════════════════════════

console.log('\n📑 handleFillOrder — manual mode:');

await test('reorders a scrambled single-page form to the requested field order', async () => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  // Created in an order that does NOT match the desired final order —
  // manual mode must not accidentally "already pass" by coincidence.
  const b = form.createTextField('B'); b.addToPage(page, { x: 50, y: 700, width: 100, height: 20 });
  const a = form.createTextField('A'); a.addToPage(page, { x: 50, y: 650, width: 100, height: 20 });
  const c = form.createTextField('C'); c.addToPage(page, { x: 50, y: 600, width: 100, height: 20 });

  const buf = await toBuffer(doc);
  await handleFillOrder(buf, { mode: 'manual', fieldOrder: ['A', 'B', 'C'] });
  const done = lastDone();
  expect(done.type).toBe('done');

  const out = await PDFDocument.load(done.result);
  expect(annotsFieldOrder(out, 0)).toEqual(['A', 'B', 'C']);
  expect(tabsOf(out, 0)).toBe('/A'); // PDF-2.0 /Tabs /A — the only value that guarantees readers respect /Annots order
});

await test('fields not present in fieldOrder are left in their original relative position', async () => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  form.createTextField('X').addToPage(page, { x: 50, y: 700, width: 100, height: 20 });
  form.createTextField('A').addToPage(page, { x: 50, y: 650, width: 100, height: 20 });
  form.createTextField('B').addToPage(page, { x: 50, y: 600, width: 100, height: 20 });

  const buf = await toBuffer(doc);
  // 'X' deliberately omitted from fieldOrder — should stay in its original slot (index 0)
  await handleFillOrder(buf, { mode: 'manual', fieldOrder: ['B', 'A'] });
  const out = await PDFDocument.load(lastDone().result);
  expect(annotsFieldOrder(out, 0)).toEqual(['X', 'B', 'A']);
});

// ══════════════════════════════════════════════════════════════
// Radio groups — multiple widgets, one field name
// ══════════════════════════════════════════════════════════════

console.log('\n📑 handleFillOrder — radio groups:');

await test('radio-group siblings stay a contiguous block after reorder', async () => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  const rg = form.createRadioGroup('Choice');
  rg.addOptionToPage('Yes', page, { x: 50, y: 700, width: 20, height: 20 });
  rg.addOptionToPage('No',  page, { x: 50, y: 670, width: 20, height: 20 });
  form.createTextField('Name').addToPage(page, { x: 50, y: 600, width: 100, height: 20 });

  const buf = await toBuffer(doc);
  await handleFillOrder(buf, { mode: 'manual', fieldOrder: ['Name', 'Choice'] });
  const out = await PDFDocument.load(lastDone().result);
  // Two 'Choice' widgets both land after 'Name', contiguously, order among
  // themselves preserved (stable sort — same rank for both).
  expect(annotsFieldOrder(out, 0)).toEqual(['Name', 'Choice', 'Choice']);
});

// ══════════════════════════════════════════════════════════════
// Cross-page fields — per-page scoping
// ══════════════════════════════════════════════════════════════

console.log('\n📑 handleFillOrder — cross-page fields:');

await test('a field repeated across pages is reordered independently on each page', async () => {
  const doc = await PDFDocument.create();
  const p1  = doc.addPage([600, 800]);
  const p2  = doc.addPage([600, 800]);
  const form = doc.getForm();

  const repeated = form.createTextField('Repeated');
  repeated.addToPage(p1, { x: 50, y: 700, width: 100, height: 20 });
  repeated.addToPage(p2, { x: 50, y: 700, width: 100, height: 20 });
  form.createTextField('P1Only').addToPage(p1, { x: 50, y: 650, width: 100, height: 20 });
  form.createTextField('P2Only').addToPage(p2, { x: 50, y: 650, width: 100, height: 20 });

  const buf = await toBuffer(doc);
  await handleFillOrder(buf, { mode: 'manual', fieldOrder: ['P1Only', 'P2Only', 'Repeated'] });
  const out = await PDFDocument.load(lastDone().result);
  expect(annotsFieldOrder(out, 0)).toEqual(['P1Only', 'Repeated']);
  expect(annotsFieldOrder(out, 1)).toEqual(['P2Only', 'Repeated']);
});

// ══════════════════════════════════════════════════════════════
// Auto mode — visual position sort
// ══════════════════════════════════════════════════════════════

console.log('\n📑 handleFillOrder — auto (visual) mode:');

await test('sorts fields top-to-bottom by visual position, no fieldOrder needed', async () => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  // Created bottom-to-top so physical creation order is the OPPOSITE of
  // the expected visual (top-first) order.
  form.createTextField('Bottom').addToPage(page, { x: 50, y: 100, width: 100, height: 20 });
  form.createTextField('Middle').addToPage(page, { x: 50, y: 400, width: 100, height: 20 });
  form.createTextField('Top').addToPage(page,    { x: 50, y: 700, width: 100, height: 20 });

  const buf = await toBuffer(doc);
  await handleFillOrder(buf, { mode: 'auto' });
  const out = await PDFDocument.load(lastDone().result);
  expect(annotsFieldOrder(out, 0)).toEqual(['Top', 'Middle', 'Bottom']);
});

await test('left-to-right as tiebreaker for fields at the same height', async () => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  form.createTextField('Right').addToPage(page, { x: 400, y: 500, width: 100, height: 20 });
  form.createTextField('Left').addToPage(page,  { x: 50,  y: 500, width: 100, height: 20 });

  const buf = await toBuffer(doc);
  await handleFillOrder(buf, { mode: 'auto' });
  const out = await PDFDocument.load(lastDone().result);
  expect(annotsFieldOrder(out, 0)).toEqual(['Left', 'Right']);
});

await test('rotation-aware: a 90°-rotated page sorts by the DISPLAYED orientation, not raw page-space y/x', async () => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  page.setRotation(degrees(90));
  const form = doc.getForm();

  // Unrotated page-space: 'LowX' at x=50, 'HighX' at x=400, same y.
  // Derivation (see fillOrderWorker.js _rotatedSortKeys comment): for a
  // page rotated 90°, visual top corresponds to ascending x in unrotated
  // space — so 'LowX' should be visually first.
  form.createTextField('LowX').addToPage(page,  { x: 50,  y: 300, width: 100, height: 20 });
  form.createTextField('HighX').addToPage(page, { x: 400, y: 300, width: 100, height: 20 });

  const buf = await toBuffer(doc);
  await handleFillOrder(buf, { mode: 'auto' });
  const out = await PDFDocument.load(lastDone().result);
  expect(annotsFieldOrder(out, 0)).toEqual(['LowX', 'HighX']);
});

// ══════════════════════════════════════════════════════════════
// Re-reordering an already-reordered document (regression)
//
// Caught live on production, not by any of the tests above: every test
// so far builds a FRESH document each time. On a document that has
// already been through one handleFillOrder + pdf-lib save/reload cycle,
// the AcroForm field tree's Kids() refs and the physical refs actually
// sitting in the page's /Annots array are NOT guaranteed to be the same
// PDFRef instances — matching widgets via form.getFields()/Kids() (the
// original implementation) silently found zero matches on the second
// pass, so nothing got reordered and /Tabs never got set. Fixed by
// reading field identity directly off each page's own /Annots entries
// (their /T, walking /Parent) instead of cross-referencing from
// form.getFields() at all.
// ══════════════════════════════════════════════════════════════

console.log('\n📑 handleFillOrder — re-reordering an already-processed document:');

await test('a second reorder pass on an already-reordered document still works', async () => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();
  form.createTextField('Third').addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
  form.createTextField('First').addToPage(page,  { x: 50, y: 600, width: 200, height: 24 });
  form.createTextField('Second').addToPage(page, { x: 50, y: 500, width: 200, height: 24 });

  const buf1 = await toBuffer(doc);
  await handleFillOrder(buf1, { mode: 'manual', fieldOrder: ['First', 'Second', 'Third'] });
  const pass1Result = lastDone().result;

  // Second pass, on the OUTPUT of the first — a different requested order.
  await handleFillOrder(pass1Result, { mode: 'manual', fieldOrder: ['Second', 'Third', 'First'] });
  const pass2Result = lastDone().result;

  const out = await PDFDocument.load(pass2Result);
  expect(annotsFieldOrder(out, 0)).toEqual(['Second', 'Third', 'First']);
  expect(tabsOf(out, 0)).toBe('/A');
});

// ══════════════════════════════════════════════════════════════
// Round-trip — reordered-but-unfilled bytes stay a valid, fillable form
// ══════════════════════════════════════════════════════════════

console.log('\n📑 handleFillOrder — round-trip with value-setting:');

await test('field values can still be set correctly after reordering (mirrors js/worker.js handleFill)', async () => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const form = doc.getForm();

  form.createTextField('B').addToPage(page, { x: 50, y: 700, width: 100, height: 20 });
  form.createTextField('A').addToPage(page, { x: 50, y: 650, width: 100, height: 20 });

  const buf = await toBuffer(doc);
  await handleFillOrder(buf, { mode: 'manual', fieldOrder: ['A', 'B'] });
  const reordered = lastDone().result;

  // This is exactly what js/worker.js's handleFill() does next — the
  // regression this test guards against is the two-worker sequencing in
  // processor.js ever running fill-order AFTER values/flatten instead of
  // before, which would leave nothing left to reorder.
  const filled = await PDFDocument.load(reordered);
  const filledForm = filled.getForm();
  filledForm.getTextField('A').setText('hello A');
  filledForm.getTextField('B').setText('hello B');
  const finalBytes = await filled.save();

  const check = await PDFDocument.load(finalBytes);
  const checkForm = check.getForm();
  expect(checkForm.getTextField('A').getText()).toBe('hello A');
  expect(checkForm.getTextField('B').getText()).toBe('hello B');
  expect(annotsFieldOrder(check, 0)).toEqual(['A', 'B']); // order survived the fill pass too
});

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

console.log('\n' + '─'.repeat(50));
console.log(`fillOrderWorker integration tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
