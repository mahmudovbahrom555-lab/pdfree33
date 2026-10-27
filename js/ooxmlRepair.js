// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// A character beyond U+FFFF (math italic 𝑎, many emoji, rare Han) is two
// UTF-16 code units in JavaScript. The DOCX and PPTX writers (docx, pptxgenjs)
// hand their XML to JSZip as a string, and JSZip encodes it to UTF-8 16 384
// code units at a time: when a chunk ends between the two units, each is
// written on its own (CESU-8: ED A0–AF xx · ED B0–BF xx) — bytes no UTF-8
// reader accepts. LibreOffice refused a whole 119-page .docx over one such
// "𝑠" (2026-10-28, a Prince-made math report: 2,487 of its math letters
// encoded right, the one at code unit 16 383 of a chunk not). Reproduced in
// the browser: the character at offset 16 383 of document.xml → invalid,
// 16 382 or 16 384 → valid; the same in a PowerPoint slide; not in Excel
// (ExcelJS encodes itself). js/vendor is never edited, so the written file is
// checked: each XML part's pairs of encoded halves are joined back into the
// one 4-byte UTF-8 character they are.

// The two halves of one character, encoded apart → its UTF-8 bytes; null when
// a part holds none (the common case, left untouched).
export function joinSplitSurrogates(bytes) {
  let out = null, w = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0xED && i + 5 < bytes.length && bytes[i + 1] >= 0xA0 && bytes[i + 1] <= 0xAF && (bytes[i + 2] & 0xC0) === 0x80
        && bytes[i + 3] === 0xED && bytes[i + 4] >= 0xB0 && bytes[i + 4] <= 0xBF && (bytes[i + 5] & 0xC0) === 0x80) {
      const hi = 0xD000 | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
      const lo = 0xD000 | ((bytes[i + 4] & 0x3F) << 6) | (bytes[i + 5] & 0x3F);
      const cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
      if (!out) { out = new Uint8Array(bytes.length); out.set(bytes.subarray(0, i)); w = i; }
      out[w++] = 0xF0 | (cp >> 18); out[w++] = 0x80 | ((cp >> 12) & 0x3F);
      out[w++] = 0x80 | ((cp >> 6) & 0x3F); out[w++] = 0x80 | (cp & 0x3F);
      i += 5;
    } else if (out) {
      out[w++] = b;
    }
  }
  return out ? out.subarray(0, w) : null;
}

// The written .docx/.pptx with every XML part's split characters joined; the
// same Blob when there were none. Parts go back as bytes, so JSZip doesn't
// re-encode (and re-split) them.
export async function repairSplitSurrogates(blob, JSZip) {
  const zip = await JSZip.loadAsync(blob);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(xml|rels)$/i.test(name)) continue;
    const fixed = joinSplitSurrogates(await zip.file(name).async('uint8array'));
    if (fixed) { zip.file(name, fixed); changed = true; }
  }
  return changed ? zip.generateAsync({ type: 'blob', mimeType: blob.type, compression: 'DEFLATE' }) : blob;
}
