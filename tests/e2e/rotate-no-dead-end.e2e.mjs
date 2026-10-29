// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Rotate had dead ends: the toolbar's ↺ / ↻ with no page selected only said
// "select pages first", and the main button with nothing turned said "rotate
// at least one page" — no hint how. All 4 rage-click tabs on the main button
// in China (2026-10) were on Rotate, 3 of 4 left with no file. Now the
// toolbar with nothing selected turns every page, each page has a large ↻ of
// its own, and the main button with nothing turned shows how to rotate.
// Checked on a desktop and a short phone screen (the sticky main button must
// not cover a page's ↻).
// Run: node tests/e2e/rotate-no-dead-end.e2e.mjs   (dist/ served on :8934)

import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 3; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 60, y: 760, size: 24, font });
const file = path.join(os.tmpdir(), `rotate-dead-end-${process.pid}.pdf`);
fs.writeFileSync(file, await doc.save());

const changed = page => page.$$eval('#rotGrid .rot-card', cs => cs.map(c => c.classList.contains('rot-card--changed')));
const toast = page => page.evaluate(() => (document.querySelector('#toast')?.innerText || '').trim());

const browser = await chromium.launch();
for (const [label, viewport, locale] of [['desktop', { width: 1440, height: 900 }, ''], ['phone', { width: 390, height: 664 }, 'zh/xuanzhuan-pdf'], ['phone', { width: 390, height: 664 }, '']]) {
  const ctx = await browser.newContext({ viewport, hasTouch: label === 'phone', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__blob = null; window.__armed = false;
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (window.__armed && !window.__blob && b instanceof Blob && b.size && !/javascript|image/.test(b.type)) window.__blob = b; return orig(b); };
  });
  const where = `${label}${locale ? ' zh' : ''}`;
  await page.goto(`${BASE_URL}/${locale || 'rotate-pdf'}/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', file);
  await page.waitForSelector('#rotGrid .rot-card', { timeout: 30_000 });

  await test(`${where}: the main button with nothing turned says how to rotate`, async () => {
    const hint = await page.$eval('#rotHint', el => el.textContent.trim());
    await page.click('#mergeBtn');
    await page.waitForFunction(h => (document.querySelector('#toast')?.innerText || '').includes(h), hint, { timeout: 5000 })
      .catch(async () => { throw new Error(`toast "${await toast(page)}", expected the hint "${hint}"`); });
    if ((await changed(page)).some(Boolean)) throw new Error('a page turned');
  });

  await test(`${where}: toolbar ↻ with no page selected turns every page`, async () => {
    await page.click('#rotRight');
    const c = await changed(page);
    if (!c.every(Boolean)) throw new Error(`changed: ${c}`);
    if (/select/i.test(await toast(page)) && !locale) throw new Error('still asks to select');
    await page.click('#rotReset');
  });

  await test(`${where}: every ↻ on screen right after the file is added takes the tap itself`, async () => {
    // the first view, unscrolled: the sticky main button must not lie on a ↻
    const covered = await page.$$eval('#rotGrid [data-act="rotate"]', bs => bs.map((b, i) => {
      const r = b.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (y < 0 || y > innerHeight) return null;
      return document.elementFromPoint(x, y)?.closest('[data-act="rotate"]') === b ? null : `page ${i + 1} under ${document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.className}`;
    }).filter(Boolean));
    if (covered.length) throw new Error(covered.join('; '));
  });

  await test(`${where}: a page's own ↻ is large, reachable and turns only that page`, async () => {
    const btn = page.locator('#rotGrid .rot-card').nth(1).locator('[data-act="rotate"]');
    await btn.evaluate(b => b.closest('.rot-card').scrollIntoView({ block: 'center' }));
    const box = await btn.boundingBox();
    if (box.width < 40 || box.height < 40) throw new Error(`button ${box.width}×${box.height}`);
    const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-act="rotate"]'), [box.x + box.width / 2, box.y + box.height / 2]);
    if (!hit) throw new Error('something covers the ↻');
    await btn.click();
    const c = await changed(page);
    if (String(c) !== 'false,true,false') throw new Error(`changed: ${c}`);
    await page.click('#rotReset');
  });

  await test(`${where}: a selection still limits the toolbar to the selected pages`, async () => {
    await page.locator('#rotGrid .rot-card').first().click({ position: { x: 10, y: 10 } });
    await page.click('#rotLeft');
    const c = await changed(page);
    if (String(c) !== 'true,false,false') throw new Error(`changed: ${c}`);
    await page.click('#rotReset');
  });

  if (!locale) await test(`${where}: toolbar ↻ then the main button gives a PDF with every page turned`, async () => {
    await page.click('#rotRight');
    await page.evaluate(() => { window.__armed = true; });
    await page.click('#mergeBtn');
    await page.waitForFunction(() => !!window.__blob, null, { timeout: 30_000 });
    const b64 = await page.evaluate(async () => {
      const u = new Uint8Array(await window.__blob.arrayBuffer()); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const out = await PDFDocument.load(Buffer.from(b64, 'base64'));
    const angles = out.getPages().map(p => p.getRotation().angle);
    if (String(angles) !== '90,90,90') throw new Error(`angles: ${angles}`);
  });
  await ctx.close();
}

await browser.close();
fs.unlinkSync(file);
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
