// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/docx2pdf.e2e.mjs — real-browser regression tests for two
//  real end-user bugs in the Word→PDF tool (js/docxToPdfCore.js).
//
//  1. "Malformed table row, a cell is undefined" — a DOCX table with a
//     merged cell (Word's gridSpan/vMerge, i.e. colspan/rowspan once
//     docx-preview renders them as real HTML) crashed pdfmake's table
//     renderer. Root cause: parseTable() assumed every <tr> has the same
//     number of <td> children as the first row — true for a plain table,
//     false the instant any row has a merged cell, since HTML simply
//     omits a <td> for a cell covered by an earlier row's rowSpan (and a
//     colSpan cell's row has fewer <td>s than the table's true column
//     count). Fixed by walking the table as a real grid, inserting
//     pdfmake's own documented {} placeholder for spanned positions.
//
//  2. A bare "Failed to fetch" aborting the WHOLE conversion — traced to
//     _imgToDataUrl()'s fetch(img.src): a network-level failure fetching
//     ONE embedded image used to crash the entire document instead of
//     just that one image (never reproduced against a specific real file
//     — the reporting user's actual file had zero images — but the code
//     path itself is real and independently verifiable: force a fetch
//     failure and confirm graceful degradation instead of a hard crash).
//
//  Uses small synthetic fixtures (not the real reporter's file, which
//  contains someone else's personal document) that reproduce the same
//  structural patterns.
//
//  Requires: dist/ already built (`python3 scripts/build.py`) and served
//  at PDFREE_BASE_URL (default http://localhost:8934).
//
//  Run: node tests/e2e/docx2pdf.e2e.mjs
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const MERGED_CELLS_DOCX  = path.join(__dirname, '..', 'fixtures', 'docx2pdf_merged_cells.docx');
const IMAGE_DOCX         = path.join(__dirname, '..', 'fixtures', 'eri', '004_libreoffice.docx');
const ENCRYPTED_OR_LEGACY_DOCX = path.join(__dirname, '..', 'fixtures', 'docx2pdf_encrypted_or_legacy.docx');
const MISSING_DOCXML_DOCX      = path.join(__dirname, '..', 'fixtures', 'docx2pdf_missing_document_xml.docx');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); failed++; }
}
function expect(actual) {
  return {
    toBe: (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
  };
}

const BLOB_HOOK = () => {
  window.__blob = null;
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
};

async function convertAndCapture(page, filePath) {
  await page.goto(`${BASE_URL}/word-to-pdf/`, { waitUntil: 'load', timeout: 30000 });
  await page.setInputFiles('#fileInput', filePath);
  await page.waitForTimeout(500);
  // docx-preview's own rendering (which parseTable/parseParagraph walk)
  // can call createObjectURL for an embedded image's <img src> well before
  // the real conversion even starts — reset right before the actual
  // trigger so BLOB_HOOK's capture can only be the real output blob, not
  // an incidental earlier one (caught a real false-positive from this
  // during development: the hook had captured an intermediate image/png
  // blob, not the final application/pdf one).
  await page.evaluate(() => { window.__blob = null; });
  await page.click('#mergeBtn');

  let result = null, toastText = null;
  for (let i = 0; i < 60; i++) {
    result = await page.evaluate(() => window.__blob ? { size: window.__blob.size, type: window.__blob.type } : null).catch(() => null);
    if (result && result.type === 'application/pdf') break;
    toastText = await page.locator('#toast').textContent().catch(() => null);
    if (toastText && toastText.trim()) break;
    await page.waitForTimeout(500);
    result = null;
  }
  return { result, toastText };
}


console.log(`\ndocx2pdf E2E — real end-user regressions stay fixed (real browser, ${BASE_URL}):`);

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error('Could not launch Chromium — run `npx playwright install --with-deps chromium` first.');
  console.error(e.message);
  process.exit(1);
}

await test('a DOCX table with a colSpan cell and a colSpan+rowSpan cell converts without "Malformed table row"', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  try {
    await page.addInitScript(BLOB_HOOK);
    const { result, toastText } = await convertAndCapture(page, MERGED_CELLS_DOCX);

    if (!result) {
      throw new Error(`Expected a downloaded PDF, got none. Toast: ${toastText || '(empty)'}. Console errors: ${consoleErrors.join(' | ')}`);
    }
    if (toastText && /Malformed table row/i.test(toastText)) {
      throw new Error(`Got the exact real-user regression back: ${toastText}`);
    }
    expect(result.type).toBe('application/pdf');
    if (!(result.size > 0)) throw new Error(`Expected a non-empty PDF, got size ${result.size}`);

    // Real regression, found via document-skeleton stress testing (2026-09-
    // 24, commit right after this test's original version): the crash was
    // fixed, but parseTable()'s rowSpanCarry only marked a spanning cell's
    // STARTING column as "carried" for continuation rows, not every column
    // a combined colSpan+rowSpan covers — docx-preview renders a real
    // (empty, display:none) phantom <td> at a vMerge-continuation's grid
    // position, which then got double-counted as new content instead of
    // skipped, inflating colCount by one extra phantom column and desyncing
    // column alignment for the rest of the table. With THIS fixture's short
    // cell text (single letters/numbers) the phantom column stayed
    // invisible to a plain "is the text still there" check — the actual
    // wrong shape only shows up by inspecting walkDomToPdfContent()'s own
    // pdfmake content structure directly (a wide real-world table with
    // longer cell content can additionally lose real columns outright — see
    // tests/e2e/quickEditSkeleton.e2e.mjs's own sibling coverage for that
    // shape of damage on a different fixture).
    const fixtureBytes = fs.readFileSync(MERGED_CELLS_DOCX);
    const shape = await page.evaluate(async (bytesArr) => {
      const { renderDocxToDom, walkDomToPdfContent } = await import('/js/docxToPdfCore.js');
      const file = new File([new Uint8Array(bytesArr)], 'f.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const container = document.createElement('div');
      container.style.cssText = 'position:absolute; top:-99999px; left:-99999px; width:800px;';
      document.body.appendChild(container);
      await renderDocxToDom(file, container, {});
      const { content } = await walkDomToPdfContent(container, {});
      const findTable = (nodes) => {
        for (const n of nodes || []) {
          if (n?.table) return n.table;
          if (n?.stack) { const t = findTable(n.stack); if (t) return t; }
        }
        return null;
      };
      const table = findTable(content);
      container.remove();
      if (!table) return null;
      const cellText = c => (c.stack || []).map(p => {
        if (typeof p.text === 'string') return p.text;
        return (p.text || []).map(t => t.text || '').join('');
      }).join('');
      return {
        colCount: table.widths.length,
        rowLengths: table.body.map(r => r.length),
        row2Texts: table.body[2].map(cellText),
      };
    }, Array.from(fixtureBytes));

    if (!shape) throw new Error('walkDomToPdfContent found no table in the merged-cells fixture');
    if (shape.colCount !== 3) throw new Error(`expected colCount 3, got ${shape.colCount} — a phantom vMerge-continuation <td> is being double-counted as a real column`);
    if (shape.rowLengths.some(n => n !== 3)) throw new Error(`expected every row to have exactly 3 entries, got ${JSON.stringify(shape.rowLengths)}`);
    if (!(shape.row2Texts[0].includes('A2') && shape.row2Texts[1].includes('B2'))) {
      throw new Error(`row 2's real content landed in the wrong columns: ${JSON.stringify(shape.row2Texts)}`);
    }
  } finally {
    await context.close();
  }
});

await test('a failed image fetch degrades gracefully (skips that image) instead of aborting the whole conversion', async () => {
  // Real user report: a bare "Failed to fetch" toast, whole conversion
  // aborted. _imgToDataUrl()'s fetch(img.src) is the only fetch() call
  // reachable in this tool's pipeline (verified by searching the whole
  // codebase) — force it to reject and confirm the document still comes
  // out, proving one unreachable image can no longer sink the whole file.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.addInitScript(() => {
      const origFetch = window.fetch.bind(window);
      window.fetch = function (url, ...rest) {
        // docx-preview's own embedded-image src is a blob: URL — only
        // sabotage those, so pdfmake/pdf.js's own unrelated fetches (if
        // any, elsewhere on the page) aren't collaterally broken.
        if (typeof url === 'string' && url.startsWith('blob:')) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return origFetch(url, ...rest);
      };
    });
    const { result, toastText } = await convertAndCapture(page, IMAGE_DOCX);

    if (!result) {
      throw new Error(`Expected the conversion to still succeed despite the forced image-fetch failure. Toast: ${toastText || '(empty)'}. Console errors: ${consoleErrors.join(' | ')}`);
    }
    if (toastText && /Failed to fetch/i.test(toastText)) {
      throw new Error(`Got the exact real-user regression back: ${toastText}`);
    }
    expect(result.type).toBe('application/pdf');
    if (!(result.size > 0)) throw new Error(`Expected a non-empty PDF, got size ${result.size}`);
  } finally {
    await context.close();
  }
});

await test('a fetched "image" that is actually an HTML error page (e.g. a hijacked/NXDOMAIN-redirected external image link) degrades gracefully instead of crashing pdfmake', async () => {
  // Real-world variant discovered while investigating the original "Failed to
  // fetch" report: a broken external image reference doesn't always fail at
  // the network level. Some networks (ISP/router NXDOMAIN hijacking, captive
  // portals) resolve an unresolvable domain to a real server that answers
  // with an HTML error page instead of DNS failure — fetch() then RESOLVES
  // (not rejects) with a non-OK, non-image response. Without a status/type
  // check, _imgToDataUrl happily turned that HTML into a "dataURL" and
  // handed it to pdfmake, which crashed later with "Unknown image format" —
  // outside the scope of the fetch-failure try/catch. Force that exact shape
  // here (200 status, text/html body) and confirm it's now caught upstream.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  try {
    await page.addInitScript(BLOB_HOOK);
    await page.addInitScript(() => {
      const origFetch = window.fetch.bind(window);
      window.fetch = function (url, ...rest) {
        if (typeof url === 'string' && url.startsWith('blob:')) {
          return Promise.resolve(new Response('<html><body>Not Found</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }));
        }
        return origFetch(url, ...rest);
      };
    });
    const { result, toastText } = await convertAndCapture(page, IMAGE_DOCX);

    if (!result) {
      throw new Error(`Expected the conversion to still succeed despite the fake HTML "image" response. Toast: ${toastText || '(empty)'}. Console errors: ${consoleErrors.join(' | ')}`);
    }
    if (toastText && /Unknown image format|Invalid image/i.test(toastText)) {
      throw new Error(`Got the pdfmake-level crash back: ${toastText}`);
    }
    expect(result.type).toBe('application/pdf');
    if (!(result.size > 0)) throw new Error(`Expected a non-empty PDF, got size ${result.size}`);
  } finally {
    await context.close();
  }
});

await test('a password-protected/legacy-.doc-shaped file (real OLE2/CFBF magic bytes, not a zip) gets a specific, correct toast instead of leaking a raw JSZip error', async () => {
  // Found via a broader corpus-based fuzz sweep (not a specific user report):
  // a genuinely password-protected .docx AND a legacy binary .doc simply
  // renamed to .docx are BOTH, at the byte level, an OLE2/CFBF compound
  // file (magic bytes D0 CF 11 E0 A1 B1 1A E1) — not a zip at all, since a
  // real .docx IS a zip. Before the fix, this hit docx-preview's own
  // JSZip.loadAsync() and surfaced RAW library internals to the user:
  // "Can't find end of central directory : is this a zip file ? If it is,
  // see https://stuk.github.io/jszip/..." — confusing (means nothing to a
  // user with an ordinary old .doc file) and actively misleading (its
  // "tap to report" implies a pdfree.io bug, not an unsupported format).
  // _rejectIfOleCfbf() in docxToPdfCore.js now sniffs the magic bytes up
  // front and throws a specific sentinel translated to a correct, friendly
  // message in js/processor.js's catch block.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    const { result, toastText } = await convertAndCapture(page, ENCRYPTED_OR_LEGACY_DOCX);

    if (result) throw new Error(`Expected a rejection toast, but got a PDF blob (size ${result.size}) — this fixture is not a valid .docx.`);
    if (!toastText) throw new Error('Expected a toast, got none.');
    if (/central directory|jszip|stuk\.github\.io/i.test(toastText)) {
      throw new Error(`Got the raw JSZip internals back instead of a friendly message: ${toastText}`);
    }
    if (!/password|\.doc\b/i.test(toastText)) {
      throw new Error(`Toast doesn't mention password-protection or the legacy .doc format: ${toastText}`);
    }
  } finally {
    await context.close();
  }
});

await test('a structurally incomplete .docx (valid zip, but word/document.xml missing) gets a friendly toast instead of a raw "Cannot read properties of undefined" crash', async () => {
  // Found via the same fuzz sweep: a truncated/failed save (or any
  // producer that emits an incomplete OOXML zip) used to crash INSIDE
  // docx-preview's own parsing with a bare property-access TypeError —
  // "Cannot read properties of undefined (reading 'body')" — surfaced
  // verbatim to the user with zero context. The renderAsync() call in
  // docxToPdfCore.js's _docxToPdfmakeContent() is now wrapped so ANY
  // parse failure normalizes to one honest, specific sentinel.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.addInitScript(BLOB_HOOK);
    const { result, toastText } = await convertAndCapture(page, MISSING_DOCXML_DOCX);

    if (result) throw new Error(`Expected a rejection toast, but got a PDF blob (size ${result.size}) — this fixture is missing word/document.xml.`);
    if (!toastText) throw new Error('Expected a toast, got none.');
    if (/reading 'body'|cannot read propert/i.test(toastText)) {
      throw new Error(`Got the raw TypeError back instead of a friendly message: ${toastText}`);
    }
    if (!/couldn't be read|corrupted/i.test(toastText)) {
      throw new Error(`Toast doesn't give a specific, friendly explanation: ${toastText}`);
    }
  } finally {
    await context.close();
  }
});

await browser.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
