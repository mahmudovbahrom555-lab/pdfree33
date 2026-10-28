// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// A character past U+FFFF that falls on a JSZip chunk boundary (UTF-16 offset
// 16 383 of a part) was written half by half — invalid UTF-8 — and
// LibreOffice refused the whole .docx (2026-10-28). The writers are vendored
// (docx, pptxgenjs); js/ooxmlRepair.js joins the halves back after writing.
// Here the browser's own vendored writers build a .docx and a .pptx with "𝑎"
// at offset 16 383: the raw output must be invalid (the bug is real here),
// the repaired one valid UTF-8 with the character in it.
// Run: node tests/e2e/ooxml-surrogates.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE_URL}/pdf-to-word/`);
const result = await page.evaluate(async () => {
  const libs = await import('/js/lazyLibs.js');
  const { repairSplitSurrogates } = await import('/js/ooxmlRepair.js');
  await libs.loadJSZip(); await libs.loadDocx(); await libs.loadPptxGenJs();
  const JSZip = window.JSZip, D = window.docx;
  const valid = async (blob, part) => {
    const raw = await (await JSZip.loadAsync(blob)).file(part).async('uint8array');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return null; }
  };
  const writers = {
    docx: { part: 'word/document.xml', make: pad => D.Packer.toBlob(new D.Document({ sections: [{ children: [new D.Paragraph({ children: [new D.TextRun('x'.repeat(pad) + '𝑎')] })] }] })) },
    pptx: { part: 'ppt/slides/slide1.xml', make: pad => { const p = new window.PptxGenJS(); p.addSlide().addText('x'.repeat(pad) + '𝑎', { x: 1, y: 1, w: 5, h: 1 }); return p.write({ outputType: 'blob' }); } },
  };
  const out = {};
  for (const [name, w] of Object.entries(writers)) {
    const probe = await valid(await w.make(100), w.part);
    const pad = 16383 - probe.indexOf('x'.repeat(100));
    const raw = await w.make(pad);
    const fixed = await repairSplitSurrogates(raw, JSZip);
    const text = await valid(fixed, w.part);
    out[name] = { rawValid: (await valid(raw, w.part)) !== null, fixedValid: text !== null, hasChar: !!text?.includes('x𝑎'),
      untouched: (await repairSplitSurrogates(await w.make(pad - 1), JSZip)) instanceof Blob };
  }
  return out;
});
for (const name of ['docx', 'pptx']) {
  await test(`${name}: "𝑎" on the chunk boundary — written invalid, repaired valid with the character`, async () => {
    const r = result[name];
    if (r.rawValid) throw new Error('the raw output was valid — the boundary case did not reproduce');
    if (!r.fixedValid || !r.hasChar) throw new Error(JSON.stringify(r));
  });
}
await browser.close();
console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
