import { copyText } from './quickEditCopyText.js';
import { t } from './i18n.js';
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
        if (!response.ok) throw new Error(copyText('The replacement font could not be loaded.', "无法加载替代字体。"));
        return response.arrayBuffer();
      }).catch(error => { fontPromises.delete(path); throw error; }));
  }
  return fontPromises.get(path);
}

// splitFonts: a line keeps one font and size per piece (the in-place editor:
// a mixed line — a bold word in a sentence — is edited piece by piece, since
// the replacement can't keep two styles in one run)
export function originalLines(items, { splitFonts = false } = {}) {
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
          Math.abs(item.skew - line.skew) > 0.01 ||
          (splitFonts && (item.fontName !== line.fontName || Math.abs(item.size - line.size) > 0.01))) {
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
      throw new Error(copyText('Preserve layout is unavailable for interactive forms or signed PDFs.', "交互式表单或已签名的 PDF 暂不支持保留原始版式。"));
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
  // In MuPDF's reading order, not sorted by x: a ligature's parts share one
  // origin ("ff" + "e" in "difference" all at one x) and a sort mixed them up —
  // "difefrence" no longer matched the line (2026-11-12).
  const selected = glyphs.filter(({ origin }) =>
    Math.abs(origin[1] - baseline) <= 0.5 && origin[0] >= line.x - 0.3 && origin[0] < line.right - 0.1
  );
  const normalized = value => value.normalize('NFKC').replace(/\s+/g, '');
  if (!selected.length || normalized(selected.map(glyph => glyph.character).join('')) !== normalized(line.text)) {
    throw new Error(copyText(`Page ${line.page + 1}: the selected line could not be matched to the original text.`, `第 ${line.page + 1} 页：无法在原始 PDF 中匹配选中的文本行。`));
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
    throw new Error(copyText(`Page ${line.page + 1}: replacing this line may remove nearby text.`, `第 ${line.page + 1} 页：替换此行可能会误删附近的文字。`));
  }
  const { font, color } = selected[0];
  if (selected.some(glyph => glyph.font !== font || glyph.color.some((value, index) => value !== color[index]))) {
    throw new Error(copyText(`Page ${line.page + 1}: the selected line has mixed text styling.`, `第 ${line.page + 1} 页：选中的文本行包含多种文字样式。`));
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
    throw new Error(copyText('Preserve layout is unavailable for signed PDFs.', "已签名的 PDF 暂不支持保留原始版式。"));
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
      throw new Error(copyText(`Page ${line.page + 1}: this line uses a layout the replacement cannot preserve.`, `第 ${line.page + 1} 页：无法在保留此行版式的情况下替换文字。`));
    }
  }
  const pages = new Map();
  for (const pageIndex of new Set(lines.map(line => line.page))) {
    const page = await original.pdf.getPage(pageIndex + 1);
    const [x, y] = page.view;
    if (x || y || page.rotate || page.userUnit !== 1) {
      throw new Error(copyText(`Page ${pageIndex + 1}: this page uses unsupported geometry.`, `第 ${pageIndex + 1} 页：此页的尺寸或坐标设置暂不受支持。`));
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

// Keep words intact. Han names can break between adjacent ideographs.
function twoLineName(text, font, size, available) {
  const breaks = [...text.matchAll(/\s+|(?<=\p{Script=Han})(?=\p{Script=Han})/gu)];
  for (const { index } of breaks.reverse()) {
    const lines = [text.slice(0, index).trimEnd(), text.slice(index).trimStart()];
    if (lines.every(line => line && font.widthOfTextAtSize(line, size) <= available)) return lines;
  }
  return null;
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
      // recipientIndex null: an in-place edit (quickEditPage.js), no recipients
      const prefix = recipientIndex == null ? copyText(`Page ${page}`, `第 ${page} 页`)
        : copyText(`Recipient ${recipientIndex + 1}, page ${page}`, `第 ${recipientIndex + 1} 位收件人，第 ${page} 页`);
      const runs = [];
      for (const part of appearance ? parts : [{ text, name: true }]) {
        if (!part.text) continue;
        const style = part.name && appearance;
        const family = style?.family || source.font.match(/^Liberation(Sans|Serif|Mono)-/)[1];
        const weight = style ? (style.bold ? 'Bold' : '') + (style.italic ? 'Italic' : '') : null;
        let path = `./vendor/liberation-fonts/${style ? `Liberation${family}-${weight || 'Regular'}.ttf` : source.font}`;
        const size = style?.size ?? line.size;
        if (line.placed && (line.y + size > line.pageHeight - 4 || line.y - size * 0.35 < 4)) {
          throw new Error(copyText(`${prefix}: the field is too close to the page edge for this font size.`, `${prefix}：当前字号下，字段离页边太近。`));
        }
        const points = Array.from(part.text, char => char.codePointAt(0));
        let selected = await loadFont(path);
        if (points.some(point => !selected.characters.has(point)) && /\p{Script=Han}/u.test(part.text)) {
          if (style?.bold || style?.italic) throw new Error(copyText(`${prefix}: the Chinese fallback supports regular text only.`, `${prefix}：中文替代字体仅支持常规字形。`));
          path = CHINESE_FONT;
          selected = await loadFont(path);
        }
        if (points.some(point => !selected.characters.has(point))) {
          throw new Error(recipientIndex == null ? t('quickedit_missing_chars', { page })
            : copyText(`${prefix}: the replacement font does not contain every character.`, `${prefix}：替代字体缺少部分字符。`));
        }
        const width = selected.font.widthOfTextAtSize(part.text, size);
        runs.push({ ...part, path, size, width, color: style?.color ?? source.color });
      }
      const available = line.maxRight - line.x;
      const fixed = runs.reduce((total, run) => total + (run.name ? 0 : run.width), 0);
      const flexible = runs.reduce((total, run) => total + (run.name ? run.width : 0), 0);
      const scale = flexible ? Math.min(1, (available - fixed) / flexible) : 1;
      if (line.placed && line.wrap && scale < 0.999 && runs.length === 1 && runs[0].size <= 16) {
        const run = runs[0];
        const { font } = await loadFont(run.path);
        const wrapped = twoLineName(run.text, font, run.size, available);
        if (wrapped) {
          for (const [row, value] of wrapped.entries()) {
            const target = row ? { ...line, y: line.y - run.size * 1.25 } : line;
            planned.push({ line: target, text: value, runs: [{
              ...run, text: value, width: font.widthOfTextAtSize(value, run.size),
            }] });
          }
          continue;
        }
      }
      if (!(scale > 0) || (scale < 0.999 && (!allowSmallerText || scale < 0.85))) {
        throw new Error(recipientIndex == null
          ? t('quickedit_line_too_long', { page })
          : copyText(`${prefix}: the name does not fit the selected line.`, `${prefix}：姓名放不进选中的文本行。`));
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
    if (check.numPages !== prepared.pageCount) throw new Error(copyText('The page count changed. No file was exported.', "页数发生变化，未导出文件。"));
    for (const [pageIndex, before] of prepared.pages) {
      const outputPage = await check.getPage(pageIndex + 1);
      const after = originalLines((await outputPage.getTextContent()).items);
      const pageChanges = changes.filter(({ line }) => line.page === pageIndex);
      // Per baseline, its text with every space removed: MuPDF rewrites the page's
      // numbers to a tenth of a point (a whole line can move 0.1 pt) and pdf.js may
      // split a line into pieces differently once a gap changes by a fraction of a
      // point — neither is a change a reader sees, and both failed the check on 8 of
      // 31 corpus documents (2026-11-12). A word gained, lost or changed still does.
      const byBaseline = entries => {
        const rows = [];
        for (const { y, x, text } of entries.sort((a, b) => b.y - a.y || a.x - b.x)) {
          let row = rows.find(r => Math.abs(r.y - y) <= 0.5);
          if (!row) rows.push(row = { y, parts: [] });
          row.parts.push({ x, text });
        }
        return rows.map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.text).join('').replace(/\s+/g, ''))
          .filter(Boolean).sort();
      };
      const expected = byBaseline(before.map(line => {
        const edit = pageChanges.find(change => !change.line.placed && change.line.x === line.x && change.line.y === line.y);
        return { y: line.y, x: line.x, text: edit?.text ?? line.text };
      }).concat(pageChanges.filter(change => change.line.placed).map(change => ({ y: change.line.y, x: change.line.x, text: change.text }))));
      const actual = byBaseline(after.map(line => ({ y: line.y, x: line.x, text: line.text })));
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error(copyText(`Page ${pageIndex + 1}: verification found an unexpected text change. No file was exported.`, `第 ${pageIndex + 1} 页：检查发现意外的文字变化，未导出文件。`));
      }
    }
  } finally {
    await check.destroy();
  }
  return new Blob([bytes], { type: 'application/pdf' });
}
