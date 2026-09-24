// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/quickEditSkeleton.e2e.mjs — real-browser regression test for a
//  real bug found via document-skeleton stress testing (2026-09-24): a
//  multi-word line inside a numbered/indented list item lost ALL its
//  inter-word spaces on a PDF -> pdf2word -> PDF round trip ("list level0
//  second item" -> "listlevel0seconditem").
//
//  Root cause: js/pdf2readCore.js's _p2wBuildPageData() (shared by
//  pdf2word/pdf2excel/pdf2ppt/pdf2md/Quick Edit PDF) used to filter OUT any
//  raw pdf.js text item whose string was whitespace-only
//  (`item.str.split('\0').join('').trim()` truthiness). Most real-world PDF
//  generators embed inter-word spacing WITHIN a word/line's own text item,
//  so this rarely mattered — but pdfmake's renderer (which both docx2pdf
//  and Quick Edit PDF's own "walk DOM -> PDF" step use) can emit each word
//  of an indented/margin-shifted list line as its own positioned
//  text-show op, with a literal lone " " item between them. Every
//  downstream text-reconstruction join site (`.join('')`, not `.join(' ')`)
//  relies on items already carrying their own necessary spacing — dropping
//  the space items silently glued adjacent words together with zero space
//  in the final output. Fixed by only dropping items that are genuinely
//  EMPTY after NUL-stripping, not merely whitespace-only.
//
//  This test drives the REAL two-stage pipeline (not a unit-level mock):
//  a DOCX skeleton exercising several structural patterns (nested list,
//  plain table, header/footer, a 2-column section, mixed bold/italic runs,
//  RTL text) -> the real /word-to-pdf/ tool -> the real /quick-edit-pdf/
//  tool (click-edit several structural targets) -> Save -> independent
//  pdf.js re-extraction confirming both the edits landed AND every
//  untouched structural element (including the multi-word list line that
//  triggered this bug) survived byte-for-byte.
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/quickEditSkeleton.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const SKELETON_DOCX = path.join(__dirname, '..', 'fixtures', 'quickedit_skeleton_test.docx');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: () => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
  };
}
const norm = s => s.replace(/\s+/g, ' ').trim();

async function captureDownload(page) {
  let buf = null;
  await page.exposeFunction('__capture', (b64) => { buf = Buffer.from(b64, 'base64'); });
  await page.addInitScript(() => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      if (blob instanceof Blob) {
        blob.arrayBuffer().then(ab => {
          const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
          window.__capture(b64);
        });
      }
      return orig.call(URL, blob);
    };
  });
  return () => buf;
}

async function extractText(page, buf) {
  return page.evaluate(async (b64) => {
    const pdf2jpgUI = await import('/js/pdf2jpgUI.js');
    await pdf2jpgUI.loadPdfJs();
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    let full = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const content = await p.getTextContent();
      full += content.items.map(it => it.str).join(' ') + '\n';
    }
    return full;
  }, buf.toString('base64'));
}

console.log(`Quick Edit PDF — document-skeleton regression test (real browser, ${BASE_URL}):`);
const browser = await chromium.launch();

let skeletonPdfBuf = null;
await test('skeleton DOCX (nested list, table, header/footer, 2-col section) converts via /word-to-pdf/', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const getDownload = await captureDownload(page);
  await page.goto(`${BASE_URL}/word-to-pdf/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', SKELETON_DOCX);
  await page.waitForTimeout(500);
  await page.click('#mergeBtn');
  await page.waitForSelector('#successCard', { timeout: 20000 });
  const buf = getDownload();
  expect(!!buf).toBeTruthy();
  expect(buf.slice(0, 4).toString()).toBe('%PDF');
  skeletonPdfBuf = buf;
  await page.close();
});

if (!skeletonPdfBuf) {
  console.log('\nfirst stage failed — aborting, nothing else can run.');
  await browser.close();
  process.exit(1);
}

const EDITS = [
  { marker: 'BOLD_RUN_TARGET', replacement: 'BOLD_RUN_EDITED' },
  { marker: 'ITALIC_RUN_TARGET', replacement: 'ITALIC_RUN_EDITED' },
  { marker: 'LIST_LEVEL0_TARGET', replacement: 'LIST_LEVEL0_EDITED' },
  { marker: 'LIST_LEVEL1_TARGET', replacement: 'LIST_LEVEL1_EDITED' },
  { marker: 'TABLE_CELL_TARGET', replacement: 'TABLE_CELL_EDITED' },
  { marker: 'COLUMN_A_TARGET', replacement: 'COLUMN_A_EDITED' },
];

let quickEditPage = null;
let editedPdfBuf = null;

await test('Quick Edit PDF opens the editor on the skeleton PDF (Atlas gate not triggered)', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE_URL}/quick-edit-pdf/`, { waitUntil: 'load' });
  await page.waitForSelector('#fileInput', { state: 'attached' });
  await page.setInputFiles('#fileInput', { name: 'skeleton.pdf', mimeType: 'application/pdf', buffer: skeletonPdfBuf });
  await page.waitForSelector('.qe-modal--open', { timeout: 20000 });
  quickEditPage = page;
});

await test('every structural target (bold/italic run, nested-list items, table cell, 2-col text) is clickable + edits without corrupting siblings', async () => {
  expect(!!quickEditPage).toBeTruthy();
  for (const { marker, replacement } of EDITS) {
    const targetIndex = await quickEditPage.evaluate((m) => {
      const spans = Array.from(document.querySelectorAll('.qe-editable-run'));
      return spans.findIndex(s => s.textContent.includes(m));
    }, marker);
    if (targetIndex < 0) throw new Error(`marker "${marker}" not found among .qe-editable-run spans`);
    const target = quickEditPage.locator('.qe-editable-run').nth(targetIndex);
    const beforeClass = await target.evaluate(el => el.className);
    await target.click();
    await quickEditPage.waitForTimeout(120);
    const editable = await target.evaluate(el => el.isContentEditable);
    if (!editable) throw new Error(`marker "${marker}": click did not enter edit mode`);
    await quickEditPage.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await quickEditPage.keyboard.type(replacement);
    await quickEditPage.keyboard.press('Enter');
    await quickEditPage.waitForTimeout(150);
    const afterClass = await target.evaluate(el => el.className.replace(' qe-editable-run--active', '').trim());
    const afterChildTypes = await target.evaluate(el => Array.from(el.childNodes).map(n => n.nodeType));
    if (afterClass !== beforeClass) throw new Error(`marker "${marker}": class changed after edit`);
    if (!(afterChildTypes.length === 1 && afterChildTypes[0] === 3)) {
      throw new Error(`marker "${marker}": span gained non-text children after edit`);
    }
  }
});

await test('Save produces a real PDF', async () => {
  await quickEditPage.evaluate(() => {
    window.__qeBufReady = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      if (blob instanceof Blob) {
        blob.arrayBuffer().then(ab => { window.__qeBufReady = Array.from(new Uint8Array(ab)); });
      }
      return orig.call(URL, blob);
    };
  });
  await quickEditPage.click('#qeModalSaveBtn');
  await quickEditPage.waitForSelector('#successCard', { timeout: 20000 });
  await quickEditPage.waitForTimeout(300);
  const arr = await quickEditPage.evaluate(() => window.__qeBufReady || null);
  expect(!!arr).toBeTruthy();
  editedPdfBuf = Buffer.from(arr);
  expect(editedPdfBuf.slice(0, 4).toString()).toBe('%PDF');
  await quickEditPage.close();
});

await test('independent check: edits landed, originals gone, and untouched structure (incl. the multi-word list line) survived with correct spacing', async () => {
  expect(!!editedPdfBuf).toBeTruthy();
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}/merge-pdf/`);
  const text = norm(await extractText(page, editedPdfBuf));
  for (const { marker, replacement } of EDITS) {
    if (!text.includes(replacement)) throw new Error(`edited text "${replacement}" missing from output PDF`);
    if (text.includes(marker)) throw new Error(`original text "${marker}" still present — edit did not take`);
  }
  // The regression this test exists for: this untouched, multi-word list
  // line must keep its inter-word spaces on the round trip, not collapse
  // into "listlevel0seconditem".
  for (const untouched of [
    'Skeleton Test Document', 'Header A', 'Header B', 'cell b2',
    'list level0 second item', 'COLUMN_B_TARGET',
  ]) {
    if (!text.includes(untouched)) throw new Error(`untouched marker "${untouched}" missing/corrupted in output PDF`);
  }
  await page.close();
});

await browser.close();
console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
