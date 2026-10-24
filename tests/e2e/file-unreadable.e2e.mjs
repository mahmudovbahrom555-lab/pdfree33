// SPDX-License-Identifier: AGPL-3.0-only
// ============================================================
//  tests/e2e/file-unreadable.e2e.mjs — a file that changed after it was
//  selected (2026-10-13).
//
//  A user's Merge failed with Chrome's raw "The requested file could not be
//  read, typically due to permission problems that have occurred after a
//  reference to a file was acquired." (MERGE-C308 — the unclassified bucket).
//  Chrome refuses to read a File whose file on disk changed since it was
//  picked: saved again by another app, moved, deleted, a cloud-drive file not
//  on the device. Since 2026-10-16 every added file is copied when it is
//  added, and such a file is simply processed: change or delete it on disk
//  after adding it, press the button — the result comes out.
//
//  And a file removed from the list right after the button was pressed (the
//  click waits a frame and the password check, the list not locked yet):
//  PDF→JPG ran on an empty list — "Cannot read properties of undefined
//  (reading 'size')", PDF2JPG-2431, 8 times in two weeks from India.
//
//  And when a file can't be copied (past the copy budget: 150 MB on a device
//  with under 4 GB of memory) and then can't be read, the error says why in
//  a "File Unreadable" event (SPLIT-DFCC, 2026-10-23: the cause couldn't be
//  told). Here: 2 GB, a 160 MB PDF, deleted after it was added → copy=over_budget;
//  then the file is marked in the list, a second press doesn't repeat the error,
//  and "choose again" puts a new file in its place, which runs.
//
//  Run: node tests/e2e/file-unreadable.e2e.mjs   (dist/ served on :8934)
// ============================================================

import { chromium } from 'playwright';
import { appendFileSync, closeSync, copyFileSync, mkdtempSync, openSync, rmSync, writeSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
const GT = path.join(__dirname, '..', 'corpus', 'groundtruth');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const dir = mkdtempSync(path.join(tmpdir(), 'pdfree-unreadable-'));
const browser = await chromium.launch();
try {
  // Each added file is copied when it is added (files.js _keepCopy), so a file
  // changed, deleted or swapped on disk afterwards is still processed — the
  // error above (MERGE-C308), and ORGANIZE-1455 (2026-10-16: a merged PDF
  // opened in Organize, pages arranged, then "Couldn't read"), never come up.
  const result = async (page, run) => {
    await page.addInitScript(() => {
      const o = URL.createObjectURL.bind(URL);
      URL.createObjectURL = x => { if (x instanceof Blob && x.size > 500 && /pdf|zip/.test(x.type)) window.__result = x; return o(x); };
      document.addEventListener('pdfree:error', e => { window.__error = e.detail.message; });
    });
    await run();
    await page.waitForFunction(() => window.__result || window.__error, null, { timeout: 90000 });
    const error = await page.evaluate(() => window.__error);
    if (error) throw new Error(error);
  };

  await test('Merge still merges a file changed on disk after it was added', async () => {
    const changed = path.join(dir, 'report.pdf'), other = path.join(dir, 'second.pdf');
    copyFileSync(path.join(GT, 'en-web.pdf'), changed);
    copyFileSync(path.join(GT, 'ru-web.pdf'), other);
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    await result(page, async () => {
      await page.goto(`${BASE_URL}/merge-pdf/`, { waitUntil: 'load' });
      await page.setInputFiles('#fileInput', [changed, other]);
      await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
      await page.waitForTimeout(1500);
      appendFileSync(changed, '\n% saved again by another app\n');
      await page.click('#mergeBtn');
    });
  });

  for (const [tool, url, prep] of [
    ['Organize', '/organize-pdf/', null],
    ['Compress (the file goes to a worker)', '/compress-pdf/', () => {
      const i = document.querySelector('input[name="compressPreset"][value="medium"]');
      i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
    }],
  ]) {
    await test(`${tool} still runs on a file deleted from disk after it was added`, async () => {
      const gone = path.join(dir, `gone-${url.replace(/\W/g, '')}.pdf`);
      copyFileSync(path.join(GT, 'en-web.pdf'), gone);
      const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
      await result(page, async () => {
        await page.goto(BASE_URL + url, { waitUntil: 'load' });
        await page.setInputFiles('#fileInput', gone);
        await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 30000 });
        await page.waitForTimeout(2000);
        rmSync(gone);
        if (prep) await page.evaluate(prep);
        await page.click('#mergeBtn');
      });
    });
  }

  await test('a file removed right after Convert was pressed is not processed — no error', async () => {
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE_URL}/pdf2jpg/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', path.join(GT, 'en-web.pdf'));
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { document.querySelector('#mergeBtn').click(); document.querySelector('.file-item-del').click(); });
    await page.waitForTimeout(3000);
    const toast = await page.evaluate(() => document.querySelector('#toast')?.innerText || '');
    if (/reading 'size'|Error ID/.test(toast) || errors.length) throw new Error(`toast: ${toast} | errors: ${errors}`);
  });
  await test('a file past the copy budget, then unreadable: the error says why (copy=over_budget)', async () => {
    // a real PDF of 160 MB: one page, its content stream 160 MB of spaces
    const big = path.join(dir, 'big.pdf'), N = 160 * 1048576, fd = openSync(big, 'w');
    const head = '%PDF-1.4\n', objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>'];
    let at = 0; const offs = []; const put = t => { writeSync(fd, t); at += Buffer.byteLength(t); };
    put(head);
    objs.forEach((o, i) => { offs.push(at); put(`${i + 1} 0 obj ${o} endobj\n`); });
    offs.push(at); put(`4 0 obj <</Length ${N}>> stream\n`);
    const chunk = Buffer.alloc(8 * 1048576, 0x20);
    for (let k = 0; k < N / chunk.length; k++) { writeSync(fd, chunk); at += chunk.length; }
    put('\nendstream endobj\n');
    const xref = at;
    put(`xref\n0 5\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer <</Size 5/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
    closeSync(fd);
    const page = await (await browser.newContext({ serviceWorkers: 'block' })).newPage();
    const events = [];
    await page.route('**/api/analytics', r => { events.push(JSON.parse(r.request().postData() || '{}')); r.fulfill({ status: 204 }); });
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });   // analytics on
      Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 2 });    // the 150 MB budget
      document.addEventListener('pdfree:error', e => { window.__error = e.detail.message; });
    });
    await page.goto(`${BASE_URL}/split-pdf/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', big);
    await page.waitForFunction(() => !document.querySelector('#mergeBtn')?.disabled, null, { timeout: 60000 });
    await page.waitForTimeout(2000);
    rmSync(big);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__error, null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const ev = events.find(e => e.event === 'File Unreadable');
    if (!ev) throw new Error(`no File Unreadable event: ${JSON.stringify(events.map(e => e.event))}`);
    if (ev.props.tool !== 'split' || ev.props.copy !== 'over_budget' || ev.props.size !== '150–600 MB') throw new Error(JSON.stringify(ev.props));
    const err = events.find(e => e.event === 'Tool Error');
    if (err?.props.error_type !== 'file_unreadable' || 'copy' in err.props) throw new Error(`Tool Error changed: ${JSON.stringify(err?.props)}`);

    // and the way back: the file is marked in the list; the button doesn't
    // repeat the error; "choose again" puts a new file in its place, which runs
    if (!await page.locator('[data-reselect="0"]').count()) throw new Error('no "choose again" on the unreadable file');
    await page.evaluate(() => { window.__error = null; });
    await page.click('#mergeBtn');
    await page.waitForTimeout(1500);
    if (events.filter(e => e.event === 'Tool Error').length !== 1) throw new Error('the press repeated the error');
    const toast = await page.evaluate(() => document.querySelector('#toast')?.innerText || '');
    if (!toast.includes('big.pdf')) throw new Error(`no pointer to the file: ${toast}`);
    const again = path.join(dir, 'again.pdf'); copyFileSync(path.join(GT, 'en-web.pdf'), again);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-reselect="0"]')]);
    await chooser.setFiles(again);
    await page.waitForFunction(() => !document.querySelector('[data-reselect]') && document.querySelector('.file-item-name')?.textContent === 'again.pdf', null, { timeout: 30000 });
    await page.evaluate(() => {
      const o = URL.createObjectURL.bind(URL);
      URL.createObjectURL = x => { if (x instanceof Blob && x.size > 500 && /pdf|zip/.test(x.type)) window.__result = x; return o(x); };
    });
    await page.waitForTimeout(1500);
    await page.click('#mergeBtn');
    await page.waitForFunction(() => window.__result || window.__error, null, { timeout: 60000 });
    const after = await page.evaluate(() => window.__error);
    if (after) throw new Error(`the chosen-again file failed: ${after}`);
  });
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
