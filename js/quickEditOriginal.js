import { copyText } from './quickEditCopyText.js';
import { t } from './i18n.js';
import { loadFontkit, loadPdfLib } from './lazyLibs.js';
import { loadPdfJs } from './pdfjsLoader.js';

const fontPromises = new Map();

// The heavy half of the save — MuPDF redaction, pdf-lib drawing and saving —
// runs in js/quickEditWorker.js so the page keeps answering taps (a 300-page
// book froze a phone's tab for 4.7 s at a time, 2026-11-12).
let worker = null;
let nextId = 0;
const pending = new Map();
function inWorker(type, payload, lines) {
  if (!worker) {
    worker = new Worker(new URL('./quickEditWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (data.result) request.resolve(data.result);
      else request.reject(data.refusal ? refusalError(data.refusal, request.lines?.[data.refusal.line]) : new Error(data.message));
    };
    worker.onerror = event => {
      event.preventDefault();
      for (const request of pending.values()) request.reject(new Error(event.message || 'Quick Edit worker failed to load'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, lines });
    worker.postMessage({ id, type, payload }, [payload.bytes]);
  });
}

// An error that belongs to one page carries it, and its line when one line is
// the cause: Replace all leaves that line (or page) as it was and saves the
// rest (js/processor.js)
function pageError(message, page, line) {
  return Object.assign(new Error(message), { page, line });
}

function refusalError({ code, page }, line) {
  return pageError(t(`quickedit_err_${code}`, { page }), page, line);
}

function loadReplacementFont(path) {
  if (!fontPromises.has(path)) {
    fontPromises.set(path, fetch(new URL(path, import.meta.url))
      .then(response => {
        if (!response.ok) throw new Error(t('quickedit_err_font'));
        return response.arrayBuffer();
      }).catch(error => { fontPromises.delete(path); throw error; }));
  }
  return fontPromises.get(path);
}

// splitFonts: a line keeps one font and size per piece (the in-place editor:
// a mixed line — a bold word in a sentence — is edited piece by piece, since
// the replacement can't keep two styles in one run). fontKey: the font a
// pdf.js font id stands for — Chrome's print splits one font into many
// subsets (a Chinese line of NotoSerifCJKsc came as one id per character,
// 2026-11-13), and those are one font, not a change of style.
export function originalLines(items, { splitFonts = false, fontKey = id => id } = {}) {
  const baselines = new Map();
  for (const item of items) {
    if (!item.str?.trim() && item.str !== ' ') continue;
    const [size, skewX, skewY, height, x, y] = item.transform;
    if (size <= 0 || skewX || Math.abs(skewY) > size * 0.4 || Math.abs(size - height) > 0.01) continue;
    // PDF.js may represent a wide column gutter as one synthetic space.
    if (item.str === ' ' && item.width > Math.max(18, size * 2)) continue;
    const row = baselines.get(y) ?? [];
    row.push({ ...item, x, y, size, skew: skewY / size, font: fontKey(item.fontName) });
    baselines.set(y, row);
  }

  const lines = [];
  for (const row of baselines.values()) {
    let line;
    for (const item of row.sort((a, b) => a.x - b.x)) {
      if (!line || item.x - line.right > Math.max(18, item.size * 2) ||
          Math.abs(item.skew - line.skew) > 0.01 ||
          (splitFonts && (item.font !== line.font || Math.abs(item.size - line.size) > 0.01))) {
        line = { text: '', x: item.x, y: item.y, right: item.x, size: item.size,
          font: item.font, mixed: false, skew: item.skew };
        lines.push(line);
      }
      line.text += item.str;
      line.right = Math.max(line.right, item.x + item.width);
      line.mixed ||= line.font !== item.font || Math.abs(line.size - item.size) > 0.01;
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

// The check after a save reads pdf.js's own pieces, not joined lines: a row is
// ordered piece by piece, so a subscript stays where it stands in a formula
// (joined lines put "2" after "β‖δ‖, (3)" on one side only, 2026-11-13).
const textPieces = items => items.filter(item => item.str?.trim())
  .map(item => ({ x: item.transform[4], y: item.transform[5], text: item.str }));

export async function prepareOriginalCopy(original, lines) {
  const pages = new Map();
  const heights = {};
  for (const pageIndex of new Set(lines.map(line => line.page))) {
    const page = await original.pdf.getPage(pageIndex + 1);
    const [x, y] = page.view;
    if (x || y || page.rotate || page.userUnit !== 1) {
      throw pageError(t('quickedit_err_geometry', { page: pageIndex + 1 }), pageIndex + 1);
    }
    heights[pageIndex] = page.view[3];
    pages.set(pageIndex, textPieces((await page.getTextContent()).items));
  }
  const { bytes, plans } = await inWorker('prepare', {
    bytes: original.bytes.slice(0),
    lines: lines.map(({ page, x, y, right, size, text, mixed, placed }) => ({ page, x, y, right, size, text, mixed, placed })),
    heights,
  }, lines);
  lines.filter(line => !line.placed).forEach((line, index) => original.plans.set(line, plans[index]));
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
  await Promise.all([loadPdfLib(), loadFontkit()]);
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
          throw pageError(recipientIndex == null ? t('quickedit_missing_chars', { page })
            : copyText(`${prefix}: the replacement font does not contain every character.`, `${prefix}：替代字体缺少部分字符。`), page, line);
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
        throw pageError(recipientIndex == null
          ? t('quickedit_line_too_long', { page })
          : copyText(`${prefix}: the name does not fit the selected line.`, `${prefix}：姓名放不进选中的文本行。`), page, line);
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
  const bytes = new Uint8Array((await inWorker('write', {
    bytes: prepared.bytes.slice(0),
    changes: changes.map(({ line, runs }) => ({ page: line.page, x: line.x, y: line.y, skew: line.skew,
      runs: runs.map(({ text, path, color, size, width }) => ({ text, path, color, size, width })) })),
  })).bytes);
  const check = await window.pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  try {
    if (check.numPages !== prepared.pageCount) throw new Error(t('quickedit_err_page_count'));
    for (const [pageIndex, before] of prepared.pages) {
      const outputPage = await check.getPage(pageIndex + 1);
      const after = textPieces((await outputPage.getTextContent()).items);
      const pageChanges = changes.filter(({ line }) => line.page === pageIndex);
      // Per row, its text with every space removed. MuPDF rewrites the page's
      // numbers to a tenth of a point and pdf.js may split a line into pieces
      // differently once a gap changes by a fraction of a point — neither is a
      // change a reader sees (8 of 31 corpus documents failed on them,
      // 2026-11-12). Rows chain pieces whose baselines are within 1.5 pt: two
      // pieces 0.6 pt apart (a formula next to its words) were two rows before
      // the save and one after (2026-11-13). The edit is put into its row's
      // text where the old piece stood — it can sit mid-row, after an italic
      // word. A word gained, lost or changed still fails the check.
      const squash = value => value.replace(/\s+/g, '');
      const rowsOf = entries => {
        const rows = [];
        for (const { y, x, text } of [...entries].sort((a, b) => b.y - a.y || a.x - b.x)) {
          const row = rows[rows.length - 1];
          if (row && row.y - y <= 1.5) { row.y = y; row.parts.push({ x, text }); } else rows.push({ y, top: y, parts: [{ x, text }] });
        }
        return rows.map(row => ({ top: row.top, y: row.y, text: squash(row.parts.sort((a, b) => a.x - b.x).map(part => part.text).join('')) }));
      };
      const expectedRows = rowsOf(before
        .concat(pageChanges.filter(change => change.line.placed).map(change => ({ y: change.line.y, x: change.line.x, text: change.text }))));
      for (const change of pageChanges.filter(change => !change.line.placed)) {
        const row = expectedRows.find(candidate => change.line.y <= candidate.top + 0.5 && change.line.y >= candidate.y - 0.5);
        const old = squash(change.line.text);
        const at = row ? row.text.indexOf(old) : -1;
        if (at >= 0) row.text = row.text.slice(0, at) + squash(change.text) + row.text.slice(at + old.length);
      }
      const expected = expectedRows.map(row => row.text).filter(Boolean).sort();
      const actual = rowsOf(after).map(row => row.text).filter(Boolean).sort();
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw pageError(t('quickedit_err_verify', { page: pageIndex + 1 }), pageIndex + 1);
      }
    }
  } finally {
    await check.destroy();
  }
  return new Blob([bytes], { type: 'application/pdf' });
}
