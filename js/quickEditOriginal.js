import { loadFontkit, loadPdfLib } from './lazyLibs.js';
import { loadPdfJs } from './pdfjsLoader.js';

let enginePromise;
const fontPromises = new Map();
function loadOriginalEngine() {
  enginePromise ??= import('./vendor/mupdf-1.28.1/mupdf.js').then(module => module.default)
    .catch(error => { enginePromise = null; throw error; });
  return enginePromise;
}

function loadReplacementFont(path) {
  if (!fontPromises.has(path)) {
    fontPromises.set(path, fetch(new URL(path, import.meta.url))
      .then(response => {
        if (!response.ok) throw new Error('The replacement font could not be loaded.');
        return response.arrayBuffer();
      }).catch(error => { fontPromises.delete(path); throw error; }));
  }
  return fontPromises.get(path);
}

export function originalLines(items) {
  const baselines = new Map();
  for (const item of items) {
    if (!item.str?.trim() && item.str !== ' ') continue;
    const [size, skewX, skewY, height, x, y] = item.transform;
    if (size <= 0 || skewX || Math.abs(skewY) > size * 0.4 || Math.abs(size - height) > 0.01) continue;
    // PDF.js may represent a wide column gutter as one synthetic space.
    if (item.str === ' ' && item.width > Math.max(18, size * 2)) continue;
    const row = baselines.get(y) ?? [];
    row.push({ ...item, x, y, size, skew: skewY / size });
    baselines.set(y, row);
  }

  const lines = [];
  for (const row of baselines.values()) {
    let line;
    for (const item of row.sort((a, b) => a.x - b.x)) {
      if (!line || item.x - line.right > Math.max(18, item.size * 2) ||
          Math.abs(item.skew - line.skew) > 0.01) {
        line = { text: '', x: item.x, y: item.y, right: item.x, size: item.size,
          fontName: item.fontName, mixed: false, skew: item.skew };
        lines.push(line);
      }
      line.text += item.str;
      line.right = Math.max(line.right, item.x + item.width);
      line.mixed ||= line.fontName !== item.fontName || Math.abs(line.size - item.size) > 0.01;
    }
  }
  return lines.filter(line => line.text.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
}

export async function openOriginalPdf(file) {
  await loadPdfJs();
  const bytes = file._decryptedBuffer?.slice(0) ?? await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
  try {
    const { info } = await pdf.getMetadata();
    if (info?.IsAcroFormPresent || info?.IsXFAPresent || info?.IsSignaturesPresent) {
      throw new Error('Preserve layout is unavailable for interactive forms or signed PDFs.');
    }
    return { bytes, pdf, plans: new WeakMap() };
  } catch (error) {
    await pdf.destroy();
    throw error;
  }
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
  const selected = glyphs.filter(({ origin }) =>
    Math.abs(origin[1] - baseline) <= 0.5 && origin[0] >= line.x - 0.3 && origin[0] < line.right - 0.1
  ).sort((a, b) => a.origin[0] - b.origin[0]);
  const normalized = value => value.normalize('NFKC').replace(/\s+/g, '');
  if (!selected.length || normalized(selected.map(glyph => glyph.character).join('')) !== normalized(line.text)) {
    throw new Error(`Page ${line.page + 1}: the selected line could not be matched to the original text.`);
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
  if (!rectangles.every(safeRect)) {
    throw new Error(`Page ${line.page + 1}: replacing this line may remove nearby text.`);
  }
  const { font, color } = selected[0];
  if (selected.some(glyph => glyph.font !== font || glyph.color.some((value, index) => value !== color[index]))) {
    throw new Error(`Page ${line.page + 1}: the selected line has mixed text styling.`);
  }
  return { rectangles, font, color };
}

async function removeOriginalLines(original, lines) {
  const engine = await loadOriginalEngine();
  const source = engine.Document.openDocument(new Uint8Array(original.bytes), 'application/pdf');
  try {
    for (const index of new Set(lines.map(line => line.page))) {
      const sheet = source.loadPage(index);
      try {
        const page = await original.pdf.getPage(index + 1);
        const height = page.view[3];
        for (const line of lines.filter(line => line.page === index)) {
          let plan = original.plans.get(line);
          if (!plan) {
            plan = redactRect(sheet, line, height);
            original.plans.set(line, plan);
          }
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
        sheet.applyRedactions(false, engine.PDFPage.REDACT_IMAGE_NONE,
          engine.PDFPage.REDACT_LINE_ART_NONE, engine.PDFPage.REDACT_TEXT_REMOVE);
      } finally {
        sheet.destroy();
      }
    }
    const output = source.saveToBuffer('garbage=4,compress');
    try {
      return output.asUint8Array().slice();
    } finally {
      output.destroy();
    }
  } finally {
    source.destroy();
  }
}

export async function prepareOriginalCopy(original, lines) {
  await Promise.all([loadPdfLib(), loadFontkit()]);
  const input = await window.PDFLib.PDFDocument.load(original.bytes, { updateMetadata: false });
  if (input.getForm().getFields().some(field => field instanceof window.PDFLib.PDFSignature)) {
    throw new Error('Preserve layout is unavailable for signed PDFs.');
  }
  for (const line of lines) {
    const page = input.getPage(line.page);
    const crop = page.getCropBox();
    const media = page.getMediaBox();
    // WPS/OFD exports can write CropBox endpoints in reverse order.
    const sameBox = Math.min(crop.x, crop.x + crop.width) === media.x &&
      Math.min(crop.y, crop.y + crop.height) === media.y &&
      Math.abs(crop.width) === media.width && Math.abs(crop.height) === media.height;
    if (line.mixed || !sameBox) {
      throw new Error(`Page ${line.page + 1}: this line uses a layout the replacement cannot preserve.`);
    }
  }
  const pages = new Map();
  for (const pageIndex of new Set(lines.map(line => line.page))) {
    const page = await original.pdf.getPage(pageIndex + 1);
    const [x, y] = page.view;
    if (x || y || page.rotate || page.userUnit !== 1) {
      throw new Error(`Page ${pageIndex + 1}: this page uses unsupported geometry.`);
    }
    pages.set(pageIndex, originalLines((await page.getTextContent()).items));
  }
  const replaced = lines.filter(line => !line.placed);
  const bytes = replaced.length ? await removeOriginalLines(original, replaced) : original.bytes;
  return { bytes, pages, plans: original.plans, pageCount: original.pdf.numPages };
}

const CHINESE_FONT = './vendor/noto/notosanssc-v40.ttf';

function replacementFonts(doc) {
  doc.registerFontkit(window.fontkit);
  const fonts = new Map();
  return async path => {
    if (!fonts.has(path)) {
      const font = await doc.embedFont(await loadReplacementFont(path), { subset: path !== CHINESE_FONT });
      fonts.set(path, { font, characters: new Set(font.getCharacterSet()) });
    }
    return fonts.get(path);
  };
}

// Measure every recipient before generating the first PDF. Use the same
// embedded font and width calculation as export, including CJK fallback.
export async function planOriginalCopies(prepared, copies, allowSmallerText, isCancelled) {
  const metricsDoc = await window.PDFLib.PDFDocument.create();
  const loadFont = replacementFonts(metricsDoc);
  const result = [];
  for (const [index, { recipientIndex, changes }] of copies.entries()) {
    if (index % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    if (isCancelled()) return null;
    const planned = [];
    for (const { line, text, parts, appearance } of changes) {
      const source = line.placed ? { font: 'LiberationSans-Regular.ttf', color: [0, 0, 0] } : prepared.plans.get(line);
      const page = line.page + 1;
      const prefix = `Recipient ${recipientIndex + 1}, page ${page}`;
      const runs = [];
      for (const part of appearance ? parts : [{ text, name: true }]) {
        if (!part.text) continue;
        const style = part.name && appearance;
        const family = style?.family || source.font.match(/^Liberation(Sans|Serif|Mono)-/)[1];
        const weight = style ? (style.bold ? 'Bold' : '') + (style.italic ? 'Italic' : '') : null;
        let path = `./vendor/liberation-fonts/${style ? `Liberation${family}-${weight || 'Regular'}.ttf` : source.font}`;
        const size = style?.size ?? line.size;
        if (line.placed && (line.y + size > line.pageHeight - 4 || line.y - size * 0.35 < 4)) {
          throw new Error(`${prefix}: the field is too close to the page edge for this font size.`);
        }
        const points = Array.from(part.text, char => char.codePointAt(0));
        let selected = await loadFont(path);
        if (points.some(point => !selected.characters.has(point)) && /\p{Script=Han}/u.test(part.text)) {
          if (style?.bold || style?.italic) throw new Error(`${prefix}: the Chinese fallback supports regular text only.`);
          path = CHINESE_FONT;
          selected = await loadFont(path);
        }
        if (points.some(point => !selected.characters.has(point))) {
          throw new Error(`${prefix}: the replacement font does not contain every character.`);
        }
        const width = selected.font.widthOfTextAtSize(part.text, size);
        runs.push({ ...part, path, size, width, color: style?.color ?? source.color });
      }
      const available = line.maxRight - line.x;
      const fixed = runs.reduce((total, run) => total + (run.name ? 0 : run.width), 0);
      const flexible = runs.reduce((total, run) => total + (run.name ? run.width : 0), 0);
      const scale = flexible ? Math.min(1, (available - fixed) / flexible) : 1;
      if (!(scale > 0) || (scale < 0.999 && (!allowSmallerText || scale < 0.85))) {
        throw new Error(`${prefix}: the name does not fit the selected line.`);
      }
      for (const run of runs) {
        if (run.name) {
          run.size *= scale;
          run.width *= scale;
        }
      }
      planned.push({ line, text, runs });
    }
    result.push(planned);
  }
  return result;
}

export async function writeOriginalCopy(prepared, changes) {
  const doc = await window.PDFLib.PDFDocument.load(prepared.bytes, { updateMetadata: false });
  const loadFont = replacementFonts(doc);
  for (const { line, runs } of changes) {
    let x = line.x;
    for (const { text, path, color, size, width } of runs) {
      const { font } = await loadFont(path);
      const [r, g, b] = color;
      doc.getPage(line.page).drawText(text, { x, y: line.y, size, font,
        ySkew: window.PDFLib.radians(Math.atan(line.skew)), color: window.PDFLib.rgb(r, g, b) });
      x += width;
    }
  }

  let bytes = await doc.save();
  if (changes.some(change => change.runs.some(run => run.path === CHINESE_FONT))) {
    // fontkit's direct Noto SC subset can contain invisible glyphs even when
    // ToUnicode is correct. Subset the valid, fully embedded PDF with MuPDF.
    const engine = await loadOriginalEngine();
    const output = engine.Document.openDocument(bytes, 'application/pdf');
    try {
      output.subsetFonts();
      const buffer = output.saveToBuffer('garbage=4,compress');
      try {
        bytes = buffer.asUint8Array().slice();
      } finally {
        buffer.destroy();
      }
    } finally {
      output.destroy();
    }
  }
  const check = await window.pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    if (check.numPages !== prepared.pageCount) throw new Error('The page count changed. No file was exported.');
    for (const [pageIndex, before] of prepared.pages) {
      const outputPage = await check.getPage(pageIndex + 1);
      const after = originalLines((await outputPage.getTextContent()).items);
      const pageChanges = changes.filter(({ line }) => line.page === pageIndex);
      const signature = (line, text) => JSON.stringify([
        Math.round(line.x * 10), Math.round(line.y * 10), text.replace(/\s+/g, ' ').trim(),
      ]);
      const expected = before.map(line => {
        const edit = pageChanges.find(change => !change.line.placed && change.line.x === line.x && change.line.y === line.y);
        return signature(line, edit?.text ?? line.text);
      }).concat(pageChanges.filter(change => change.line.placed).map(change => signature(change.line, change.text))).sort();
      const actual = after.map(line => signature(line, line.text)).sort();
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error(`Page ${pageIndex + 1}: verification found an unexpected text change. No file was exported.`);
      }
    }
  } finally {
    await check.destroy();
  }
  return new Blob([bytes], { type: 'application/pdf' });
}
