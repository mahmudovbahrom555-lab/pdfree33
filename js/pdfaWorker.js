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

const { PDFDocument, PDFName, PDFDict, PDFRef, PDFArray } = self.PDFLib;

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

// ── Main ──────────────────────────────────────────────────────────────────
self.onmessage = async function (e) {
  const { id, fileBytes } = e.data;
  try {
    const pdfDoc = await PDFDocument.load(fileBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    const encrypted = checkEncryption(pdfDoc);
    // If encrypted, object streams may not have parsed — font/forbidden
    // checks on a still-encrypted document are unreliable, so skip them
    // and report the single blocking issue instead of false positives.
    const missingFonts = encrypted ? [] : checkFonts(pdfDoc);
    const forbidden     = encrypted ? [] : checkForbidden(pdfDoc);

    const pageCount = pdfDoc.getPageCount();

    self.postMessage({
      id,
      ok: true,
      result: {
        pageCount,
        encrypted,
        missingFonts,
        forbidden,
        compliant: !encrypted && missingFonts.length === 0 && forbidden.length === 0,
      },
    });
  } catch (err) {
    self.postMessage({ id, ok: false, message: err?.message || 'Failed to analyze PDF' });
  }
};
