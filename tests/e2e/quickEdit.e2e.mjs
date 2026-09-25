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

import { chromium } from 'playwright';
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

async function captureDownload(page) {
  let buf = null;
  await page.exposeFunction('__qeCapture', (b64) => { buf = Buffer.from(b64, 'base64'); });
  await page.addInitScript(() => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      if (blob instanceof Blob) {
        blob.arrayBuffer().then(ab => {
          const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
          window.__qeCapture(b64);
        });
      }
      return orig.call(URL, blob);
    };
  });
  return () => buf;
}

console.log(`Quick Edit PDF E2E — real end-to-end round trip (real browser, ${BASE_URL}):`);

const browser = await chromium.launch();

await test('Atlas gate blocks a text-extraction-failure document (no editor, #mergeBtn disabled)', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE_URL}/quick-edit-pdf/`);
  await page.waitForSelector('#fileInput', { state: 'attached' });
  const input = await page.$('#fileInput');
  await input.setInputFiles([HEAVY_PDF]);
  await page.waitForTimeout(3000);

  const html = await page.locator('#quickEditOptions').innerHTML();
  expect(html.includes('qeReopenBtn')).toBeFalsy();
  expect(html.includes('/pdf-to-word/')).toBeTruthy();
  const modalOpen = await page.locator('.qe-modal--open').count();
  expect(modalOpen).toBe(0);
  const disabled = await page.locator('#mergeBtn').isDisabled();
  expect(disabled).toBeTruthy();
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
  await page.waitForSelector('.qe-modal--open', { timeout: 20000 });
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
  await page.waitForSelector('.qe-modal--open', { timeout: 20000 });
  await page.click('#qeModalSaveBtn');
  await page.waitForSelector('#successCard', { timeout: 20000 });
  await page.waitForTimeout(300);

  const sawWarning = toasts.some(t => /Chinese|Japanese|Korean|Arabic|Hebrew|Thai|emoji/i.test(t));
  if (!sawWarning) throw new Error(`Expected an unsupported-script warning toast, saw: ${JSON.stringify(toasts)}`);
  await page.close();
});

await browser.close();

console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
