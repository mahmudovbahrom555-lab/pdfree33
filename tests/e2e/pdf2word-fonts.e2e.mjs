// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// PDF→Word carries the PDF's own fonts (js/docxFonts.js, 2026-11-18). Word
// set every line in its default font, so a page came out in another face,
// wider or narrower than the PDF. Now each TrueType font the PDF embeds, and
// whose licence allows it, goes into the .docx — rebuilt from pdf.js's copy
// with a Unicode cmap — and the text drawn in it is set in it.
//
// The real browser path: pdf.js's font objects (fontExtraProperties), the
// licence read with pdf-lib, the font in word/fonts linked from fontTable.xml
// (docx leaves fontTable.xml unlinked — LibreOffice then loaded no font at
// all). Fixtures: Liberation Sans embedded by PyMuPDF, once as it is
// (installable) and once marked "preview & print" (fsType 4), which Word
// would open read-only — that one is left to Word's default font.
//
// Run: node tests/e2e/pdf2word-fonts.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import JSZip from 'jszip';
import { readFileSync } from 'fs';
import { sfntTables, cmapGlyphs, obfuscateFont } from '../../js/docxFonts.js';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const fixture = name => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();

// the .docx PDF→Word makes of `pdf` (bytes), as a JSZip
async function convert(pdf) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
    });
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', { name: 'fonts.pdf', mimeType: 'application/pdf', buffer: pdf });
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled
      && !/Analys/.test(document.querySelector('#toast')?.textContent || '')
      && /Output mode/.test(document.querySelector('#pdf2wordOptions')?.textContent || ''), null, { timeout: 60000 });
    await page.evaluate(() => { window.__blob = null; });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__blob && /officedocument/.test(window.__blob.type), null, { timeout: 90000 });
    const b64 = await page.evaluate(async () => {
      const u = new Uint8Array(await window.__blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    return await JSZip.loadAsync(Buffer.from(b64, 'base64'));
  } finally {
    await ctx.close();
  }
}
const textOf = xml => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]).join('');

const embedded = await convert(fixture('p2w_font_installable.pdf'));
const left = await convert(fixture('p2w_font_preview_only.pdf'));

await test('an installable TrueType font goes into the .docx, linked so Word and LibreOffice read it', async () => {
  const table = await embedded.file('word/fontTable.xml').async('string');
  const m = table.match(/<w:font w:name="Liberation Sans \(PDF\)">.*?<w:embedRegular r:id="([^"]+)" w:fontKey="\{([0-9A-F-]{36})\}"\/>/);
  if (!m) throw new Error(`no embedded Liberation Sans in fontTable.xml: ${table.slice(0, 400)}`);
  const rels = await embedded.file('word/_rels/fontTable.xml.rels').async('string');
  const target = rels.match(new RegExp(`Id="${m[1]}"[^>]*Target="([^"]+)"`))?.[1];
  if (!target) throw new Error(`relationship ${m[1]} missing`);
  if (!/relationships\/fontTable"/.test(await embedded.file('word/_rels/document.xml.rels').async('string'))) {
    throw new Error('fontTable.xml not linked from the document');
  }
  const font = obfuscateFont(await embedded.file(`word/${target}`).async('uint8array'), m[2]);
  const glyphs = cmapGlyphs(sfntTables(font).get('cmap'));
  for (const ch of 'QuarterlyПривет2026 ') if (!glyphs.get(ch.codePointAt(0))) throw new Error(`"${ch}" missing from the embedded font`);
});

await test('the text drawn in it is set in it', async () => {
  const xml = await embedded.file('word/document.xml').async('string');
  if (!/<w:rFonts w:ascii="Liberation Sans \(PDF\)"/.test(xml)) throw new Error('no run in Liberation Sans');
  if (!textOf(xml).includes('Quarterly report') || !textOf(xml).includes('Привет, мир')) throw new Error(`text changed: ${textOf(xml)}`);
});

await test('a "preview & print" font is not embedded — Word would open the file read-only; the text is all there', async () => {
  if (Object.keys(left.files).some(n => n.startsWith('word/fonts/'))) throw new Error('a font was embedded');
  const xml = await left.file('word/document.xml').async('string');
  if (/Liberation Sans/.test(xml)) throw new Error('run names a font the file does not carry');
  if (textOf(xml) !== textOf(await embedded.file('word/document.xml').async('string'))) throw new Error('text differs from the embedded conversion');
});

await browser.close();
console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
