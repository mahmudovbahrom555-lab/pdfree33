// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/file-added-analytics.e2e.mjs — "File Added" once per attempt
//  (2026-10-25). It fired only when the list held exactly one file, so Merge
//  and JPG→PDF — files several at a time — showed 11 % and 9 % of opens adding
//  one (Split 65 %). An attempt runs from a tool opening, or a result, to the
//  next result: one event however many files come, none more for removing and
//  adding again, a new one after a result or in another tool. The event holds
//  no file name. And Draw, which downloads its result itself, sends Tool
//  Success and Download like every other tool. Analytics calls are
//  intercepted here, never sent.
//  Run: node tests/e2e/file-added-analytics.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const A = path.join(FIX, 'normal-1page.pdf'), B = path.join(FIX, 'normal-3page.pdf'), C = path.join(FIX, 'minimal.pdf');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
async function open(toolPath) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const page = await context.newPage();
  const events = [];
  await page.route('**/api/analytics', r => { events.push(JSON.parse(r.request().postData())); r.fulfill({ status: 200, body: 'OK' }); });
  await page.goto(BASE_URL + toolPath, { waitUntil: 'load' });
  const added = () => events.filter(e => e.event === 'File Added');
  const settle = () => page.waitForTimeout(1500);
  return { context, page, events, added, settle };
}

console.log(`\nFile Added per attempt E2E (${BASE_URL}):`);

await test('Merge: three files at once count once; the event holds the tool and a size band, no file name', async () => {
  const s = await open('/merge-pdf/');
  try {
    await s.page.setInputFiles('#fileInput', [A, B, C]); await s.settle();
    const fa = s.added();
    if (fa.length !== 1) throw new Error(`${fa.length} File Added`);
    const keys = Object.keys(fa[0].props).sort().join(',');
    if (keys !== 'def,locale,session,size,tool') throw new Error(`props: ${keys}`);
    if (fa[0].props.tool !== 'merge' || fa[0].props.def !== 2) throw new Error(JSON.stringify(fa[0].props));
    if (JSON.stringify(fa[0]).includes('normal-')) throw new Error('a file name in the event');
  } finally { await s.context.close(); }
});

await test('Merge: one file, then two more — still one attempt', async () => {
  const s = await open('/merge-pdf/');
  try {
    await s.page.setInputFiles('#fileInput', A); await s.settle();
    await s.page.setInputFiles('#fileInput', [B, C]); await s.settle();
    if (s.added().length !== 1) throw new Error(`${s.added().length} File Added`);
  } finally { await s.context.close(); }
});

await test('Merge: files removed and added again before a result — still one attempt', async () => {
  const s = await open('/merge-pdf/');
  try {
    await s.page.setInputFiles('#fileInput', [A, B]); await s.settle();
    while (await s.page.$('.file-item-del')) { await s.page.click('.file-item-del'); await s.page.waitForTimeout(300); }
    await s.page.setInputFiles('#fileInput', [A, C]); await s.settle();
    if (s.added().length !== 1) throw new Error(`${s.added().length} File Added`);
  } finally { await s.context.close(); }
});

await test('Split: after a result, the next file starts a new attempt — one more event', async () => {
  const s = await open('/split-pdf/');
  try {
    await s.page.setInputFiles('#fileInput', B); await s.settle();
    await s.page.click('#mergeBtn');
    await s.page.waitForFunction(() => !document.querySelector('#successCard')?.hidden, null, { timeout: 60000 });
    await s.settle();
    if (!s.events.some(e => e.event === 'Tool Success')) throw new Error('no Tool Success — the test tests nothing');
    while (await s.page.$('.file-item-del')) { await s.page.click('.file-item-del'); await s.page.waitForTimeout(300); }
    await s.page.setInputFiles('#fileInput', A); await s.settle();
    if (s.added().length !== 2) throw new Error(`${s.added().length} File Added, expected 2`);
  } finally { await s.context.close(); }
});

await test('another tool opened in the page: its first file counts for it', async () => {
  const s = await open('/merge-pdf/');
  try {
    await s.page.setInputFiles('#fileInput', [A, B]); await s.settle();
    await s.page.evaluate(() => document.querySelector('a[data-tool="split"]')?.click());
    await s.page.waitForTimeout(1500);
    if (!s.events.some(e => e.event === 'Tool Open' && e.props.tool === 'split')) throw new Error('split not opened in the page');
    while (await s.page.$('.file-item-del')) { await s.page.click('.file-item-del'); await s.page.waitForTimeout(300); }
    await s.page.setInputFiles('#fileInput', C); await s.settle();
    const tools = s.added().map(e => e.props.tool).join(',');
    if (tools !== 'merge,split') throw new Error(`File Added for: ${tools}`);
  } finally { await s.context.close(); }
});

// Draw downloads its result itself: Tool Success and Download were never sent
// (verified on pdfree.io 2026-10-25: annotated.pdf saved, events Tool Open and
// File Added only).
async function drawStroke(page, dx = 0) {
  const bb = await (await page.$('#drawCanvas')).boundingBox();
  await page.mouse.move(bb.x + 80 + dx, bb.y + 80); await page.mouse.down();
  for (let k = 1; k <= 10; k++) await page.mouse.move(bb.x + 80 + dx + k * 15, bb.y + 80 + k * 8);
  await page.mouse.up(); await page.waitForTimeout(300);
}
await test('Draw: a downloaded drawing sends Tool Success and Download once per result, after the download — none with nothing drawn, none for the same drawing again', async () => {
  const s = await open('/draw-on-pdf/');
  const context = s.context;
  try {
    const at = {};
    s.page.on('download', () => { at.download ??= Date.now(); });
    await s.page.route('**/api/analytics', r => {
      const e = JSON.parse(r.request().postData()); s.events.push(e);
      if (e.event === 'Tool Success') at.success ??= Date.now();
      r.fulfill({ status: 200, body: 'OK' });
    });
    await s.page.setInputFiles('#fileInput', B); await s.page.waitForTimeout(5000);
    await s.page.click('#downloadPdfBtn'); await s.settle();   // nothing drawn: no result
    const count = name => s.events.filter(e => e.event === name && e.props.tool === 'draw-pdf').length;
    if (count('Tool Success')) throw new Error('a success with nothing drawn');
    await drawStroke(s.page);
    const [dl] = await Promise.all([s.page.waitForEvent('download', { timeout: 60000 }), s.page.click('#downloadPdfBtn')]);
    await s.settle();
    if (!dl) throw new Error('no download');
    if (count('Tool Success') !== 1 || count('Download') !== 1) throw new Error(`success ${count('Tool Success')}, download ${count('Download')}`);
    if (!(at.download <= at.success)) throw new Error('success sent before the download started');
    await Promise.all([s.page.waitForEvent('download', { timeout: 60000 }), s.page.click('#downloadPdfBtn')]);   // same drawing again
    await s.settle();
    if (count('Tool Success') !== 1 || count('Download') !== 1) throw new Error(`the same drawing again: success ${count('Tool Success')}, download ${count('Download')}`);
    await drawStroke(s.page, 120);   // a new stroke: a new result
    await Promise.all([s.page.waitForEvent('download', { timeout: 60000 }), s.page.click('#downloadPdfBtn')]);
    await s.settle();
    if (count('Tool Success') !== 2 || count('Download') !== 2) throw new Error(`a changed drawing: success ${count('Tool Success')}, download ${count('Download')}`);
    if (s.events.some(e => /normal-3page|annotated/.test(JSON.stringify(e)))) throw new Error('a file name in an event');
  } finally { await context.close(); }
});

await browser.close();
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
