// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pdf2mdCore.js — pdf2md's extraction/render core, browser-independent
//
//  Moved out of processor.js so this logic can be reused outside the
//  browser tool (e.g. packages/pdf2md-core/, a standalone npm package/CLI)
//  without pulling in processor.js's own Worker orchestration / DOM
//  progress+cancel UI. Takes a plain pdf.js PDFDocumentProxy-shaped object
//  (NOT a browser File/Blob) — the caller (processor.js's _runPdf2Md in the
//  browser, or packages/pdf2md-core/src/index.js in Node) owns loading the
//  PDF and producing that object.
//
//  Browser-coupling is limited to 4 injectable seams, all optional:
//    onProgress(pct, label)   — UI progress callback; no-op by default.
//    isCancelled()            — mid-run cancellation check; never-cancel default.
//    canvasFactory(w, h)      — returns a canvas-shaped object (.getContext,
//                               .toBlob) already sized to w×h; used for real
//                               embedded-image extraction and the display-
//                               formula image-crop feature. Defaults to
//                               browserCanvasFactory (below) when `document`
//                               exists, otherwise null — omitting it degrades
//                               gracefully (images dropped, formulas fall
//                               back to the existing $...$ text flattening),
//                               it does not error.
//    ocrFormula(imageBlob)    — optional real math-OCR (Texo/FormulaNet, see
//                               js/formulaOcr.js), browser-only and opt-in.
//                               Returns Promise<{latex}> or throws/rejects.
//                               Called on a display-formula crop candidate
//                               (the same crop canvasFactory already produces
//                               for the image-embed fallback below); on
//                               success, real LaTeX replaces the image crop,
//                               always paired with a visible disclosure in
//                               the rendered Markdown — no per-token
//                               confidence signal is available from this
//                               model (verified directly: transformers.js's
//                               output_scores/return_dict_in_generate returns
//                               no .scores for it), so nothing is silently
//                               trusted. undefined by default — zero behavior
//                               change for every existing caller (Node/CLI/
//                               Docker packages, and the browser tool with
//                               its opt-in toggle off).
// ============================================================

import { detectTables, looksLikeProseNotData } from './pdf2wordTables.js';
import { detectColumnRegions, pageIsRtl } from './pdf2wordColumns.js';
import { BULLET_RE, NUMBERED_RE, BOLD_FONT_NAME_RE, MONEY_TOKEN_RE,
         _visualRTLToLogical, _splitCrossColumnLines, _isCjk,
         joinHyphenatedLineEnd } from './textLayoutUtils.js';

// Escapes literal CommonMark-special characters found in TEXT EXTRACTED
// FROM THE SOURCE PDF, before that text is emitted into the rendered
// Markdown — real bug found via scripts/pdf2md_benchmark.mjs's own first
// run: a real academic paper's footnote marker ("*indicates the
// corresponding author") contains a literal "*" that, left unescaped, can
// combine with an adjacent bold/italic run's own "**"/"*" delimiters and
// produce genuinely unbalanced/corrupted Markdown — exactly the kind of
// structural noise a downstream Markdown/RAG consumer is more sensitive to
// than plain whitespace noise. Deliberately NOT applied to formula/LaTeX
// runs (see wrapRun's own `$`-only escape below) — inside a `$...$` math
// span, `*`/`_` are LaTeX content, not CommonMark emphasis markers, and
// escaping them would corrupt the LaTeX itself.
function _escapeMdText(s) {
  return s.replace(/[\\`*_[\]]/g, '\\$&');
}

// Real HTMLCanvasElement satisfies the canvasFactory contract natively —
// this is the default used by processor.js's browser tool (and by this
// module's own default parameter when `document` exists, e.g. under a
// jsdom-style test stub). packages/pdf2md-core's Node/CLI entry point does
// NOT use this — plain Node has no `document` global at all.
export function browserCanvasFactory(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// ── Image extraction (position detection) ──────────────────────────────────
// Same CTM-stack pattern as js/pdf2wordBorders.js's detectTableGrids —
// including the Form XObject begin/end handling that a naive save/restore-
// only stack silently gets wrong for: pdf.js flattens a Form XObject's own
// operators into the page's operator list, bracketed by paintFormXObjectBegin/
// End, and an image drawn inside one (letterheads, stamped figures, some PDF
// generators wrap whole page content in a form) needs that form's own
// placement matrix composed on top of the current CTM or its position lands
// in the wrong space entirely — pdf2wordBorders.js already had to solve this
// for table-border lines; images need the identical fix, not a simpler one.
// Numeric opcodes hardcoded rather than importing pdfjsLib.OPS, matching that
// file's own convention (its comment: "these are NOT raw PDF spec op
// numbers", pdfjs 3.x-specific) — verified directly against pdfjs-dist
// 3.11.174, the exact version js/pdf2jpgUI.js's PDFJS_VERSION loads from CDN.
const _IMG_OPS_SAVE        = 10;
const _IMG_OPS_RESTORE     = 11;
const _IMG_OPS_TRANSFORM   = 12;
const _IMG_OPS_FORM_BEGIN  = 74;
const _IMG_OPS_FORM_END    = 75;
const _IMG_OPS_PAINT_IMAGE = 85; // paintImageXObject
// paintInlineImageXObject (86) deliberately NOT handled: its argsArray[0] is
// raw decoded pixel data directly, not an objs-cache id — a genuinely
// different extraction path. Every real PDF in this repo's own test corpus
// (tests/fixtures/columns/*.pdf) had zero inline images when checked
// directly against pdfjs-dist's real operator lists — scoped out because
// there's no real example to build and verify against yet, not guessed at.

function _composeImgCtm(m, [a, b, c, d, e, f]) {
  return {
    a: m.a * a + m.c * b,  b: m.b * a + m.d * b,
    c: m.a * c + m.c * d,  d: m.b * c + m.d * d,
    e: m.a * e + m.c * f + m.e,
    f: m.b * e + m.d * f + m.f,
  };
}

// Real bounding box of the image unit square [0,1]×[0,1] transformed by the
// CTM — NOT Math.abs(ctm.a)/Math.abs(ctm.d), which gives a wrong box under
// rotation, skew, or reflection (all four corners must be transformed and
// min/maxed, not just the diagonal scale factors read off the matrix).
function _imgBBoxFromCtm(m) {
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
    m.a * x + m.c * y + m.e,
    m.b * x + m.d * y + m.f,
  ]);
  const xs = corners.map(p => p[0]);
  const ys = corners.map(p => p[1]);
  return {
    x:     Math.min(...xs),
    yTop:  Math.max(...ys), // PDF Y increases upward — "top" is the max
    width:  Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

const _MIN_IMG_DIM = 40; // pt — filters bullet/icon/rule-line-sized noise
                          // (a real, common case: decorative small images
                          // scattered through a page shouldn't each become
                          // a Markdown image reference)

// Pure position-detection pass over an already-fetched operator list — no
// pixel data touched yet, deliberately split from the (heavier, async)
// pixel-extraction step below, same "detect cheap, extract only what's
// needed" shape as detectTableGrids. Returns page-space (PDF coordinates,
// Y-up — the SAME convention _p2mdExtractText's own `item.y` already uses,
// so these merge into the same `lines` array with zero coordinate
// conversion needed, unlike a top-down/screen-space design would require).
export function _detectPageImages(opList) {
  const { fnArray, argsArray } = opList;
  const ctmStack = [{ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }];
  const ctm = () => ctmStack[ctmStack.length - 1];
  const found = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    switch (fn) {
      case _IMG_OPS_SAVE:
        ctmStack.push({ ...ctm() });
        break;
      case _IMG_OPS_RESTORE:
        if (ctmStack.length > 1) ctmStack.pop();
        break;
      case _IMG_OPS_TRANSFORM:
        ctmStack[ctmStack.length - 1] = _composeImgCtm(ctm(), args);
        break;
      case _IMG_OPS_FORM_BEGIN: {
        ctmStack.push({ ...ctm() });
        const matrix = args[0];
        if (Array.isArray(matrix) && matrix.length === 6) {
          ctmStack[ctmStack.length - 1] = _composeImgCtm(ctm(), matrix);
        }
        break;
      }
      case _IMG_OPS_FORM_END:
        if (ctmStack.length > 1) ctmStack.pop();
        break;
      case _IMG_OPS_PAINT_IMAGE: {
        const bbox = _imgBBoxFromCtm(ctm());
        if (bbox.width >= _MIN_IMG_DIM && bbox.height >= _MIN_IMG_DIM) {
          found.push({ imgId: args[0], x: bbox.x, yTop: bbox.yTop, width: bbox.width, height: bbox.height });
        }
        break;
      }
    }
  }
  return found;
}

const _MAX_IMG_EDGE = 1800; // px cap on the long edge when re-encoding — a
                             // high-res embedded scan/figure (real example
                             // found: 5236×3541 px) would otherwise produce
                             // a multi-ten-MB PNG from a single page image

// Pulls decoded pixel data for one image out of pdf.js's internal object
// cache and re-encodes it as a PNG Blob via an offscreen canvas. Confirmed
// directly (not assumed) against real embedded images in this repo's own
// test corpus (tests/fixtures/columns/2608.11694.pdf, via a real pdfjs-dist
// 3.11.174 load): page.objs.get() returns {width, height, kind, data} where
// `data` is ALREADY fully decoded raw pixel bytes (dataLen matches
// width*height*3 for kind 2 / width*height*4 for kind 3 exactly) — pdf.js
// has done the JPEG/whatever decode itself by this point, so there is no
// original-encoded-bytes path to preserve through this API; every image is
// necessarily re-encoded here, not just optionally for a size win.
export async function _p2mdExtractImageBlob(page, imgId, canvasFactory) {
  if (!canvasFactory) return null;
  const imgData = await new Promise(resolve => {
    try { page.objs.get(imgId, resolve); } catch { resolve(null); }
  });
  if (!imgData || !imgData.width || !imgData.height) return null;
  const { width, height, kind, data, bitmap } = imgData;

  const src  = canvasFactory(width, height);
  const sctx = src.getContext('2d');

  // Real, browser-verified: pdf.js returns ONE of two shapes depending on
  // environment/decode path, not always the same one — {bitmap} (a real
  // ImageBitmap, no `data`/`kind` at all) is what a real Chromium browser
  // (this tool's actual runtime) gives back; {data, kind} (raw decoded
  // pixels, RGB_24BPP=2 / RGB_32BPP=3) is what pdf.js's Node/no-OffscreenCanvas
  // fallback path gives back. Handling only one of these silently drops
  // every image in whichever environment doesn't match — confirmed directly
  // by testing both, not assumed from either shape alone.
  if (bitmap) {
    sctx.drawImage(bitmap, 0, 0);
  } else if (data && (kind === 2 || kind === 3)) {
    const rgba = sctx.createImageData(width, height);
    if (kind === 2) {
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        rgba.data[j] = data[i]; rgba.data[j + 1] = data[i + 1]; rgba.data[j + 2] = data[i + 2]; rgba.data[j + 3] = 255;
      }
    } else {
      rgba.data.set(data);
    }
    sctx.putImageData(rgba, 0, 0);
  } else {
    // GRAYSCALE_1BPP (kind 1, bit-packed) and any unrecognized shape are
    // skipped rather than guessed at — graceful degradation: this image is
    // silently dropped, not inserted as a broken Markdown reference (see
    // the caller).
    return null;
  }

  const scale = Math.min(1, _MAX_IMG_EDGE / Math.max(width, height));
  if (scale === 1) return await new Promise(resolve => src.toBlob(resolve, 'image/png'));

  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out  = canvasFactory(outW, outH);
  out.getContext('2d').drawImage(src, 0, 0, outW, outH);
  return await new Promise(resolve => out.toBlob(resolve, 'image/png'));
}

// Pass 1: identical line-grouping technique to _p2wExtractText (YTOL=6,
// gap-based inline space insertion, RTL visual→logical reorder). Pass 2
// classifies each line as list / heading / body and buffers consecutive
// body lines into paragraphs using the same gap-based merge threshold
// (CJK/RTL-aware) _p2wExtractText uses for docx paragraph breaks.
export async function _p2mdExtractText(pdfDoc, {
  onProgress = () => {},
  isCancelled = () => false,
  canvasFactory = (typeof document !== 'undefined' ? browserCanvasFactory : null),
  ocrFormula = null,
} = {}) {
  const YTOL = 6;
  const pageData = [];
  const allSizes = [];

  // Formula detection — "honest flattening" only (see pdf2md analysis memory):
  // real LaTeX reconstruction needs OCR/ML (out of scope, no in-browser math
  // model exists in this codebase), so the bar here is "mark it as math and
  // preserve the raw extracted glyphs inside $...$" instead of letting a
  // formula silently decay into ungrammatical plain-text prose. Two signals,
  // either sufficient on its own:
  // 1. Font name — LaTeX/AMS math fonts (Computer Modern Math Italic/Symbol/
  //    Extension, Latin Modern equivalents, AMS msam/msbm, common OpenType
  //    math fonts) resolved the same way _isFontBold resolves bold, via
  //    page.commonObjs (content.styles' fontFamily alone reports a generic
  //    CSS fallback for embedded math fonts just like it does for bold, see
  //    _isFontBold's own comment above).
  // 2. Glyph content — a conservative, curated set of math operator symbols
  //    that essentially never appear in ordinary prose in any of this
  //    product's 14 supported languages. Deliberately excludes arrows (→/←)
  //    and superscript digits: both appear in genuine non-math prose
  //    elsewhere in this product's own content ("File → Export", "5 km²"),
  //    so including them would be a real, not hypothetical, false-positive
  //    source — "prefer false negatives" per this file's established rule.
  // No trailing \b: real font names append a subset digit suffix with no
  // word-boundary before it (e.g. "CMMI10", "CMBSY10-Bold") since letters and
  // digits are both \w — a trailing \b would silently never match those.
  const MATH_FONT_RE  = /\b(cmmi|cmsy|cmex|cmbsy|msam|msbm|lmmi|lmsy|lmex|eufm|eusm|rsfs|stix.?math|xits.?math|asana.?math|cambria.?math|latinmodernmath|mt-?extra)/i;
  const MATH_GLYPH_RE = /[∑∫∬∭∏√∛∜±×÷≤≥≠≈≡∞∂∇∈∉⊂⊆⊃⊇∪∩∀∃¬∧∨⇒⇔]/;
  // Display-formula crop thresholds — see the per-page loop below (right
  // after _splitCrossColumnLines) for the full rationale comment.
  const FORMULA_MIN_FRACTION = 0.7;       // share of the line's characters that must be formula-tagged
  const FORMULA_MAX_WIDTH_FRACTION = 0.6; // wider than this = a formula-heavy PROSE line, not a standalone equation — keep as text
  const FORMULA_RENDER_SCALE = 2.5;       // crop regions are small — bias toward legibility over file size

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    if (isCancelled()) break;
    onProgress(10 + Math.round((p / pdfDoc.numPages) * 70),
                `Reading page ${p}/${pdfDoc.numPages}…`);

    const page    = await pdfDoc.getPage(p);
    const pageVp1 = page.getViewport({ scale: 1 });
    const pageW   = pageVp1.width;
    const pageH   = pageVp1.height; // needed for the footnote Y-band check below
    // getOperatorList() runs alongside getTextContent() purely to force pdf.js
    // to resolve font objects into page.commonObjs — same fix pdf2word's
    // _p2wBuildPageData applies, and for the same confirmed reason: without
    // it, every font's style reports a generic CSS fallback family
    // ("sans-serif") instead of the real embedded name, so the fontFamily-
    // string-only check below silently fails to detect bold on any PDF whose
    // fonts pdf.js can't map to a known family (confirmed there on a real
    // contract where headings were same-size-but-bold and indistinguishable
    // from body text by fontFamily alone).
    const [content, opList] = await Promise.all([
      page.getTextContent({ normalizeWhitespace: false }),
      page.getOperatorList().catch(() => null),
    ]);
    // Greek-letter formula signal, gated per page — real STEM formulas use
    // Greek variables constantly (θ, λ, α, β, Ω, Σ...) and MATH_GLYPH_RE's
    // curated symbol set doesn't cover them, but a bare Greek-letter check
    // would misfire on every line of an actual Greek-LANGUAGE PDF (a real,
    // not hypothetical, upload — this product has no Greek UI locale, but
    // still accepts any PDF a user hands it). Distinguish the two by density:
    // Greek PROSE is overwhelmingly Greek letters; Greek used as isolated
    // math variables amid otherwise-Latin content is a tiny fraction of the
    // page's characters. Computed once per page (not per document) so a
    // document mixing scripts across pages still gets a locally-correct call.
    // 'g'-flagged so .match() below counts ALL occurrences, not just the
    // first — every use of this regex goes through .match(), never .test(),
    // so there's no risk of the classic stateful-global-regex .lastIndex bug
    // (that bug is specific to reusing a global regex across .test()/.exec()
    // calls; .match() doesn't carry state between calls).
    const GREEK_COUNT_RE   = /[Ͱ-Ͽἀ-῿]/g;
    const GREEK_DOC_RATIO  = 0.15;
    const GREEK_ITEM_RATIO = 0.2; // Greek chars must be a real fraction of a SINGLE item's own text — see isFormula's comment below
    let _greekChars = 0, _totalChars = 0;
    for (const item of content.items) {
      if (!('str' in item)) continue;
      _totalChars += item.str.length;
      _greekChars += (item.str.match(GREEK_COUNT_RE) || []).length;
    }
    const pageIsGreekProse = _totalChars > 0 && (_greekChars / _totalChars) > GREEK_DOC_RATIO;

    const _boldFontCache = new Map(); // fontName -> boolean, one commonObjs lookup per unique font per page
    const _isFontBold = fontName => {
      if (_boldFontCache.has(fontName)) return _boldFontCache.get(fontName);
      let bold = false;
      try {
        bold = BOLD_FONT_NAME_RE.test(page.commonObjs.get(fontName)?.name || '');
      } catch { /* font object failed to resolve — fall through to false */ }
      _boldFontCache.set(fontName, bold);
      return bold;
    };
    const _mathFontCache = new Map(); // fontName -> boolean, same one-lookup-per-font pattern as _isFontBold
    const _isFontMath = (fontName, fam) => {
      if (_mathFontCache.has(fontName)) return _mathFontCache.get(fontName);
      let math = false;
      try {
        math = MATH_FONT_RE.test(page.commonObjs.get(fontName)?.name || '') || MATH_FONT_RE.test(fam);
      } catch { /* font object failed to resolve — fall through to false */ }
      _mathFontCache.set(fontName, math);
      return math;
    };
    const items = content.items
      .filter(item => 'str' in item && item.str.split(' ').join('').trim())
      .map(item => {
        const fontSize = (item.height > 0 ? item.height : Math.abs(item.transform[3])) || 10;
        const style    = content.styles[item.fontName] || {};
        const fam      = (style.fontFamily || '').toLowerCase();
        // NFC-normalize before anything else touches this string — a PDF
        // commonly encodes diacritic-heavy scripts as decomposed (NFD)
        // combining-character sequences; pdf2word's own DOCX path
        // (eriAnatomy.js's ownParagraphText) already had to fix the exact
        // same bug class for real Vietnamese text, but pdf2md's own
        // extraction never got the equivalent fix until now. Real,
        // independently-documented failure mode for this exact
        // dependency (pdf.js): mozilla/pdf.js#11016, #11779, #18201.
        const nfcStr = item.str.normalize('NFC');
        const str = ((item.dir === 'rtl') ? _visualRTLToLogical(nfcStr) : nfcStr)
          .split(' ').join('');
        // Formula wins over bold/italic when both would otherwise apply —
        // math-italic glyphs (variables) are a font-design artifact, not a
        // real emphasis signal, and letting both fire would nest ** / * markers
        // around a $...$ span, which most Markdown parsers render incorrectly.
        //
        // Greek-letter check is ratio-gated PER ITEM, not a bare .test() —
        // confirmed on a real paper: a whole justified sentence can come
        // back from pdf.js as ONE text item ("...standard flat ΛCDM"), and a
        // single embedded Greek acronym letter would otherwise flag the
        // ENTIRE item (all ~50 characters) as formula, silently swallowing a
        // real, readable prose sentence into an unrelated image crop. Real
        // formula fragments are overwhelmingly Greek within their OWN item
        // (a lone "θ", a "jθ" superscript run); real prose borrows at most
        // one Greek letter in an acronym amid dozens of Latin characters.
        const greekInItem = (str.match(GREEK_COUNT_RE) || []).length;
        const isFormula = _isFontMath(item.fontName, fam) || MATH_GLYPH_RE.test(str) ||
          (!pageIsGreekProse && str.length > 0 && (greekInItem / str.length) >= GREEK_ITEM_RATIO);
        return {
          str, x: item.transform[4], y: item.transform[5], width: item.width || 0,
          fontSize,
          bold:    !isFormula && (_isFontBold(item.fontName) || BOLD_FONT_NAME_RE.test(fam)),
          italic:  !isFormula && /italic|oblique/.test(fam),
          formula: isFormula,
        };
      });

    const lines = [];
    for (const item of [...items].sort((a, b) => b.y - a.y)) {
      let merged = false;
      for (const ln of lines) {
        if (Math.abs(ln.y - item.y) <= YTOL) { ln.items.push(item); merged = true; break; }
      }
      if (!merged) lines.push({ y: item.y, items: [item] });
    }
    lines.forEach(ln => {
      const txt    = ln.items.map(i => i.str).join('');
      const rtlCnt = (txt.match(/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
      ln.rtl = rtlCnt > 0;
      if (rtlCnt === 0) ln.items.sort((a, b) => a.x - b.x);
    });

    // Column-aware re-splitting — same fix pdf2word's _p2wBuildPageData
    // applies and for the same reason (see _splitCrossColumnLines's own
    // comment): plain Y-proximity grouping above frequently merges BOTH
    // columns' items into one line object on a genuine 2-column page. A
    // no-op when detectColumnRegions() finds no confident multi-column
    // layout (the common case).
    _splitCrossColumnLines(lines, pageW);

    // Display-formula crop — a standalone equation line (e.g. a centered
    // "E = mc^2") gets rendered+cropped as an image instead of flattened to
    // $...$: honest-flattening (above) reliably preserves reading order for
    // INLINE math (a few symbols inside a sentence), but a standalone
    // equation built from 2D glyph layout (stacked fractions, integral
    // bounds, matrices) often can't be linearized correctly by left-to-right
    // concatenation — and a confidently-wrong flattening is worse for a
    // downstream AI reader than an honestly-labeled image: silently-wrong
    // text gets trusted as ground truth, an image doesn't assert false
    // content. Scoped to a SINGLE Y-cluster (this file's existing YTOL=6
    // line-grouping, a few lines up) — true multi-baseline formulas
    // (matrices, stacked fractions spanning 2+ line clusters) aren't merged
    // into one crop here and fall through to the existing $...$ flattening
    // unchanged; there's no real multi-line-formula corpus yet to validate a
    // merge heuristic against ("prefer false negatives", this file's own
    // established rule — see MATH_GLYPH_RE's comment above).
    let _pageCanvas = null; // rendered lazily, at most once per page, only if a candidate line exists
    const _renderPageCanvas = async () => {
      if (_pageCanvas) return _pageCanvas;
      const vp = page.getViewport({ scale: FORMULA_RENDER_SCALE });
      const canvas = canvasFactory(vp.width, vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      _pageCanvas = { canvas, viewport: vp };
      return _pageCanvas;
    };
    for (const ln of (canvasFactory ? lines : [])) {
      if (ln.isImage || ln.rtl) continue; // RTL formula layout is out of scope — no real test document to verify against
      const totalLen = ln.items.reduce((s, i) => s + i.str.length, 0);
      if (totalLen < 3) continue;
      const formulaLen = ln.items.reduce((s, i) => s + (i.formula ? i.str.length : 0), 0);
      if (formulaLen / totalLen < FORMULA_MIN_FRACTION) continue;
      const minX = Math.min(...ln.items.map(i => i.x));
      const maxX = Math.max(...ln.items.map(i => i.x + i.width));
      if ((maxX - minX) > pageW * FORMULA_MAX_WIDTH_FRACTION) continue;
      const maxSize = Math.max(...ln.items.map(i => i.fontSize));
      // Best-effort raw text as alt text — a pure-text (non-vision) AI/RAG
      // consumer can't open the PNG, but markdown alt text IS plain text in
      // the .md source itself, so it still gets SOME signal instead of an
      // opaque filename. Same left-to-right glyph concatenation as the
      // $...$ flattening path — labeled "approx." rather than presented as
      // a clean transcription: this line became an image specifically
      // because it may have real vertical structure (super/subscripts, a
      // stacked fraction's numerator/denominator sharing this Y-cluster)
      // that left-to-right concatenation cannot represent, so the flattened
      // string can read as plausible but wrong (e.g. a lost superscript
      // silently turning "dx^μ dx^ν" into "dx dx") rather than obviously
      // incomplete — worth flagging explicitly rather than letting a reader
      // (human or AI) mistake it for a faithful transcription.
      const rawAlt = ln.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim()
        .replace(/[[\]]/g, '').slice(0, 250);
      const altText = rawAlt ? `formula (approx., may not preserve exact layout): ${rawAlt}` : 'formula';
      try {
        const { canvas, viewport } = await _renderPageCanvas();
        const padTop = maxSize * 0.9, padBot = maxSize * 0.6, padX = maxSize * 0.3;
        const corners = [
          [minX - padX, ln.y + padTop], [maxX + padX, ln.y + padTop],
          [minX - padX, ln.y - padBot], [maxX + padX, ln.y - padBot],
        ].map(([x, y]) => viewport.convertToViewportPoint(x, y));
        const px = corners.map(c => c[0]), py = corners.map(c => c[1]);
        const cx = Math.max(0, Math.floor(Math.min(...px))), cy = Math.max(0, Math.floor(Math.min(...py)));
        const cw = Math.min(canvas.width, Math.ceil(Math.max(...px))) - cx;
        const ch = Math.min(canvas.height, Math.ceil(Math.max(...py))) - cy;
        if (cw < 4 || ch < 4) continue;
        const crop = canvasFactory(cw, ch);
        crop.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
        const blob = await new Promise(resolve => crop.toBlob(resolve, 'image/png'));
        if (!blob) continue;
        // Real math-OCR (opt-in, browser-only — see ocrFormula's own comment
        // above). No confidence signal exists for this model (verified
        // directly this session), so success here is never silently trusted:
        // _emitLines below always pairs ln.ocrLatex with a visible disclosure
        // in the rendered Markdown. Any failure (network, model load,
        // inference, or an empty result) falls through unchanged to the
        // existing image-crop embed — the same safe default as today.
        if (ocrFormula) {
          try {
            const { latex } = await ocrFormula(blob);
            if (latex && latex.trim()) {
              ln.ocrFormula = true;
              ln.ocrLatex = latex.trim();
              continue;
            }
          } catch { /* OCR failed — fall through to the image-crop embed below */ }
        }
        ln.isImage = true; ln.imgKind = 'formula'; ln.imgWidth = cw; ln.imgHeight = ch; ln.imgBlob = blob; ln.imgPage = p;
        ln.imgAlt = altText;
      } catch { /* rendering/crop failed — line falls through to normal $...$ flattening below */ }
    }

    // Images — inserted as synthetic single-item "lines" (isImage:true) so
    // they ride the SAME Y-sort/column-dispatch machinery real text lines
    // already use below, rather than a separate geometry/interleaving system.
    // Extracted here, before page.cleanup() a few lines down: pdf.js's
    // page.objs cache (needed by _p2mdExtractImageBlob) is released by that
    // call, so extraction can't be deferred to a later pass over `blocks`
    // once every page has already been visited and cleaned up. Sequential
    // (not Promise.all'd) deliberately — caps peak memory to one decoded
    // image at a time instead of every image on the page at once.
    if (opList) {
      for (const d of _detectPageImages(opList)) {
        const blob = await _p2mdExtractImageBlob(page, d.imgId, canvasFactory).catch(() => null);
        if (!blob) continue; // graceful degradation — dropped silently, not
                              // inserted as a broken Markdown image reference
        lines.push({
          y: d.yTop, rtl: false,
          items: [{ str: '', x: d.x, y: d.yTop, width: d.width, fontSize: 10, bold: false, italic: false, formula: false }],
          isImage: true, imgWidth: Math.round(d.width), imgHeight: Math.round(d.height), imgBlob: blob, imgPage: p,
        });
      }
      lines.sort((a, b) => b.y - a.y);
    }

    allSizes.push(...items.map(i => i.fontSize).filter(s => s > 0));
    pageData.push({ lines, pageW, pageH });
    page.cleanup?.();
  }

  const sorted = [...allSizes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 10;

  // Gap-based inline space insertion — same technique _flushPara() uses when
  // building docx TextRuns: items on a line don't always carry their own
  // spaces, so an X-gap larger than ~20% of the font size implies a word break.
  const _lineText = ln => {
    let text = '';
    for (let idx = 0; idx < ln.items.length; idx++) {
      const item = ln.items[idx];
      const prev = ln.items[idx - 1];
      let s = item.str;
      if (prev && !ln.rtl && !prev.str.endsWith(' ') && !s.startsWith(' ')) {
        const prevW = (prev.width > 0) ? prev.width : prev.fontSize * prev.str.length * 0.5;
        const gap   = item.x - (prev.x + prevW);
        if (gap > item.fontSize * 0.2) s = ' ' + s;
      }
      text += s;
    }
    return text;
  };

  // Same walk as _lineText, but keeps per-item bold/italic instead of
  // collapsing straight to a flat string — consecutive items sharing the
  // same (bold, italic) pair merge into one run. This is what lets a
  // paragraph with one bold word in the middle of plain text come out as
  // "plain **bold** plain" instead of pdf2md's old all-or-nothing
  // `allItems.every(i => i.bold)` flag (matches pdf2word's per-run TextRun
  // approach, which never had that limitation). Runs never span a line
  // boundary — kept deliberately simple (a bold phrase wrapping across two
  // source lines renders as two adjacent **runs** instead of one merged
  // run) to avoid having to re-collapse whitespace that's been split across
  // a run boundary; still 100% valid Markdown, just marginally less compact.
  const _lineRuns = ln => {
    const runs = [];
    for (let idx = 0; idx < ln.items.length; idx++) {
      const item = ln.items[idx];
      const prev = ln.items[idx - 1];
      let s = item.str;
      if (prev && !ln.rtl && !prev.str.endsWith(' ') && !s.startsWith(' ')) {
        const prevW = (prev.width > 0) ? prev.width : prev.fontSize * prev.str.length * 0.5;
        const gap   = item.x - (prev.x + prevW);
        if (gap > item.fontSize * 0.2) s = ' ' + s;
      }
      const last = runs[runs.length - 1];
      if (last && last.bold === item.bold && last.italic === item.italic && last.formula === item.formula) last.text += s;
      else runs.push({ text: s, bold: item.bold, italic: item.italic, formula: item.formula });
    }
    return runs;
  };

  // Repeated header/footer/page-number suppression — same technique as
  // _p2wExtractText: short text on ≥⅔ of pages (min 3) is a watermark.
  const _normWatermark = t =>
    t.replace(/^(CamScanner)+$/i, 'CamScanner')
     .replace(/^[Cc][Ss]\]?$/, 'CamScanner')
     .replace(/^-$/, '');
  const _repeatTextSet = new Set();
  {
    const freq = new Map();
    for (const { lines } of pageData) {
      const seenOnPage = new Set();
      for (const ln of lines) {
        const t = _normWatermark(_lineText(ln).trim());
        if (t.length > 0 && t.length <= 60 && !seenOnPage.has(t)) {
          seenOnPage.add(t);
          freq.set(t, (freq.get(t) || 0) + 1);
        }
      }
    }
    const minPages = Math.max(3, Math.ceil(pageData.length * 2 / 3));
    for (const [t, cnt] of freq) {
      if (cnt >= minPages && !/^\d+$/.test(t)) _repeatTextSet.add(t);
    }
  }

  const blocks      = [];
  const _paraBuffer = [];
  let _imgSeq       = 0; // running counter across the whole doc -> unique filenames

  const _flushPara = () => {
    if (!_paraBuffer.length) return;
    const linesCopy = _paraBuffer.slice();
    _paraBuffer.length = 0;

    if (linesCopy.length === 1) {
      const t = _normWatermark(_lineText(linesCopy[0]).trim());
      if (t === '' || _repeatTextSet.has(t)) return;
    }

    const text = linesCopy.map(_lineText).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;

    // One flat run array for the whole paragraph — lines joined by a plain
    // (never-bold/italic) space run, matching _lineText's own `.join(' ')`
    // — UNLESS the previous line ends mid-word with a soft PDF line-wrap
    // hyphen (joinHyphenatedLineEnd, js/textLayoutUtils.js), in which case
    // the two runs merge directly with no join-space at all. Guarded on
    // RTL (no real test coverage for hyphenation in RTL scripts — same
    // "leave RTL alone" policy this file already follows elsewhere),
    // formula runs (never rewrite math), and matching bold/italic (a real
    // hyphen break essentially never switches formatting mid-word; if it
    // did, merging would silently pick one side's formatting for both).
    const runs = [];
    for (let i = 0; i < linesCopy.length; i++) {
      const curRuns = _lineRuns(linesCopy[i]);
      if (i > 0) {
        const prevRun = runs[runs.length - 1];
        const nextRun = curRuns[0];
        const canTryHyphen = prevRun && nextRun &&
          !linesCopy[i - 1].rtl && !linesCopy[i].rtl &&
          !prevRun.formula && !nextRun.formula &&
          prevRun.bold === nextRun.bold && prevRun.italic === nextRun.italic;
        const hyphenResult = canTryHyphen ? joinHyphenatedLineEnd(prevRun.text, nextRun.text) : null;
        if (hyphenResult) {
          prevRun.text = hyphenResult.text;
          curRuns.shift(); // merged into prevRun — don't push its own copy too
        } else {
          runs.push({ text: ' ', bold: false, italic: false, formula: false });
        }
      }
      runs.push(...curRuns);
    }
    // Trim leading/trailing whitespace off the paragraph as a whole (mirrors
    // the flat `text`'s own `.trim()`) without disturbing interior runs.
    while (runs.length && !runs[0].text.trim()) runs.shift();
    while (runs.length && !runs[runs.length - 1].text.trim()) runs.pop();
    if (runs.length) {
      runs[0].text = runs[0].text.replace(/^\s+/, '');
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
    }
    if (!runs.length) return;

    blocks.push({ type: 'para', runs });
  };

  // Same-size-but-bold section headings — verbatim port of pdf2word's
  // _isBoldHeadingLine (see its own comment: found on a real 19-page
  // contract where every heading used the EXACT same point size as body
  // text, only distinguished by bold; the font-size-ratio check below never
  // fires there). Checking the WHOLE line (not just some items) matters:
  // inline emphasis mid-sentence is bold only within a longer non-bold
  // line, not a heading — a partial-line bold run must not qualify.
  const _isBoldHeadingLine = (items) => {
    if (!items.every(i => i.bold)) return false;
    const text = items.map(i => i.str).join('');
    if (MONEY_TOKEN_RE.test(text)) return false; // tabular/financial data, not a real heading
    const len = text.replace(/\s+/g, '').length;
    return len > 3 && len <= 100;
  };

  // Processes one column's worth of lines (or a whole page's, when no
  // column split applies) — table detection + per-line classification.
  // Extracted so the outer loop below can call it once per detected column
  // region, in reading order, instead of once per page: without that,
  // lines from two columns that _splitCrossColumnLines already separated
  // into distinct line objects would still interleave by Y the moment this
  // function walked `lines` as one flat array again.
  const _emitLines = (lines) => {
    // Same text-based detector pdf2excel uses (no border-grid pass — that's
    // only worth the extra render cost in pdf2word's richer visual pipeline).
    // Filtered through looksLikeProseNotData(): two unrelated prose lists
    // (e.g. a resume's Skills/Interests columns) can pass detectTables()'s
    // own alignment/fill checks cleanly — there's no built file afterward
    // to score, like pdf2excel's post-build ERI check has, so this has to
    // gate here, before the candidate is ever treated as a table.
    const tables = detectTables(lines).filter(t => !looksLikeProseNotData(t.rows));
    const lineToTable = new Map();
    for (const t of tables) {
      for (let li = t.startIdx; li <= t.endIdx; li++) lineToTable.set(li, t);
    }

    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li];

      // Real math-OCR result — checked before the image branch below since
      // this is the SAME display-formula crop candidate, just resolved to
      // real LaTeX instead of an image (see ocrFormula's comment above).
      if (ln.ocrFormula) {
        _flushPara();
        blocks.push({ type: 'formula-latex', latex: ln.ocrLatex });
        continue;
      }

      // Images short-circuit everything else — checked first so an empty-str
      // synthetic image "line" (see its construction above) never reaches
      // the table/list/heading text checks below, which all assume real
      // text content.
      if (ln.isImage) {
        _flushPara();
        _imgSeq++;
        const isFormula = ln.imgKind === 'formula';
        blocks.push({
          type: 'image', blob: ln.imgBlob,
          filename: `images/page${ln.imgPage}-${isFormula ? 'formula' : 'img'}${_imgSeq}.png`,
          width: ln.imgWidth, height: ln.imgHeight,
          alt: isFormula ? (ln.imgAlt || 'formula') : '',
        });
        continue;
      }

      // Table lines never fall through to heading/list/paragraph
      // classification — emit one 'table' block at the first line, then
      // skip the rest (already accounted for by that block).
      const tbl = lineToTable.get(li);
      if (tbl) {
        if (li === tbl.startIdx) {
          _flushPara();
          blocks.push({ type: 'table', rows: tbl.rows });
        }
        continue;
      }

      // Skip embedded page numbers: bottom-region line that's a bare integer
      // (same heuristic _p2wExtractText uses).
      if (li >= lines.length - 3 && ln.items.length === 1) {
        const t = ln.items[0].str.trim();
        if (/^\d+$/.test(t)) continue;
      }

      const rawText  = _lineText(ln).trim();
      const normText = _normWatermark(rawText);
      if (!normText || _repeatTextSet.has(normText)) continue;

      const bulletMatch   = BULLET_RE.test(rawText);
      let numberedMatch = !bulletMatch && NUMBERED_RE.test(rawText);

      // A numbered line ("1. Introduction") is indistinguishable on the
      // surface from a numbered list marker — demote it out of the list
      // branch when it's BOTH isolated (no numbered neighbor immediately
      // before or after — a real numbered list item almost always has one;
      // a numbered section heading almost never does) AND heading-shaped
      // (font-size ratio or all-bold, the same two signals the heading
      // classification below already uses), so that classification gets a
      // chance at it instead. Reuses the existing heading logic rather than
      // duplicating it — this only decides which branch runs, not the level.
      if (numberedMatch) {
        const prevNumbered = li > 0 && NUMBERED_RE.test(_lineText(lines[li - 1]).trim());
        const nextNumbered = li + 1 < lines.length && NUMBERED_RE.test(_lineText(lines[li + 1]).trim());
        const maxFontHere  = Math.max(...ln.items.map(i => i.fontSize));
        const headingShaped = maxFontHere >= median * 1.3 || _isBoldHeadingLine(ln.items);
        if (!prevNumbered && !nextNumbered && headingShaped) numberedMatch = false;
      }

      if (bulletMatch || numberedMatch) {
        _flushPara();
        // NUMBERED_RE's marker-detection no longer requires a real space after
        // "N."/"N)" (see its definition) — some real PDFs extract the marker
        // and item text as separate positionally-gapped items with no actual
        // space character. Markdown's own ordered-list syntax DOES require a
        // space after the marker to parse as a list ("1.Text" renders as
        // plain text, not an item) — normalize exactly one space here so
        // detection and valid Markdown output stay in sync regardless of
        // whether the source line already had one.
        // Escape the CONTENT only — never the marker this code just built
        // ("- " / "N. "), which is real, intentional Markdown syntax, not
        // extracted text.
        let text;
        if (bulletMatch) {
          text = `- ${_escapeMdText(rawText.replace(BULLET_RE, '').trim())}`;
        } else {
          const markerMatch = rawText.match(/^\d{1,3}[.)]\s*/);
          text = `${markerMatch[0].replace(/\s*$/, ' ')}${_escapeMdText(rawText.slice(markerMatch[0].length))}`;
        }
        if (text.replace(/^[-\d.)\s]+/, '').trim()) blocks.push({ type: 'list', text });
        continue;
      }

      const maxFont = Math.max(...ln.items.map(i => i.fontSize));
      let isHead      = maxFont >= median * 1.3 && rawText.replace(/\s+/g, '').length > 3;
      let boldOnlyHead = false;
      if (!isHead && _isBoldHeadingLine(ln.items)) {
        // Extra guard pdf2word's own fallback doesn't need: pdf2word buffers
        // a whole paragraph before classifying it, so a trailing bold line
        // with nothing after it never reaches this check on its own. pdf2md
        // classifies one line at a time, so require a real, non-suppressed
        // line to follow — otherwise a bold signature/footer line at the end
        // of a page or column gets promoted on formatting alone with nothing
        // to distinguish it from an actual section heading.
        const next = lines[li + 1];
        const nextRaw = next ? _normWatermark(_lineText(next).trim()) : '';
        if (nextRaw && !_repeatTextSet.has(nextRaw)) { isHead = true; boldOnlyHead = true; }
      }

      if (isHead) {
        _flushPara();
        let level = 3;
        if (boldOnlyHead) {
          // No font-size signal available — fall back to the same ALL-CAPS
          // heuristic pdf2word's own bold-heading fallback uses to separate
          // top-level sections from sub-labels in real formal/legal PDFs.
          const letters   = rawText.replace(/[^\p{L}]/gu, '');
          const isAllCaps = letters.length > 0 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
          level = isAllCaps ? 1 : 2;
        } else {
          if      (maxFont >= median * 2.2) level = 1;
          else if (maxFont >= median * 1.7) level = 2;
        }
        blocks.push({ type: 'heading', level, text: rawText });
        continue;
      }

      if (_paraBuffer.length > 0) {
        const lastLn      = _paraBuffer[_paraBuffer.length - 1];
        const lastMaxFont = Math.max(...lastLn.items.map(i => i.fontSize));
        const gap         = lastLn.y - ln.y;
        const lastText    = _lineText(lastLn);
        const lastIsCjk    = _isCjk(lastText);
        const lastIsRtl    = lastLn.rtl;
        const lastEndsSent = /[。！？…]$/.test(lastText.trimEnd());
        const mergeThreshold = (lastIsCjk && !lastEndsSent)
          ? lastMaxFont * 3.5
          : lastIsRtl
          ? lastMaxFont * 1.3
          : lastMaxFont * 2.0;
        if (gap > mergeThreshold) _flushPara();
      }
      _paraBuffer.push(ln);
    }
    _flushPara();
  };

  // Footnote/marginal-text separation — real gap found via literature
  // research (GROBID, PDFBoT arXiv:2010.12647 — both use bottom-of-page-Y +
  // below-median-font-size as the real, precision-favoring signal, not text
  // patterns): a footnote paragraph sitting at the bottom of the page in a
  // smaller font currently just flows straight into the ordinary paragraph
  // stream wherever its Y-coordinate happens to sort, interrupting body-text
  // flow — exactly the fragmentation eriChecks.js's own checkFlow already
  // penalizes downstream, never fixed upstream. Both signals required
  // (precision-first, "prefer false negatives" — same policy this file's
  // other detectors already follow): a real body paragraph that merely ends
  // near the bottom of a page must never be misclassified as a footnote.
  const FOOTNOTE_Y_BAND_FRACTION  = 0.15; // bottom 15% of page height (PDF Y=0 is the page BOTTOM)
  const FOOTNOTE_FONT_RATIO       = 0.85; // must be meaningfully smaller than the document's own median
  // Real false-positive found via a dense, formula-heavy physics paper
  // (scripts/pdf2md_benchmark.mjs's Atlas_DR corpus run): stray equation
  // fragments/sub/superscript glyphs near a page's bottom margin can also
  // be small relative to the document median, which is otherwise
  // dominated by body-prose font size — but a real footnote is citation
  // PROSE, not a chunk of an equation. Excluding lines that are mostly
  // formula-tagged keeps the legal-brief-footnotes real-world case
  // (verified working — citations correctly separated) while dropping
  // this false-positive class.
  const FOOTNOTE_MAX_FORMULA_FRACTION = 0.5;

  for (const { lines, pageW, pageH } of pageData) {
    let bodyLines = lines;
    let footnoteLines = [];
    if (pageH) {
      const yThreshold = pageH * FOOTNOTE_Y_BAND_FRACTION;
      footnoteLines = lines.filter(ln => {
        if (!ln.items.length || ln.isImage || ln.y > yThreshold) return false;
        if (Math.max(...ln.items.map(i => i.fontSize)) >= median * FOOTNOTE_FONT_RATIO) return false;
        const totalLen   = ln.items.reduce((s, i) => s + i.str.length, 0);
        const formulaLen = ln.items.reduce((s, i) => s + (i.formula ? i.str.length : 0), 0);
        return totalLen > 0 && (formulaLen / totalLen) < FOOTNOTE_MAX_FORMULA_FRACTION;
      });
      if (footnoteLines.length) {
        const footnoteSet = new Set(footnoteLines);
        bodyLines = lines.filter(ln => !footnoteSet.has(ln));
      }
    }

    // Column-aware dispatch — same "prefer false negatives" detector as
    // pdf2word's _p2wBuildParagraphs: detectColumnRegions() only returns
    // non-null on confident multi-column evidence, so the overwhelming
    // majority of pages (single-column) take the unsplit path below
    // unchanged. When it IS confident, each region is walked as its own
    // independent unit, in reading order (RTL pages read their rightmost
    // column first) — this is the part that actually fixes interleaving:
    // _splitCrossColumnLines above only separates merged lines into
    // distinct objects, it doesn't reorder `lines` itself, so without this
    // dispatch they'd still come out interleaved by Y.
    const regions = pageW ? detectColumnRegions(bodyLines, pageW) : null;
    if (!regions) {
      _emitLines(bodyLines);
    } else {
      const ordered = pageIsRtl(bodyLines) ? [...regions].reverse() : regions;
      for (const region of ordered) {
        const colLines = bodyLines.filter(ln =>
          ln.items.length && ln.items[0].x >= region.left && ln.items[0].x < region.right);
        if (colLines.length) _emitLines(colLines);
      }
    }

    // Emitted as its own trailing paragraph for the page, AFTER the body
    // content above and flushed first — never spliced mid-flow — so a real
    // footnote's own text isn't lost (unlike silently dropping it), just
    // kept out of the way of the body paragraph it would otherwise corrupt.
    // Italicized as the one, minimal visual/semantic distinction from body
    // text — no added heading, no horizontal rule, deliberately avoiding
    // visual clutter on documents with a footnote on every page.
    if (footnoteLines.length) {
      _flushPara();
      footnoteLines.sort((a, b) => b.y - a.y);
      const footnoteText = footnoteLines.map(_lineText).join(' ').replace(/\s+/g, ' ').trim();
      if (footnoteText) {
        // Raw text, NOT pre-escaped here — wrapRun (_p2mdRender) already
        // escapes every run's own text at render time; escaping here too
        // would double-escape (e.g. "\*" becoming "\\\*").
        blocks.push({ type: 'para', runs: [{ text: footnoteText, bold: false, italic: true, formula: false }] });
      }
    }
  }

  // Real gap found via scripts/pdf2md_benchmark.mjs's own scanned.pdf case:
  // this used to only fire when `blocks` was COMPLETELY empty — but a
  // genuine full-page scan almost never produces that in the browser tool,
  // since canvasFactory (real, always available there) successfully
  // extracts the page as a real embedded IMAGE block. That left the most
  // realistic real-world scanned-document shape with no guidance at all:
  // just a lone `![](images/...)` reference and no hint that OCR would
  // recover real, searchable text. Checking "no block carries real text"
  // (not just "no blocks at all") catches that case too — prepended, not
  // replacing the image, so no extracted content is lost either way.
  const hasRealText = blocks.some(b => b.type !== 'image');
  if (!hasRealText) {
    blocks.unshift({
      type: 'para',
      runs: [{
        text: 'No extractable text was found in this PDF. It may be a scanned/image-only document — try OCR first, then convert the result.',
        bold: false, italic: false,
      }],
    });
  }

  return blocks;
}

// Single source of truth for the formula-OCR disclosure text — always
// visible, never a silent HTML comment, because no confidence signal exists
// for this model (see ocrFormula's comment above _p2mdExtractText). Kept as
// one named constant, not inlined in the block-rendering switch below, so
// that IF a future model/approach ever legitimately earns a real confidence
// signal, there is exactly one place to change or conditionally drop this —
// no such signal exists today, so it is unconditional.
export const FORMULA_OCR_DISCLOSURE =
  '*(AI-recognized formula — extracted via automated OCR, not manually verified; double-check before relying on it)*';

// Pure string builder: heading/list/para blocks → Markdown text. Paragraphs
// wrap per-run (a 'para' block's `runs` array — see _lineRuns/_flushPara
// above), so a single bold word in the middle of otherwise-plain text stays
// bold instead of pdf2md's old all-or-nothing whole-paragraph flag. Headings
// are left unwrapped since the '#' prefix already conveys emphasis; list
// items are left unwrapped to keep list syntax unambiguous.
export function _p2mdRender(blocks) {
  // CommonMark requires no whitespace immediately inside **/* delimiters
  // ("** bold**" won't render as bold in most parsers) — split leading/
  // trailing whitespace off the run's core and emit it outside the markers,
  // regardless of which side of a word-boundary the space landed on.
  const wrapRun = (run) => {
    const m = run.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const [, lead, core, trail] = m;
    if (!core) return run.text; // whitespace-only run — nothing to wrap
    let wrapped;
    // Formula wins over bold/italic (see _p2mdExtractText's isFormula
    // comment) — inline math delimiter, not emphasis. Escape a stray literal
    // '$' so it can't prematurely close the span (rare in math-glyph text,
    // cheap to guard). LaTeX content is deliberately NOT run through
    // _escapeMdText — '*'/'_' there are math syntax, not CommonMark emphasis.
    if (run.formula) {
      wrapped = `$${core.replace(/\$/g, '\\$')}$`;
    } else {
      // _escapeMdText guards the PLAIN (most common) case too, not just
      // bold/italic — a literal '*' in ordinary extracted text (e.g. a
      // footnote marker like "*Corresponding author", the real case
      // scripts/pdf2md_benchmark.mjs's first run caught) previously went
      // through unescaped here, real risk regardless of this run's own
      // formatting.
      const escaped = _escapeMdText(core);
      if      (run.bold && run.italic) wrapped = `***${escaped}***`;
      else if (run.bold)               wrapped = `**${escaped}**`;
      else if (run.italic)             wrapped = `*${escaped}*`;
      else                             wrapped = escaped;
    }
    return lead + wrapped + trail;
  };

  const lines = [];
  let prevType = null;

  for (const b of blocks) {
    if (b.type === 'heading') {
      if (lines.length) lines.push('');
      lines.push(`${'#'.repeat(b.level)} ${_escapeMdText(b.text)}`);
    } else if (b.type === 'list') {
      if (prevType !== 'list' && lines.length) lines.push('');
      lines.push(b.text);
    } else if (b.type === 'table') {
      if (lines.length) lines.push('');
      // GFM pipe-table syntax. A literal '|' in cell text would otherwise
      // be read as a column boundary; a raw newline would break the row
      // onto multiple lines — both are rare in a single detected table
      // cell, but cheap to guard against. _escapeMdText handles the same
      // '*'/'_'/backtick risk wrapRun/headings guard against — a cell's
      // raw extracted text is just as capable of containing a stray
      // footnote-marker asterisk as a paragraph run is.
      const cell = c => _escapeMdText((c || '').replace(/\r?\n/g, ' ')).replace(/\|/g, '\\|');
      const [header, ...body] = b.rows;
      lines.push(`| ${header.map(cell).join(' | ')} |`);
      lines.push(`| ${header.map(() => '---').join(' | ')} |`);
      for (const row of body) lines.push(`| ${row.map(cell).join(' | ')} |`);
    } else if (b.type === 'image') {
      if (lines.length) lines.push('');
      lines.push(`![${b.alt || ''}](${b.filename})`);
    } else if (b.type === 'formula-latex') {
      // Always-visible disclosure, not a silent HTML comment — there is no
      // confidence signal for this model (see ocrFormula's comment above),
      // so every OCR'd formula must honestly tell the reader it's automated
      // and unverified, every time, with no silent high-confidence path.
      if (lines.length) lines.push('');
      lines.push('$$');
      lines.push(b.latex);
      lines.push('$$');
      lines.push(FORMULA_OCR_DISCLOSURE);
    } else {
      if (lines.length) lines.push('');
      lines.push(b.runs.map(wrapRun).join(''));
    }
    prevType = b.type;
  }

  return lines.join('\n') + '\n';
}
