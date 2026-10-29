// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/search-misses.e2e.mjs — homepage search on real misses
//  (Search Miss events, 2026-10-14..29), in a real browser.
//
//  What tests/search.logic.test.js can't see: a Chinese or Japanese request
//  typed on the English page (searched with the CJK synonyms build.py ships
//  in searchKeywords.js), and that a two-letter word still being typed
//  ("cl") is not sent as a Search Miss while "md" finds a tool.
//  Run: node tests/e2e/search-misses.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const browser = await chromium.launch();
async function home(urlPath) {
  const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // analytics is off for automated browsers; on here, and caught, not sent
  await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => false }));
  const events = [];
  await page.route('**/api/analytics', r => { events.push(JSON.parse(r.request().postData())); r.fulfill({ status: 204 }); });
  await page.goto(BASE_URL + urlPath, { waitUntil: 'load' });
  await page.waitForFunction(() => window.PDFREE_CJK_TAGS);
  const find = async q => {
    await page.evaluate(q => { const el = document.querySelector('#toolSearch'); el.value = q; el.dispatchEvent(new InputEvent('input', { data: q })); }, q);
    await page.waitForTimeout(400);
    return page.evaluate(() => document.querySelector('#searchResult')?.hidden ? '' : document.querySelector('#srName')?.innerText);
  };
  return { page, errors, events, find };
}

try {
  console.log('\nEnglish homepage:');
  const en = await home('/');
  for (const [q, want] of [['漂白', /Clean Scan/], ['编辑', /Quick Edit/], ['背景の黒い部分を白くしたい', /Clean Scan/],
    ['md', /Markdown/], ['unprotect', /Unlock/], ['edit', /Quick Edit/], ['whiten scan', /Clean Scan/], ['pdf', /./]]) {
    await test(`"${q}" → ${want.source}`, async () => {
      const name = await en.find(q);
      if (!want.test(name)) throw new Error(`got "${name}"`);
    });
  }
  await test('"cl" (still typing) shows nothing and sends no Search Miss; "zzqx" does', async () => {
    en.events.length = 0;
    if (await en.find('cl')) throw new Error('"cl" found a tool');
    await en.find('zzqx');
    const misses = en.events.filter(e => e.event === 'Search Miss').map(e => e.props.query);
    if (misses.join() !== 'zzqx') throw new Error(`misses sent: ${JSON.stringify(misses)}`);
  });
  await test('no page errors', async () => { if (en.errors.length) throw new Error(en.errors.join('; ')); });

  console.log('\nChinese homepage:');
  const zh = await home('/zh/');
  for (const [q, want] of [['去水印', /涂黑|Redact/], ['插入空白', /合并/], ['漂白', /清理扫描/]]) {
    await test(`"${q}" → ${want.source}`, async () => {
      const name = await zh.find(q);
      if (!want.test(name)) throw new Error(`got "${name}"`);
    });
  }
} finally {
  await browser.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
