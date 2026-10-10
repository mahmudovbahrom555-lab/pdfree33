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
let englishText = '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 x';
// `texts[model]`: what that model reads (default: text in its own script).
const OWN_TEXT = {
  chi_sim: '压缩后的文件看起来一样体积却变小了', jpn: 'クリーンモードと補正モードの違い',
  ara: 'ما الفرق بين الوضعين', fas: 'تفاوت بین دو حالت چیست', rus: 'в чем разница между режимами',
};
function stubWorker(conf, texts = {}, words = []) {
  let model = 'eng';
  const w = {
    loaded: [],
    terminated: false,
    reinitialize: async lang => { model = lang; w.loaded.push(lang); },
    recognize: async () => ({ data: {
      text: texts[model] ?? (model === 'eng' ? englishText : OWN_TEXT[model] ?? 'text text text text'),
      confidence: conf[model] ?? 10, words: model === 'eng' ? words : [],
    } }),
    terminate: async () => { w.terminated = true; },
  };
  return w;
}
// detectOcrLanguage(pdfDoc, main worker, opts) with the probe workers it made
async function detect(conf, opts = {}, texts = {}, words = []) {
  const w = stubWorker(conf, texts, words);
  const probes = [];
  const newWorker = async () => { const p = stubWorker(conf, texts); probes.push(p); return p; };
  const d = await detectOcrLanguage(pdfDoc, w, { ignoreTextLayer: true, ...opts, newWorker });
  return { d, w, probes, probed: probes.flatMap(p => p.loaded) };
}

await test('Chinese is read with the Chinese model, not the Japanese one that gained first', async () => {
  // zh-CN office scan: jpn 63 beat eng 32 by 15+, and the old loop stopped there
  const { d, w, probes } = await detect({ eng: 32, rus: 20, ara: 25, fas: 20, jpn: 63, chi_sim: 91 });
  assert.equal(d.lang, 'chi_sim');
  assert.equal(d.confident, true);
  // `worker` is not taken to the model: a new one reads the document
  assert.deepEqual(w.loaded, []);
  assert.ok(probes.length === 1 && probes[0].terminated, 'one probe worker, closed');
});

await test('a Japanese scan an unsure Arabic probe "won" goes on to the Japanese model', async () => {
  // ja clean scan: ara 38 beat eng 17 by 15+ — not sure, so probing goes on
  const { d } = await detect({ eng: 17, rus: 15, ara: 38, fas: 30, jpn: 92, chi_sim: 49 });
  assert.equal(d.lang, 'jpn');
  assert.equal(d.confident, true);
});

await test('an Arabic photo stops at Arabic: no 10–15 MB CJK model is downloaded', async () => {
  // ar photo: ara 55, a 20-point lead over English — sure by the RTL rule
  const { d, probed } = await detect({ eng: 35, rus: 20, ara: 55, fas: 40, jpn: 30, chi_sim: 30 });
  assert.equal(d.lang, 'ara');
  assert.equal(d.confident, true);
  assert.ok(!probed.includes('jpn') && !probed.includes('chi_sim'), `probed ${probed}`);
});

// The site locale's model (`hint`) is tried even when English looks sure.
await test('a Chinese invoice English reads at 67 goes to the Chinese hint (80)', async () => {
  englishText = 'Invoice No 1042 Item Qty Unit price Total Date paper ink folders stapler pens';  // not suspicious
  const { d, w, probed } = await detect({ eng: 67, chi_sim: 80, jpn: 60 }, { hint: 'chi_sim' });
  assert.equal(d.lang, 'chi_sim');
  assert.equal(d.confident, true);
  assert.ok(!probed.includes('jpn'), 'the hint winning needs no Japanese download');
  assert.deepEqual(w.loaded, []);
});

await test('an English invoice on the Chinese site stays English, its worker untouched by the probe', async () => {
  englishText = 'Invoice No 1042 Item Qty Unit price Total Date paper ink folders stapler pens';
  const { d, w, probes, probed } = await detect({ eng: 84, chi_sim: 40 }, { hint: 'chi_sim' });
  assert.equal(d.lang, 'eng');
  assert.deepEqual(probed, ['chi_sim']);
  // eng read after chi_sim on the same worker lost a third of its words (70 → 47)
  assert.deepEqual(w.loaded, []);
  assert.ok(probes[0].terminated);
});

const ZH_INVOICE = '发票编号 1042 项目 数量 单价 金额 日期 A4打印纸 12 18.50 222.00 2026-09-14 黑色打印机墨水 10 145.00 1,450.00';
await test('a ruled Chinese scan both models read at 61 goes to the Chinese hint: it reads Chinese', async () => {
  englishText = 'ATRS 1042 b=] nE| ef 2H am AGYTENSR 12] 18.50 222.00 2026-09-14 FT ETELHUEK 10';
  const { d } = await detect({ eng: 61, chi_sim: 61 }, { hint: 'chi_sim' }, { chi_sim: ZH_INVOICE });
  assert.equal(d.lang, 'chi_sim');
  assert.equal(d.confident, true);
});

await test('an English scan chi_sim reads 3 below English stays English: chi_sim read it in Latin', async () => {
  englishText = 'Invoice No. 1042 Item Qty Unit price Total Date A4 printing paper 12 18.50 222.00';
  const { d } = await detect({ eng: 66, chi_sim: 63 }, { hint: 'chi_sim' },
    { chi_sim: 'Invoice No. 1042 一 一 一 一 一 一 一 一 一 一 一 一 | rem 1 gj um price | Total pate 公 rintingpaper' });
  assert.equal(d.lang, 'eng');
});

// English and Chinese paragraphs in turn, on the English site: `eng` reads the
// English well and the Chinese as garbage — 71 overall, 22 % of words under 40.
const MIXED_ENG = 'Clean flattens the background to pure white and darkens the text for maximum contrast';
const MIXED_ZH = '清理会将背景统一为纯白 Clean flattens the background to pure white and darkens the text for maximum contrast 并加深文字以获得最大对比度';
const engWords = (n, low) => Array.from({ length: n }, (_, i) => ({ text: 'w', confidence: i < low ? 20 : 90 }));
await test('English and Chinese paragraphs in turn on the English site: chi_sim+eng', async () => {
  englishText = MIXED_ENG;
  const { d } = await detect({ eng: 71, chi_sim: 86, jpn: 72 }, {}, { chi_sim: MIXED_ZH }, engWords(100, 22));
  assert.equal(d.lang, 'chi_sim+eng');
  assert.equal(d.confident, true);
});

await test('an English photo with a few unsure words is not probed', async () => {
  englishText = MIXED_ENG;
  const { d, probed } = await detect({ eng: 80, chi_sim: 72 }, {}, {}, engWords(100, 12));
  assert.equal(d.lang, 'eng');
  assert.deepEqual(probed, []);
});

await test('a Chinese page full of product names stays chi_sim alone', async () => {
  const { d } = await detect({ eng: 30, chi_sim: 88 }, { hint: 'chi_sim' },
    { chi_sim: '使用 Adobe Reader 或 Chrome 打开压缩后的文件，看起来一样，体积却变小了，邮件服务商附件上限' });
  assert.equal(d.lang, 'chi_sim');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
