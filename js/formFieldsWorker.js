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
//    in  → { fileBuffer: ArrayBuffer, fields: [{page,name,type,xFrac,yFrac,wFrac,hFrac,group?,options?}], fontBytes: ArrayBuffer }
//        — type is one of:
//            'text'     → createTextField  (needs the embedded font)
//            'checkbox' → createCheckBox   (no font — built-in tick appearance)
//            'radio'    → createRadioGroup + addOptionToPage (no font — built-in
//                         dot appearance). `group` is the SHARED group name and
//                         `name` is this widget's own option VALUE. Several
//                         fields carrying the same `group` become ONE AcroForm
//                         field with several widget annotations, only one of
//                         which can be on at a time — that's what makes them
//                         behave as a radio group rather than N checkboxes.
//            'dropdown' → createDropdown + addOptions (needs the font, its
//                         appearance stream draws the selected option's text).
//                         `options` is the array of choice strings.
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
// `used` is the de-dup scope, and WHICH scope matters: a radio group's name
// is de-duped once per group against every other field name (a group is one
// AcroForm field no matter how many option widgets it owns — de-duping it
// per option would shatter one group into N single-button groups), while a
// radio option's VALUE is de-duped against only its own group's other
// option values (two groups may both legitimately offer "Yes"/"No", but two
// widgets sharing one export value inside a group would toggle together).
function _sanitizeFieldName(raw, index, used, fallback) {
  // eslint-disable-next-line no-control-regex -- intentional: stripping control chars
  let name = String(raw ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\./g, '_').trim();
  if (!name) name = fallback || `Field ${index + 1}`;
  let candidate = name;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${name} (${n})`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

// Dropdown choice strings aren't field names (no '.' hierarchy concern) but
// still need control chars stripped, blanks dropped and duplicates removed —
// pdf-lib writes them straight into the field's /Opt array, and a duplicated
// entry would simply show up twice in every reader's own dropdown UI.
function _cleanOptions(raw) {
  const out  = [];
  const seen = new Set();
  for (const o of Array.isArray(raw) ? raw : []) {
    // eslint-disable-next-line no-control-regex -- intentional: stripping control chars
    const v = String(o ?? '').replace(/[\u0000-\u001f]/g, '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// A PDF *name* can only safely carry this — see _relabelRadioStates.
// pdf-lib escapes any non-regular character in a name as "#XX" using its own
// toHexString(), which always emits exactly TWO hex digits. A codepoint above
// 0xFF therefore produces a malformed three-digit escape: verified directly,
// PDFName.of('Имя') serialises to "/#418#43C#44F" and decodes back as the
// garbage "A8CCDF". Spaces are fine (escaped as #20, a legal and correctly
// round-tripping escape); the length cap keeps the decoded name well inside
// the PDF spec's own 127-byte recommendation for names.
function _isSafePdfName(v) {
  return /^[\u0020-\u00ff]+$/.test(v) && v.length <= 60;
}

// Makes a radio group's widgets identify their option BY NAME rather than by
// position — the actual reason this exists, found by running the real feature
// end to end rather than by reading pdf-lib:
//
// pdf-lib's addOptionToPage stores each option's text in the field's /Opt
// array and names the widget's "on" appearance state after its INDEX in that
// array ("0", "1", "2" — see PDFAcroButton.addWidgetWithOpt). That's legal
// AcroForm, and pdf-lib itself reads the text back correctly from /Opt. But
// pdf.js — which this site's own Fill tool, and plenty of other software,
// reads forms through — reports a radio kid's export value from its appearance
// STATE name and never consults /Opt. Result, confirmed in a real browser
// against the real Fill tool before this fix: a group saved as Red/Green/Blue
// came back offering choices literally labelled "0", "1" and "2".
//
// So rename each widget's on-state to the option's own text. /Opt is kept as
// well, so both kinds of reader now agree — and pdf-lib's own
// getOptions()/select() keep working unchanged (both arrays stay in widget
// order). Skipped entirely, leaving pdf-lib's index names in place, when any
// option in the group can't be represented as a PDF name; /Opt still carries
// the correct text for readers that use it, which is a strictly better
// fallback than corrupting the name.
function _relabelRadioStates(rg, values, PDFName, PDFDict) {
  if (!values.length || !values.every(_isSafePdfName)) return;
  const widgets = rg.acroField.getWidgets();
  if (widgets.length !== values.length) return;

  // lookupMaybe, NOT lookup, throughout: pdf-lib's typed `lookup(key, Type)`
  // THROWS UnexpectedObjectTypeError when the key is simply absent rather
  // than returning undefined. A real bug caught by running this end to end —
  // the optional rollover ('/R') appearance dict doesn't exist on these
  // widgets, so `lookup` threw on the very first widget and silently aborted
  // the rename for every widget after it (output had one relabelled option
  // and the rest still numbered).
  const OFF = PDFName.of('Off');
  widgets.forEach((w, i) => {
    const ap = w.dict.lookupMaybe(PDFName.of('AP'), PDFDict);
    if (!ap) return;
    const normal = ap.lookupMaybe(PDFName.of('N'), PDFDict);
    if (!normal) return;
    // Read the widget's CURRENT on-state key rather than assuming it equals
    // the loop index — same thing pdf-lib's own getOnValue() does, and it
    // keeps working if pdf-lib ever changes how it numbers states.
    const onKey = normal.keys().find(k => k !== OFF);
    if (!onKey) return;
    const target = PDFName.of(values[i]);
    if (onKey === target) return;
    // Every appearance sub-dictionary that can carry the state (normal, down,
    // rollover) has to be renamed together, or a reader would find the state
    // in one and not the other.
    for (const sub of ['N', 'D', 'R']) {
      const d = ap.lookupMaybe(PDFName.of(sub), PDFDict);
      if (!d) continue;
      const entry = d.get(onKey);
      if (entry === undefined) continue;
      d.set(target, entry);
      d.delete(onKey);
    }
    // /AS stays '/Off' — nothing is pre-selected on a freshly placed form, and
    // 'Off' is present in every one of those dictionaries either way, so
    // pdf-lib's needsAppearancesUpdate() still reports false and save() won't
    // regenerate (and thereby undo) what was just renamed.
  });
}

self.onmessage = async (e) => {
  try {
    const { fileBuffer, fields = [], fontBytes } = e.data;

    if (!fields.length) {
      self.postMessage({ type: 'error', message: 'No fields to add' });
      return;
    }

    progress(5, 'Loading PDF…');
    const { PDFDocument, rgb, PDFName, PDFDict } = self.PDFLib;
    const pdf = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });

    progress(15, 'Preparing font…');
    pdf.registerFontkit(self.fontkit);
    const font = await pdf.embedFont(fontBytes);

    const form  = pdf.getForm();
    const pages = pdf.getPages();
    const used  = new Set();
    // Raw (pre-sanitization) group name → { rg, optsUsed }. Built lazily as
    // radio options stream past in placement order, so N options sharing a
    // group name create the pdf-lib PDFRadioGroup exactly once and then just
    // add widgets to it. Keyed on the RAW name so two groups whose
    // sanitized names collide (and therefore got a "(2)" suffix) still stay
    // distinct groups rather than silently merging.
    const radioGroups = new Map();

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

      // Deliberately NOT computed for radio: a radio option's `name` is its
      // option VALUE, not a field name, so running it through the shared
      // `used` set here would reserve (and possibly "(2)"-suffix) a
      // document-level field name that no field actually claims.
      const name = f.type === 'radio' ? '' : _sanitizeFieldName(f.name, i, used);

      try {
        if (f.type === 'radio') {
          // A radio GROUP is one AcroForm field carrying several widget
          // annotations — NOT several fields — which is exactly what makes
          // only one of them selectable at a time. So the group is created
          // once (on its first option) and every later option with the same
          // group name just adds another widget to that same field.
          //
          // Verified directly against pdf-lib's own source before relying on
          // it (same discipline as the checkbox branch below):
          // PDFRadioGroup.addOptionToPage takes NO font option — it draws
          // its dot via defaultRadioGroupAppearanceProvider, not text — and
          // internally does createWidget + acroField.addWidgetWithOpt +
          // page.node.addAnnot, leaving the widget's appearance state 'Off'.
          // That 'Off' default is exactly right here: a freshly placed form
          // should start with nothing selected.
          const rawGroup = String(f.group ?? '').trim();
          let entry = radioGroups.get(rawGroup);
          if (!entry) {
            const groupName = _sanitizeFieldName(rawGroup, i, used, `Group ${radioGroups.size + 1}`);
            entry = { rg: form.createRadioGroup(groupName), optsUsed: new Set(), values: [] };
            radioGroups.set(rawGroup, entry);
          }
          const optValue = _sanitizeFieldName(f.name, i, entry.optsUsed, `Option ${entry.optsUsed.size + 1}`);
          entry.values.push(optValue);
          entry.rg.addOptionToPage(optValue, page, {
            x: ptX, y: ptY, width: ptW, height: ptH,
            borderWidth:     1,
            borderColor:     rgb(0.55, 0.55, 0.55),
            backgroundColor: rgb(1, 1, 1),
          });
        } else if (f.type === 'dropdown') {
          // Options must be attached BEFORE addToPage: addToPage builds the
          // widget's appearance stream from the field's current state, so a
          // dropdown whose /Opt array is still empty at that point would be
          // written with an appearance that doesn't match the options a
          // reader later finds on it. Left with nothing selected on purpose,
          // same reasoning as the unchecked checkbox below.
          const dd = form.createDropdown(name);
          const opts = _cleanOptions(f.options);
          if (opts.length) dd.addOptions(opts);
          dd.addToPage(page, {
            x: ptX, y: ptY, width: ptW, height: ptH,
            font,
            borderWidth:     1,
            borderColor:     rgb(0.55, 0.55, 0.55),
            backgroundColor: rgb(1, 1, 1),
          });
        } else if (f.type === 'checkbox') {
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

    // After every option of every group exists, and before save() (which
    // could otherwise regenerate appearances over the top of this) — see
    // _relabelRadioStates for the real bug this fixes.
    radioGroups.forEach(entry => {
      try { _relabelRadioStates(entry.rg, entry.values, PDFName, PDFDict); }
      catch { /* a group that can't be relabelled keeps pdf-lib's index names + /Opt */ }
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
