// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// The PDF safety check page end to end, at phone and desktop width, light and
// dark: a built PDF that acts (a script on open, an attached program, a link
// that shows one site and leads to another, a QR code) is reported; the
// cleaned copy downloads and checks clean; the empty button opens the file
// picker; the page's strict CSP raises no violation; the level badges keep
// WCAG AA contrast in both themes.
// Run: node tests/e2e/pdf-safety-check.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import * as PDFLib from 'pdf-lib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanPdf } from '../../js/pdfSafetyScan.js';

const { PDFDocument, PDFName, PDFString, StandardFonts, rgb } = PDFLib;
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const __dir = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

// a PDF that acts
const codes = JSON.parse(fs.readFileSync(path.join(__dir, '../fixtures/safety/qr-codes.json'), 'utf8'));
const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Log in at www.mybank.com to confirm.', { x: 60, y: 760, size: 14, font });
const x0 = 60 + font.widthOfTextAtSize('Log in at ', 14), w = font.widthOfTextAtSize('www.mybank.com', 14);
page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(doc.context.obj({
  Type: 'Annot', Subtype: 'Link', Rect: [x0, 755, x0 + w, 775], Border: [0, 0, 0],
  A: { S: 'URI', URI: PDFString.of('https://mybank-login.example.test/verify') } }))]));
codes.phish.rows.forEach((row, r) => [...row].forEach((bit, c) => {
  if (bit === '1') page.drawRectangle({ x: 60 + c * 5, y: 300 - r * 5, width: 5, height: 5, color: rgb(0, 0, 0) });
}));
doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.launchURL("https://example.test/")') })));
await doc.attach(new TextEncoder().encode('MZ fake'), 'invoice.exe', { mimeType: 'application/octet-stream' });
const file = path.join(os.tmpdir(), `safety-${process.pid}.pdf`);
fs.writeFileSync(file, await doc.save());

// WCAG contrast of two rgb() colours
const lum = c => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const browser = await chromium.launch();
for (const [label, viewport, colorScheme] of [['phone, light', { width: 390, height: 664 }, 'light'], ['desktop, dark', { width: 1440, height: 900 }, 'dark']]) {
  const ctx = await browser.newContext({ viewport, colorScheme, acceptDownloads: true });
  const p = await ctx.newPage();
  const problems = [];
  // Cloudflare injects its analytics beacon into every page at the edge; this
  // page's CSP refuses it on purpose (no third-party script where suspect files
  // are opened). Any other refusal is a real problem.
  p.on('console', m => {
    if (m.type() !== 'error' || !/Content Security Policy|Refused to/i.test(m.text())) return;
    if (/static\.cloudflareinsights\.com\/beacon/.test(m.text())) return;
    problems.push(m.text().slice(0, 160));
  });
  p.on('pageerror', e => problems.push(`pageerror: ${e.message.slice(0, 160)}`));
  await p.goto(`${BASE_URL}/pdf-safety-check/`, { waitUntil: 'load' });

  await test(`${label}: the button before a file opens the file picker`, async () => {
    const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 5000 }), p.click('#mergeBtn')]);
    if (!chooser) throw new Error('no file picker');
  });

  await p.setInputFiles('#fileInput', file);
  await p.waitForSelector('#safetyReport:not([hidden])', { timeout: 60_000 });
  await p.waitForFunction(() => document.querySelectorAll('#safetyPages canvas').length > 0, null, { timeout: 30_000 });
  const report = await p.evaluate(() => document.getElementById('safetyReport').innerText);

  await test(`${label}: the report names the script, the attached program, the link that shows another site, the QR code`, async () => {
    for (const want of ['This PDF can do more than show pages', 'Scripts', 'when the document opens', 'invoice.exe',
      'shows one address but leads to another', 'www.mybank.com', 'QR codes', 'mybank-login.example.test']) {
      if (!report.includes(want)) throw new Error(`missing "${want}" in:\n${report.slice(0, 600)}`);
    }
    if (/\bsafe\b/i.test(report.split('\n')[0])) throw new Error('the headline must not say safe');
  });

  await test(`${label}: the report shows clear of the sticky button; the links checkbox can be tapped`, async () => {
    const hit = await p.evaluate(() => {
      const h = document.querySelector('.safety-headline').getBoundingClientRect();
      const top = document.elementFromPoint(h.left + 20, h.top + h.height / 2);
      const box = document.getElementById('safetyRemoveLinks');
      box.scrollIntoView({ block: 'center' });
      const r = box.closest('label').getBoundingClientRect();
      const tap = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { headline: !!top?.closest('.safety-headline'), headlineTop: h.top, checkbox: !!tap?.closest('.safety-check') };
    });
    if (!hit.headline || hit.headlineTop < 0 || hit.headlineTop > 400) throw new Error(JSON.stringify(hit));
    if (!hit.checkbox) throw new Error(`the checkbox is covered: ${JSON.stringify(hit)}`);
  });

  await test(`${label}: the level badges keep AA contrast`, async () => {
    const pairs = await p.evaluate(() => [...document.querySelectorAll('.safety-badge')].map(b => {
      let bg = 'rgba(0, 0, 0, 0)', n = b;
      while (n && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; }
      return [getComputedStyle(b).color, bg, b.className];
    }));
    const bad = pairs.filter(([c, bg]) => ratio(c, bg) < 4.5).map(([c, bg, cls]) => `${cls}: ${ratio(c, bg).toFixed(2)}`);
    if (bad.length) throw new Error(bad.join('; '));
  });

  await test(`${label}: the cleaned copy downloads and checks clean`, async () => {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60_000 }), p.click('#mergeBtn')]);
    const out = path.join(os.tmpdir(), `safety-out-${process.pid}.pdf`);
    await dl.saveAs(out);
    const scan = await scanPdf(new Uint8Array(fs.readFileSync(out)), PDFLib);
    const acting = scan.findings.filter(f => f.risk === 'high' || f.risk === 'medium');
    fs.unlinkSync(out);
    if (acting.length) throw new Error(JSON.stringify(acting));
    if (!/-cleaned\.pdf$/.test(dl.suggestedFilename())) throw new Error(dl.suggestedFilename());
    const title = await p.textContent('#successTitle');
    if (!/Cleaned: \d+ part/.test(title)) throw new Error(title);
  });

  await test(`${label}: "as pictures" gives the same pages, each a picture, nothing of the original kept`, async () => {
    const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 120_000 }), p.click('#safetyPicturesBtn')]);
    const out = path.join(os.tmpdir(), `safety-pics-${process.pid}.pdf`);
    await dl.saveAs(out);
    const bytes = new Uint8Array(fs.readFileSync(out));
    fs.unlinkSync(out);
    const pics = await PDFDocument.load(bytes);
    const pages = pics.getPages();
    if (pages.length !== 1) throw new Error(`${pages.length} pages`);
    const res = pages[0].node.Resources();
    const xo = res.lookupMaybe(PDFName.of('XObject'), PDFLib.PDFDict);
    // pdf-lib gives every new page an empty /Font dictionary: no font in it
    const fonts = res.lookupMaybe(PDFName.of('Font'), PDFLib.PDFDict);
    if (!xo || xo.keys().length !== 1 || (fonts && fonts.keys().length)) throw new Error(`expected one picture and no font: ${String(res)}`);
    const scan = await scanPdf(bytes, PDFLib);
    if (scan.findings.length || scan.uris.length) throw new Error(JSON.stringify(scan.findings));
    if (!/-pictures\.pdf$/.test(dl.suggestedFilename())) throw new Error(dl.suggestedFilename());
  });

  await test(`${label}: no CSP violation, no page error`, async () => {
    if (problems.length) throw new Error(problems.join('\n'));
  });
  await ctx.close();
}

await browser.close();
fs.unlinkSync(file);
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
