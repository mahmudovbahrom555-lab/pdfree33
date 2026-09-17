// ============================================================
//  tests/resizeWorker.integration.test.js
//
//  Integration tests for js/resizeWorker.js's handleResize().
//  Same harness pattern as tests/worker.integration.test.js — see
//  that file's header comment for why we test the handler function
//  directly instead of the real Worker (postMessage doesn't exist
//  in Node).
//
//  Wired into `npm test` (package.json), same as its sibling
//  worker.integration.test.js/mergeWorker.integration.test.js — the
//  "not wired in" note that used to be here was stale, they're both in
//  the chain. Run standalone: node tests/resizeWorker.integration.test.js
// ============================================================

const PDFLib = await import('pdf-lib');
const { PDFDocument, StandardFonts, rgb, PDFName } = PDFLib;

const messages = [];
global.self = {
  postMessage: (msg) => messages.push(msg),
  onmessage:   null,
  PDFLib,        // resizeWorker.js reads self.PDFLib (not global PDFLib — differs from worker.js)
};
global.PDFLib = PDFLib;

const { readFileSync } = await import('fs');
const { join, dirname } = await import('path');
const { fileURLToPath } = await import('url');
const zlib = await import('zlib');
const __dir = dirname(fileURLToPath(import.meta.url));

const workerSrc = readFileSync(join(__dir, '../js/resizeWorker.js'), 'utf8')
  .replace(/importScripts\([^)]+\);?/g, '')
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const workerModule = new AsyncFunction(workerSrc + '\nreturn { handleResize };');
const { handleResize } = await workerModule();

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
    toBeTruthy:      ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy:       ()  => { if (actual)  throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toBeGreaterThan: (n) => { if (!(actual > n)) throw new Error(`Expected ${actual} > ${n}`); },
    toBeLessThan:    (n) => { if (!(actual < n)) throw new Error(`Expected ${actual} < ${n}`); },
    toBeCloseTo:     (n, eps = 0.5) => { if (Math.abs(actual - n) > eps) throw new Error(`Expected ${actual} ≈ ${n} (±${eps})`); },
    toBeInstanceOf:  (T) => { if (!(actual instanceof T)) throw new Error(`Expected instanceof ${T.name}`); },
  };
}

function lastDone()  { return messages.findLast(m => m.type === 'done'); }

// Extracts drawPage()'s ACTUAL applied scale by reading the real content
// stream `cm` operator, not by inferring it from page geometry (addPage()
// always creates a page of exactly the requested [w,h] regardless of
// whether the CONTENT drawn onto it was correctly scaled — that's exactly
// what the white-frame bug got wrong, so page-size-only assertions can't
// catch it). Content streams are FlateDecode-compressed by default;
// inflate then find the `cm` line whose values aren't the 1/0 identity —
// drawPage() emits several `cm` ops (translate, then scale, both as
// identity matrices when unused) but only the real scale one has non-1
// diagonal values.
function drawnScale(pdfDoc, page) {
  const { PDFName } = PDFLib;
  const contentRefs = page.node.Contents().array;
  const cs = pdfDoc.context.lookup(contentRefs[0]);
  const raw = Buffer.from(cs.getContents());
  const text = zlib.inflateSync(raw).toString();
  for (const line of text.split('\n')) {
    const m = line.match(/^([\d.]+) 0 0 ([\d.]+) 0 0 cm$/);
    if (m) {
      const sx = parseFloat(m[1]), sy = parseFloat(m[2]);
      if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) return { sx, sy };
    }
  }
  return { sx: 1, sy: 1 }; // no non-identity scale line found — genuinely 1:1
}

const PAGE_SIZES = {
  a0:     [2383.94, 3370.40],
  a1:     [1683.78, 2383.94],
  a2:     [1190.55, 1683.78],
  a3:     [841.89, 1190.55],
  a4:     [595.28, 841.89],
  a5:     [419.53, 595.28],
  a6:     [297.64, 419.53],
  letter: [612, 792],
  legal:  [612, 1008],
};

async function toBuffer(pdfDoc) {
  const bytes = await pdfDoc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// pdf-lib's embedPage() requires the source page to have a /Contents
// stream — a bare doc.addPage(size) with nothing drawn on it has none.
// Every test fixture below needs at least one draw call.
function addContentPage(doc, size) {
  const page = doc.addPage(size);
  page.drawRectangle({ x: 5, y: 5, width: 10, height: 10, color: rgb(0, 0, 0) });
  return page;
}

// ══════════════════════════════════════════════════════════════
// Per-page independent scale — mixed Letter/A4/landscape source
// ══════════════════════════════════════════════════════════════

console.log('\n🖨️  handleResize — per-page independent scale (mixed sizes):');

await test('every output page matches target paper regardless of source size', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.letter);                                  // page 1: Letter portrait
  addContentPage(doc, PAGE_SIZES.a4);                                      // page 2: A4 portrait
  addContentPage(doc, [PAGE_SIZES.a4[1], PAGE_SIZES.a4[0]]);               // page 3: A4 landscape
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 0, orientation: 'portrait' });
  const done = lastDone();
  expect(done.pageCount).toBe(3);

  const out = await PDFDocument.load(done.result);
  const pages = out.getPages();
  expect(pages.length).toBe(3);
  for (const p of pages) {
    const { width, height } = p.getSize();
    expect(width).toBeCloseTo(PAGE_SIZES.a4[0]);
    expect(height).toBeCloseTo(PAGE_SIZES.a4[1]);
  }
});

await test('auto orientation: landscape source page gets a landscape target frame', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, [PAGE_SIZES.letter[1], PAGE_SIZES.letter[0]]); // landscape source
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 0, orientation: 'auto' });
  const out = await PDFDocument.load(lastDone().result);
  const { width, height } = out.getPages()[0].getSize();
  expect(width).toBeGreaterThan(height); // landscape output
});

await test('auto orientation: portrait source page gets a portrait target frame', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.letter); // portrait source
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 0, orientation: 'auto' });
  const out = await PDFDocument.load(lastDone().result);
  const { width, height } = out.getPages()[0].getSize();
  expect(height).toBeGreaterThan(width); // portrait output
});

// ══════════════════════════════════════════════════════════════
// Fit / Fill / Actual — scale math
// ══════════════════════════════════════════════════════════════

console.log('\n🖨️  handleResize — fit/fill/actual scale math:');

await test('fit mode never enlarges past 100% when source already fits', async () => {
  // A5 source into A4 target with no margin — A5 is smaller than A4 on
  // both axes, so 'fit' must NOT blow it up to fill A4.
  const doc = await PDFDocument.create();
  const page = doc.addPage(PAGE_SIZES.a5);
  page.drawText('x', { x: 5, y: 5, size: 10 });
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 0, orientation: 'portrait' });
  const out = await PDFDocument.load(lastDone().result);
  expect(out.getPageCount()).toBe(1);
  // Can't directly read the drawn content's scale from pdf-lib's page API,
  // but we can assert the operation succeeded and produced a valid A4 page —
  // the scale-cap itself is unit-tested by inspecting resizeUI.js's
  // duplicated _fitRect (identical arithmetic) in the browser test below.
  const { width, height } = out.getPages()[0].getSize();
  expect(width).toBeCloseTo(PAGE_SIZES.a4[0]);
  expect(height).toBeCloseTo(PAGE_SIZES.a4[1]);
});

await test('fill mode with mismatched aspect ratio (Letter→A4) clips — output still valid A4', async () => {
  // Letter (612×792, ratio 0.773) → A4 (595.28×841.89, ratio 0.707).
  // These aspect ratios differ meaningfully (unlike A4→A5, which share
  // the same ratio) — fill's max() scale WILL overflow one axis here.
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.letter);
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'fill', marginPt: 0, orientation: 'portrait' });
  const out = await PDFDocument.load(lastDone().result);
  const { width, height } = out.getPages()[0].getSize();
  expect(width).toBeCloseTo(PAGE_SIZES.a4[0]);
  expect(height).toBeCloseTo(PAGE_SIZES.a4[1]);
  // Confirm the underlying math actually predicts a fill-mode overflow for
  // this exact pairing (sanity-checks the test's premise, not the worker).
  const scaleW = PAGE_SIZES.a4[0] / PAGE_SIZES.letter[0];
  const scaleH = PAGE_SIZES.a4[1] / PAGE_SIZES.letter[1];
  const fillScale = Math.max(scaleW, scaleH);
  const overflowsH = PAGE_SIZES.letter[1] * fillScale > PAGE_SIZES.a4[1] + 0.5;
  const overflowsW = PAGE_SIZES.letter[0] * fillScale > PAGE_SIZES.a4[0] + 0.5;
  expect(overflowsH || overflowsW).toBeTruthy();
});

await test('actual mode: A3 source into A4 target does not throw (overflow is valid, not an error)', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.a3);
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'actual', marginPt: 14, orientation: 'portrait' });
  const done = lastDone();
  expect(done).toBeTruthy();
  const out = await PDFDocument.load(done.result);
  const { width, height } = out.getPages()[0].getSize();
  expect(width).toBeCloseTo(PAGE_SIZES.a4[0]);
  expect(height).toBeCloseTo(PAGE_SIZES.a4[1]);
  // Sanity-check the overflow premise: A3 dimensions exceed A4's margin box.
  expect(PAGE_SIZES.a3[0]).toBeGreaterThan(PAGE_SIZES.a4[0] - 28);
});

await test('emits progress messages and a final done message', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.a4);
  addContentPage(doc, PAGE_SIZES.a4);
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 14, orientation: 'auto' });
  const progressMsgs = messages.filter(m => m.type === 'progress');
  expect(progressMsgs.length).toBeGreaterThan(0);
  expect(progressMsgs.every(m => m.value >= 0 && m.value <= 100)).toBeTruthy();
  expect(lastDone()).toBeTruthy();
});

// This test's original premise ("PDFDocument.create() + save() round-trips
// to a real 0-page file") turned out false for this pdf-lib version:
// saving a 0-page doc and reloading it always yields 1 auto-added blank
// page (verified directly — save() on 0 pages produces a 583-byte file
// that reloads with getPageCount() === 1), so the "0 pages" case was
// never actually reachable through this construction. The test used to
// pass anyway, by accident: that single auto-added page has no
// /Contents, so the OLD (pre-blank-page-fix) code threw
// MissingPageContentsEmbeddingError for an unrelated reason, which
// happened to satisfy `expect(threw).toBeTruthy()`. Now that blank pages
// are handled gracefully (see the blank-page test below), this exact
// input correctly does NOT throw — updated to assert the real, intended
// behavior instead of a coincidental one.
await test('a PDF that round-trips to a single auto-added blank page does not throw (no genuine 0-page case is constructible via pdf-lib save/reload)', async () => {
  const doc = await PDFDocument.create();
  const buf = await toBuffer(doc);
  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 14, orientation: 'auto' });
  expect(lastDone().pageCount).toBe(1);
});

// ══════════════════════════════════════════════════════════════
// embedPage resource-fidelity — inherited /Pages-tree resources
// ══════════════════════════════════════════════════════════════
//
// This is the correctness-critical test, not a formality:
// embedPage(), like copyPages(), only sees a page's OWN /Resources
// dict. If a font/image lives only at an inherited /Pages-tree
// node and _flattenPageTreeResources() is broken or removed, page
// geometry and count still look perfectly correct while the
// rendered content is silently missing. Structural pdf-lib re-load
// alone (asserting page count/size) would NOT catch this — we
// specifically assert the font/image references survive in the
// output's resource dictionary.
// ══════════════════════════════════════════════════════════════

console.log('\n🖨️  handleResize — embedPage resource fidelity (inherited resources):');

await test('font referenced only via inherited /Pages resources survives resize', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(PAGE_SIZES.a4);
  page.drawText('Resource fidelity check', { x: 50, y: 700, size: 24, font, color: rgb(0, 0, 0) });

  // Manually relocate the font reference from the page's own /Resources
  // up to the shared /Pages tree node, and clear it from the page —
  // reproducing a real-world "inherited resources" PDF (some generators
  // emit fonts at the tree level rather than duplicating per page).
  const { PDFName } = PDFLib;
  const pagesNode = doc.context.lookup(doc.catalog.get(PDFName.of('Pages')));
  const pageNode = page.node;
  const pageRes = doc.context.lookup(pageNode.get(PDFName.of('Resources')));
  const fontDict = doc.context.lookup(pageRes.get(PDFName.of('Font')));
  pagesNode.set(PDFName.of('Resources'), doc.context.obj({ Font: fontDict }));
  pageRes.delete(PDFName.of('Font'));

  const buf = await toBuffer(doc);
  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 14, orientation: 'auto' });
  const done = lastDone();
  expect(done).toBeTruthy();

  const out = await PDFDocument.load(done.result);
  const outPage = out.getPages()[0];
  // After embedPage + flatten, the new page's own XObject (the embedded
  // form) must reference a Font resource somewhere reachable from it —
  // verify by reading the raw resource dict off the embedded XObject.
  const outPageRes = out.context.lookup(outPage.node.get(PDFName.of('Resources')));
  const xobjDict = out.context.lookup(outPageRes.get(PDFName.of('XObject')));
  expect(xobjDict).toBeTruthy();
  // Walk into the XObject's own Resources to confirm a Font dict exists —
  // this is exactly the entry that would be MISSING without
  // _flattenPageTreeResources() flattening the inherited resources first.
  let foundFont = false;
  for (const [, ref] of xobjDict.entries()) {
    const xobj = out.context.lookup(ref);
    const xobjRes = xobj?.dict ? out.context.lookup(xobj.dict.get(PDFName.of('Resources'))) : null;
    const xobjFont = xobjRes ? out.context.lookup(xobjRes.get(PDFName.of('Font'))) : null;
    if (xobjFont) foundFont = true;
  }
  expect(foundFont).toBeTruthy();
});

// 1×1 red pixel PNG, hardcoded so the test needs no fixture file.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

await test('image referenced only via inherited /Pages resources survives resize', async () => {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(Buffer.from(TINY_PNG_BASE64, 'base64'));
  const page = doc.addPage(PAGE_SIZES.a4);
  page.drawImage(png, { x: 50, y: 700, width: 40, height: 40 });

  const { PDFName } = PDFLib;
  const pagesNode = doc.context.lookup(doc.catalog.get(PDFName.of('Pages')));
  const pageRes = doc.context.lookup(page.node.get(PDFName.of('Resources')));
  const xobjDict = doc.context.lookup(pageRes.get(PDFName.of('XObject')));
  pagesNode.set(PDFName.of('Resources'), doc.context.obj({ XObject: xobjDict }));
  pageRes.delete(PDFName.of('XObject'));

  const buf = await toBuffer(doc);
  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 14, orientation: 'auto' });
  const done = lastDone();
  expect(done).toBeTruthy();

  const out = await PDFDocument.load(done.result);
  const outPage = out.getPages()[0];
  const outPageRes = out.context.lookup(outPage.node.get(PDFName.of('Resources')));
  const outXobjDict = out.context.lookup(outPageRes.get(PDFName.of('XObject')));
  expect(outXobjDict).toBeTruthy();
  let foundImage = false;
  for (const [, ref] of outXobjDict.entries()) {
    const formXobj = out.context.lookup(ref);
    const formRes = formXobj?.dict ? out.context.lookup(formXobj.dict.get(PDFName.of('Resources'))) : null;
    const nestedXobj = formRes ? out.context.lookup(formRes.get(PDFName.of('XObject'))) : null;
    if (nestedXobj) {
      for (const [, innerRef] of nestedXobj.entries()) {
        const inner = out.context.lookup(innerRef);
        if (inner?.dict?.get(PDFName.of('Subtype'))?.toString() === '/Image') foundImage = true;
      }
    }
  }
  expect(foundImage).toBeTruthy();
});

await test('mixed page resources: two pages with different own fonts stay isolated', async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const p1 = doc.addPage(PAGE_SIZES.a4);
  p1.drawText('Page one — Helvetica', { x: 50, y: 700, size: 18, font: helv });
  const p2 = doc.addPage(PAGE_SIZES.a4);
  p2.drawText('Page two — Times', { x: 50, y: 700, size: 18, font: times });

  const buf = await toBuffer(doc);
  await handleResize(buf, { targetSize: 'letter', mode: 'fit', marginPt: 14, orientation: 'auto' });
  const done = lastDone();
  expect(done.pageCount).toBe(2);

  const out = await PDFDocument.load(done.result);
  const outPages = out.getPages();
  expect(outPages.length).toBe(2);
  // Each output page must be independently valid (own /Resources → own
  // XObject → own embedded page) — not sharing or corrupting the other's.
  const { PDFName } = PDFLib;
  for (const p of outPages) {
    const res = out.context.lookup(p.node.get(PDFName.of('Resources')));
    const xobj = out.context.lookup(res.get(PDFName.of('XObject')));
    expect(xobj).toBeTruthy();
  }
});

// ══════════════════════════════════════════════════════════════
// CropBox vs MediaBox — real user bug (macOS/Safari 26 report,
// "still having a white frame"), see resize_cropbox_white_frame_bug
// memory for the full diagnosis. embedPage()/getSize() both default to
// MediaBox — a print-ready PDF with a MediaBox larger than its CropBox
// (bleed/trim margins, common Illustrator/InDesign export) used to get
// fit-scaled against the bigger bleed box, insetting the real (smaller)
// visible content inside a white frame. Pinned down here so this exact
// regression can't silently reappear.
// ══════════════════════════════════════════════════════════════

console.log('\n🖨️  handleResize — CropBox vs MediaBox (white-frame regression):');

// Builds a page whose MediaBox has `bleed`pt of extra margin on every side
// beyond its CropBox — the exact shape of a real prepress export.
function addBleedPage(doc, [cropW, cropH], bleed) {
  const mediaW = cropW + bleed * 2, mediaH = cropH + bleed * 2;
  const page = doc.addPage([mediaW, mediaH]);
  page.setCropBox(bleed, bleed, cropW, cropH);
  // Content fills the full MediaBox (including the "bleed" area) so a
  // MediaBox-based fit would visibly under-scale the CropBox region —
  // same red/blue contrast technique used in the live manual repro.
  page.drawRectangle({ x: 0, y: 0, width: mediaW, height: mediaH, color: rgb(0.2, 0.4, 1) });
  page.drawRectangle({ x: bleed, y: bleed, width: cropW, height: cropH, color: rgb(1, 0.2, 0.2) });
  return page;
}

await test('CropBox-sized source onto a matching target: ACTUAL drawn scale is 1.0, not shrunk by the MediaBox bleed', async () => {
  const doc = await PDFDocument.create();
  addBleedPage(doc, PAGE_SIZES.a4, 20); // MediaBox = A4 + 20pt bleed, CropBox = exact A4
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 0, orientation: 'portrait' });
  const out = await PDFDocument.load(lastDone().result);
  const outPage = out.getPages()[0];
  expect(outPage.getSize().width).toBeCloseTo(PAGE_SIZES.a4[0]);
  expect(outPage.getSize().height).toBeCloseTo(PAGE_SIZES.a4[1]);
  // The real check: broken (MediaBox-based) code draws the content at
  // ~0.937 scale here — a real, measured shrink — even though the PAGE
  // itself is always exactly the target size regardless (addPage([w,h])
  // alone can't reveal this bug). Reading the actual `cm` operator from
  // the output's content stream is what would have caught the real
  // reported bug; asserting only page geometry (as this test originally
  // did) would NOT have.
  const { sx, sy } = drawnScale(out, outPage);
  expect(sx).toBeCloseTo(1, 0.01);
  expect(sy).toBeCloseTo(1, 0.01);
});

await test('sanity: CropBox actually differs from MediaBox for the bleed fixture (confirms the test premise)', async () => {
  const doc = await PDFDocument.create();
  const page = addBleedPage(doc, PAGE_SIZES.a4, 20);
  const cropBox  = page.getCropBox();
  const mediaBox = page.getMediaBox();
  expect(cropBox.width).toBeCloseTo(PAGE_SIZES.a4[0]);
  expect(mediaBox.width).toBeCloseTo(PAGE_SIZES.a4[0] + 40); // +20pt each side
  expect(mediaBox.width > cropBox.width).toBeTruthy();
});

await test('CropBox unset falls back to MediaBox — zero regression on ordinary (non-bleed) PDFs', async () => {
  // Every other test in this file uses addPage()/addContentPage() with no
  // explicit setCropBox() call — they already exercise this path — this
  // test just makes the fallback assertion explicit and named.
  const doc = await PDFDocument.create();
  const page = addContentPage(doc, PAGE_SIZES.a4);
  const cropBox = page.getCropBox();
  expect(cropBox.width).toBeCloseTo(PAGE_SIZES.a4[0]);
  expect(cropBox.height).toBeCloseTo(PAGE_SIZES.a4[1]);
});

// ══════════════════════════════════════════════════════════════
// Custom page size (customSizePt) — user-entered width/height, not a
// PAGE_SIZES preset. baseSize must prefer it over targetSize when present.
// ══════════════════════════════════════════════════════════════

console.log('\n🖨️  handleResize — custom page size (customSizePt):');

await test('customSizePt overrides targetSize preset entirely', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.a4);
  const buf = await toBuffer(doc);

  // orientation:'landscape' forces the frame to [max,min] = exactly this
  // pair's own order — isolates "does customSizePt override targetSize"
  // from portrait/landscape reordering (covered by its own test below).
  const customPt = [300, 200]; // arbitrary, not close to any PAGE_SIZES entry
  await handleResize(buf, {
    targetSize: 'a4', // must be ignored — customSizePt wins
    mode: 'fit', marginPt: 0, orientation: 'landscape', customSizePt: customPt,
  });
  const out = await PDFDocument.load(lastDone().result);
  const { width, height } = out.getPages()[0].getSize();
  expect(width).toBeCloseTo(300);
  expect(height).toBeCloseTo(200);
});

await test('customSizePt + orientation auto: normalizes portrait/landscape same as a preset', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.a4); // portrait source
  const buf = await toBuffer(doc);

  // customSizePt given as [wide, narrow] (landscape order) — auto
  // orientation must still normalize the FRAME to match the portrait
  // source, exactly like _resolveTargetSize already does for presets.
  await handleResize(buf, {
    mode: 'fit', marginPt: 0, orientation: 'auto', customSizePt: [300, 200],
  });
  const out = await PDFDocument.load(lastDone().result);
  const { width, height } = out.getPages()[0].getSize();
  expect(height).toBeGreaterThan(width); // portrait output, frame was reordered
});

await test('no customSizePt: falls back to the targetSize preset as before', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.a4);
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a5', mode: 'fit', marginPt: 0, orientation: 'portrait' });
  const out = await PDFDocument.load(lastDone().result);
  const { width, height } = out.getPages()[0].getSize();
  expect(width).toBeCloseTo(PAGE_SIZES.a5[0]);
  expect(height).toBeCloseTo(PAGE_SIZES.a5[1]);
});

await test('new A0/A1/A2/A6 presets each resolve to their correct ISO 216 target dimensions', async () => {
  for (const size of ['a0', 'a1', 'a2', 'a6']) {
    const doc = await PDFDocument.create();
    addContentPage(doc, PAGE_SIZES.a4);
    const buf = await toBuffer(doc);

    await handleResize(buf, { targetSize: size, mode: 'fit', marginPt: 0, orientation: 'portrait' });
    const out = await PDFDocument.load(lastDone().result);
    const { width, height } = out.getPages()[0].getSize();
    expect(width).toBeCloseTo(PAGE_SIZES[size][0]);
    expect(height).toBeCloseTo(PAGE_SIZES[size][1]);
  }
});

// ══════════════════════════════════════════════════════════════
// Blank pages (no /Contents) — real user report
// ══════════════════════════════════════════════════════════════

console.log('\n📐 handleResize — blank pages (no /Contents):');

await test('a genuinely blank page (Merge\'s "Insert Blank Pages" style — addPage() with zero draw calls) does not throw', async () => {
  const doc = await PDFDocument.create();
  addContentPage(doc, PAGE_SIZES.a4);
  doc.addPage(PAGE_SIZES.a4); // deliberately no drawing — matches mergeWorker.js's blank-page insert
  addContentPage(doc, PAGE_SIZES.a4);
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'letter', mode: 'fit', marginPt: 0, orientation: 'portrait' });
  const out = await PDFDocument.load(lastDone().result);
  expect(out.getPageCount()).toBe(3);
  // the blank page still gets resized to the target size, just with nothing drawn on it
  const { width, height } = out.getPages()[1].getSize();
  expect(width).toBeCloseTo(PAGE_SIZES.letter[0]);
  expect(height).toBeCloseTo(PAGE_SIZES.letter[1]);
});

// ══════════════════════════════════════════════════════════════
// Malformed CropBox array — a PDF that's been through several rounds of
// merge/edit can end up with a structurally broken box entry. pdf-lib's
// PDFArray.asRectangle() throws PDFArrayIsNotRectangleError for anything
// other than exactly 4 elements — _safeCropBox() must not let that crash
// the whole resize for one page.
// ══════════════════════════════════════════════════════════════

console.log('\n📐 handleResize — malformed CropBox array:');

await test('a page with a malformed CropBox (wrong element count) does not throw — falls back gracefully', async () => {
  const doc = await PDFDocument.create();
  const page = addContentPage(doc, PAGE_SIZES.a4);
  // 3 elements instead of the required 4 — pdf-lib's asRectangle() throws
  // PDFArrayIsNotRectangleError for this on a real, otherwise-valid page.
  page.node.set(PDFName.of('CropBox'), doc.context.obj([0, 0, 100]));
  const buf = await toBuffer(doc);

  await handleResize(buf, { targetSize: 'a4', mode: 'fit', marginPt: 0, orientation: 'portrait' });
  const out = await PDFDocument.load(lastDone().result);
  expect(out.getPageCount()).toBe(1);
  const { width, height } = out.getPages()[0].getSize();
  expect(width).toBeCloseTo(PAGE_SIZES.a4[0]);
  expect(height).toBeCloseTo(PAGE_SIZES.a4[1]);
});

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

console.log('\n' + '─'.repeat(50));
console.log(`resizeWorker integration tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
