// tests/ocrEngine.detect.test.js — detectOcrLanguage()'s choice of model,
// against a stub Tesseract worker that answers, per model, with the words it
// really read on synthetic scans: how many confident ones in each script
// (2026-10-16). The OCR itself is covered end to end by
// tests/e2e/pdf2word-ocr.e2e.mjs and ocr-searchable.e2e.mjs (network, not in CI).
//
// Run: node tests/ocrEngine.detect.test.js

import { strict as assert } from 'assert';

// detectOcrLanguage renders the sample page onto a canvas; nothing is drawn.
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
const { detectOcrLanguage, latinLanguage } = await import('../js/ocrEngine.js');

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

const SAMPLE = {
  lat: 'document', cyr: 'документ', arb: 'كتاب', heb: 'מסמך', hang: '문서', kana: 'ファイル', han: '文件',
  low: 'ae', digit: '12',
};
// A model's reading: `n` words of each kind ({ cyr: 120, lat: 190 }), sure
// ones (90) but `low` (unreadable, 20) and `digit`; `text`: its text, by
// default its words joined.
function reading(conf, counts, text) {
  const words = Object.entries(counts).flatMap(([kind, n]) => Array.from({ length: n }, () =>
    ({ text: SAMPLE[kind], confidence: kind === 'low' ? 20 : kind === 'digit' ? 70 : 90 })));
  return { confidence: conf, words, text: text ?? words.map(w => w.text).join(' ') };
}
// detectOcrLanguage(pdfDoc, `eng` worker, opts) given each model's reading;
// a model missing from `page` reads garbage (conf 30, Latin junk).
async function detect(page, opts = {}) {
  const probed = [];
  const workers = [];
  const make = lang => {
    const w = {
      terminated: false,
      reinitialize: async () => { throw new Error('a worker is not taken to another model'); },
      recognize: async () => ({ data: page[lang] ?? reading(30, { low: 100 }) }),
      terminate: async () => { w.terminated = true; },
    };
    workers.push(w);
    return w;
  };
  const main = make('eng');
  const newWorker = async lang => { probed.push(lang); return make(lang); };
  const d = await detectOcrLanguage(pdfDoc, main, { ignoreTextLayer: true, ...opts, newWorker });
  return { d, probed, main, probesClosed: workers.slice(1).every(w => w.terminated) };
}

const EN = 'Clean flattens the background to pure white and darkens the text for maximum contrast. It is best for plain text pages and for the scans you can read';
// `eng` on a page of another script, or of two: unsure, much of it unreadable
const engOn = (latin, low = 120) => reading(45, { lat: latin, low });

// 7491997 / 3508224-like (corpus, 2026-10-18): `ara+eng` wins, but below the
// clear-winner bar (a fifth of its words sure) — every other script model was
// probed before it was taken. The page's own text layer is Arabic.
const araWeakWin = { eng: engOn(20), 'ara+eng': reading(70, { arb: 20, low: 80 }), ara: reading(72, { arb: 22 }), fas: reading(60, { arb: 15 }) };
await test('the text layer\'s script: an Arabic probe that wins below the clear bar ends the probing — same answer, three probes instead of eight', async () => {
  const slow = await detect(araWeakWin);
  const fast = await detect(araWeakWin, { layerLang: 'ara' });
  assert.equal(slow.d.lang, 'ara');
  assert.equal(fast.d.lang, 'ara');
  assert.ok(slow.probed.includes('jpn+eng'), `without the layer's script every model is asked: ${slow.probed}`);
  assert.deepEqual(fast.probed, ['ara+eng', 'ara', 'fas']);
});

await test('the text layer\'s script is a hint, not an order: a probe too weak to win goes on to the others', async () => {
  const weak = { eng: engOn(20), 'ara+eng': reading(60, { arb: 6, low: 90 }), 'heb+eng': reading(88, { heb: 150 }) };
  const { d, probed } = await detect(weak, { layerLang: 'ara' });
  assert.equal(d.lang, 'heb');
  assert.ok(probed.includes('heb+eng'), String(probed));
});

await test('a clean English page is read in English, with no probe', async () => {
  const { d, probed } = await detect({ eng: reading(95, { lat: 270 }, EN) });
  assert.equal(d.lang, 'eng');
  assert.equal(d.confident, true);
  assert.deepEqual(probed, []);
});

await test('Russian and English paragraphs in turn: rus+eng, not English (the Russian half lost)', async () => {
  // ru-mx scan: `eng` 69 — rus alone read less, and the old rule went English
  const { d, probesClosed } = await detect({
    eng: reading(69, { lat: 210, low: 80 }, EN), 'rus+eng': reading(94, { lat: 189, cyr: 123 }),
  });
  assert.equal(d.lang, 'rus+eng');
  assert.equal(d.confident, true);
  assert.ok(probesClosed, 'every probe worker closed');
});

await test('a Russian page is read with rus+eng too: its Latin terms with it', async () => {
  const { d } = await detect({ eng: engOn(64), 'rus+eng': reading(94, { lat: 13, cyr: 238 }) });
  assert.equal(d.lang, 'rus+eng');
});

await test('Korean is found — no Korean probe before, every Korean scan stopped unsure', async () => {
  const { d } = await detect({ eng: engOn(12), 'kor+eng': reading(89, { lat: 8, hang: 488 }) });
  assert.equal(d.lang, 'kor');
  assert.equal(d.confident, true);
});

await test('Korean and English paragraphs in turn: kor+eng', async () => {
  const { d } = await detect({ eng: engOn(201), 'kor+eng': reading(90, { lat: 195, hang: 305 }) });
  assert.equal(d.lang, 'kor+eng');
});

await test('Hebrew has its model: heb, and heb+eng with English paragraphs', async () => {
  assert.equal((await detect({ eng: engOn(25), 'heb+eng': reading(90, { lat: 12, heb: 174 }) })).d.lang, 'heb');
  assert.equal((await detect({ eng: engOn(169), 'heb+eng': reading(92, { lat: 163, heb: 103 }) })).d.lang, 'heb+eng');
});

await test('Chinese: chi_sim, though jpn+eng reads its characters too', async () => {
  const { d, probed } = await detect({
    eng: engOn(37), 'chi_sim+eng': reading(91, { lat: 26, han: 483 }), 'jpn+eng': reading(64, { lat: 37, han: 190 }),
  });
  assert.equal(d.lang, 'chi_sim');
  assert.ok(probed.includes('jpn+eng'), 'Japanese asked too');
});

await test('Japanese: jpn — its kana and kanji outnumber chi_sim+eng\'s characters', async () => {
  const { d } = await detect({
    eng: engOn(5), 'chi_sim+eng': reading(40, { lat: 5, han: 61 }), 'jpn+eng': reading(92, { lat: 8, kana: 457, han: 144 }),
  });
  assert.equal(d.lang, 'jpn');
});

await test('English and Chinese paragraphs in turn: chi_sim+eng', async () => {
  const { d } = await detect({ eng: engOn(170), 'chi_sim+eng': reading(90, { lat: 164, han: 220 }) });
  assert.equal(d.lang, 'chi_sim+eng');
});

await test('an Arabic page stops at Arabic: no 10–15 MB CJK model is downloaded', async () => {
  const { d, probed } = await detect({
    eng: engOn(4), 'ara+eng': reading(80, { lat: 3, arb: 195 }), ara: reading(78, { arb: 195 }), fas: reading(60, { arb: 150 }),
  });
  assert.equal(d.lang, 'ara');
  assert.ok(!probed.some(l => /chi_sim|jpn/.test(l)), `probed ${probed}`);
});

await test('Persian: fas — the models are told apart by confidence (fas within 6 of ara)', async () => {
  const { d } = await detect({
    eng: engOn(17), 'ara+eng': reading(84, { lat: 10, arb: 194 }), ara: reading(84, { arb: 194 }), fas: reading(82, { arb: 194 }),
  });
  assert.equal(d.lang, 'fas');
});

await test('Arabic and English paragraphs in turn: ara+eng', async () => {
  const { d } = await detect({
    eng: engOn(156), 'ara+eng': reading(84, { lat: 156, arb: 90 }), ara: reading(49, { arb: 102 }), fas: reading(35, { arb: 80 }),
  });
  assert.equal(d.lang, 'ara+eng');
});

await test('an English photo with unsure words: probed, every model reads it in Latin — English', async () => {
  // en-web photo: rus+eng found 6 Cyrillic words, heb+eng 2
  const { d, probed } = await detect({
    eng: reading(74, { lat: 147, low: 50 }, EN), 'rus+eng': reading(76, { lat: 143, cyr: 6 }), 'heb+eng': reading(74, { lat: 146, heb: 2 }),
  });
  assert.equal(d.lang, 'eng');
  assert.ok(probed.length > 0);
});

await test('a German page is read with the German model: deu', async () => {
  const de = 'Mit PDFree werden die Dateien nicht hochgeladen und es ist auch kein Konto für die Nutzung nötig, sie bleiben auf dem Gerät und werden dort zusammengefügt';
  const { d, probed } = await detect({ eng: reading(91, { lat: 300 }, de) });
  assert.equal(d.lang, 'deu');
  assert.deepEqual(probed, []);
});

await test('German and English paragraphs in turn: deu, which reads both (94–100 % of words, eng 86–95)', async () => {
  const mixed = `${EN} Mit PDFree werden die Dateien nicht hochgeladen und es ist auch kein Konto für die Nutzung nötig`;
  assert.equal(latinLanguage(mixed).lang, 'deu');
});

await test('Arabic and English on a photo: ara+eng though fas read 4 below ara (Persian: within 2)', async () => {
  const { d } = await detect({
    eng: engOn(133), 'ara+eng': reading(79, { lat: 135, arb: 99 }), ara: reading(51, { arb: 109 }), fas: reading(47, { arb: 100 }),
  });
  assert.equal(d.lang, 'ara+eng');
});

await test('the site\'s script is probed even when English looks sure: a Chinese invoice', async () => {
  // eng read the Chinese invoice at 67 — garbage, but not "suspicious"
  const { d, probed } = await detect({ eng: reading(67, { lat: 150 }, EN), 'chi_sim+eng': reading(80, { lat: 20, han: 140 }) }, { hint: 'chi_sim' });
  assert.equal(d.lang, 'chi_sim');
  assert.deepEqual(probed, ['chi_sim+eng']);
});

await test('an English invoice on the Chinese site stays English, its worker never switched', async () => {
  const { d, probed, main } = await detect({ eng: reading(84, { lat: 200 }, EN), 'chi_sim+eng': reading(84, { lat: 200, han: 3 }) }, { hint: 'chi_sim' });
  assert.equal(d.lang, 'eng');
  assert.deepEqual(probed, ['chi_sim+eng']);
  assert.equal(main.terminated, false);
});

await test('alternatives: the runner-up languages, for a re-run in one click', async () => {
  const { d } = await detect({ eng: engOn(170), 'chi_sim+eng': reading(90, { lat: 164, han: 220 }), 'jpn+eng': reading(79, { lat: 168, han: 63 }) });
  assert.deepEqual(d.alternatives.slice(0, 1), ['jpn']);
  assert.ok(d.alternatives.includes('eng'));
});

// Latin languages by their commonest words, as `eng` reads them (letters lost)
await test('latinLanguage: each language by its own words, eng read', async () => {
  const cases = {
    fra: 'Fusionner des PDF est une des taches les plus courantes pour vous et votre equipe dans le travail',
    spa: 'Unir archivos PDF es una de las tareas mas comunes para los usuarios y su equipo en el trabajo',
    por: 'Juntar arquivos PDF e uma das tarefas mais comuns para os usuarios e sua equipe no trabalho com voce',
    ita: 'Unire file PDF è una delle attività più comuni per gli utenti della azienda nel lavoro di ogni giorno',
    nld: 'PDF bestanden samenvoegen is een van de meest voorkomende taken voor het werk en ook voor thuis',
    pol: 'Laczenie plikow PDF jest jednym z najczestszych zadan i nie wymaga konta przez caly czas dla nas',
    tur: 'PDF dosyalarini birlestirmek en yaygin islerden biri ve bu islem icin hesap gerekmez daha hizli',
    vie: 'Ghep nhieu file PDF lai la mot trong nhung tac vu khong can tai len cua cac nguoi dung',
    ind: 'Menggabungkan file PDF adalah salah satu tugas yang paling umum dan tidak perlu akun untuk anda',
    eng: EN,
  };
  for (const [lang, text] of Object.entries(cases)) assert.equal(latinLanguage(text).lang, lang, text);
  assert.equal(latinLanguage('PDF 12 34 ok').lang, 'eng', 'too few words: English');
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
