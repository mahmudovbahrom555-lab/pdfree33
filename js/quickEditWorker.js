// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  quickEditWorker.js — the heavy half of Quick Edit's in-place save, off
//  the page's main thread (driven by js/quickEditOriginal.js).
//
//  Why (2026-11-12, a 300-page Chinese book on a phone, CPU 4×): the save
//  took 15 s and the tab was frozen for 12.6 s of it, the longest single
//  freeze 4.7 s — MuPDF opening, redacting and saving every page (3.6 s),
//  pdf-lib saving the file with the whole Noto SC font (5.8 s), MuPDF
//  subsetting that font and saving again (4.2 s). Here none of it blocks a
//  tap; pdf.js (already in its own worker) still reads the result back on
//  the page.
//
//  Two requests:
//   prepare — checks (signed, layout), then removes exactly the edited
//             lines' glyphs (MuPDF redaction) → { bytes, plans }
//   write   — draws the new text (pdf-lib + fontkit), subsets Noto SC with
//             MuPDF when it was used → { bytes }
//  A refusal comes back as { code, page } — the page turns it into a message
//  in its own language.
// ============================================================

// Loaded inside the handler, not as static imports: MuPDF finishes loading
// with a top-level await, and a request posted before a module worker has
// finished evaluating never reached a handler set after it (2026-11-12).
let PDFLib, fontkit, mupdf;
const ready = Promise.all([
  import('./vendor/pdf-lib.min.js'), import('./vendor/fontkit.umd.js'), import('./vendor/mupdf-1.28.1/mupdf.js'),
]).then(([, , engine]) => { ({ PDFLib, fontkit } = self); mupdf = engine.default; });
const CHINESE_FONT = './vendor/noto/notosanssc-v40.ttf';

// line: the refused line's place in the request, when one line is the cause
class Refusal extends Error {
  constructor(code, page, line) { super(code); this.code = code; this.page = page; this.line = line; }
}

const fontBytes = new Map();
function loadFont(path) {
  if (!fontBytes.has(path)) {
    fontBytes.set(path, fetch(new URL(path, import.meta.url)).then(response => {
      if (!response.ok) throw new Refusal('font');
      return response.arrayBuffer();
    }).catch(error => { fontBytes.delete(path); throw error; }));
  }
  return fontBytes.get(path);
}

function redactRect(sheet, line, pageHeight) {
  const text = sheet.toStructuredText('preserve-whitespace');
  const glyphs = [];
  try {
    text.walk({
      onChar(character, origin, font, size, quad, color) {
        try {
          if (!character.trim()) return;
          const xs = [quad[0], quad[2], quad[4], quad[6]];
          const ys = [quad[1], quad[3], quad[5], quad[7]];
          const family = font.isMono() ? 'Mono' : font.isSerif() ? 'Serif' : 'Sans';
          const style = (font.isBold() ? 'Bold' : '') + (font.isItalic() ? 'Italic' : '');
          glyphs.push({
            character, origin, color, font: `Liberation${family}-${style || 'Regular'}.ttf`,
            bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          });
        } finally {
          font.destroy();
        }
      },
    });
  } finally {
    text.destroy();
  }
  const baseline = pageHeight - line.y;
  // In MuPDF's reading order, not sorted by x: a ligature's parts share one
  // origin ("ff" + "e" in "difference" all at one x) and a sort mixed them up —
  // "difefrence" no longer matched the line (2026-11-12).
  // The line's last glyph starts at least ~2 pt before its right edge; a glyph
  // of the next piece set tight against it (a Latin "A" after Chinese text)
  // starts a hair before it in MuPDF's numbers (2026-11-13)
  const end = line.right - Math.max(0.1, Math.min(1, line.size * 0.08));
  const selected = glyphs.filter(({ origin }) =>
    Math.abs(origin[1] - baseline) <= 0.5 && origin[0] >= line.x - 0.3 && origin[0] < end
  );
  // pdf.js and MuPDF can name one glyph differently: a radical (⻚, ⽂) for an
  // ideograph (页, 文), one dash for another (— U+2014 / ― U+2015) — the same
  // glyph either way (Chinese and Japanese pages, 2026-11-13)
  const normalized = value => Array.from(value.normalize('NFKC').replace(/\s+/g, ''));
  const dash = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D-]/;
  const radical = /[\u2E80-\u2FDF]/;
  const ideograph = /\p{Ideographic}/u;
  const same = (a, b) => a === b || (dash.test(a) && dash.test(b)) ||
    (radical.test(a) && ideograph.test(b)) || (radical.test(b) && ideograph.test(a));
  const found = normalized(selected.map(glyph => glyph.character).join(''));
  const wanted = normalized(line.text);
  if (!selected.length || found.length !== wanted.length || found.some((c, i) => !same(c, wanted[i]))) {
    throw new Refusal('no_match', line.page + 1);
  }
  const selectedSet = new Set(selected);
  const rect = [
    Math.min(...selected.map(glyph => glyph.bounds[0])) + 0.05,
    Math.min(...selected.map(glyph => glyph.bounds[1])) + 0.05,
    Math.max(...selected.map(glyph => glyph.bounds[2])) - 0.05,
    Math.max(...selected.map(glyph => glyph.bounds[3])) - 0.05,
  ];
  const safeRect = candidate => candidate[0] < candidate[2] && candidate[1] < candidate[3] &&
    !glyphs.some(glyph => !selectedSet.has(glyph) &&
      glyph.bounds[0] < candidate[2] && candidate[0] < glyph.bounds[2] &&
      glyph.bounds[1] < candidate[3] && candidate[1] < glyph.bounds[3]);
  // Italic overhang can make the union touch an adjacent upright glyph.
  // Try a small rectangle inside each selected glyph instead. Verification
  // still rejects the export if any unselected glyph was actually removed.
  const rectangles = safeRect(rect) ? [rect] : selected.map(({ bounds }) => {
    const x = (bounds[0] + bounds[2]) / 2;
    const y = (bounds[1] + bounds[3]) / 2;
    return [x - 0.1, y - 0.1, x + 0.1, y + 0.1];
  });
  if (!rectangles.every(safeRect)) throw new Refusal('nearby', line.page + 1);
  const { font, color } = selected[0];
  if (selected.some(glyph => glyph.font !== font || glyph.color.some((value, index) => value !== color[index]))) {
    throw new Refusal('mixed_style', line.page + 1);
  }
  return { rectangles, font, color };
}

// lines: [{ page, x, y, right, size, text, mixed, placed }], heights: { [page]: height }
async function prepare({ bytes, lines, heights }) {
  const input = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  if (input.getForm().getFields().some(field => field instanceof PDFLib.PDFSignature)) throw new Refusal('signed');
  for (const line of lines) {
    const page = input.getPage(line.page);
    const crop = page.getCropBox();
    const media = page.getMediaBox();
    // WPS/OFD exports can write CropBox endpoints in reverse order.
    const sameBox = Math.min(crop.x, crop.x + crop.width) === media.x &&
      Math.min(crop.y, crop.y + crop.height) === media.y &&
      Math.abs(crop.width) === media.width && Math.abs(crop.height) === media.height;
    if (line.mixed || !sameBox) throw new Refusal('layout', line.page + 1, lines.indexOf(line));
  }
  const replaced = lines.filter(line => !line.placed);
  if (!replaced.length) return { bytes, plans: [] };
  const plans = [];
  const source = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  try {
    for (const index of new Set(replaced.map(line => line.page))) {
      const sheet = source.loadPage(index);
      try {
        for (const line of replaced.filter(line => line.page === index)) {
          let plan;
          try {
            plan = redactRect(sheet, line, heights[index]);
          } catch (error) {
            if (error instanceof Refusal) error.line = lines.indexOf(line);
            throw error;
          }
          plans[replaced.indexOf(line)] = plan;
          for (const rect of plan.rectangles) {
            const mark = sheet.createAnnotation('Redact');
            try {
              mark.setRect(rect);
              mark.update();
            } finally {
              mark.destroy();
            }
          }
        }
        sheet.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE,
          mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      } finally {
        sheet.destroy();
      }
    }
    const output = source.saveToBuffer('garbage=4,compress');
    try {
      return { bytes: output.asUint8Array().slice().buffer, plans };
    } finally {
      output.destroy();
    }
  } finally {
    source.destroy();
  }
}

// changes: [{ page, x, y, skew, runs: [{ text, path, color, size, width }] }]
async function write({ bytes, changes }) {
  const doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const fonts = new Map();
  for (const { page, x: start, y, skew, runs } of changes) {
    let x = start;
    for (const { text, path, color, size, width } of runs) {
      if (!fonts.has(path)) fonts.set(path, await doc.embedFont(await loadFont(path), { subset: path !== CHINESE_FONT }));
      const [r, g, b] = color;
      doc.getPage(page).drawText(text, { x, y, size, font: fonts.get(path),
        ySkew: PDFLib.radians(Math.atan(skew)), color: PDFLib.rgb(r, g, b) });
      x += width;
    }
  }
  let out = await doc.save();
  if (fonts.has(CHINESE_FONT)) {
    // fontkit's direct Noto SC subset can contain invisible glyphs even when
    // ToUnicode is correct. Subset the valid, fully embedded PDF with MuPDF.
    const output = mupdf.Document.openDocument(out, 'application/pdf');
    try {
      output.subsetFonts();
      const buffer = output.saveToBuffer('garbage=4,compress');
      try {
        out = buffer.asUint8Array().slice();
      } finally {
        buffer.destroy();
      }
    } finally {
      output.destroy();
    }
  }
  return { bytes: out.byteOffset || out.byteLength !== out.buffer.byteLength ? out.slice().buffer : out.buffer };
}

self.onmessage = async ({ data: { id, type, payload } }) => {
  try {
    await ready;
    const result = await (type === 'prepare' ? prepare(payload) : write(payload));
    self.postMessage({ id, result }, [result.bytes]);
  } catch (error) {
    self.postMessage({ id, refusal: error instanceof Refusal ? { code: error.code, page: error.page, line: error.line } : null,
      message: String(error?.message || error) });
  }
};
