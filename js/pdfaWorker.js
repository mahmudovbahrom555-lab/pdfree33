// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  pdfaWorker.js — Dedicated Web Worker for PDF/A-2b analysis
//
//  Deliberately NOT part of worker.js (off-limits per CLAUDE.md).
//  Same pattern as vendor/qpdf/worker.js + decryptPdf.js: a
//  standalone classic worker, driven by js/pdfaAnalyze.js on the
//  main thread via postMessage.
//
//  This file only ANALYZES a PDF (read-only) — no output file is
//  produced. Conversion is a separate, later phase.
// ============================================================

importScripts('./vendor/pdf-lib.min.js');
importScripts('./vendor/fontkit.umd.js');

const { PDFDocument, PDFName, PDFDict, PDFRef, PDFArray, PDFString, decodePDFRawStream } = self.PDFLib;

// ── Font embedding check ─────────────────────────────────────────────────
// Walks Type0 → DescendantFonts → CIDFont → FontDescriptor for composite
// fonts (the common case for anything with non-Latin text or subset fonts),
// falling back to a direct FontDescriptor lookup for simple fonts. A `seen`
// set guards against a malformed PDF whose font dict graph cycles back on
// itself, which would otherwise recurse forever.
function isFontEmbedded(context, fontDict, seen) {
  const subtype = fontDict.get(PDFName.of('Subtype'))?.decodeText?.();

  if (subtype === 'Type0') {
    const descendants = context.lookup(fontDict.get(PDFName.of('DescendantFonts')));
    if (!(descendants instanceof PDFArray) || descendants.size() === 0) return false;
    const descendantRef = descendants.get(0);
    const key = descendantRef instanceof PDFRef ? descendantRef.toString() : null;
    if (key) {
      if (seen.has(key)) return true; // cycle — treat as resolved, don't loop forever
      seen.add(key);
    }
    const cidFont = context.lookup(descendantRef);
    if (!(cidFont instanceof PDFDict)) return false;
    return isFontEmbedded(context, cidFont, seen);
  }

  const fdRef = fontDict.get(PDFName.of('FontDescriptor'));
  if (!fdRef) return false; // no descriptor at all → relying on a standard 14 font, never embedded

  const fd = context.lookup(fdRef);
  if (!(fd instanceof PDFDict)) return false;

  for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
    const streamRef = fd.get(PDFName.of(key));
    if (!streamRef) continue;
    const stream = context.lookup(streamRef);
    // A present-but-empty/near-empty stream is not a real embedded font —
    // guards against malformed PDFs claiming embedding without content.
    if (stream?.contents?.length > 64) return true;
  }
  return false;
}

function checkFonts(pdfDoc) {
  const context = pdfDoc.context;
  const missing = new Set();
  const seen = new Set();

  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type'))?.decodeText?.() !== 'Font') continue;
    if (!isFontEmbedded(context, obj, seen)) {
      const baseFont = obj.get(PDFName.of('BaseFont'))?.decodeText?.() || 'Unknown';
      missing.add(baseFont.replace(/^[A-Z]{6}\+/, '')); // strip subset tag e.g. ABCDEF+Helvetica
    }
  }
  return Array.from(missing);
}

// ── Font substitution (opt-in, standard-14 fonts only) ───────────────────
// See js/vendor/liberation-fonts/SOURCE.txt for provenance/license. Scope
// is deliberately narrow: only the Helvetica/Arial, Times, and Courier
// families — the fonts that are conceptually "the standard 14" and have a
// well-established, purpose-built free metric-compatible replacement.
// Symbol/ZapfDingbats and anything else are never substituted; the
// existing "not embedded, please fix the source" refusal still applies.
function classifyStandardFont(baseFont) {
  const name = baseFont.toLowerCase();
  let family = null;
  if (/helvetica|arial/.test(name)) family = 'Sans';
  else if (/times/.test(name)) family = 'Serif';
  else if (/courier/.test(name)) family = 'Mono';
  else return null;
  const bold = /bold/.test(name);
  const italic = /italic|oblique/.test(name);
  const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  return { family, style, file: `Liberation${family}-${style}.ttf` };
}

// WinAnsiEncoding code -> Unicode codepoint, for codes 32-255 (generated
// from Python's cp1252 codec, which matches WinAnsiEncoding in this range;
// a handful of codes — 129,141,143,144,157 — are genuinely unassigned and
// simply absent from this table, treated as "unmappable" below).
const WIN_ANSI_TO_UNICODE = {32:32,33:33,34:34,35:35,36:36,37:37,38:38,39:39,40:40,41:41,42:42,43:43,44:44,45:45,46:46,47:47,48:48,49:49,50:50,51:51,52:52,53:53,54:54,55:55,56:56,57:57,58:58,59:59,60:60,61:61,62:62,63:63,64:64,65:65,66:66,67:67,68:68,69:69,70:70,71:71,72:72,73:73,74:74,75:75,76:76,77:77,78:78,79:79,80:80,81:81,82:82,83:83,84:84,85:85,86:86,87:87,88:88,89:89,90:90,91:91,92:92,93:93,94:94,95:95,96:96,97:97,98:98,99:99,100:100,101:101,102:102,103:103,104:104,105:105,106:106,107:107,108:108,109:109,110:110,111:111,112:112,113:113,114:114,115:115,116:116,117:117,118:118,119:119,120:120,121:121,122:122,123:123,124:124,125:125,126:126,127:127,128:8364,130:8218,131:402,132:8222,133:8230,134:8224,135:8225,136:710,137:8240,138:352,139:8249,140:338,142:381,145:8216,146:8217,147:8220,148:8221,149:8226,150:8211,151:8212,152:732,153:8482,154:353,155:8250,156:339,158:382,159:376,160:160,161:161,162:162,163:163,164:164,165:165,166:166,167:167,168:168,169:169,170:170,171:171,172:172,173:173,174:174,175:175,176:176,177:177,178:178,179:179,180:180,181:181,182:182,183:183,184:184,185:185,186:186,187:187,188:188,189:189,190:190,191:191,192:192,193:193,194:194,195:195,196:196,197:197,198:198,199:199,200:200,201:201,202:202,203:203,204:204,205:205,206:206,207:207,208:208,209:209,210:210,211:211,212:212,213:213,214:214,215:215,216:216,217:217,218:218,219:219,220:220,221:221,222:222,223:223,224:224,225:225,226:226,227:227,228:228,229:229,230:230,231:231,232:232,233:233,234:234,235:235,236:236,237:237,238:238,239:239,240:240,241:241,242:242,243:243,244:244,245:245,246:246,247:247,248:248,249:249,250:250,251:251,252:252,253:253,254:254,255:255};

// A /Differences array means the font remaps character codes in a custom,
// non-standard way — we can't safely resolve code->glyph without correctly
// interpreting it, so substitution is refused rather than risk a wrong
// glyph. Absent /Encoding, or a bare /WinAnsiEncoding|/MacRomanEncoding|
// /StandardEncoding name, are all identical to this table in the range we
// verify, so all three are treated the same, safe way.
function getSafeEncodingTable(context, fontDict) {
  const enc = context.lookup(fontDict.get(PDFName.of('Encoding')));
  if (!enc) return WIN_ANSI_TO_UNICODE;
  if (enc instanceof PDFDict) {
    return enc.get(PDFName.of('Differences')) ? null : WIN_ANSI_TO_UNICODE;
  }
  return WIN_ANSI_TO_UNICODE; // a bare PDFName encoding
}

// The actual safety check: does the ORIGINAL font's own declared /Widths
// (if any) agree with what the Liberation replacement's real glyph metrics
// would produce for the same character codes? This is the "only if it
// doesn't break the document" verification — never trust the Liberation
// project's metric-compatibility claim blindly, confirm it against THIS
// specific file's own numbers. A ±1 tolerance absorbs integer rounding
// (PDF widths are integers in 1/1000 em); anything larger is a genuine
// mismatch and refuses substitution for that font.
function verifyFontMetrics(context, fontDict, fkFont) {
  const table = getSafeEncodingTable(context, fontDict);
  if (!table) return false;

  const widthsArr = context.lookup(fontDict.get(PDFName.of('Widths')));
  if (!widthsArr) return true; // no override present — relies on standard metrics, safe by construction

  if (!(widthsArr instanceof PDFArray)) return false;
  const firstChar = fontDict.get(PDFName.of('FirstChar'))?.asNumber?.();
  if (typeof firstChar !== 'number') return false;

  const scale = 1000 / fkFont.unitsPerEm;
  for (let i = 0, n = widthsArr.size(); i < n; i++) {
    const declared = context.lookup(widthsArr.get(i))?.asNumber?.();
    if (typeof declared !== 'number' || declared === 0) continue; // 0 = code unused in this font
    const unicode = table[firstChar + i];
    if (unicode == null) return false; // a real declared width for a code we can't safely map
    let glyph;
    try { glyph = fkFont.glyphForCodePoint(unicode); } catch { return false; }
    const actual = Math.round(glyph.advanceWidth * scale);
    if (Math.abs(actual - declared) > 1) return false;
  }
  return true;
}

// Embeds the Liberation font program directly into the EXISTING font
// dict's object slot (same object number) rather than creating a new
// object and rewriting every reference to it — every page/annotation that
// already points at this font automatically sees the embedded version.
// containsFontFile validators (correctly) require /Subtype to agree with
// the embedded format — this must stay /TrueType since the program is
// FontFile2. Found via direct testing: labeling the dict /Type1 while
// embedding via FontFile2 passed our own structural checks (and pikepdf's)
// but veraPDF correctly flagged it as still "not embedded" because the
// subtype/format didn't match — the two must agree, not just both be present.
function substituteFont(context, fontDict, fontBytes, fkFont) {
  const scale = 1000 / fkFont.unitsPerEm;
  const fontFileStream = context.flateStream(fontBytes, { Length1: fontBytes.length });
  const fontFileRef = context.register(fontFileStream);

  const descriptor = context.obj({
    Type: 'FontDescriptor',
    FontName: fkFont.postscriptName || 'LiberationReplacement',
    Flags: 32 | (fkFont.italicAngle ? 64 : 0),
    FontBBox: [
      Math.round(fkFont.bbox.minX * scale), Math.round(fkFont.bbox.minY * scale),
      Math.round(fkFont.bbox.maxX * scale), Math.round(fkFont.bbox.maxY * scale),
    ],
    ItalicAngle: fkFont.italicAngle || 0,
    Ascent: Math.round(fkFont.ascent * scale),
    Descent: Math.round(fkFont.descent * scale),
    CapHeight: Math.round((fkFont.capHeight || fkFont.ascent) * scale),
    StemV: /bold/i.test(fkFont.postscriptName || '') ? 120 : 80,
    FontFile2: fontFileRef,
  });
  const descriptorRef = context.register(descriptor);

  fontDict.set(PDFName.of('Subtype'), PDFName.of('TrueType'));
  fontDict.set(PDFName.of('FontDescriptor'), descriptorRef);

  // If the original had no /Widths (relying on standard metrics), supply
  // Liberation's own — otherwise the original array already passed
  // verifyFontMetrics() and is left untouched.
  if (!context.lookup(fontDict.get(PDFName.of('Widths')))) {
    const table = WIN_ANSI_TO_UNICODE;
    const widths = [];
    for (let code = 32; code <= 255; code++) {
      const unicode = table[code];
      if (unicode == null) { widths.push(0); continue; }
      let glyph;
      try { glyph = fkFont.glyphForCodePoint(unicode); } catch { glyph = null; }
      widths.push(glyph ? Math.round(glyph.advanceWidth * scale) : 0);
    }
    fontDict.set(PDFName.of('FirstChar'), context.obj(32));
    fontDict.set(PDFName.of('LastChar'), context.obj(255));
    fontDict.set(PDFName.of('Widths'), context.obj(widths));
  }
}

// ── Forbidden-content check ──────────────────────────────────────────────
// PDF/A-2b forbids interactivity/automation constructs: open actions,
// additional actions (page/document triggers), and embedded JavaScript.
// Table-driven so new rules are one line, not a new branch.
const FORBIDDEN_RULES = [
  { key: 'openAction',  label: 'Document open action',  path: ['OpenAction'] },
  { key: 'aa',          label: 'Document-level actions', path: ['AA'] },
  { key: 'javascript',  label: 'Embedded JavaScript',    path: ['Names', 'JavaScript'] },
];

// Catalog/document-level actions only — misses the far more common real-world
// case: a Link or form-field annotation's own /A (its click/activation
// action) or /AA (focus/blur/format...), and a Page's own /AA (open/close
// triggers for that one page). All three can carry embedded JavaScript and
// are individually forbidden by PDF/A, but none of them live under the
// Catalog paths above — confirmed missed entirely until a synthetic fixture
// (an otherwise-clean, fully-embedded-font PDF with a Link annotation's /AA
// running JavaScript) came back "✓ compliant" and was actually converted,
// producing a file that claims PDF/A-2b while still containing the script.
// Page dicts are found via /Type /Page (required by spec); annotations are
// found by walking each page's /Annots array rather than scanning for
// /Type /Annot, since /Type on an annotation dict is OPTIONAL per spec and
// frequently omitted in the wild — a Type-based scan would silently miss them.
function checkPageAndAnnotActions(pdfDoc) {
  const context = pdfDoc.context;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type'))?.decodeText?.() !== 'Page') continue;

    if (obj.get(PDFName.of('AA'))) return true;

    const annots = context.lookup(obj.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0, n = annots.size(); i < n; i++) {
      const annot = context.lookup(annots.get(i));
      if (annot instanceof PDFDict && (annot.get(PDFName.of('A')) || annot.get(PDFName.of('AA')))) {
        return true;
      }
    }
  }
  return false;
}

function checkForbidden(pdfDoc) {
  const catalog = pdfDoc.catalog;
  const context = pdfDoc.context;
  const found = [];

  for (const rule of FORBIDDEN_RULES) {
    let node = catalog;
    let present = true;
    for (const segment of rule.path) {
      if (!(node instanceof PDFDict)) { present = false; break; }
      const next = node.get(PDFName.of(segment));
      if (!next) { present = false; break; }
      node = context.lookup(next);
    }
    if (present) found.push(rule.key);
  }
  if (checkPageAndAnnotActions(pdfDoc)) found.push('annotAction');
  return found;
}

function checkEncryption(pdfDoc) {
  return !!pdfDoc.isEncrypted;
}

// ── Digital signature check ──────────────────────────────────────────────
// A signed PDF's signature covers a byte-range hash of the file as it was
// AT SIGNING TIME — any re-save (this tool's save() included) changes those
// bytes and silently invalidates the signature, with no error from pdf-lib
// itself. For the legal/court/government segment this tool is explicitly
// aimed at, that's not a cosmetic issue: a converted, "PDF/A-compliant"
// court filing with a dead signature is a serious, undetected problem.
// Checked two ways: AcroForm's /SigFlags bit 1 (SignaturesExist, value 1
// per PDF spec 12.7.2 Table 225), and directly walking Widget annotations
// for an /FT /Sig field whose /V (the applied signature dictionary) is
// actually present — an unsigned signature FIELD (a placeholder waiting to
// be signed) has no /V and is not a problem; an already-signed one is.
function checkDigitalSignature(pdfDoc) {
  const context = pdfDoc.context;
  const acroForm = context.lookup(pdfDoc.catalog.get(PDFName.of('AcroForm')));
  if (acroForm instanceof PDFDict) {
    const sigFlags = context.lookup(acroForm.get(PDFName.of('SigFlags')));
    if (sigFlags?.asNumber?.() & 1) return true;
  }
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('FT'))?.decodeText?.() !== 'Sig') continue;
    if (obj.get(PDFName.of('V'))) return true;
  }
  return false;
}

// ── Unicode mapping check (PDF/A-2u eligibility) ─────────────────────────
// PDF/A-2u adds one requirement on top of 2b: every glyph used for
// rendering must have a determinable Unicode value, normally via a
// /ToUnicode CMap stream on the font. Real-world validators vary on how
// lenient they are about *implicit* Unicode mapping through well-known
// encodings (WinAnsiEncoding etc.) without an explicit /ToUnicode — rather
// than guess at that leniency, this check requires an explicit, non-empty
// /ToUnicode on every font. Conservative on purpose: it can under-qualify
// a file that some validators would accept as 2u, but it can never
// overclaim 2u — consistent with this tool's whole "honest refusal over
// false positive" position (see the Phase 1/2 analyzer's same bias).
function hasToUnicode(context, fontDict) {
  const stream = context.lookup(fontDict.get(PDFName.of('ToUnicode')));
  return !!(stream?.contents?.length > 0);
}

function checkUnicodeMapping(pdfDoc) {
  const context = pdfDoc.context;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type'))?.decodeText?.() !== 'Font') continue;
    // Descendant CID fonts (referenced only via a Type0's /DescendantFonts)
    // never carry their own /ToUnicode per spec — the Type0 wrapper does.
    // Checking them here would always fail even on a correctly-mapped
    // composite font, exactly the bug that first shipped this function:
    // a fixture with a real, verified /ToUnicode on the Type0 object still
    // came back "not eligible" because the loop also visited its
    // CIDFontType2 descendant and failed on that unrelated object.
    const subtype = obj.get(PDFName.of('Subtype'))?.decodeText?.();
    if (subtype === 'CIDFontType0' || subtype === 'CIDFontType2') continue;
    if (!hasToUnicode(context, obj)) return false;
  }
  return true; // no fonts (or all mapped) — vacuously eligible, same logic as checkFonts()
}

// PDF/A forbids LZWDecode (patent-encumbered historically, and simply not on
// the permitted filter list). pdf-lib's own save() only ever WRITES
// FlateDecode — it never introduces LZW itself — but it also doesn't
// recompress streams it didn't touch, so a source PDF that already has an
// LZW-compressed stream (old scanners/ancient Distiller output) would sail
// through save() unchanged and ship a silently non-compliant "PDF/A". This
// scans for that up front so conversion can refuse instead.
//
// /Filter lives on the STREAM dict, and stream objects (PDFRawStream) are
// NOT instanceof PDFDict in pdf-lib — they extend a separate base class and
// expose their dict via a `.dict` property instead. An earlier version of
// this function only checked `obj instanceof PDFDict`, which silently
// skipped every stream object in the document — i.e. every place /Filter
// actually appears — so it could never detect a real LZWDecode filter.
// Found via a synthetic fixture (a stream with /Filter forced to
// /LZWDecode) that this function wrongly reported as clean.
function checkLzw(pdfDoc) {
  const context = pdfDoc.context;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : (obj?.dict instanceof PDFDict ? obj.dict : null);
    if (!dict) continue;
    const filter = context.lookup(dict.get(PDFName.of('Filter')));
    if (!filter) continue;
    const names = filter instanceof PDFArray
      ? Array.from({ length: filter.size() }, (_, i) => filter.get(i))
      : [filter];
    if (names.some(n => n?.decodeText?.() === 'LZWDecode')) return true;
  }
  return false;
}

function analyze(pdfDoc) {
  const encrypted = checkEncryption(pdfDoc);
  // If encrypted, object streams may not have parsed — other checks on a
  // still-encrypted document are unreliable, so skip them and report the
  // single blocking issue instead of false positives.
  const missingFonts = encrypted ? [] : checkFonts(pdfDoc);
  const forbidden     = encrypted ? [] : checkForbidden(pdfDoc);
  const hasLzw         = encrypted ? false : checkLzw(pdfDoc);
  const unicodeOk      = encrypted ? false : checkUnicodeMapping(pdfDoc);
  const hasSignature   = encrypted ? false : checkDigitalSignature(pdfDoc);

  // Forbidden actions (OpenAction/AA/JS/annotation actions) are NOT a
  // blocking issue — convert() strips them automatically and reports
  // exactly what was removed (see stripForbiddenActions()). Unlike font
  // embedding or encryption, removing an action changes zero visible
  // content, so there's no layout-risk reason to refuse the way we do for
  // the other checks. `blocking` is the set that genuinely still requires
  // the user to act before conversion is possible at all. hasSignature IS
  // blocking — unlike a forbidden action, there is no automatic fix for
  // "this would silently invalidate a legal signature."
  const blocking = encrypted || missingFonts.length > 0 || hasLzw || hasSignature;

  // Cheap, name-only classification (no fontkit / font bytes needed) —
  // just enough to decide whether the "try safe substitution" opt-in is
  // worth offering at all. The real, per-file metric verification only
  // happens in convert(), once the user has actually opted in and the
  // Liberation bytes have been fetched.
  const substitutableFonts = missingFonts.filter(f => classifyStandardFont(f) != null);

  return {
    pageCount: pdfDoc.getPageCount(),
    encrypted,
    missingFonts,
    substitutableFonts,
    forbidden,
    hasLzw,
    unicodeOk,
    hasSignature,
    blocking,
    compliant: !blocking, // kept for backward compat with existing callers/tests
  };
}

// ── XMP metadata ──────────────────────────────────────────────────────────
// Info dict and XMP must agree (a PDF/A validator flags a mismatch as an
// error) — so XMP fields are read FROM the Info dict just set below, never
// authored independently.
function _xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildXmp({ title, author, producer, createdISO, conformance }) {
  // The xpacket "begin" attribute must contain a literal U+FEFF (BOM) per
  // the XMP spec — written as an escape, not the raw invisible character,
  // so it survives editors/linters that mangle or flag irregular whitespace.
  return `<?xpacket begin="${'\uFEFF'}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>2</pdfaid:part>
      <pdfaid:conformance>${conformance}</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${_xmlEscape(title || '')}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${_xmlEscape(author || '')}</rdf:li></rdf:Seq></dc:creator>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>${_xmlEscape(producer || '')}</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreateDate>${_xmlEscape(createdISO || '')}</xmp:CreateDate>
      <xmp:MetadataDate>${_xmlEscape(createdISO || '')}</xmp:MetadataDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

// ── Strip forbidden actions ──────────────────────────────────────────────
// Unlike font embedding or encryption, removing an OpenAction/AA/JS action
// changes zero visible content — there's no layout-risk reason to refuse
// conversion over these the way we do for the other checks. Every removal
// is counted and reported back (see convert()) rather than done silently —
// a competitor tool tested against this exact dataset did this same
// stripping with no disclosure at all, which is the anti-pattern here.
function stripForbiddenActions(pdfDoc) {
  const catalog = pdfDoc.catalog;
  const context = pdfDoc.context;
  const removed = { openAction: false, aa: false, javascript: false, pageOrAnnotCount: 0 };

  if (catalog.get(PDFName.of('OpenAction'))) {
    catalog.delete(PDFName.of('OpenAction'));
    removed.openAction = true;
  }
  if (catalog.get(PDFName.of('AA'))) {
    catalog.delete(PDFName.of('AA'));
    removed.aa = true;
  }
  const names = context.lookup(catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict && names.get(PDFName.of('JavaScript'))) {
    names.delete(PDFName.of('JavaScript'));
    removed.javascript = true;
  }

  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type'))?.decodeText?.() !== 'Page') continue;

    if (obj.get(PDFName.of('AA'))) {
      obj.delete(PDFName.of('AA'));
      removed.pageOrAnnotCount++;
    }

    const annots = context.lookup(obj.get(PDFName.of('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0, n = annots.size(); i < n; i++) {
      const annot = context.lookup(annots.get(i));
      if (!(annot instanceof PDFDict)) continue;
      let touched = false;
      if (annot.get(PDFName.of('A')))  { annot.delete(PDFName.of('A'));  touched = true; }
      if (annot.get(PDFName.of('AA'))) { annot.delete(PDFName.of('AA')); touched = true; }
      if (touched) removed.pageOrAnnotCount++;
    }
  }

  return removed;
}

// ── Conversion ──────────────────────────────────────────────────────────
const PRODUCER = 'PDFree (pdfree.io) — client-side PDF/A-2b/2u conversion';

// Finds actual unembedded SIMPLE (Type1/TrueType/MMType1) font dict objects
// — deliberately excludes Type0/CIDFontType0/2, since a "standard 14, not
// embedded" reference in practice is essentially always a simple font;
// composite fonts exist specifically for subsetting/embedding non-Latin
// scripts, not for referencing Helvetica/Times/Courier by name. Skipping
// them here avoids double-counting a Type0 wrapper and its own descendant
// as two separate substitution targets when only the wrapper is what
// resources actually reference.
function findSimpleUnembeddedFonts(context) {
  const targets = [];
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type'))?.decodeText?.() !== 'Font') continue;
    const subtype = obj.get(PDFName.of('Subtype'))?.decodeText?.();
    if (subtype === 'Type0' || subtype === 'CIDFontType0' || subtype === 'CIDFontType2') continue;
    if (obj.get(PDFName.of('FontDescriptor'))) {
      const fd = context.lookup(obj.get(PDFName.of('FontDescriptor')));
      const embedded = fd instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3']
        .some(k => { const s = context.lookup(fd.get(PDFName.of(k))); return s?.contents?.length > 64; });
      if (embedded) continue;
    }
    const baseFont = (obj.get(PDFName.of('BaseFont'))?.decodeText?.() || 'Unknown').replace(/^[A-Z]{6}\+/, '');
    targets.push({ dict: obj, baseFont });
  }
  return targets;
}

// Attempts verified substitution for every unembedded simple font. Refuses
// as a whole (no partial substitution) if even one font can't be safely
// verified — a half-fixed document is worse than a clear refusal.
function trySubstituteFonts(context, liberationFonts) {
  const targets = findSimpleUnembeddedFonts(context);
  const substituted = [];
  const failed = [];

  for (const { dict, baseFont } of targets) {
    const cls = classifyStandardFont(baseFont);
    if (!cls) { failed.push(baseFont); continue; }
    const fontBytes = liberationFonts[cls.file];
    if (!fontBytes) { failed.push(baseFont); continue; }
    let fkFont;
    try { fkFont = self.fontkit.create(fontBytes); } catch { failed.push(baseFont); continue; }
    if (!verifyFontMetrics(context, dict, fkFont)) { failed.push(baseFont); continue; }
    substituteFont(context, dict, fontBytes, fkFont);
    substituted.push(baseFont);
  }

  return { ok: failed.length === 0, substituted, failed };
}

async function convert(pdfDoc, iccBytes, substituteFontsOpt, liberationFonts) {
  let report = analyze(pdfDoc);
  let substitution = null;

  if (report.missingFonts.length > 0 && substituteFontsOpt) {
    const result = trySubstituteFonts(pdfDoc.context, liberationFonts || {});
    if (!result.ok) {
      // Refuse clearly rather than partially substitute — re-run analyze()
      // for an up-to-date report and tell the UI exactly which font(s)
      // couldn't be safely verified.
      return { blocked: true, report: analyze(pdfDoc), substitutionFailed: result.failed };
    }
    substitution = result.substituted;
    report = analyze(pdfDoc); // fonts are now embedded — re-check from scratch
  }

  if (report.blocking) {
    return { blocked: true, report };
  }

  const context = pdfDoc.context;

  const removedActions = report.forbidden.length > 0 ? stripForbiddenActions(pdfDoc) : null;

  // unicodeOk was computed before any modification above; stripping actions
  // never touches fonts, so it's still valid to decide the conformance
  // letter here. 'U' (PDF/A-2u) is strictly 2b plus this one requirement,
  // so upgrading is always safe when it qualifies.
  const conformance = report.unicodeOk ? 'U' : 'B';

  // Info dict is the single source of truth — set it first, then mirror
  // into XMP, so the two can never disagree.
  const nowISO = new Date().toISOString();
  pdfDoc.setProducer(PRODUCER);
  pdfDoc.setModificationDate(new Date());
  const xmp = buildXmp({
    title:      pdfDoc.getTitle() || '',
    author:     pdfDoc.getAuthor() || '',
    producer:   PRODUCER,
    createdISO: nowISO,
    conformance,
  });
  const xmpBytes = new TextEncoder().encode(xmp);
  const xmpStream = context.flateStream(xmpBytes, { Type: 'Metadata', Subtype: 'XML' });
  const xmpRef = context.register(xmpStream);
  pdfDoc.catalog.set(PDFName.of('Metadata'), xmpRef);

  // ICC OutputIntent — DestOutputProfile is the embedded profile stream;
  // N=3 declares a 3-component (RGB) profile.
  const iccStream = context.flateStream(iccBytes, { N: 3, Alternate: 'DeviceRGB' });
  const iccRef = context.register(iccStream);
  // OutputConditionIdentifier/Info are text strings per spec (7.11.4.1) — a
  // bare JS string through context.obj() would instead become a PDFName
  // (its default coercion for strings), which a strict validator flags.
  const outputIntent = context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccRef,
  });
  const outputIntentRef = context.register(outputIntent);
  pdfDoc.catalog.set(PDFName.of('OutputIntents'), context.obj([outputIntentRef]));

  const savedBytes = await pdfDoc.save();

  const audit = await selfAudit(savedBytes, iccBytes.length, conformance);
  return { blocked: false, fileBytes: savedBytes, audit, removedActions, conformance, substitution };
}

// Re-parses the just-written file independently — never trusts "we called
// the right functions", only trusts what's actually readable back out of
// the produced bytes. Streams come back from the parser still Flate-
// compressed (PDFRawStream.contents is the raw on-disk bytes) — an earlier
// version of this function compared/decoded that compressed data directly,
// which under-counted the ICC profile's length (compression isn't 1:1) and
// decoded garbage instead of XML for the XMP check, silently reporting a
// correctly-written file as failed. decodePDFRawStream(...).decode() —
// the same utility already used in worker.js for image pixel data — does
// the actual inflate.
async function selfAudit(savedBytes, expectedIccLen, expectedConformance) {
  const doc = await PDFDocument.load(savedBytes, { ignoreEncryption: true, updateMetadata: false });
  const context = doc.context;

  const outputIntents = context.lookup(doc.catalog.get(PDFName.of('OutputIntents')));
  let outputIntentOk = false;
  if (outputIntents instanceof PDFArray && outputIntents.size() > 0) {
    const oi = context.lookup(outputIntents.get(0));
    const profileStream = oi instanceof PDFDict ? context.lookup(oi.get(PDFName.of('DestOutputProfile'))) : null;
    if (profileStream) {
      const iccInflated = decodePDFRawStream(profileStream).decode();
      outputIntentOk = iccInflated.length === expectedIccLen;
    }
  }

  const metadataStream = context.lookup(doc.catalog.get(PDFName.of('Metadata')));
  let xmpOk = false;
  if (metadataStream) {
    const xmpBytes = decodePDFRawStream(metadataStream).decode();
    const xmpText = new TextDecoder().decode(xmpBytes);
    xmpOk = xmpText.includes('pdfaid:part>2') && xmpText.includes(`pdfaid:conformance>${expectedConformance}`);
  }

  // Forbidden actions are supposed to have been stripped, and any font
  // substitution supposed to have actually embedded real glyph data —
  // re-check both against the ACTUAL saved bytes rather than trusting the
  // earlier steps ran cleanly, same "never trust, re-verify" discipline as
  // the OutputIntent/XMP checks above.
  const reloaded = analyze(doc);
  const actionsClean = reloaded.forbidden.length === 0;
  const fontsClean = reloaded.missingFonts.length === 0;

  return {
    outputIntentPresent: outputIntentOk,
    xmpPresent: xmpOk,
    notEncrypted: !doc.isEncrypted,
    actionsClean,
    fontsClean,
    passed: outputIntentOk && xmpOk && !doc.isEncrypted && actionsClean && fontsClean,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────
self.onmessage = async function (e) {
  const { id, type, fileBytes, iccBytes, substituteFonts, liberationFonts } = e.data;
  try {
    const pdfDoc = await PDFDocument.load(fileBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    if (type === 'convert') {
      const result = await convert(pdfDoc, iccBytes, substituteFonts, liberationFonts);
      const transfer = result.fileBytes ? [result.fileBytes.buffer] : [];
      self.postMessage({ id, ok: true, result }, transfer);
      return;
    }

    self.postMessage({ id, ok: true, result: analyze(pdfDoc) });
  } catch (err) {
    self.postMessage({ id, ok: false, message: err?.message || 'Failed to process PDF' });
  }
};
