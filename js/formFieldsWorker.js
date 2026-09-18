// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  formFieldsWorker.js — Dedicated Web Worker for "Add Form Fields"
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md). Same
//  pattern as watermarkTextWorker.js/pdfaWorker.js: a standalone classic
//  worker, driven by js/processor.js on the main thread.
//
//  Job: take a flat/scanned PDF (no existing AcroForm fields — the UI
//  layer already redirects PDFs that DO have fields to the existing Fill
//  tool instead) plus a list of user-placed text-field rectangles, and
//  write real pdf-lib AcroForm text fields into the output — not a visual
//  overlay, an actual interactive field a reader like Acrobat/Fill can
//  detect and fill.
//
//  Why a dedicated worker instead of worker.js's shared pdfPipeline: same
//  reasoning as watermarkTextWorker.js — this embeds a Unicode-capable
//  font (LiberationSans via fontkit, already vendored for pdf2pdfa's font
//  substitution feature) instead of pdf-lib's WinAnsi-only StandardFonts,
//  so a field's own /DA (default appearance) can render non-Latin field
//  labels/typed values correctly, at least for any script Liberation
//  covers (Latin/Cyrillic/Greek — not CJK, same documented gap as
//  watermarkTextWorker.js's own raster-fallback comment explains for CJK).
//
//  Coordinate contract: each placed field arrives as TOP-LEFT-origin
//  FRACTIONS of the page as it was rendered in the UI's canvas (xFrac,
//  yFrac, wFrac, hFrac — all 0..1, independent of actual render
//  resolution). pdf-lib's page coordinate space is bottom-left-origin in
//  PDF points, so yFrac needs a flip. Using fractions (not raw canvas
//  pixels) means this works correctly regardless of what zoom/DPR the
//  canvas happened to render at — the only requirement is that the UI
//  rendered the page with rotation forced to 0 (see formFieldsUI.js),
//  matching pdf-lib's own unrotated page.getWidth()/getHeight() space.
//  Known limitation: a PDF whose page actually carries non-zero /Rotate
//  metadata will place fields in the wrong spot — deferred, see
//  formFieldsUI.js's own header comment.
//
//  Message contract:
//    in  → { fileBuffer: ArrayBuffer, fields: [{page,name,type,xFrac,yFrac,wFrac,hFrac}], fontBytes: ArrayBuffer }
//        — type is 'text' (default, createTextField) or 'checkbox' (createCheckBox, no font needed)
//    out → { type: 'progress', value, label }
//        | { type: 'done', result: ArrayBuffer, pageCount, fieldCount }
//        | { type: 'error', message }
// ============================================================

importScripts('./vendor/pdf-lib.min.js');
importScripts('./vendor/fontkit.umd.js');

function progress(value, label) {
  self.postMessage({ type: 'progress', value, label });
}

// Same guard as resizeWorker.js/mangaSplitWorker.js/watermarkTextWorker.js's
// own _safeSize() — page.getSize() throws PDFArrayIsNotRectangleError for a
// /MediaBox that isn't exactly 4 elements, a realistic risk on a PDF that's
// been through several rounds of other tools. Falls back to A4 rather than
// failing the whole job for one malformed page.
function _safeSize(page) {
  try { return page.getSize(); } catch { return { width: 595.28, height: 841.89 }; }
}

// PDF field names use '.' as a hierarchy separator (fully-qualified
// "parent.child" names) — a user-typed label containing a literal '.'
// would silently create an unintended nested field instead of a flat one.
// Strip control chars, collapse whitespace, replace '.', and guarantee
// non-empty + de-duplicated (pdf-lib throws on a name collision).
function _sanitizeFieldName(raw, index, used) {
  // eslint-disable-next-line no-control-regex -- intentional: stripping control chars
  let name = String(raw ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\./g, '_').trim();
  if (!name) name = `Field ${index + 1}`;
  let candidate = name;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${name} (${n})`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

self.onmessage = async (e) => {
  try {
    const { fileBuffer, fields = [], fontBytes } = e.data;

    if (!fields.length) {
      self.postMessage({ type: 'error', message: 'No fields to add' });
      return;
    }

    progress(5, 'Loading PDF…');
    const { PDFDocument, rgb } = self.PDFLib;
    const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });

    progress(15, 'Preparing font…');
    pdf.registerFontkit(self.fontkit);
    const font = await pdf.embedFont(fontBytes);

    const form  = pdf.getForm();
    const pages = pdf.getPages();
    const used  = new Set();

    progress(25, 'Adding fields…');
    let added = 0;
    fields.forEach((f, i) => {
      const pageIndex = Math.min(Math.max(0, (f.page || 1) - 1), pages.length - 1);
      const page = pages[pageIndex];
      const { width, height } = _safeSize(page);

      const ptW = Math.max(4, (f.wFrac || 0) * width);
      const ptH = Math.max(4, (f.hFrac || 0) * height);
      let ptX = (f.xFrac || 0) * width;
      // Flip: canvas yFrac is measured top-down, PDF points are bottom-up,
      // and addToPage's y is the box's BOTTOM edge.
      let ptY = height - (f.yFrac || 0) * height - ptH;
      ptX = Math.min(Math.max(0, ptX), Math.max(0, width  - ptW));
      ptY = Math.min(Math.max(0, ptY), Math.max(0, height - ptH));

      const name = _sanitizeFieldName(f.name, i, used);

      try {
        if (f.type === 'checkbox') {
          // No font option — PDFCheckBox renders its tick via a built-in
          // appearance stream, not text, so there's nothing to embed for
          // this branch (verified directly against pdf-lib's own source
          // before relying on it: PDFCheckBox.addToPage doesn't accept a
          // font option at all). addToPage always creates the widget
          // unchecked — matches placing a blank, not-yet-ticked field on a
          // form, which is the only behavior this tool needs.
          const cb = form.createCheckBox(name);
          cb.addToPage(page, {
            x: ptX, y: ptY, width: ptW, height: ptH,
            borderWidth:     1,
            borderColor:     rgb(0.55, 0.55, 0.55),
            backgroundColor: rgb(1, 1, 1),
          });
        } else {
          const tf = form.createTextField(name);
          tf.addToPage(page, {
            x: ptX, y: ptY, width: ptW, height: ptH,
            font,
            borderWidth:     1,
            borderColor:     rgb(0.55, 0.55, 0.55),
            backgroundColor: rgb(1, 1, 1),
          });
        }
        added++;
      } catch {
        // A single unplaceable field (e.g. a pathological name pdf-lib still
        // rejects after sanitizing) shouldn't fail the whole document.
      }

      progress(25 + Math.round((i / fields.length) * 60), `Adding fields… ${i + 1}/${fields.length}`);
    });

    progress(92, 'Saving…');
    const bytes = await pdf.save({ useObjectStreams: true });
    self.postMessage(
      { type: 'done', result: bytes.buffer, pageCount: pages.length, fieldCount: added },
      [bytes.buffer]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
