// tests/ocrEngine.detect.test.js — detectOcrLanguage()'s choice of model,
// against a stub Tesseract worker that answers with the confidences each
// model really scored on synthetic scans (2026-10-09). The OCR itself is
// covered end to end by tests/e2e/pdf2word-ocr.e2e.mjs (network, not in CI).
//
// Run: node tests/ocrEngine.detect.test.js

import { strict as assert } from 'assert';

// detectOcrLanguage renders the sample page onto a canvas; nothing is drawn.
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
const { detectOcrLanguage } = await import('../js/ocrEngine.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const pdfDoc = {
  numPages: 1,
  getPage: async () => ({
    getViewport: () => ({ width: 595, height: 842 }),
    render: () => ({ promise: Promise.resolve() }),
  }),
};
// A worker reading a page with `conf[model]` confidence; English output that
// looks like garbage, so the probes run.
function stubWorker(conf) {
  let model = 'eng';
  const loaded = [];
  return {
    loaded,
    reinitialize: async lang => { model = lang; loaded.push(lang); },
    recognize: async () => ({ data: { text: model === 'eng' ? '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 x' : 'text text text text', confidence: conf[model] ?? 10 } }),
  };
}

await test('Chinese is read with the Chinese model, not the Japanese one that gained first', async () => {
  // zh-CN office scan: jpn 63 beat eng 32 by 15+, and the old loop stopped there
  const w = stubWorker({ eng: 32, rus: 20, ara: 25, fas: 20, jpn: 63, chi_sim: 91 });
  const d = await detectOcrLanguage(pdfDoc, w, { ignoreTextLayer: true });
  assert.equal(d.lang, 'chi_sim');
  assert.equal(d.confident, true);
  assert.equal(w.loaded[w.loaded.length - 1], 'chi_sim');   // left on the model it chose
});

await test('a Japanese scan an unsure Arabic probe "won" goes on to the Japanese model', async () => {
  // ja clean scan: ara 38 beat eng 17 by 15+ — not sure, so probing goes on
  const w = stubWorker({ eng: 17, rus: 15, ara: 38, fas: 30, jpn: 92, chi_sim: 49 });
  const d = await detectOcrLanguage(pdfDoc, w, { ignoreTextLayer: true });
  assert.equal(d.lang, 'jpn');
  assert.equal(d.confident, true);
});

await test('an Arabic photo stops at Arabic: no 10–15 MB CJK model is downloaded', async () => {
  // ar photo: ara 55, a 20-point lead over English — sure by the RTL rule
  const w = stubWorker({ eng: 35, rus: 20, ara: 55, fas: 40, jpn: 30, chi_sim: 30 });
  const d = await detectOcrLanguage(pdfDoc, w, { ignoreTextLayer: true });
  assert.equal(d.lang, 'ara');
  assert.equal(d.confident, true);
  assert.ok(!w.loaded.includes('jpn') && !w.loaded.includes('chi_sim'), `loaded ${w.loaded}`);
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
