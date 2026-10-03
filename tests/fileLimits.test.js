// tests/fileLimits.test.js — js/fileLimits.js: one table of per-tool file-size caps,
// with a larger tier for a desktop Chromium browser reporting 8 GB+ of memory.
// Run: node tests/fileLimits.test.js

import { strict as assert } from 'assert';
import { maxFileMb } from '../js/fileLimits.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const desktop8 = { deviceMemory: 8, userAgentData: { mobile: false } };
const android8 = { deviceMemory: 8, userAgentData: { mobile: true } };
const desktop4 = { deviceMemory: 4, userAgentData: { mobile: false } };
const safari = {}; // no deviceMemory, no userAgentData

console.log('\nfileLimits.js — maxFileMb:');

test('every device keeps the caps the runners had before the table (no silent change)', () => {
  const before = { merge: 300, split: 200, extract: 200, organize: 200, resize: 200, mangaSplit: 200, fill: 200,
    watermark: 200, formFields: 200, pagenum: 200, meta: 200, protect: 200, flatten: 200, rotate: 150, redact: 150,
    compress: 150, glossary: 150, cleanScan: 150, ereader: 150, pdf2word: 150, pdf2excel: 150, pdf2ppt: 150,
    pdf2md: 150, unlock: 150, ocr: 200, pdf2jpg: 100, docx2pdf: 60, jpg2pdf: 50 };
  for (const [tool, mb] of Object.entries(before)) assert.equal(maxFileMb(tool, safari), mb, tool);
});

test('a desktop Chromium browser with 8 GB+ gets the measured larger caps', () => {
  for (const tool of ['merge', 'split', 'extract', 'compress']) assert.equal(maxFileMb(tool, desktop8), 500, tool);
});

test('tools not measured on a large device keep their base cap there too', () => {
  assert.equal(maxFileMb('pdf2word', desktop8), 150);
  assert.equal(maxFileMb('jpg2pdf', desktop8), 50);
});

test('an Android phone reporting 8 GB, a 4 GB desktop and Safari/Firefox stay on the base caps', () => {
  for (const nav of [android8, desktop4, safari]) assert.equal(maxFileMb('compress', nav), 150);
});

test('an unknown tool falls back to 200 MB', () => {
  assert.equal(maxFileMb('someNewTool', safari), 200);
});

console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
if (failed > 0) process.exit(1);
