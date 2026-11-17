// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ── exifAngle.js ─────────────────────────────────────────────────────────────
// A JPEG's EXIF turn, in degrees — what Images → PDF's conversion is given so
// it embeds a photo's own bytes only when no turn is needed (worker.js). Read
// for Images → PDF (jpg2pdfUI.js) and for the pictures Merge takes
// (processor.js): one reader, so both read a photo the same way.
// ─────────────────────────────────────────────────────────────────────────────

export async function readExifAngle(file) {
  if (!file.type.includes('jpeg') && !file.name.toLowerCase().endsWith('.jpg')) return 0;
  try {
    const slice = file.slice(0, 65536);
    const buf   = await slice.arrayBuffer();
    const view  = new DataView(buf);
    // Check JPEG magic
    if (view.getUint16(0) !== 0xFFD8) return 0;
    let offset = 2;
    while (offset < buf.byteLength - 1) {
      const marker = view.getUint16(offset);
      if (marker === 0xFFE1) { // APP1
        const segLen = view.getUint16(offset + 2);
        const exifHeader = String.fromCharCode(
          view.getUint8(offset + 4), view.getUint8(offset + 5),
          view.getUint8(offset + 6), view.getUint8(offset + 7)
        );
        if (exifHeader === 'Exif') {
          return _extractOrientation(view, offset + 10);
        }
        offset += 2 + segLen;
      } else if ((marker & 0xFF00) === 0xFF00) {
        offset += 2 + view.getUint16(offset + 2);
      } else break;
    }
  } catch { /* ignore — non-critical */ }
  return 0;
}

function _extractOrientation(view, tiffStart) {
  try {
    const littleEndian = view.getUint16(tiffStart) === 0x4949;
    const ifdOffset    = view.getUint32(tiffStart + 4, littleEndian);
    const entryCount   = view.getUint16(tiffStart + ifdOffset, littleEndian);
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = tiffStart + ifdOffset + 2 + i * 12;
      if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
        const val = view.getUint16(entryOffset + 8, littleEndian);
        return { 1: 0, 3: 180, 6: 90, 8: -90 }[val] ?? 0;
      }
    }
    return 0;
  } catch {
    // Corrupted EXIF structure — safe fallback, no rotation applied
    return 0;
  }
}
