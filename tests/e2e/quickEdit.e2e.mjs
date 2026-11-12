// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/quickEdit.e2e.mjs — real-browser regression test for
//  "Quick Edit PDF" (js/quickEditUI.js + the shared docxToPdfCore.js /
//  _buildPdf2WordDocxBlob pipeline it drives).
//
//  This tool's entire value proposition is "PDF -> DOCX -> in-browser edit
//  -> PDF, and the edit actually survives the round trip" — so, per this
//  project's own "verify empirically" standard, a passing unit test isn't
//  convincing evidence on its own. This drives the real UI end to end
//  (real file input, real click-to-edit on the real rendered docx-preview
//  DOM, real keyboard typing) and then verifies the output TWO
//  independent ways:
//
//  1. Load the downloaded PDF back through raw pdf.js text extraction (a
//     completely separate code path from the pdfmake-based walk that
//     produced the file) and confirm the edited text is present AND the
//     original pre-edit text is absent.
//  2. Feed that same downloaded PDF into this site's own real pdf2word
//     tool (/pdf-to-word/) through a second real browser page, and
//     confirm ITS extraction — a second, independent pipeline — agrees.
//
//  Also covers: the Atlas ERI pre-edit gate correctly blocks a
//  text-extraction-failure document (reusing the existing
//  tests/fixtures/normal-3page.pdf — confirmed elsewhere this session to
//  score 20%/Heavy) and reaches neither the editor nor #mergeBtn's
//  enabled state.
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/quickEdit.e2e.mjs
// ============================================================

import { chromium, firefox, webkit } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const EXTRACTABLE_PDF = path.join(__dirname, '..', 'fixtures', 'quickedit_extractable_text.pdf');
const HEAVY_PDF        = path.join(__dirname, '..', 'fixtures', 'normal-3page.pdf');
const UNSUPPORTED_SCRIPT_PDF = path.join(__dirname, '..', 'fixtures', 'quickedit_unsupported_script.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy: () => { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
  };
}

const norm = s => s.replace(/\s+/g, ' ').trim();

// A file with a text layer opens in the page editor (in place); the rebuild
// editor these older flows test is one press away from it
async function useRebuildEditor(page) {
  await page.locator('.qe-modal--open #qeUseRebuild').click({ timeout: 20000 });
}

async function captureDownload(page) {
  let buf = null;
  await page.exposeFunction('__qeCapture', (b64) => { buf = Buffer.from(b64, 'base64'); });
  await page.addInitScript(() => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      if (blob instanceof Blob) {
        blob.arrayBuffer().then(ab => {
          // in chunks: a spread of a multi-MB file (an embedded CJK font) overflows the stack
          const u = new Uint8Array(ab);
          let s = '';
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
          window.__qeCapture(btoa(s));
        });
      }
      return orig.call(URL, blob);
    };
  });
  return () => buf;
}

console.log(`Quick Edit PDF E2E — real end-to-end round trip (real browser, ${BASE_URL}):`);

const engine = { chromium, firefox, webkit }[process.env.PDFREE_BROWSER || 'chromium'];
const browser = await engine.launch({ executablePath: process.env.CHROME_PATH });

await test('Atlas gate blocks a text-extraction-failure document (no editor, #mergeBtn disabled)', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE_URL}/quick-edit-pdf/`);
  await page.waitForSelector('#fileInput', { state: 'attached' });
  const input = await page.$('#fileInput');
  await input.setInputFiles([HEAVY_PDF]);
  await useRebuildEditor(page);
  await page.waitForTimeout(3000);

  const html = await page.locator('#quickEditOptions').innerHTML();
  expect(html.includes('qeReopenBtn')).toBeFalsy();
  expect(html.includes('/pdf-to-word/')).toBeTruthy();
  const modalOpen = await page.locator('.qe-modal--open').count();
  expect(modalOpen).toBe(0);
  const disabled = await page.locator('#mergeBtn').isDisabled();
  expect(disabled).toBeTruthy();
  await page.locator('#qeOpenOriginal').click();
  await page.locator('#qeOriginalPage').waitFor({ state: 'visible' });
  expect(await page.locator('#qeModalSaveBtn').isVisible()).toBeFalsy();
  expect(await page.locator('[data-download]').isEnabled()).toBeFalsy();
  await page.locator('#qeModalClose').click();
  expect(await page.locator('#mergeBtn').isDisabled()).toBeTruthy();
  await page.close();
});

let outputBuf = null;

await test('a clean document opens the editor, click-to-edit changes only the clicked run, Save produces a real PDF', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const getDownload = await captureDownload(page);

  await page.goto(`${BASE_URL}/quick-edit-pdf/`);
  await page.waitForSelector('#fileInput', { state: 'attached' });
  const input = await page.$('#fileInput');
  await input.setInputFiles([EXTRACTABLE_PDF]);
  await useRebuildEditor(page);
  await page.waitForSelector('.qe-modal--open .qe-editable-run', { timeout: 20000 });
  await page.waitForTimeout(300);

  const badge = await page.locator('.atlas-check__badge').first().innerText();
  expect(badge.includes('Ready') || badge.includes('%')).toBeTruthy();

  // A locator filtered by hasText re-resolves its filter on every call —
  // once the edit below changes the span's text, a hasText-based locator
  // can no longer find the SAME element (confirmed the hard way during
  // Stage 3's own manual verification). Resolve the target's stable INDEX
  // among .qe-editable-run once, then address it by position for every
  // subsequent access — position survives the text change, text doesn't.
  const targetIndex = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.qe-editable-run'));
    return spans.findIndex(s => s.textContent.includes('typo that needs fixing'));
  });
  expect(targetIndex >= 0).toBeTruthy();
  const target = page.locator('.qe-editable-run').nth(targetIndex);

  const beforeClass = await target.evaluate(el => el.className);
  const beforeStyle = await target.evaluate(el => el.getAttribute('style'));
  await target.click();
  await page.waitForTimeout(150);
  const editable = await target.evaluate(el => el.isContentEditable);
  expect(editable).toBeTruthy();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('This paragraph has been CORRECTED via Quick Edit.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  const afterClass = await target.evaluate(el => el.className.replace(' qe-editable-run--active', '').trim());
  const afterStyle  = await target.evaluate(el => el.getAttribute('style'));
  const afterChildTypes = await target.evaluate(el => Array.from(el.childNodes).map(n => n.nodeType));
  expect(afterClass).toBe(beforeClass);
  expect(afterStyle).toBe(beforeStyle);
  expect(afterChildTypes.length === 1 && afterChildTypes[0] === 3).toBeTruthy();

  await page.click('#qeModalSaveBtn');
  await page.waitForSelector('#successCard', { timeout: 20000 });

  const buf = getDownload();
  expect(!!buf).toBeTruthy();
  expect(buf.slice(0, 4).toString()).toBe('%PDF');
  outputBuf = buf;
  await page.close();
});

await test('independent check #1 — raw pdf.js re-extraction confirms the edit survived, original text is gone', async () => {
  if (!outputBuf) throw new Error('no output from the previous test to check');
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/merge-pdf/`); // any real page — just needs pdf.js loadable
  const text = await page.evaluate(async (b64) => {
    const pdf2jpgUI = await import('/js/pdf2jpgUI.js');
    await pdf2jpgUI.loadPdfJs();
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const p1 = await doc.getPage(1);
    const content = await p1.getTextContent();
    return content.items.map(i => i.str).join(' ');
  }, outputBuf.toString('base64'));
  const t = norm(text);
  expect(t.includes(norm('CORRECTED via Quick Edit'))).toBeTruthy();
  expect(t.includes(norm('typo that needs fixing'))).toBeFalsy();
  expect(t.includes(norm('Quick Edit Fixture Document'))).toBeTruthy(); // untouched title survived
  await page.close();
});

await test('independent check #2 — this site\'s own real pdf2word tool re-extraction agrees', async () => {
  if (!outputBuf) throw new Error('no output from the previous test to check');
  const page = await browser.newPage();
  const getDownload = await captureDownload(page);
  await page.goto(`${BASE_URL}/pdf-to-word/`);
  await page.waitForSelector('#fileInput', { state: 'attached' });
  const input = await page.$('#fileInput');
  await input.setInputFiles([{ name: 'output.pdf', mimeType: 'application/pdf', buffer: outputBuf }]);
  await page.waitForSelector('.file-item', { timeout: 10000 });
  await page.waitForTimeout(1500); // avoid the file-select race discovered earlier this session
  await page.click('#mergeBtn');
  await page.waitForSelector('#successCard', { timeout: 20000 });

  const docxBuf = getDownload();
  expect(!!docxBuf).toBeTruthy();
  const xml = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const zip = await window.JSZip.loadAsync(bytes);
    return zip.file('word/document.xml').async('string');
  }, docxBuf.toString('base64'));
  const flat = norm(xml.replace(/<[^>]+>/g, ' '));
  expect(flat.includes(norm('CORRECTED via Quick Edit'))).toBeTruthy();
  expect(flat.includes(norm('typo that needs fixing'))).toBeFalsy();
  await page.close();
});

await test('Save on a document with intact RTL text shows the same unsupported-script warning word-to-pdf shows, instead of silently wiping it to NUL bytes', async () => {
  // Real bug found via overnight round-2 stress testing: word-to-pdf's own
  // docxToPdf() wrapper threads walkDomToPdfContent()'s hasUnsupportedScript
  // flag through to a warning toast (see docx2pdf.e2e.mjs's own sibling
  // test) — but Quick Edit's _runQuickEdit() calls
  // walkDomToPdfContent()/pdfContentToBlob() directly and used to drop the
  // flag on the floor. Confirmed empirically before the fix: a PDF with
  // genuinely intact Hebrew text got ALL of that text silently wiped to NUL
  // bytes on Save — even with zero edits made — while #successCard reported
  // plain success and #toast stayed completely silent.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const toasts = [];
  await page.exposeFunction('__recordToast', (txt) => toasts.push(txt));
  await page.goto(`${BASE_URL}/quick-edit-pdf/`, { waitUntil: 'load' });
  await page.evaluate(() => {
    const el = document.getElementById('toast');
    if (!el) return;
    new MutationObserver(() => { if (el.textContent.trim()) window.__recordToast(el.textContent.trim()); })
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.waitForSelector('#fileInput', { state: 'attached' });
  await page.setInputFiles('#fileInput', UNSUPPORTED_SCRIPT_PDF);
  await useRebuildEditor(page);
  await page.waitForSelector('.qe-modal--open .qe-editable-run', { timeout: 20000 });
  await page.click('#qeModalSaveBtn');
  await page.waitForSelector('#successCard', { timeout: 20000 });
  await page.waitForTimeout(300);

  const sawWarning = toasts.some(t => /Chinese|Japanese|Korean|Arabic|Hebrew|Thai|emoji/i.test(t));
  if (!sawWarning) throw new Error(`Expected an unsupported-script warning toast, saw: ${JSON.stringify(toasts)}`);
  await page.close();
});

await test('personalized copies replace only selected text and export one PDF per recipient', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE_URL}/quick-edit-pdf/`);
    await page.setInputFiles('#fileInput', EXTRACTABLE_PDF);
    await useRebuildEditor(page);
    await page.waitForSelector('.qe-modal--open .qe-editable-run');
    await page.getByRole('button', { name: 'Create personalized copies' }).click();
    expect(await page.locator('#qeModalSaveBtn').isVisible()).toBeFalsy();
    expect(await page.locator('[data-download]').isEnabled()).toBeFalsy();
    await page.locator('[data-recipient-file]').setInputFiles({
      name: 'recipients.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Group,Full name\nA,Anna Example\nB,Boris Example\nC,Anna Example\nD,'),
    });
    await page.locator('[data-import-column]').selectOption('1');
    const importSummary = await page.locator('[data-import-preview]').innerText();
    expect(importSummary.includes('1 blank or non-text rows skipped')).toBeTruthy();
    expect(importSummary.includes('1 repeated names kept as separate copies')).toBeTruthy();
    await page.getByRole('button', { name: 'Use this column' }).click();
    expect(await page.locator('#qeCopies textarea').inputValue()).toBe('Anna Example\nBoris Example\nAnna Example');
    await page.locator('#qeCopies textarea').fill('Anna Example\nBoris Example');
    expect(await page.locator('[data-recipient-count]').innerText()).toBe('2 recipients');
    expect(await page.locator('[data-download]').isEnabled()).toBeFalsy();
    const originals = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('.qe-editable-run'))
        .filter(span => span.firstChild?.nodeType === Node.TEXT_NODE && /[a-z]{4}/i.test(span.textContent));
      return spans.slice(0, 2).map(span => span.textContent.match(/[a-z]{4}/i)[0]);
    });
    expect(originals.length).toBe(2);
    for (let index = 0; index < originals.length; index++) {
      await page.evaluate(index => {
        const spans = Array.from(document.querySelectorAll('.qe-editable-run'))
          .filter(span => span.firstChild?.nodeType === Node.TEXT_NODE && /[a-z]{4}/i.test(span.textContent));
        const span = spans[index];
        const start = span.textContent.search(/[a-z]{4}/i);
        const range = document.createRange();
        range.setStart(span.firstChild, start);
        range.setEnd(span.firstChild, start + 4);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }, index);
      await page.getByRole('button', { name: 'Use selected text' }).click();
      expect(await page.locator('[data-field-count]').innerText()).toBe(`${index + 1} ${index === 0 ? 'field' : 'fields'} selected`);
    }
    await page.locator('#qeCopyRecipient').selectOption('1');
    const [sample] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download sample PDF' }).click(),
    ]);
    expect(sample.suggestedFilename()).toBe('2 - Boris Example.pdf');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download ZIP' }).click(),
    ]);
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(await download.path());
    const copies = await page.evaluate(async bytes => {
      const zip = await window.JSZip.loadAsync(bytes);
      const pdfjs = await import('/js/vendor/pdfjs-4.10.38/pdf.min.js');
      pdfjs.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs-4.10.38/pdf.worker.min.js';
      const result = [];
      for (const entry of Object.values(zip.files)) {
        const doc = await pdfjs.getDocument({ data: await entry.async('uint8array') }).promise;
        const content = await (await doc.getPage(1)).getTextContent();
        result.push(content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim());
        await doc.destroy();
      }
      return result;
    }, Array.from(bytes));
    expect(copies.length).toBe(2);
    expect(copies[0].split('Anna Example').length).toBe(3);
    expect(copies[1].split('Boris Example').length).toBe(3);
    expect(copies[0].includes('Boris Example')).toBeFalsy();
    expect(copies[0].includes('A second independent paragraph for testing purposes.')).toBeTruthy();
    await page.locator('#qeCopies textarea').fill('王小明');
    await page.getByRole('button', { name: 'Download ZIP' }).click();
    await page.locator('#qeCopies [role=status]').filter({ hasText: 'cannot export safely' }).waitFor();
    expect(await page.locator('.qe-editable-run').allTextContents().then(values => values.some(value => value.includes('Anna Example')))).toBeFalsy();
  } finally {
    await page.close();
  }
});

await test('preserve original layout replaces separate columns on two original PDF pages', async () => {
  const { PDFDocument, PDFName, StandardFonts, degrees } = await import('pdf-lib');
  const input = await PDFDocument.create();
  const font = await input.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index++) {
    const sheet = input.addPage([500, 600]);
    sheet.node.set(PDFName.of('CropBox'), input.context.obj([0, 600, 500, 0]));
    sheet.drawText('1', { x: 50, y: 500, size: 12, font, ySkew: degrees(index ? 0 : 12) });
    sheet.drawText('Other party: 1', { x: 275, y: 500, size: 12, font });
    sheet.drawText('This paragraph remains unchanged.', { x: 50, y: 450, size: 12, font });
  }
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE_URL}/quick-edit-pdf/`);
    await page.setInputFiles('#fileInput', {
      name: 'layout-test.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await input.save()),
    });
    await useRebuildEditor(page);
    await page.waitForSelector('.qe-modal--open .qe-editable-run');
    await page.locator('[data-copies-toggle]').click();
    await page.locator('#qeCopies textarea').fill('王小明');
    await page.locator('[data-preserve-layout]').check();
    await page.waitForFunction(() => !document.querySelector('[data-preserve-layout]').disabled);
    if (!await page.locator('[data-preserve-layout]').isChecked()) {
      throw new Error(await page.locator('#qeCopies [role=status]').innerText());
    }
    for (let index = 0; index < 2; index++) {
      if (index) await page.locator('#qeOriginalPage').selectOption(String(index));
      const field = page.locator('.qe-original-line').filter({ hasText: /^1$/ });
      await field.evaluate(span => {
        const range = document.createRange();
        range.selectNodeContents(span.firstChild);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      });
      await page.locator('[data-bind]').click();
      expect(await page.locator('#qeCopies [role=status]').innerText()).toBe('Name field added.');
    }
    const names = page.locator('#qeCopies textarea');
    await names.fill('王小明\n' + '非常长的采购公司名称'.repeat(35));
    let downloads = 0;
    page.on('download', () => { downloads++; });
    await page.locator('[data-download]').click();
    await page.locator('#qeCopies [role=status]').filter({
      hasText: 'Recipient 2, page 1: the name does not fit',
    }).waitFor();
    expect(downloads).toBe(0);

    await names.fill(Array.from({ length: 30 }, () => '王小明').join('\n'));
    await page.locator('[data-download]').click();
    await page.locator('[data-stop]').click();
    await page.locator('#qeCopies [role=status]').filter({ hasText: 'Export stopped' }).waitFor();
    expect(downloads).toBe(0);
    await names.fill('王小明');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-preview]').click(),
    ]);
    const { readFile } = await import('node:fs/promises');
    const output = await readFile(await download.path());
    const text = await page.evaluate(async bytes => {
      const doc = await window.pdfjsLib.getDocument({ data: Uint8Array.from(bytes) }).promise;
      try {
        const pages = [];
        for (let index = 1; index <= doc.numPages; index++) {
          const sheet = await doc.getPage(index);
          const items = (await sheet.getTextContent()).items.filter(item => item.str.trim());
          const viewport = sheet.getViewport({ scale: 2 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext('2d');
          await sheet.render({ canvasContext: context, viewport }).promise;
          // Each Han glyph should visibly paint inside its own advance.
          // Text extraction alone passes even when the embedded outlines are missing.
          const glyphsVisible = Array.from({ length: 3 }, (_, index) => {
            const { data } = context.getImageData(100 + 24 * index, 173, 24, 31);
            return data.some((value, offset) => offset % 4 === 0 && value < 120);
          }).every(Boolean);
          pages.push({ glyphsVisible, items: items.map(item => [item.str, item.transform[4], item.transform[5]]) });
        }
        return pages;
      } finally {
        await doc.destroy();
      }
    }, Array.from(output));
    expect(text.length).toBe(2);
    for (const { items, glyphsVisible } of text) {
      expect(glyphsVisible).toBeTruthy();
      expect(items.some(([str, x, y]) => str === '王小明' && x === 50 && y === 500)).toBeTruthy();
      expect(items.some(([str, x, y]) => str === 'Other party: 1' && x === 275 && y === 500)).toBeTruthy();
      expect(items.some(([str]) => str === '1')).toBeFalsy();
    }
  } finally {
    await page.close();
  }
});

await test('original layout styles only the inserted name and can place a name on a scan', async () => {
  const { PDFDocument, PDFDict, PDFName, StandardFonts } = await import('pdf-lib');
  const input = await PDFDocument.create();
  const textPage = input.addPage([500, 600]);
  const font = await input.embedFont(StandardFonts.Helvetica);
  textPage.drawText('Dear CUSTOMER PLACEHOLDER, welcome.', { x: 50, y: 500, size: 12, font });
  const mobile = process.env.PDFREE_MOBILE_PREVIEW === '1';
  const page = await browser.newPage(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : {});
  try {
    const image = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 500;
      canvas.height = 600;
      const context = canvas.getContext('2d');
      context.fillStyle = 'white';
      context.fillRect(0, 0, 500, 600);
      context.fillStyle = 'black';
      context.font = '24px sans-serif';
      context.fillText('Raster-only sample', 50, 75);
      return canvas.toDataURL('image/png');
    });
    const scannedPage = input.addPage([500, 600]);
    scannedPage.drawImage(await input.embedPng(image), { x: 0, y: 0, width: 500, height: 600 });
    await page.goto(`${BASE_URL}/quick-edit-pdf/`);
    await page.setInputFiles('#fileInput', {
      name: 'text-and-scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await input.save()),
    });
    await page.locator('.qe-modal--open [data-copies-toggle]').click();
    await page.locator('#qeCopies textarea').fill('Anna Example');
    const line = page.locator('.qe-original-line').filter({ hasText: 'CUSTOMER PLACEHOLDER' });
    await line.evaluate(span => {
      const range = document.createRange();
      const start = span.textContent.indexOf('CUSTOMER');
      range.setStart(span.firstChild, start);
      range.setEnd(span.firstChild, start + 'CUSTOMER PLACEHOLDER'.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await page.locator('[data-bind]').click();
    await page.locator('#qeOriginalPage').selectOption('1');
    await page.locator('[data-place]').click();
    const preview = page.locator('.qe-original-page canvas');
    const box = await preview.boundingBox();
    const position = { x: box.width * 0.16, y: box.height * 0.28 };
    if (mobile) await preview.tap({ position });
    else await preview.click({ position });
    expect(await page.locator('[data-field-count]').innerText()).toBe('2 fields selected');
    expect(await page.locator('.qe-scan-field').innerText()).toBe('Anna Example');

    await page.locator('[data-name-style] summary').click();
    const styleToggle = page.locator('[data-style-enable]');
    const styleInputs = page.locator('[data-style-options] :is(input, select)');
    for (const control of await styleInputs.all()) expect(await control.isEnabled()).toBeFalsy();
    await styleToggle.check();
    for (const control of await styleInputs.all()) expect(await control.isEnabled()).toBeTruthy();
    await styleToggle.uncheck();
    for (const control of await styleInputs.all()) expect(await control.isEnabled()).toBeFalsy();
    await styleToggle.check();
    await page.locator('[data-style-font]').selectOption('Mono');
    await page.locator('[data-style-size]').fill('14');
    await page.locator('[data-style-color]').fill('#b80000');
    await page.locator('[data-style-bold]').check();
    await page.locator('[data-style-italic]').check();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-preview]').click(),
    ]);
    const { readFile } = await import('node:fs/promises');
    const file = await readFile(await download.path());
    const result = await page.evaluate(async bytes => {
      const pdf = await window.pdfjsLib.getDocument({ data: Uint8Array.from(bytes) }).promise;
      try {
        const first = await (await pdf.getPage(1)).getTextContent();
        const scan = await pdf.getPage(2);
        const second = await scan.getTextContent();
        const canvas = document.createElement('canvas');
        canvas.width = 500;
        canvas.height = 600;
        const context = canvas.getContext('2d');
        await scan.render({ canvasContext: context, viewport: scan.getViewport({ scale: 1 }) }).promise;
        const pixels = context.getImageData(0, 0, 500, 600).data;
        const red = pixels.some((value, i) => i % 4 === 0 && value > 120 && pixels[i + 1] < 70 && pixels[i + 2] < 70);
        const rasterPreserved = context.getImageData(45, 45, 300, 35).data
          .some((value, i) => i % 4 === 0 && value < 80);
        return { first: first.items, second: second.items, red, rasterPreserved };
      } finally {
        await pdf.destroy();
      }
    }, Array.from(file));
    const atSize = (items, size) => items.filter(item => item.transform[0] === size).map(item => item.str).join('');
    expect(atSize(result.first, 14)).toBe('Anna Example');
    expect(atSize(result.first, 12)).toBe('Dear , welcome.');
    expect(atSize(result.second, 14)).toBe('Anna Example');
    expect(result.red).toBeTruthy();
    expect(result.rasterPreserved).toBeTruthy();
    const output = await PDFDocument.load(file);
    expect(output.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFDict &&
      String(object.get(PDFName.of('BaseFont'))).includes('LiberationMono-BoldItalic'))).toBeTruthy();
  } finally {
    await page.close();
  }
});

await test('Simplified Chinese copies localizes import, overflow and cancellation', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const input = await PDFDocument.create();
  const sheet = input.addPage([500, 600]);
  const font = await input.embedFont(StandardFonts.Helvetica);
  sheet.drawText('1', { x: 50, y: 500, size: 12, font });
  sheet.drawText('Other party', { x: 275, y: 500, size: 12, font });
  const page = await browser.newPage();
  try {
    // The copies entry by its own link: the panel's "open original" button is replaced when the
    // regular conversion finishes, and on a slow CI machine a click landed on it mid-replacement
    // (deploy of #173, 2026-11-10). This test is about the Chinese copy, not that race.
    await page.goto(`${BASE_URL}/zh/kuaisu-bianji-pdf/?mode=personalized-copies`);
    await page.setInputFiles('#fileInput', {
      name: 'layout-test.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await input.save()),
    });
    await page.getByRole('heading', { name: '个性化 PDF 副本' }).waitFor();
    await page.locator('[data-recipient-file]').setInputFiles({
      name: 'recipients.csv', mimeType: 'text/csv', buffer: Buffer.from('姓名\n王小明'),
    });
    await page.locator('[data-import-column]').selectOption('0');
    await page.getByRole('button', { name: '使用此列' }).click();
    const status = page.locator('#qeCopies [role=status]');
    expect(await status.innerText()).toBe('收件人列表已导入。');
    const field = page.locator('.qe-original-line').filter({ hasText: /^1$/ });
    await field.evaluate(span => {
      const range = document.createRange();
      range.selectNodeContents(span.firstChild);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await page.getByRole('button', { name: '使用选中的文字' }).click();
    await page.locator('#qeCopies textarea').fill('王小明\n' + '非常长的采购公司名称'.repeat(25));
    await page.getByRole('button', { name: '检查所有姓名' }).click();
    await status.filter({ hasText: '第 2 位收件人，第 1 页：姓名放不进选中的文本行。' }).waitFor();
    await page.locator('#qeCopies textarea').fill(Array.from({ length: 30 }, () => '王小明').join('\n'));
    await page.getByRole('button', { name: '下载 ZIP' }).click();
    await page.getByRole('button', { name: '停止导出' }).click();
    await status.filter({ hasText: '已停止导出。可编辑列表后重试。' }).waitFor();
  } finally {
    await page.close();
  }
});

await test('homepage search and Watermark open personalized copies in the existing editor', async () => {
  const page = await browser.newPage();
  try {
    for (const [home, query, editor] of [
      ['/', 'pdf mail merge', '/quick-edit-pdf/'],
      ['/zh/', 'Excel名单生成PDF', '/zh/kuaisu-bianji-pdf/'],
    ]) {
      await page.goto(BASE_URL + home);
      await page.locator('#toolSearch').fill(query);
      const link = page.locator('#searchResult [role=link]');
      await link.waitFor();
      await link.press('Enter');
      await page.waitForURL(BASE_URL + editor + '?mode=personalized-copies');
      expect(await page.locator('[data-qe-mode=personalized-copies]').getAttribute('aria-pressed')).toBe('true');
    }
    await page.goto(BASE_URL + '/zh/shuiyin-pdf/');
    await page.getByRole('link', { name: '在文档正文中替换为每个姓名' }).click();
    await page.waitForURL(BASE_URL + '/zh/kuaisu-bianji-pdf/?mode=personalized-copies');
    await page.setInputFiles('#fileInput', EXTRACTABLE_PDF);
    await page.getByRole('heading', { name: '个性化 PDF 副本' }).waitFor();
    expect(await page.locator('#qeCopyNames').inputValue()).toBe('');
  } finally {
    await page.close();
  }
});

await test('example loads fictional recipients and exports a ZIP without a user file', async () => {
  const page = await browser.newPage({ acceptDownloads: true });
  try {
    await page.goto(BASE_URL + '/quick-edit-pdf/');
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.locator('#qeCopies').waitFor();
    expect(await page.locator('#qeCopyNames').inputValue()).toBe('Alex Morgan\nJamie Chen');
    const suggestion = page.getByRole('button', { name: 'Recipient: SAMPLE NAME' });
    await suggestion.click();
    expect(await suggestion.isDisabled()).toBeTruthy();
    expect(await page.locator('[data-field-count]').innerText()).toBe('1 field selected');
    await page.getByRole('button', { name: 'Preview on page' }).click();
    await page.getByRole('img', { name: 'Generated PDF preview' }).waitFor();
    await page.locator('#qeCopyRecipient').selectOption('1');
    await page.getByRole('img', { name: 'Generated PDF preview' }).waitFor();
    await page.getByRole('button', { name: 'Back to field editing' }).click();
    expect(await page.getByRole('img', { name: 'Generated PDF preview' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Check all names' }).click();
    await page.locator('#qeCopies [role=status]').filter({ hasText: 'All names fit' }).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-download]').click(),
    ]);
    expect(download.suggestedFilename().endsWith('.zip')).toBeTruthy();
  } finally {
    await page.close();
  }
});

await test('an explicitly reserved scan field wraps long names while retaining the font size', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const { readFile } = await import('node:fs/promises');
  const input = await PDFDocument.create();
  input.addPage([500, 600]);
  const page = await browser.newPage({ acceptDownloads: true });
  try {
    await page.goto(BASE_URL + '/quick-edit-pdf/?mode=personalized-copies');
    await page.setInputFiles('#fileInput', {
      name: 'blank.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await input.save()),
    });
    await page.locator('#qeCopyNames').fill('Alexandria Montgomery Catherine Richardson');
    await page.locator('[data-wrap-name]').check();
    await page.locator('[data-place]').click();
    await page.locator('.qe-original-page canvas').click({ position: { x: 80, y: 120 } });
    await page.locator('.qe-scan-field--wrap').waitFor();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-preview]').click(),
    ]);
    const bytes = await readFile(await download.path());
    const lines = await page.evaluate(async data => {
      const pdf = await window.pdfjsLib.getDocument({ data: Uint8Array.from(data) }).promise;
      try {
        const content = await (await pdf.getPage(1)).getTextContent();
        return content.items.filter(item => item.str).map(item => ({
          text: item.str, size: item.transform[0], y: item.transform[5],
        }));
      } finally {
        await pdf.destroy();
      }
    }, Array.from(bytes));
    expect(lines.length).toBe(2);
    expect(lines.map(line => line.text).join(' ')).toBe('Alexandria Montgomery Catherine Richardson');
    expect(lines.every(line => line.size === 12)).toBeTruthy();
    expect(lines[0].y - lines[1].y).toBe(15);
  } finally {
    await page.close();
  }
});

// The users' own request ("watermark-batch", 💬 2026-11-09/10): one PDF per
// person with that person's name in the watermark — in the Watermark tool.
await test('Watermark personalized copies: one PDF per name, the name in each watermark, any script', async () => {
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      window.__blob = null;
      const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob instanceof Blob && /zip/.test(blob.type)) window.__blob = blob; return original(blob); };
    });
    await page.goto(`${BASE_URL}/watermark-pdf/`);
    await page.setInputFiles('#fileInput', EXTRACTABLE_PDF);
    await page.locator('#wmCopies').waitFor();
    // {name} without copies, and copies without {name}, are refused with a reason
    await page.locator('#wmText').fill('Draft for {name}');
    await page.click('#mergeBtn');
    await page.locator('#toast').filter({ hasText: 'Turn on personalized copies' }).waitFor();
    expect(await page.locator('#wmCopiesBody').isVisible()).toBeFalsy();
    await page.locator('#wmCopies').check();
    // the import settings appear only once a table is chosen
    expect(await page.locator('#wmCopiesBody [data-import-options]').isVisible()).toBeFalsy();
    await page.locator('#wmText').fill('Confidential');
    await page.locator('#wmNames').fill('Anna Example');
    await page.click('#mergeBtn');
    await page.locator('#toast').filter({ hasText: 'Write {name}' }).waitFor();
    // the template button, a CSV import, then Latin, Cyrillic, Chinese and a repeated name
    await page.locator('#wmText').fill('Copy for ');
    await page.locator('#wmText').press('End');
    await page.click('#wmInsertName');
    expect(await page.locator('#wmText').inputValue()).toBe('Copy for {name}');
    await page.locator('#wmRecipientFile').setInputFiles({ name: 'people.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Group,Full name\nA,Anna Example\nB,Борис Пример\nC,张小明\nD,Anna Example') });
    await page.locator('#wmRecipientColumn').selectOption('1');
    await page.locator('#wmCopiesBody [data-import-apply]').click();
    expect(await page.locator('#wmNames').inputValue()).toBe('Anna Example\nБорис Пример\n张小明\nAnna Example');
    expect(await page.locator('#wmNamesCount').innerText()).toBe('4 copies');
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob, null, { timeout: 60000 });
    const copies = await page.evaluate(async () => {
      const zip = await window.JSZip.loadAsync(await window.__blob.arrayBuffer());
      const pdfjs = await import('/js/vendor/pdfjs-4.10.38/pdf.min.js');
      pdfjs.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs-4.10.38/pdf.worker.min.js';
      const out = [];
      for (const name of Object.keys(zip.files).sort()) {
        const doc = await pdfjs.getDocument({ data: await zip.files[name].async('uint8array') }).promise;
        const page1 = await doc.getPage(1);
        const text = (await page1.getTextContent()).items.map(i => i.str).join(' ');
        const ops = await page1.getOperatorList();
        const images = ops.fnArray.filter(f => f === pdfjs.OPS.paintImageXObject).length;
        out.push({ name, pages: doc.numPages, text, images });
        await doc.destroy();
      }
      return out;
    });
    expect(copies.map(c => c.name).join('|')).toBe(
      'quickedit_extractable_text-Anna Example (2).pdf|quickedit_extractable_text-Anna Example.pdf|quickedit_extractable_text-Борис Пример.pdf|quickedit_extractable_text-张小明.pdf');
    for (const c of copies) expect(c.pages >= 1).toBeTruthy();
    const byName = Object.fromEntries(copies.map(c => [c.name, c]));
    expect(byName['quickedit_extractable_text-Anna Example.pdf'].text.includes('Copy for Anna Example')).toBeTruthy();
    expect(byName['quickedit_extractable_text-Борис Пример.pdf'].text.includes('Copy for Борис Пример')).toBeTruthy();
    expect(byName['quickedit_extractable_text-Anna Example.pdf'].text.includes('Борис')).toBeFalsy();
    // Chinese: the font has no Han glyphs, so the watermark is drawn as an image (watermarkTextWorker.js)
    expect(byName['quickedit_extractable_text-张小明.pdf'].images >= 1).toBeTruthy();
    expect(byName['quickedit_extractable_text-Anna Example.pdf'].images).toBe(0);
    // the original text is still there under the watermark
    expect(byName['quickedit_extractable_text-张小明.pdf'].text.length > 20).toBeTruthy();
  } finally {
    await page.close();
  }
});

await test('Quick Edit copies with a watermark: the name in the text and in the watermark of each copy', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE_URL}/quick-edit-pdf/`);
    await page.setInputFiles('#fileInput', EXTRACTABLE_PDF);
    await useRebuildEditor(page);
    await page.waitForSelector('.qe-modal--open .qe-editable-run');
    await page.getByRole('button', { name: 'Create personalized copies' }).click();
    await page.locator('#qeCopies textarea').fill('Anna Example\nBoris Example');
    await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll('.qe-editable-run'))
        .find(s => s.firstChild?.nodeType === Node.TEXT_NODE && /[a-z]{4}/i.test(s.textContent));
      const start = span.textContent.search(/[a-z]{4}/i);
      const range = document.createRange();
      range.setStart(span.firstChild, start);
      range.setEnd(span.firstChild, start + 4);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await page.getByRole('button', { name: 'Use selected text' }).click();
    // the watermark settings appear only once it is turned on; empty text is refused with a reason
    expect(await page.locator('[data-wm-options]').isVisible()).toBeFalsy();
    await page.locator('#qeCopyWm').check();
    expect(await page.locator('#qeCopyWmText').inputValue()).toBe('Copy for {name}');
    await page.locator('#qeCopyWmText').fill('  ');
    await page.getByRole('button', { name: 'Download ZIP' }).click();
    await page.locator('#qeCopies [role=status]').filter({ hasText: 'Write the watermark text' }).waitFor();
    await page.locator('#qeCopyWmText').fill('Copy for {name}');
    await page.locator('#qeCopyWmPosition').selectOption('tile');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download ZIP' }).click(),
    ]);
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(await download.path());
    const copies = await page.evaluate(async bytes => {
      const zip = await window.JSZip.loadAsync(new Uint8Array(bytes));
      const pdfjs = await import('/js/vendor/pdfjs-4.10.38/pdf.min.js');
      pdfjs.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs-4.10.38/pdf.worker.min.js';
      const out = [];
      for (const name of Object.keys(zip.files).sort()) {
        const doc = await pdfjs.getDocument({ data: await zip.files[name].async('uint8array') }).promise;
        const text = (await (await doc.getPage(1)).getTextContent()).items.map(i => i.str).join(' ').replace(/\s+/g, ' ');
        out.push({ name, text });
        await doc.destroy();
      }
      return out;
    }, Array.from(bytes));
    expect(copies.map(c => c.name).join('|')).toBe('1 - Anna Example.pdf|2 - Boris Example.pdf');
    const [anna, boris] = copies.map(c => c.text);
    // tiled: the watermark repeats; the field holds the same name; nothing of the other recipient
    expect(anna.split('Copy for Anna Example').length > 2).toBeTruthy();
    expect(anna.replaceAll('Copy for Anna Example', '').includes('Anna Example')).toBeTruthy();
    expect(anna.includes('Boris')).toBeFalsy();
    expect(boris.includes('Copy for Boris Example')).toBeTruthy();
    expect(boris.includes('Anna')).toBeFalsy();
    expect(anna.includes('A second independent paragraph for testing purposes.')).toBeTruthy();
  } finally {
    await page.close();
  }
});

// ── In place (the default for a file with a text layer): only the edited line
// changes; the page count, the other lines and the other pages stay as they were

async function inPlaceDoc() {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const sheet = doc.addPage([420, 595]);
    sheet.drawText(`Chapter ${i} heading`, { x: 40, y: 540, size: 16, font });
    sheet.drawText(`Body text on page ${i} stays exactly as written.`, { x: 40, y: 500, size: 11, font });
    sheet.drawText('Join our group for more books: example0001', { x: 40, y: 40, size: 8, font });
  }
  return Buffer.from(await doc.save());
}

async function pagesText(page, buf) {
  return page.evaluate(async (b64) => {
    const pdf2jpgUI = await import('/js/pdf2jpgUI.js');
    await pdf2jpgUI.loadPdfJs();
    const doc = await window.pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), c => c.charCodeAt(0)) }).promise;
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      out.push((await (await doc.getPage(i)).getTextContent()).items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim());
    }
    return out;
  }, buf.toString('base64'));
}

async function editLine(page, from, to) {
  const line = page.locator('.qe-page-line').filter({ hasText: from });
  await line.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type(to);
  await page.keyboard.press('Enter');
}

await test('in place: a file with text opens the page editor; only the edited line changes, pages and other text kept', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const getDownload = await captureDownload(page);
  try {
    await page.goto(`${BASE_URL}/quick-edit-pdf/`);
    await page.setInputFiles('#fileInput', { name: 'book.pdf', mimeType: 'application/pdf', buffer: await inPlaceDoc() });
    await page.waitForSelector('.qe-modal--open .qe-page-line', { timeout: 20000 });
    expect(await page.locator('.qe-editable-run').count()).toBe(0);
    await page.locator('[data-next]').click();
    await page.waitForSelector('.qe-page-line:has-text("page 2")');
    await editLine(page, 'Join our group', 'Visit pdfree.io');
    expect(await page.locator('.qe-page-line--edited').count()).toBe(1);
    // Escape on another line drops that edit, keeps the first
    await page.locator('.qe-page-line').filter({ hasText: 'Chapter 2' }).click();
    await page.keyboard.type(' DROPPED');
    await page.keyboard.press('Escape');
    expect(await page.locator('.qe-modal--open').count()).toBe(1);
    expect(await page.locator('.qe-page-line--edited').count()).toBe(1);
    await page.click('#qeModalSaveBtn');
    await page.waitForSelector('#successCard', { timeout: 30000 });
    for (let i = 0; i < 50 && !getDownload(); i++) await page.waitForTimeout(100);
    const buf = getDownload();
    expect(!!buf).toBeTruthy();
    const pages = await pagesText(page, buf);
    expect(pages.length).toBe(3);
    expect(pages[1].includes('Visit pdfree.io')).toBeTruthy();
    expect(pages[1].includes('example0001')).toBeFalsy();
    expect(pages[1].includes('DROPPED')).toBeFalsy();
    expect(pages[1].includes('Body text on page 2 stays exactly as written.')).toBeTruthy();
    expect(pages[0]).toBe('Chapter 1 heading Body text on page 1 stays exactly as written. Join our group for more books: example0001');
    expect(pages[2].includes('example0001')).toBeTruthy();
  } finally {
    await page.close();
  }
});

await test('in place: Chinese text can be typed into a Latin-font line and is saved as text', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const getDownload = await captureDownload(page);
  try {
    await page.goto(`${BASE_URL}/quick-edit-pdf/`);
    await page.setInputFiles('#fileInput', { name: 'book.pdf', mimeType: 'application/pdf', buffer: await inPlaceDoc() });
    await page.waitForSelector('.qe-modal--open .qe-page-line', { timeout: 20000 });
    await editLine(page, 'Chapter 1', '第一章 王小明');
    await page.click('#qeModalSaveBtn');
    await page.waitForSelector('#successCard', { timeout: 30000 });
    for (let i = 0; i < 50 && !getDownload(); i++) await page.waitForTimeout(100);
    const buf = getDownload();
    expect(!!buf).toBeTruthy();
    const pages = await pagesText(page, buf);
    expect(pages.length).toBe(3);
    expect(pages[0].replace(/\s/g, '').includes('第一章王小明')).toBeTruthy();
    expect(pages[0].includes('Chapter 1')).toBeFalsy();
  } finally {
    await page.close();
  }
});

await test('in place on a phone: no sideways page scroll, a tap reaches the line, copies and the previous editor one press away', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(`${BASE_URL}/quick-edit-pdf/`);
    await page.setInputFiles('#fileInput', { name: 'book.pdf', mimeType: 'application/pdf', buffer: await inPlaceDoc() });
    await page.waitForSelector('.qe-modal--open .qe-page-line', { timeout: 20000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    for (const sel of ['[data-prev]', '[data-next]', '[data-zoom]']) {
      const box = await page.locator(sel).boundingBox();
      if (Math.round(box.height) < 44 || Math.round(box.width) < 44) throw new Error(`${sel} is ${box.width}×${box.height}, under 44 px`);
    }
    await page.locator('[data-zoom]').click();
    const line = page.locator('.qe-page-line').filter({ hasText: 'Chapter 1' });
    await line.scrollIntoViewIfNeeded();
    const hit = await line.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
    expect(hit).toBeTruthy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    expect(await page.locator('#qeUseRebuild').isVisible()).toBeTruthy();
    await page.locator('.qe-modal--open [data-copies-toggle]').click();
    await page.locator('#qeOriginalPage').waitFor({ state: 'visible' });
    await page.locator('#qeModalClose').click();
    await page.locator('#qeReopenBtn').click();
    await page.waitForSelector('.qe-modal--open .qe-page-line');
  } finally {
    await page.close();
  }
});

await browser.close();

console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
