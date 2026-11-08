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
    if (size <= 0 || skewX || skewY || Math.abs(size - height) > 0.01) continue;
    // PDF.js may represent a wide column gutter as one synthetic space.
    if (item.str === ' ' && item.width > Math.max(18, size * 2)) continue;
    const row = baselines.get(y) ?? [];
    row.push({ ...item, x, y, size });
    baselines.set(y, row);
  }

  const lines = [];
  for (const row of baselines.values()) {
    let line;
    for (const item of row.sort((a, b) => a.x - b.x)) {
      if (!line || item.x - line.right > Math.max(18, item.size * 2)) {
        line = { text: '', x: item.x, y: item.y, right: item.x, size: item.size,
          fontName: item.fontName, mixed: false };
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
  if (rect[0] >= rect[2] || rect[1] >= rect[3] || glyphs.some(({ bounds }, index) =>
    !selectedSet.has(glyphs[index]) &&
    bounds[0] < rect[2] && rect[0] < bounds[2] && bounds[1] < rect[3] && rect[1] < bounds[3]
  )) {
    throw new Error(`Page ${line.page + 1}: replacing this line may remove nearby text.`);
  }
  const { font, color } = selected[0];
  if (selected.some(glyph => glyph.font !== font || glyph.color.some((value, index) => value !== color[index]))) {
    throw new Error(`Page ${line.page + 1}: the selected line has mixed text styling.`);
  }
  return { rect, font, color };
}

async function removeOriginalLines(original, lines) {
  const engine = await loadOriginalEngine();
  const source = engine.Document.openDocument(new Uint8Array(original.bytes), 'application/pdf');
  try {
    for (const index of new Set(lines.map(line => line.page))) {
      const sheet = source.loadPage(index);
      try {
        const page = await original.pdf.getPage(index + 1);
        const [x, y, , height] = page.view;
        if (x || y || page.rotate || page.userUnit !== 1) {
          throw new Error(`Page ${index + 1}: this page uses unsupported geometry.`);
        }
        for (const line of lines.filter(line => line.page === index)) {
          let plan = original.plans.get(line);
          if (!plan) {
            plan = redactRect(sheet, line, height);
            original.plans.set(line, plan);
          }
          const mark = sheet.createAnnotation('Redact');
          try {
            mark.setRect(plan.rect);
            mark.update();
          } finally {
            mark.destroy();
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
    if (line.mixed || crop.x || crop.y || crop.width !== media.width || crop.height !== media.height) {
      throw new Error(`Page ${line.page + 1}: this line uses a layout the replacement cannot preserve.`);
    }
  }
  const pages = new Map();
  for (const pageIndex of new Set(lines.map(line => line.page))) {
    const page = await original.pdf.getPage(pageIndex + 1);
    pages.set(pageIndex, originalLines((await page.getTextContent()).items));
  }
  const bytes = await removeOriginalLines(original, lines);
  return { bytes, pages, plans: original.plans, pageCount: original.pdf.numPages };
}

export async function writeOriginalCopy(prepared, changes, allowSmallerText) {
  const doc = await window.PDFLib.PDFDocument.load(prepared.bytes, { updateMetadata: false });
  doc.registerFontkit(window.fontkit);
  const fonts = new Map();
  async function embed(path) {
    if (!fonts.has(path)) {
      const font = await doc.embedFont(await loadReplacementFont(path), { subset: true });
      fonts.set(path, { font, characters: new Set(font.getCharacterSet()) });
    }
    return fonts.get(path);
  }

  for (const { line, text } of changes) {
    const page = doc.getPage(line.page);
    const plan = prepared.plans.get(line);
    const codepoints = Array.from(text, char => char.codePointAt(0));
    let selected = await embed(`./vendor/liberation-fonts/${plan.font}`);
    if (codepoints.some(point => !selected.characters.has(point)) && /\p{Script=Han}/u.test(text)) {
      selected = await embed('./vendor/noto/notosanssc-v40.ttf');
    }
    if (codepoints.some(point => !selected.characters.has(point))) {
      throw new Error(`Page ${line.page + 1}: the replacement font does not contain every character.`);
    }
    const { font } = selected;
    const maxWidth = line.maxRight - line.x;
    const width = font.widthOfTextAtSize(text, line.size);
    const size = Math.min(line.size, line.size * maxWidth / width);
    if (size < line.size - 0.01 && (!allowSmallerText || size < line.size * 0.85)) {
      throw new Error(`Page ${line.page + 1}: this name does not fit the selected line.`);
    }
    const [r, g, b] = plan.color;
    page.drawText(text, { x: line.x, y: line.y, size, font, color: window.PDFLib.rgb(r, g, b) });
  }

  const bytes = await doc.save();
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
        const edit = pageChanges.find(change => change.line.x === line.x && change.line.y === line.y);
        return signature(line, edit?.text ?? line.text);
      }).sort();
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
