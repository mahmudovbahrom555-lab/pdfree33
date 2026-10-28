// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Every tool that reads a PDF with pdf.js, one built document through each:
// the page draws (a preview canvas that isn't blank, where the tool shows
// one), the main button gives a file, and a converter's file holds the
// document's own words. Written for the pdf.js 3.11 → 4.10 move (2026-10-28):
// a coverage audit found compare, e-reader, read, redact, glossary and the
// PDF→Markdown page with no browser test at all. Run it on two builds to
// compare them.
// Run: node tests/e2e/pdfjs-smoke.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const ONLY = process.env.SMOKE_ONLY?.split(',');
let passed = 0, failed = 0;
const results = {};
async function test(name, fn) {
  try { const r = await fn(); results[name] = r ?? 'ok'; console.log(`  ✓ ${name}`); passed++; }
  catch (e) { results[name] = `FAIL ${e.message}`; console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// The document: words to look for, a ruled 2×2 table, two pages.
const WORDS = ['Alphabet', 'Kilowatt', 'Omegaline'];
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const p1 = doc.addPage([595, 842]);
p1.drawText('PDFree smoke test Alphabet 12345', { x: 60, y: 780, size: 18, font });
p1.drawText('A second line of plain body text that says Kilowatt.', { x: 60, y: 740, size: 12, font });
for (const [r, c, t] of [[0, 0, 'Cell A1'], [0, 1, 'Cell B1'], [1, 0, 'Cell A2'], [1, 1, 'Cell B2']]) {
  const x = 60 + c * 150, y = 640 - r * 40;
  p1.drawRectangle({ x, y, width: 150, height: 40, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  p1.drawText(t, { x: x + 10, y: y + 14, size: 12, font });
}
doc.addPage([595, 842]).drawText('Second page Omegaline', { x: 60, y: 780, size: 18, font });
const file = path.join(os.tmpdir(), `pdfjs-smoke-${process.pid}.pdf`);
fs.writeFileSync(file, await doc.save());
// Compare wants two files: the same document under another name
const file2 = path.join(os.tmpdir(), `pdfjs-smoke-b-${process.pid}.pdf`);
fs.copyFileSync(file, file2);

// Text inside a result, by its type.
async function textOf(bytes, type) {
  if (/pdf$/.test(type)) return null;
  if (/markdown|text\//.test(type)) return Buffer.from(bytes).toString('utf8');
  if (/zip|officedocument/.test(type)) {
    const z = await JSZip.loadAsync(bytes);
    const names = Object.keys(z.files).filter(n => /\.(xml|md|txt|html)$/.test(n));
    return (await Promise.all(names.map(n => z.file(n).async('string')))).join('\n');
  }
  return null;
}

// tool page → how to drive it; `words` = which document words its file must hold
const TOOLS = [
  { name: 'pdf2word',  path: '/pdf-to-word/',        words: WORDS },
  { name: 'pdf2excel', path: '/pdf-to-excel/',       words: ['Cell A1', 'Cell B2'] },
  { name: 'pdf2md',    path: '/pdf-to-markdown/',    words: WORDS },
  { name: 'pdf2ppt',   path: '/pdf-to-powerpoint/',  words: ['Alphabet'] },
  { name: 'pdf2jpg',   path: '/pdf2jpg/' },
  { name: 'extract',   path: '/extract-pdf/' },
  { name: 'organize',  path: '/organize-pdf/' },
  { name: 'rotate',    path: '/rotate-pdf/', prepare: async p => { await p.click('#rotSelAll'); await p.click('#rotRight'); } },
  { name: 'resize',    path: '/resize-pdf-for-printing/' },
  { name: 'watermark', path: '/watermark-pdf/', prepare: async p => { await p.fill('#wmText', 'DRAFT').catch(() => {}); } },
  { name: 'compare',   path: '/compare-pdf/', two: true },
  // Read PDF has no page of its own: the homepage search hands it the file
  { name: 'read',      path: '/', search: 'read pdf', showsText: 'Alphabet' },
  { name: 'ereader',   path: '/optimize-pdf-for-ereader/' },
  { name: 'redact',    path: '/redact-pdf/', previewOnly: true },
  { name: 'glossary',  path: '/glossary-pdf/', prepare: async p => { await p.fill('#glsDictionary', 'Alphabet - the letters\nKilowatt - a unit of power'); } },
  { name: 'safety',    path: '/pdf-safety-check/' },
];

const browser = await chromium.launch();
for (const t of TOOLS) {
  if (ONLY && !ONLY.includes(t.name)) continue;
  await test(`${t.name}: the page draws the PDF${t.previewOnly ? '' : ' and its button gives a file'}${t.words ? ' with the document\'s words' : ''}`, async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 160)));
    await page.addInitScript(() => {
      window.__blob = null; window.__armed = false;
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = b => { if (window.__armed && !window.__blob && b instanceof Blob && b.size > 0 && !/javascript/.test(b.type)) window.__blob = b; return orig(b); };
    });
    try {
      const res = await page.goto(`${BASE_URL}${t.path}`, { waitUntil: 'load', timeout: 45_000 });
      if (!res || res.status() >= 400) throw new Error(`page ${res?.status()}`);
      if (t.search) {
        await page.fill('#toolSearch', t.search);
        // the input is always there: wait until the search has picked the tool
        await page.waitForFunction(() => /Read PDF/.test(document.getElementById('srName')?.textContent || ''), null, { timeout: 10_000 });
        await page.setInputFiles('#srFileInput', file);
        // the reading view lays the document's text out as text
        const shown = await page.waitForFunction(w => (document.getElementById('readContent')?.textContent ?? '').includes(w), t.showsText, { timeout: 45_000 }).then(() => true, () => false);
        if (!shown) throw new Error(`"${t.showsText}" never shown`);
        if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
        return 'text shown';
      }
      await page.setInputFiles('#fileInput', t.two ? [file, file2] : file);
      // a canvas pdf.js painted: some pixel not white and not transparent
      const drawn = await page.waitForFunction(() => [...document.querySelectorAll('canvas')].some(c => {
        if (!c.width || !c.height || c.width * c.height > 16e6) return false;
        try {
          const d = c.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, c.width, c.height).data;
          if (!d) return false;
          for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3] > 0 && (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200)) return true;
        } catch { /* a canvas in another context (webgl) */ }
        return false;
      }), null, { timeout: 30_000 }).then(() => true, () => false);
      if (t.previewOnly) {
        if (!drawn) throw new Error('no page drawn');
        if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
        return 'drawn';
      }
      await t.prepare?.(page);
      await page.evaluate(() => { window.__armed = true; });
      const started = Date.now();
      await page.click('#mergeBtn');
      for (;;) {
        const s = await page.evaluate(() => ({
          done: !!window.__blob, busy: !!document.querySelector('#mergeBtn')?.classList.contains('merge-btn--processing'),
          toast: (document.querySelector('#toast')?.innerText || '').trim().slice(0, 140),
        }));
        if (s.done) break;
        if (!s.busy && /Analys/i.test(s.toast) && Date.now() - started < 90_000) { await page.waitForTimeout(1000); await page.click('#mergeBtn'); continue; }
        if (Date.now() - started > 90_000) throw new Error(`no file in 90 s (${s.toast || 'no message'})`);
        await page.waitForTimeout(300);
      }
      const { b64, type } = await page.evaluate(async () => {
        const u = new Uint8Array(await window.__blob.arrayBuffer()); let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
        return { b64: btoa(s), type: window.__blob.type };
      });
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length < 100) throw new Error(`file of ${bytes.length} bytes`);
      if (t.words) {
        const text = await textOf(bytes, type);
        if (text == null) throw new Error(`can't read text from ${type}`);
        const missing = t.words.filter(w => !text.includes(w));
        if (missing.length) throw new Error(`${type}: missing ${missing.join(', ')}`);
      }
      if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
      return `${type} ${bytes.length} B${drawn ? ', drawn' : ''}`;
    } finally {
      await ctx.close();
    }
  });
}

await browser.close();
fs.unlinkSync(file);
fs.unlinkSync(file2);
if (process.env.SMOKE_JSON) fs.writeFileSync(process.env.SMOKE_JSON, JSON.stringify(results, null, 1));
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
