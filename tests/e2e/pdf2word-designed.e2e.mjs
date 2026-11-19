// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// PDF→Word on a designed page (2026-11-17). A certificate — a picture or a
// coloured ground over the whole page and a few lines of text set on it — was
// rebuilt as flowing paragraphs: the ground cut into strips around the text,
// the text pulled to the left margin, a one-page certificate spread over two
// or more Word pages. Another converter kept such a page as it looks. Now it
// is a section of its own, the page's size: the page drawn without its text
// behind the text, the text as ordinary paragraphs at its own places — the
// two pieces of a signature line one paragraph, a tab between them.
//
// Built here with pdf-lib: a certificate on a coloured ground, a plain text
// page (stays as before), and a page that is one coloured table (stays a
// table — data, not a design).
//
// Run: node tests/e2e/pdf2word-designed.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();

// word/document.xml of the .docx PDF→Word makes of `pdf` (bytes)
async function docxXml(pdf) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
    });
    await page.goto(`${BASE_URL}/pdf-to-word/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', { name: 'page.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
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
    return await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('word/document.xml').async('string');
  } finally {
    await ctx.close();
  }
}
const paragraphs = xml => [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(m => m[0]);
const textOf = p => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>/g)].map(m => m[1] ?? '\t').join('');

async function certificate() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(0.05, 0.2, 0.35) });
  page.drawRectangle({ x: 40, y: 40, width: 515.28, height: 761.89, color: rgb(0.97, 0.94, 0.85) });
  const centred = (text, y, size, f = font, color = rgb(0.6, 0.45, 0.1)) =>
    page.drawText(text, { x: (595.28 - f.widthOfTextAtSize(text, size)) / 2, y, size, font: f, color });
  centred('CERTIFICATE', 640, 44);
  centred('of professional development', 600, 16, regular, rgb(0.2, 0.2, 0.2));
  centred('Jane Example Person', 520, 26, font, rgb(0.1, 0.1, 0.1));
  centred('completed a 36-hour course', 480, 13, regular, rgb(0.3, 0.3, 0.3));
  page.drawText('A.Ismailov', { x: 90, y: 180, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawText('18', { x: 460, y: 180, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
  return doc.save();
}

console.log(`\nPDF→Word designed pages E2E (real browser, ${BASE_URL}):`);

await test('a certificate stays one page: its own size, the ground behind, every line in place', async () => {
  const xml = await docxXml(await certificate());
  const sect = xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) || [];
  if (sect.length !== 1) throw new Error(`expected one section, got ${sect.length}`);
  if (!/<w:pgSz w:w="11906" w:h="16838"/.test(sect[0])) throw new Error(`page size not the PDF's A4: ${sect[0].slice(0, 160)}`);
  if (!/<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0"/.test(sect[0])) throw new Error('page margins not 0');
  const behind = (xml.match(/<wp:anchor[^>]*behindDoc="1"/g) || []).length;
  if (behind !== 1) throw new Error(`expected the page drawn once behind the text, got ${behind}`);
  if ((xml.match(/<wp:inline/g) || []).length) throw new Error('the ground was cut into pictures in the text');
  const texts = paragraphs(xml).map(textOf).filter(t => t.trim());
  for (const want of ['CERTIFICATE', 'of professional development', 'Jane Example Person', 'completed a 36-hour course', 'A.Ismailov\t18']) {
    if (!texts.includes(want)) throw new Error(`no paragraph "${want}" — got ${JSON.stringify(texts)}`);
  }
  if (/<w:framePr/.test(xml)) throw new Error('left-to-right text set in frames, not paragraphs');
  const centredTitle = paragraphs(xml).find(p => textOf(p) === 'CERTIFICATE');
  if (!/<w:jc w:val="center"\/>/.test(centredTitle)) throw new Error('the centred title is not centred');
});

await test('a plain text page is converted as before — no picture behind it, the default page', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 12; i++) page.drawText(`Line ${i + 1} of an ordinary letter with plain text on white paper.`, { x: 72, y: 760 - i * 18, size: 11, font });
  const xml = await docxXml(await doc.save());
  if (/behindDoc="1"/.test(xml)) throw new Error('a plain page got a picture behind it');
  if (/<w:pgMar w:top="0"/.test(xml)) throw new Error('a plain page lost its margins');
});

await test('a page that is one coloured table stays a table, not a design', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const cols = [50, 200, 350, 545], rows = 12, top = 800, rowH = 60;
  for (let r = 0; r < rows; r++) for (let c = 0; c < 3; c++) {
    page.drawRectangle({ x: cols[c], y: top - (r + 1) * rowH, width: cols[c + 1] - cols[c], height: rowH,
      color: c === 1 ? rgb(0.75, 0.9, 0.75) : rgb(0.8, 0.85, 0.95), borderColor: rgb(0, 0, 0), borderWidth: 1 });
    page.drawText(r ? `${(r * 7.3 + c).toFixed(1)}` : ['Parameter', 'Limit', 'Result'][c], { x: cols[c] + 8, y: top - (r + 1) * rowH + 24, size: 11, font });
  }
  const xml = await docxXml(await doc.save());
  if (/behindDoc="1"/.test(xml)) throw new Error('a coloured table was laid out as a designed page');
});

await test('an article in two columns over a coloured ground stays flowing text, read column by column', async () => {
  // Arabic newsletters were laid out as designed pages and read across their
  // columns, row by row (nightly Arabic run, 2026-11-18)
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(0.93, 0.96, 0.9) });
  // running prose wrapped to each column's width — rows of one shape read as a table
  const prose = col => (`${col} begins here. ` + (col.endsWith('A')
      ? 'The council met on Tuesday to discuss the budget for the coming year, and members raised questions about school transport, the new library hours, road repairs on the eastern side of town and the cost of heating public buildings through the winter. A decision on most of these items was postponed until the next meeting, when officials will present revised figures and residents may speak about the plans for the market square. '
      : 'Volunteers cleaned the river bank over the weekend and collected more than two hundred bags of rubbish, old tyres and a shopping trolley. The organisers thanked the local bakery for the coffee and promised another clean-up in the spring, this time along the canal path behind the station where walkers have complained about litter for months. ')
    + `${col} ends here.`).split(' ');
  const wrap = (words, width) => words.reduce((ls, w) => {
    const last = ls[ls.length - 1];
    if (last && font.widthOfTextAtSize(`${last} ${w}`, 8) <= width) ls[ls.length - 1] = `${last} ${w}`; else ls.push(w);
    return ls;
  }, []);
  wrap(prose('Column A'), 190).forEach((t, i) => page.drawText(t, { x: 40, y: 780 - i * 12, size: 8, font }));
  wrap(prose('Column B'), 190).forEach((t, i) => page.drawText(t, { x: 270, y: 780 - i * 12, size: 8, font }));
  const xml = await docxXml(await doc.save());
  if (/behindDoc="1"/.test(xml)) throw new Error('an article in columns was laid out as a designed page');
  const text = paragraphs(xml).map(textOf).join('\n');
  const a = text.indexOf('Column A ends here'), b = text.indexOf('Column B begins here');
  if (a < 0 || b < 0 || a > b) throw new Error('not read column by column: column A does not end before column B begins');
});

await test('two long columns of short lines (bulleted lists) over a coloured ground stay flowing text, column by column', async () => {
  // a newsletter page of lists: 34 lines a column at 35 letters a line —
  // short lines, but no flyer holds a column that long (0525394 p. 5, 2026-11-19)
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(0.95, 0.95, 0.88) });
  const items = col => Array.from({ length: 32 }, (_, i) => i === 0 ? `${col} begins here` : i === 31 ? `${col} ends here` : `- ${col} item ${i}: a short note`);
  items('Column A').forEach((t, i) => page.drawText(t, { x: 40, y: 790 - i * 22, size: 9, font }));
  items('Column B').forEach((t, i) => page.drawText(t, { x: 330, y: 790 - i * 22, size: 9, font }));
  const xml = await docxXml(await doc.save());
  if (/behindDoc="1"/.test(xml)) throw new Error('two long columns were laid out as a designed page');
  const text = paragraphs(xml).map(textOf).join('\n');
  const a = text.indexOf('Column A ends here'), b = text.indexOf('Column B begins here');
  if (a < 0 || b < 0 || a > b) throw new Error('not read column by column: column A does not end before column B begins');
});

await browser.close();
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
