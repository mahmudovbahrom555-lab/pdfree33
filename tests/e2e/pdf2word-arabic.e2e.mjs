// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/pdf2word-arabic.e2e.mjs — PDF to Word reads Arabic from the
//  letters a PDF says it holds (/ActualText), not from its shaped glyphs
//  (2026-10-17).
//
//  Chromium (a browser's "Save as PDF", Google Docs) maps Arial's initial
//  and medial yeh and heh glyphs to the Persian ی and Urdu ھ, and the
//  letters under Tahoma's vowel marks to nothing; the real letters are in
//  /ActualText, which pdf.js drops. The .docx read "یقدم ھذا التقریر" for
//  "يقدم هذا التقرير" — a dot wrong in every other word, so Word's search
//  and spell-check failed on them — 60 % of the words right; vowelled text
//  15 %. Now 100 % and 100 % (js/pdfActualText.js).
//  Fixtures: tests/fixtures/pdf2word/ar-chrome-{arial,harakat}.pdf, made by
//  make-arabic-actualtext.mjs from arabic-actualtext.json (the truth here).
//  And pages with /Rotate (corpus class C1, 2026-10-18): a page a scanner or
//  "rotate and save" left turned showed upright, but its text — drawn turned
//  in the page's own space — was taken for rotated labels: an empty Word file
//  (a Persian book of 62 such pages: 0 words, Smallpdf 90 %).
//  Fixture: rotated-pages.pdf (make-rotated.mjs, rotated-pages.json).
//  And digits a font's ToUnicode names wrongly (class C4, 2026-10-21): a
//  page drawing "2011" read as "3122" by every text reader — 26 of 269
//  Arabic-script corpus documents with digits (js/pdfDigitFix.js); and the
//  control, a font whose own cmap is the wrong one, left alone.
//  Fixtures: c4-wrong-digits.pdf, c4-font-cmap-wrong.pdf (make-c4-digits.py).
//  And two-letter ligatures in visual-order Arabic (class C10, 2026-10-21):
//  pdf.js split ﳎ into its letters and then reversed them with the item —
//  "جملس" for "مجلس", "املتحدة" for "المتحدة": 8,057 words in 53 corpus
//  documents. Fixture: ar-ligatures.pdf (make-ligatures.py).
//  And a glyph ToUnicode names by several letters, read backwards with its
//  line (class C11, Urdu Word files with Nastaleeq ligatures: "ےس" for
//  "سے"). Fixture: ar-ligatures-letters.pdf (make-ligatures.py).
//  And text a PDF repeats at the top and bottom of its pages (2026-10-22):
//  kept out of the body as page furniture, it now goes into the Word header
//  and footer instead of being lost — a UN document symbol was in no part of
//  the .docx. Fixture: running-header.pdf (make-running-header.py).
//  And CJK fonts a PDF names without embedding them, through Adobe's
//  predefined CMaps (Chinese corpus, 2026-10-23: 8 of 128 documents —
//  TCPDF, Acrobat PDFWriter, Hong Kong filings): pdf.js read none of their
//  text without the CMap files, the .docx had the Latin only or nothing.
//  Fixture: cjk-cmaps.pdf (make-cjk-cmaps.py).
//  And text a printer driver drew several times over itself to fake bold
//  (class C14, 2026-10-24: 14 of 368 Chinese corpus documents, "壬壬壬壬"):
//  read once, while "謝謝" and the same text in two cells stay.
//  Fixture: overprint.pdf (make-overprint.py).
//  And pages that hold only a picture and their bottom lines (a catalogue,
//  4736268, competitor pilot 2026-10-24): the bottom lines went partly into
//  the Word HEADER — the page's "first three" and "last three" lines were the
//  same. Bottom lines go to the footer, top lines to the header.
//  Fixture: footer-only.pdf (make-footer-only.py).
//  Run: node tests/e2e/pdf2word-arabic.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(__dirname, '..', 'fixtures', 'pdf2word');
const TRUTH = JSON.parse(readFileSync(path.join(FIX, 'arabic-actualtext.json'), 'utf8'));
const ROTATED = JSON.parse(readFileSync(path.join(FIX, 'rotated-pages.json'), 'utf8'));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// Arabic words, letters exact (ي ≠ ی, ه ≠ ھ, ة ≠ ه); with or without their vowel marks
const words = (t, marks) => (t.normalize('NFKC').replace(/[ـ‌-‏]/g, '')
  .replace(marks ? /(?!)/g : /[ً-ْٰ]/g, '')
  .match(/[؀-ۿ]+/g) ?? []);
function recall(truth, out, marks) {
  const got = new Map();
  for (const w of words(out, marks)) got.set(w, (got.get(w) ?? 0) + 1);
  const want = words(truth, marks);
  let hit = 0;
  for (const w of want) if (got.get(w) > 0) { hit++; got.set(w, got.get(w) - 1); }
  return hit / want.length;
}

async function docxText(browser, file, part = 'word/document.xml') {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  await page.addInitScript(() => {
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (b instanceof Blob && /officedocument/.test(b.type)) window.__docx = b; return orig(b); };
  });
  await page.goto(BASE_URL + '/pdf-to-word/', { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', path.join(FIX, file));
  await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.click('#mergeBtn');
  await page.waitForFunction(() => window.__docx, null, { timeout: 90000 });
  return page.evaluate(async part => {
    await (await import('/js/lazyLibs.js')).loadJSZip();
    const zip = await window.JSZip.loadAsync(await window.__docx.arrayBuffer());
    const xml = await zip.file(part)?.async('string') ?? '';
    return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(m => [...m[0].matchAll(/<w:t[^>]*>([^<]*)/g)].map(t => t[1]).join('')).join('\n');
  }, part);
}

const browser = await chromium.launch();
console.log(`\npdf2word — Arabic /ActualText E2E (${BASE_URL}):`);
try {
  await test('Chrome + Arial: Arabic yeh and heh, not Persian ی / Urdu ھ — every word right', async () => {
    const out = await docxText(browser, 'ar-chrome-arial.pdf');
    const wrong = (out.match(/[یھ]/g) ?? []).length;
    if (wrong) throw new Error(`${wrong} Persian/Urdu letters in Arabic text: ${out.slice(0, 200)}`);
    const r = recall(TRUTH.prose.join('\n'), out, false);
    if (r < 0.97) throw new Error(`${(r * 100).toFixed(0)} % of the words right (≥ 97 % expected): ${out.slice(0, 200)}`);
  });

  await test('Chrome + Tahoma, fully vowelled: letters under the marks kept, words whole with their marks', async () => {
    const out = await docxText(browser, 'ar-chrome-harakat.pdf');
    const plain = recall(TRUTH.harakat.join('\n'), out, false), vowelled = recall(TRUTH.harakat.join('\n'), out, true);
    if (plain < 0.95 || vowelled < 0.9) throw new Error(`words ${(plain * 100).toFixed(0)} %, with their marks ${(vowelled * 100).toFixed(0)} %: ${out.slice(0, 200)}`);
  });

  await test('pages with /Rotate 90, 180, 270: their text, numbers and order kept, as on the unrotated page', async () => {
    const out = await docxText(browser, 'rotated-pages.pdf');
    let at = -1;
    ROTATED.pages.forEach(([ar, en], i) => {
      const r = recall(ar, out, false);
      if (r < 0.9) throw new Error(`page ${i + 1} (/Rotate ${ROTATED.rotate[i]}): ${(r * 100).toFixed(0)} % of its Arabic words: ${out.slice(0, 300)}`);
      for (const n of en.match(/\d[\d:/]*\d|\d/g)) if (!out.includes(n)) throw new Error(`page ${i + 1}: number ${n} lost`);
      const k = out.indexOf(en.split(':')[0]);
      if (k < 0 || k < at) throw new Error(`page ${i + 1}: "${en.split(':')[0]}" ${k < 0 ? 'missing' : 'out of order'}`);
      at = k;
    });
  });

  await test('digits ToUnicode names wrongly come out as drawn: "2011, total 4096", not "3122, total 5107"', async () => {
    const out = await docxText(browser, 'c4-wrong-digits.pdf');
    if (!out.includes('2011') || !out.includes('4096') || out.includes('3122')) throw new Error(out.slice(0, 200));
  });

  await test('a font whose own cmap is wrong keeps the right digits ToUnicode gives', async () => {
    const out = await docxText(browser, 'c4-font-cmap-wrong.pdf');
    if (!out.includes('2011') || !out.includes('4096')) throw new Error(out.slice(0, 200));
  });

  await test('two-letter ligatures drawn in visual order keep their letters in order: "مجلس", not "جملس"', async () => {
    const out = await docxText(browser, 'ar-ligatures.pdf');
    const truth = 'مجلس الأمن في الأمم المتحدة الحقوق والحريات لجميع الناس';
    const r = recall(truth, out, false);
    if (r < 1) throw new Error(`${(r * 100).toFixed(0)} % of the words right: ${out.slice(0, 200)}`);
  });

  await test('a glyph ToUnicode names by two letters keeps them in order: "مجلس", not "جملس"', async () => {
    const out = await docxText(browser, 'ar-ligatures-letters.pdf');
    const truth = 'مجلس الأمن في الأمم المتحدة الحقوق والحريات لجميع الناس';
    const r = recall(truth, out, false);
    if (r < 1) throw new Error(`${(r * 100).toFixed(0)} % of the words right: ${out.slice(0, 200)}`);
  });

  await test('a symbol repeated at the top of every page goes into the Word header, a repeated last line into the footer — not lost', async () => {
    const body = await docxText(browser, 'running-header.pdf');
    const header = await docxText(browser, 'running-header.pdf', 'word/header1.xml');
    const footer = await docxText(browser, 'running-header.pdf', 'word/footer1.xml');
    if (!header.includes('A/HRC/55/L.12')) throw new Error(`header: ${JSON.stringify(header)}`);
    if (!footer.includes('Distr.: General')) throw new Error(`footer: ${JSON.stringify(footer)}`);
    if (body.includes('A/HRC/55/L.12')) throw new Error('the symbol is in the body too');
    if (recall('مجلس حقوق الإنسان', body, false) < 1) throw new Error(`body: ${body.slice(0, 200)}`);
  });

  await test('CJK fonts named through predefined CMaps (not embedded): Chinese, traditional, Japanese and Korean text kept', async () => {
    const out = await docxText(browser, 'cjk-cmaps.pdf');
    for (const want of ['董事会成员名单与其角色和职能', '董事會成員名單與其角色和職能', '第四十八回全国学生スキー大会', '이사회 구성원 명단']) {
      if (!out.includes(want)) throw new Error(`"${want}" missing: ${out.slice(0, 300)}`);
    }
    if (!out.includes('Korean 2026')) throw new Error(`Latin lost: ${out.slice(0, 300)}`);
  });

  await test('text drawn over itself (fake bold) is read once; "謝謝" and two cells of "合計" stay', async () => {
    const out = await docxText(browser, 'overprint.pdf');
    const count = w => out.split(w).length - 1;
    for (const w of ['年柱壬戌', '技術於校園安全建置之經驗分享', '備註欄']) if (count(w) !== 1) throw new Error(`"${w}" ${count(w)} times: ${out}`);
    if (/壬壬|備備|註註/.test(out)) throw new Error(`copies left: ${out}`);
    if (!out.includes('謝謝您的參與') || count('合計') !== 2) throw new Error(`real text lost: ${out}`);
  });

  await test('lines at the bottom of every page go to the Word footer, never the header (pages with nothing else)', async () => {
    const header = await docxText(browser, 'footer-only.pdf', 'word/header1.xml');
    const footer = await docxText(browser, 'footer-only.pdf', 'word/footer1.xml');
    const body = await docxText(browser, 'footer-only.pdf');
    if (/173842|example-shop|Firenze/.test(header)) throw new Error(`bottom line in the header: ${JSON.stringify(header)}`);
    const all = header + footer + body;
    for (const w of ['173842', 'example-shop.com', '0548100']) if (!all.includes(w)) throw new Error(`"${w}" lost: header ${JSON.stringify(header)} footer ${JSON.stringify(footer)}`);
  });
} finally {
  await browser.close();
}
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
