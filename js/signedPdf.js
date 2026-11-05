// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  signedPdf.js — is this PDF digitally signed? (class C28, 2026-11-05)
//
//  Every tool that writes a PDF saves it again (pdf-lib, qpdf), and a save
//  changes the bytes a digital signature covers (/ByteRange): the copy's
//  signature is no longer valid. Checked with pdfsig on real signed files
//  (2395337, 3307692). So the user is told before such a tool runs.
//
//  A signature counts only if it really signs something — read from the
//  bytes, no full parse (files can be 100+ MB):
//    /ByteRange [0 b c d] with 0 < b < c and c + d within the file, and
//    between b and c a <hex…> /Contents that isn't the all-zero placeholder.
//  A signature dictionary is never inside a compressed object stream: the
//  signing tool writes the file, then patches /ByteRange and /Contents in
//  place at known offsets — so a byte scan finds every one.
//  Not counted: an empty signature field, a picture of a signature.
//  Certified (certification signature): /TransformMethod /DocMDP.
// ============================================================

const RANGE = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
const DOCMDP = /\/TransformMethod\s*\/DocMDP/;
const CHUNK = 4 << 20, OVERLAP = 256;

/**
 * @param {Blob} file  a PDF (File or Blob)
 * @returns {Promise<null|{count:number, certified:boolean}>}  null when not signed
 */
export async function detectSignature(file) {
  const size = file.size, dec = new TextDecoder('latin1');
  const ranges = new Set();
  let certified = false;
  for (let at = 0; at < size; at += CHUNK) {
    const text = dec.decode(await file.slice(at, Math.min(size, at + CHUNK + OVERLAP)).arrayBuffer());
    for (const m of text.matchAll(RANGE)) ranges.add(m.slice(1, 5).join(' '));
    if (!certified && DOCMDP.test(text)) certified = true;
  }
  let count = 0;
  for (const r of ranges) {
    const [a, b, c, d] = r.split(' ').map(Number);
    if (a !== 0 || !(b > 0 && c > b && c + d <= size)) continue;
    // the hole between the two signed ranges is the /Contents hex string
    const hole = dec.decode(await file.slice(b, Math.min(c, b + 4096)).arrayBuffer());
    if (hole[0] === '<' && /[1-9a-fA-F]/.test(hole.slice(1))) count++;
  }
  return count ? { count, certified } : null;
}
