// ============================================================
//  tests/splitWorker.integration.test.js
//
//  Integration tests for js/splitWorker.js's handleSplit().
//
//  Sibling of (NOT a replacement for) tests/worker.integration.test.js's
//  own handleSplit tests — that file keeps testing js/worker.js's own
//  now-dead copy of handleSplit (worker.js is off-limits so it's left
//  untouched, harmless dead code). This file tests the LIVE copy that
//  js/splitWorker.js actually ships, forked out specifically to fix an
//  O(N pages) peak-memory bug in 'separate' mode (see splitWorker.js's
//  own header comment — a real user hit an out-of-memory crash,
//  error ID SPLIT-7058).
//
//  Same harness pattern as tests/resizeWorker.integration.test.js — see
//  that file's header for why we test the handler function directly
//  instead of the real Worker (postMessage doesn't exist in Node).
//
//  'single' mode assertions below are ported UNCHANGED from
//  worker.integration.test.js's own handleSplit coverage — the fork was
//  verified byte-identical for this branch (see splitWorker.js's header),
//  and these tests are the regression guard for that claim staying true
//  over time, not just at fork time. 'separate' mode assertions are NEW:
//  the streaming message contract (individual 'page' messages instead of
//  one batched 'done' with a results array) is the actual behavior change.
//
//  Run: node tests/splitWorker.integration.test.js
// ============================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

const PDFLib = await import('pdf-lib');

const messages = [];
global.self = {
  postMessage: (msg) => messages.push(msg),
  onmessage:   null,
};
global.PDFLib = PDFLib;   // splitWorker.js reads PDFLib from global scope (verbatim copy of worker.js's own convention)

const FIXTURES = join(__dir, 'fixtures');

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
const fix = (name) => toArrayBuffer(readFileSync(join(FIXTURES, name)));

const _normal1 = fix('normal-1page.pdf');
const _normal3 = fix('normal-3page.pdf');
const clone = (buf) => buf.slice(0);  // ArrayBuffer.slice() = fresh copy — handleSplit transfers (detaches) buffers
const normal1 = () => clone(_normal1);
const normal3 = () => clone(_normal3);

// Same bookmarked-3-page fixture construction as worker.integration.test.js's
// _buildBookmarked3Page — duplicated here rather than imported (that file
// doesn't export it, and it's cheap to rebuild).
async function _buildBookmarked3Page() {
  const { PDFDocument, PDFName, PDFString } = PDFLib;
  const doc = await PDFDocument.load(_normal3.slice(0));
  const pages = doc.getPages();
  const itemRefs = pages.map(() => doc.context.nextRef());
  pages.forEach((page, i) => {
    const item = doc.context.obj({
      Title: PDFString.of(`Bookmark ${i + 1}`),
      Dest:  [page.ref, PDFName.of('Fit')],
    });
    if (i < pages.length - 1) item.set(PDFName.of('Next'), itemRefs[i + 1]);
    if (i > 0) item.set(PDFName.of('Prev'), itemRefs[i - 1]);
    doc.context.assign(itemRefs[i], item);
  });
  const outlineRef = doc.context.register(doc.context.obj({
    Type:  PDFName.of('Outlines'),
    First: itemRefs[0],
    Last:  itemRefs[itemRefs.length - 1],
    Count: pages.length,
  }));
  itemRefs.forEach(ref => {
    doc.context.lookup(ref).set(PDFName.of('Parent'), outlineRef);
  });
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
const _bookmarked3 = await _buildBookmarked3Page();
const bookmarked3 = () => clone(_bookmarked3);

function _collectOutlineEntries(doc) {
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFString } = PDFLib;
  const entries = [];
  const outlinesObj = doc.catalog.get(PDFName.of('Outlines'));
  if (!outlinesObj) return entries;
  const outlinesDict = doc.context.lookup(outlinesObj, PDFDict);

  function walk(ref) {
    let cur = ref;
    while (cur) {
      const item  = doc.context.lookup(cur, PDFDict);
      const titleObj = item.lookup(PDFName.of('Title'));
      const title = titleObj instanceof PDFString ? titleObj.decodeText() : titleObj.toString();
      const destArr = item.lookupMaybe(PDFName.of('Dest'), PDFArray);
      const first = destArr && destArr.size() > 0 ? destArr.get(0) : null;
      entries.push({ title, pageRef: first instanceof PDFRef ? first : null });
      const childFirst = item.get(PDFName.of('First'));
      if (childFirst) walk(childFirst);
      cur = item.get(PDFName.of('Next'));
    }
  }
  const first = outlinesDict.get(PDFName.of('First'));
  if (first) walk(first);
  return entries;
}

// ── Extract handleSplit from splitWorker.js ────────────────────
const workerSrc = readFileSync(join(__dir, '../js/splitWorker.js'), 'utf8')
  .replace(/importScripts\([^)]+\);?/g, '')
  .replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const workerModule = new AsyncFunction(workerSrc + '\nreturn { handleSplit };');
const { handleSplit } = await workerModule();

// ── Test runner (same shape as worker.integration.test.js) ─────

let passed = 0, failed = 0;

async function test(name, fn) {
  messages.length = 0;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe:           (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy:     ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy:      ()  => { if (actual)  throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toBeGreaterThan:(n) => { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
    toBeInstanceOf: (T) => { if (!(actual instanceof T)) throw new Error(`Expected instanceof ${T.name}`); },
  };
}

function lastDone()   { return messages.findLast(m => m.type === 'done'); }
function pageMsgs()   { return messages.filter(m => m.type === 'page'); }

console.log('\nsplitWorker.js — handleSplit (dedicated worker, forked for the SPLIT-7058 memory fix):');

// ── Single mode — ported unchanged from worker.integration.test.js ─────

await test('single mode: extracts subset of pages (unchanged from the shared-worker version)', async () => {
  await handleSplit(normal3(), { pages: [1, 3], mode: 'single' });
  const done = lastDone();
  expect(done.mode).toBe('single');
  expect(done.totalPages).toBe(2);
  expect(done.result).toBeInstanceOf(ArrayBuffer);
  expect(String.fromCharCode(...new Uint8Array(done.result).slice(0, 4))).toBe('%PDF');
});

await test('split throws on no valid pages', async () => {
  let threw = false;
  try { await handleSplit(normal1(), { pages: [99], mode: 'single' }); }
  catch { threw = true; }
  expect(threw).toBeTruthy();
});

await test('single mode: extracting a SUBSET of a bookmarked PDF keeps ONLY the surviving pages\' bookmarks', async () => {
  const { PDFDocument } = PDFLib;
  await handleSplit(bookmarked3(), { pages: [1, 2], mode: 'single' }); // page 3 removed
  const done = lastDone();
  const out  = await PDFDocument.load(done.result);
  expect(out.getPageCount()).toBe(2);

  const entries = _collectOutlineEntries(out);
  expect(entries.length).toBe(2);
  expect(entries.map(e => e.title).sort().join(',')).toBe('Bookmark 1,Bookmark 2');
  expect(entries.some(e => e.title === 'Bookmark 3')).toBeFalsy();

  const pageRefTags = new Set(out.getPages().map(p => p.ref.tag));
  for (const e of entries) {
    expect(e.pageRef !== null).toBeTruthy();
    expect(pageRefTags.has(e.pageRef.tag)).toBeTruthy();
  }
});

await test('single mode: pages=[3,1,2] (full reorder, nothing removed) outputs in that exact order', async () => {
  const { PDFDocument } = PDFLib;
  await handleSplit(bookmarked3(), { pages: [3, 1, 2], mode: 'single' });
  const done = lastDone();
  const out  = await PDFDocument.load(done.result);
  expect(out.getPageCount()).toBe(3);

  const entries = _collectOutlineEntries(out);
  const titleForRef = tag => entries.find(e => e.pageRef.tag === tag)?.title;
  const outputOrder = out.getPages().map(p => titleForRef(p.ref.tag));
  expect(outputOrder.join(',')).toBe('Bookmark 3,Bookmark 1,Bookmark 2');
});

// ── Separate mode — NEW streaming-contract assertions ───────────────────
// This is the actual behavior change: was one 'done' message carrying a
// results[] array of every page's buffer; now it's one 'page' message per
// finished page (so processor.js's _runSplit can zip-and-discard each one
// as it arrives instead of waiting for all of them), followed by a 'done'
// with no result field at all.

await test('separate mode: streams one \'page\' message per page, not a batched result array', async () => {
  await handleSplit(normal3(), { pages: [1, 2], mode: 'separate' });
  const pages = pageMsgs();
  expect(pages.length).toBe(2);
  expect(pages[0].name).toBe('page_1.pdf');
  expect(pages[1].name).toBe('page_2.pdf');
  expect(pages[0].buffer).toBeInstanceOf(ArrayBuffer);
  expect(pages[1].buffer).toBeInstanceOf(ArrayBuffer);
  expect(String.fromCharCode(...new Uint8Array(pages[0].buffer).slice(0, 4))).toBe('%PDF');

  const done = lastDone();
  expect(done.mode).toBe('separate');
  expect(done.totalPages).toBe(2);
  expect('result' in done).toBeFalsy(); // no batched array anymore — all pages already streamed
});

await test('separate mode: \'page\' messages arrive in ascending index order', async () => {
  await handleSplit(normal3(), { pages: [1, 2, 3], mode: 'separate' });
  const pages = pageMsgs();
  expect(pages.length).toBe(3);
  expect(pages.map(p => p.index).join(',')).toBe('0,1,2');
  expect(pages.every(p => p.total === 3)).toBeTruthy();
});

await test('separate mode: each per-page split of a bookmarked PDF keeps ONLY that page\'s own bookmark', async () => {
  const { PDFDocument } = PDFLib;
  await handleSplit(bookmarked3(), { pages: [1, 2, 3], mode: 'separate' });
  const pages = pageMsgs();
  expect(pages.length).toBe(3);
  for (let i = 0; i < pages.length; i++) {
    const out = await PDFDocument.load(pages[i].buffer);
    expect(out.getPageCount()).toBe(1);
    const entries = _collectOutlineEntries(out);
    expect(entries.length).toBe(1);
    expect(entries[0].title).toBe(`Bookmark ${i + 1}`);
    expect(entries[0].pageRef.tag).toBe(out.getPages()[0].ref.tag);
  }
});

await test('AES-encrypted PDF still throws pdf-aes-encrypted in separate mode (same guard as single mode)', async () => {
  const { PDFDocument, PDFName, PDFDict } = PDFLib;
  const doc = await PDFDocument.load(_normal1.slice(0));
  // Minimal fake /Encrypt entry — handleSplit only checks for its presence,
  // never actually decrypts, matching the real guard's own logic.
  const encRef = doc.context.register(doc.context.obj({ Filter: PDFName.of('Standard') }));
  doc.context.trailerInfo.Encrypt = encRef;
  const bytes = await doc.save({ useObjectStreams: false });
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  let threw = null;
  try { await handleSplit(buf, { pages: [1], mode: 'separate' }); }
  catch (e) { threw = e; }
  expect(threw !== null).toBeTruthy();
  expect(threw.message).toBe('pdf-aes-encrypted');
});

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
