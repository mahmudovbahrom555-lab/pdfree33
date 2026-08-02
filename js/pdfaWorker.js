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

// ── Forbidden-content check ──────────────────────────────────────────────
// PDF/A-2b forbids interactivity/automation constructs: open actions,
// additional actions (page/document triggers), and embedded JavaScript.
// Table-driven so new rules are one line, not a new branch.
const FORBIDDEN_RULES = [
  { key: 'openAction',  label: 'Document open action',  path: ['OpenAction'] },
  { key: 'aa',          label: 'Document-level actions', path: ['AA'] },
  { key: 'javascript',  label: 'Embedded JavaScript',    path: ['Names', 'JavaScript'] },
];

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
  return found;
}

function checkEncryption(pdfDoc) {
  return !!pdfDoc.isEncrypted;
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

  return {
    pageCount: pdfDoc.getPageCount(),
    encrypted,
    missingFonts,
    forbidden,
    hasLzw,
    compliant: !encrypted && missingFonts.length === 0 && forbidden.length === 0 && !hasLzw,
  };
}

// ── XMP metadata ──────────────────────────────────────────────────────────
// Info dict and XMP must agree (a PDF/A validator flags a mismatch as an
// error) — so XMP fields are read FROM the Info dict just set below, never
// authored independently.
function _xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildXmp({ title, author, producer, createdISO }) {
  // The xpacket "begin" attribute must contain a literal U+FEFF (BOM) per
  // the XMP spec — written as an escape, not the raw invisible character,
  // so it survives editors/linters that mangle or flag irregular whitespace.
  return `<?xpacket begin="${'\uFEFF'}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>2</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
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

// ── Conversion ──────────────────────────────────────────────────────────
const PRODUCER = 'PDFree (pdfree.io) — client-side PDF/A-2b conversion';

async function convert(pdfDoc, iccBytes) {
  const report = analyze(pdfDoc);
  if (!report.compliant) {
    return { blocked: true, report };
  }

  const context = pdfDoc.context;

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

  const audit = await selfAudit(savedBytes, iccBytes.length);
  return { blocked: false, fileBytes: savedBytes, audit };
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
async function selfAudit(savedBytes, expectedIccLen) {
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
    xmpOk = xmpText.includes('pdfaid:part>2') && xmpText.includes('pdfaid:conformance>B');
  }

  return {
    outputIntentPresent: outputIntentOk,
    xmpPresent: xmpOk,
    notEncrypted: !doc.isEncrypted,
    passed: outputIntentOk && xmpOk && !doc.isEncrypted,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────
self.onmessage = async function (e) {
  const { id, type, fileBytes, iccBytes } = e.data;
  try {
    const pdfDoc = await PDFDocument.load(fileBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    if (type === 'convert') {
      const result = await convert(pdfDoc, iccBytes);
      const transfer = result.fileBytes ? [result.fileBytes.buffer] : [];
      self.postMessage({ id, ok: true, result }, transfer);
      return;
    }

    self.postMessage({ id, ok: true, result: analyze(pdfDoc) });
  } catch (err) {
    self.postMessage({ id, ok: false, message: err?.message || 'Failed to process PDF' });
  }
};
