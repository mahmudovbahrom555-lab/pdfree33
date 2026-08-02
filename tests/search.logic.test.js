// ============================================================
//  tests/search.logic.test.js — Unit tests for js/search.js
//  Запуск: node tests/search.logic.test.js
//
//  Тестирует реальный модуль (не реимплементацию):
//  buildIndex, search — including typo-tolerant fuzzy matching.
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function expect(actual) {
  return {
    toBe:       (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy: ()  => { if (!actual) throw new Error(`Expected truthy, got ${actual}`); },
    toBeFalsy:  ()  => { if (actual)  throw new Error(`Expected falsy, got ${actual}`); },
  };
}

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const { buildIndex, search } = await import('../js/search.js');
const { TOOLS } = await import('../js/config.js');

const index = buildIndex(TOOLS, 'en');

function topKey(query, idx = index) {
  const results = search(query, idx);
  return results.length ? results[0].key : null;
}

// Loads a js/locales/<lc>.js file (a plain script that assigns to
// window.PDFREE_LOCALE as a side effect) in an isolated sandbox and
// returns its search_tags object, without polluting the real `window`
// or clobbering other locale files loaded the same way in this process.
function loadLocaleSearchTags(lc) {
  const source  = readFileSync(path.join(ROOT, `js/locales/${lc}.js`), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.PDFREE_LOCALE?.search_tags || {};
}

// ── Exact / substring matching (pre-existing behavior) ──────
console.log('\nExact and substring matching:');

test('exact tag match wins', () => {
  expect(topKey('excel')).toBe('pdf2excel');
});

test('name-prefix match', () => {
  expect(topKey('compress')).toBe('compress');
});

test('query under 3 chars returns no results', () => {
  expect(search('pd', index).length).toBe(0);
});

// ── Fuzzy typo tolerance (regression: "exel" found nothing) ─
console.log('\nFuzzy typo tolerance:');

test('"exel" (missing letter) still finds PDF to Excel', () => {
  expect(topKey('exel')).toBe('pdf2excel');
});

test('"excell" (extra letter) still finds PDF to Excel', () => {
  expect(topKey('excell')).toBe('pdf2excel');
});

test('"unlok" still finds Unlock PDF', () => {
  expect(topKey('unlok')).toBe('unlock');
});

test('"roate" still finds Rotate PDF', () => {
  expect(topKey('roate')).toBe('rotate');
});

test('"flaten" still finds Flatten PDF', () => {
  expect(topKey('flaten')).toBe('flatten');
});

test('a precise tag typo outranks a loose coincidental name typo', () => {
  // "redct" is 1 edit from the redact tool's own name/tag "redact",
  // but was previously also drifting toward unrelated tools whose
  // name merely happened to contain a short word within edit distance.
  expect(topKey('redct')).toBe('redact');
});

test('exact match still beats a fuzzy match (no regression in ranking)', () => {
  expect(topKey('watermark')).toBe('watermark');
});

test('nonsense query beyond typo tolerance returns nothing', () => {
  expect(topKey('xyzxyzxyz')).toBeFalsy();
});

// ── Tool-key indexing (typing the tool's own internal identifier) ──
console.log('\nTool-key indexing:');

test("'pdf2word' (exact key) finds pdf2word", () => {
  expect(topKey('pdf2word')).toBe('pdf2word');
});

test("'draw-pdf' (exact key, with hyphen) finds draw-pdf", () => {
  expect(topKey('draw-pdf')).toBe('draw-pdf');
});

test("'drawpdf' (key with hyphen dropped) also finds draw-pdf", () => {
  expect(topKey('drawpdf')).toBe('draw-pdf');
});

test("'pdf2w' (key prefix) narrows to pdf2word alone", () => {
  const results = search('pdf2w', index);
  expect(results.length).toBe(1);
  expect(results[0].key).toBe('pdf2word');
});

// ── Digit-triggered fuzzy suppression (regression: "pdf2" fuzzy-matched
//    merge/split/compress via 1-edit distance to the unrelated word "pdfs"
//    in their tags — a coincidental digit/letter collision, not a typo) ──
console.log('\nDigit-triggered fuzzy suppression:');

test("'pdf2' does not fuzzy-match merge/split/compress (old bug)", () => {
  const keys = search('pdf2', index).map(r => r.key);
  expect(keys.includes('merge')).toBeFalsy();
  expect(keys.includes('split')).toBeFalsy();
  expect(keys.includes('compress')).toBeFalsy();
});

test("'pdf2' instead correctly surfaces the whole pdf2* family via key-prefix", () => {
  const keys = search('pdf2', index).map(r => r.key).sort();
  expect(JSON.stringify(keys)).toBe(JSON.stringify(['pdf2excel', 'pdf2jpg', 'pdf2md', 'pdf2ppt', 'pdf2word'].sort()));
});

// ── search() no longer truncates internally — caller decides how many
//    to render (this is what makes the multi-candidate narrowing UI and
//    the pdf2*-family result above possible in the first place) ──
console.log('\nNo internal result cap:');

test("a broad query ('pdf2') can return more than 3 results", () => {
  expect(search('pdf2', index).length > 3).toBeTruthy();
});

// ── Connector-phrase family narrowing across languages (e.g. "pdf to" /
//    "pdf в" / "pdf'den" plausibly means any pdf2* tool; narrows as the
//    user keeps typing) — every locale's pdf2* titles already follow a
//    "PDF <connector> <Format>" pattern, so this exercises the interaction
//    between that data and the uncapped multi-result search above ──
console.log('\nConnector-phrase family narrowing (real per-locale titles):');

test('EN "pdf to" surfaces multiple pdf2* tools', () => {
  const enIndex = buildIndex(TOOLS, 'en');
  const keys = search('pdf to', enIndex).map(r => r.key);
  expect(keys.length > 1).toBeTruthy();
  expect(keys.includes('pdf2word')).toBeTruthy();
});

test('EN "pdf to w" narrows to just pdf2word', () => {
  const enIndex = buildIndex(TOOLS, 'en');
  expect(topKey('pdf to w', enIndex)).toBe('pdf2word');
});

test('RU "pdf в" surfaces multiple pdf2* tools', () => {
  const ruIdx = buildIndex(TOOLS, 'ru', loadLocaleSearchTags('ru'));
  const keys = search('pdf в', ruIdx).map(r => r.key);
  expect(keys.length > 1).toBeTruthy();
  expect(keys.includes('pdf2word')).toBeTruthy();
});

test("TR \"pdf'den\" surfaces multiple pdf2* tools", () => {
  const trIdx = buildIndex(TOOLS, 'tr', loadLocaleSearchTags('tr'));
  const keys = search("pdf'den", trIdx).map(r => r.key);
  expect(keys.length > 1).toBeTruthy();
  expect(keys.includes('pdf2word')).toBeTruthy();
});

// ── Diacritic folding (regression: a real user testing every locale in a
//    browser found that Turkish "sikistir" — the ASCII spelling of
//    "sıkıştır", compress, typed without dotless-ı/ş because those aren't
//    on every keyboard — returned nothing at all. The word needs 4 letter
//    substitutions to become "sıkıştır", well past the fuzzy-typo edit
//    budget, so it silently fell through everything) ──
console.log('\nDiacritic folding (ASCII-typed accented words):');

test('TR "sikistir" (no dotless-ı/ş) finds compress', () => {
  const trIdx = buildIndex(TOOLS, 'tr', loadLocaleSearchTags('tr'));
  expect(topKey('sikistir', trIdx)).toBe('compress');
});

test('TR accented "sıkıştır" still finds the same tool as the ASCII form', () => {
  const trIdx = buildIndex(TOOLS, 'tr', loadLocaleSearchTags('tr'));
  expect(topKey('sıkıştır', trIdx)).toBe('compress');
});

test('ES "titulo" (no accent, real tag is "título") finds metadata', () => {
  const esIdx = buildIndex(TOOLS, 'es', loadLocaleSearchTags('es'));
  expect(topKey('titulo', esIdx)).toBe('meta');
});

test("CJK matching is unaffected by diacritic folding (結合 still finds merge)", () => {
  const jaIdx = buildIndex(TOOLS, 'ja', loadLocaleSearchTags('ja'));
  expect(topKey('結合', jaIdx)).toBe('merge');
});

test('VI "dat mat khau" (đặt mật khẩu with no diacritics at all) finds protect', () => {
  const viIdx = buildIndex(TOOLS, 'vi', loadLocaleSearchTags('vi'));
  expect(topKey('dat mat khau', viIdx)).toBe('protect');
});

// ── Multi-word phrase typo tolerance (regression: found via manual browser
//    QA across ko/ja/id/vi — a typo in just one word of a multi-word tag
//    ("tanda air" -> "tada air", Indonesian for watermark) matched nothing.
//    bestWordDistance alone compares the *entire* query as one unit against
//    individual words of the target text, which can never work once the
//    query itself has more than one word — bestPhraseDistance matches each
//    query word to its own best word in the target independently) ──
console.log('\nMulti-word phrase typo tolerance:');

test('KO multi-word query with a typo in the second word finds ocr', () => {
  // 스캔한 문서 (scanned document) typo'd to 문사 in the second word only
  const koIdx = buildIndex(TOOLS, 'ko', loadLocaleSearchTags('ko'));
  expect(topKey('스캔한 문사', koIdx)).toBe('ocr');
});

test('ID multi-word query with a dropped letter in the first word finds watermark', () => {
  // "tanda air" (watermark) typo'd to "tada air" (dropped the 'n')
  const idIdx = buildIndex(TOOLS, 'id', loadLocaleSearchTags('id'));
  expect(topKey('tada air', idIdx)).toBe('watermark');
});

test('VI multi-word query combining a typo AND dropped diacritics finds pdf2word', () => {
  // "chuyển sang word" typo'd to "chuen sang word" (dropped diacritics too)
  const viIdx = buildIndex(TOOLS, 'vi', loadLocaleSearchTags('vi'));
  expect(topKey('chuen sang word', viIdx)).toBe('pdf2word');
});

test('an unrelated 2-word query still returns nothing (no new false positives)', () => {
  expect(topKey('purple elephant')).toBeFalsy();
  expect(topKey('happy birthday')).toBeFalsy();
});

// ── More non-decomposing base letters (found by scanning every character
//    actually used across all 13 locales' search_tags, not by guessing
//    language-by-language — same bug class as ı/đ above) ──
console.log('\nMore non-decomposing base letters (Polish ł, German ß):');

test('PL "polacz" (no ł) exact-matches merge, not just a weak fuzzy guess', () => {
  const plIdx = buildIndex(TOOLS, 'pl', loadLocaleSearchTags('pl'));
  const results = search('polacz', plIdx);
  expect(results[0]?.key).toBe('merge');
  expect(results[0]?.score).toBe(90);
});

test('PL "splaszcz" (no ł, real tag is "spłaszcz") finds flatten', () => {
  const plIdx = buildIndex(TOOLS, 'pl', loadLocaleSearchTags('pl'));
  expect(topKey('splaszcz', plIdx)).toBe('flatten');
});

test('DE "fusszeile" (ß folded to ss, real tag is "fußzeile") finds pagenum', () => {
  const deIdx = buildIndex(TOOLS, 'de', loadLocaleSearchTags('de'));
  const results = search('fusszeile', deIdx);
  expect(results[0]?.key).toBe('pagenum');
  expect(results[0]?.score).toBe(90);
});

// ── Localized search (regression: non-English queries found nothing —
//    buildIndex only ever scanned English tags/names, see js/i18n.js's
//    EN.search_tags contract and js/locales/<lc>.js's search_tags) ──
console.log('\nLocalized search (RU, via real js/locales/ru.js data):');

const ruTags  = loadLocaleSearchTags('ru');
const ruIndex = buildIndex(TOOLS, 'ru', ruTags);

test('ru.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(ruTags['draw-pdf']) && ruTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Russian tag match finds draw-pdf', () => {
  expect(topKey('рисовать', ruIndex)).toBe('draw-pdf');
});

test('a typo of a Russian tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('рисовт', ruIndex)).toBe('draw-pdf');
});

test('Russian query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('объединить', ruIndex)).toBe('merge');
});

test('English tags still work on a Russian-language index (bilingual fallback)', () => {
  expect(topKey('compress', ruIndex)).toBe('compress');
});

console.log('\nLocalized search (DE, via real js/locales/de.js data):');

const deTags  = loadLocaleSearchTags('de');
const deIndex = buildIndex(TOOLS, 'de', deTags);

test('de.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(deTags['draw-pdf']) && deTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact German tag match finds draw-pdf', () => {
  expect(topKey('zeichnen', deIndex)).toBe('draw-pdf');
});

test('a typo of a German tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('zeichnnen', deIndex)).toBe('draw-pdf');
});

test('German query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('zusammenführen', deIndex)).toBe('merge');
});

console.log('\nLocalized search (ES, via real js/locales/es.js data):');

const esTags  = loadLocaleSearchTags('es');
const esIndex = buildIndex(TOOLS, 'es', esTags);

test('es.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(esTags['draw-pdf']) && esTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Spanish tag match finds draw-pdf', () => {
  expect(topKey('dibujar', esIndex)).toBe('draw-pdf');
});

test('a typo of a Spanish tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('dibuar', esIndex)).toBe('draw-pdf');
});

test('Spanish query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('combinar', esIndex)).toBe('merge');
});

console.log('\nLocalized search (FR, via real js/locales/fr.js data):');

const frTags  = loadLocaleSearchTags('fr');
const frIndex = buildIndex(TOOLS, 'fr', frTags);

test('fr.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(frTags['draw-pdf']) && frTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact French tag match finds draw-pdf', () => {
  expect(topKey('dessiner', frIndex)).toBe('draw-pdf');
});

test('a typo of a French tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('dessinner', frIndex)).toBe('draw-pdf');
});

test('French query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('fusionner', frIndex)).toBe('merge');
});

console.log('\nLocalized search (PT, via real js/locales/pt.js data):');

const ptTags  = loadLocaleSearchTags('pt');
const ptIndex = buildIndex(TOOLS, 'pt', ptTags);

test('pt.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(ptTags['draw-pdf']) && ptTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Portuguese tag match finds draw-pdf', () => {
  expect(topKey('desenhar', ptIndex)).toBe('draw-pdf');
});

test('a typo of a Portuguese tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('desenhr', ptIndex)).toBe('draw-pdf');
});

test('Portuguese query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('mesclar', ptIndex)).toBe('merge');
});

console.log('\nLocalized search (IT, via real js/locales/it.js data):');

const itTags  = loadLocaleSearchTags('it');
const itIndex = buildIndex(TOOLS, 'it', itTags);

test('it.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(itTags['draw-pdf']) && itTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Italian tag match finds draw-pdf', () => {
  expect(topKey('disegnare', itIndex)).toBe('draw-pdf');
});

test('a typo of an Italian tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('disegnre', itIndex)).toBe('draw-pdf');
});

test('Italian query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('unire', itIndex)).toBe('merge');
});

console.log('\nLocalized search (KO, via real js/locales/ko.js data):');

const koTags  = loadLocaleSearchTags('ko');
const koIndex = buildIndex(TOOLS, 'ko', koTags);

test('ko.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(koTags['draw-pdf']) && koTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Korean tag match finds draw-pdf', () => {
  expect(topKey('드로잉', koIndex)).toBe('draw-pdf');
});

test('a typo of a Korean tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('드러잉', koIndex)).toBe('draw-pdf');
});

test('Korean query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('합치기', koIndex)).toBe('merge');
});

console.log('\nLocalized search (NL, via real js/locales/nl.js data):');

const nlTags  = loadLocaleSearchTags('nl');
const nlIndex = buildIndex(TOOLS, 'nl', nlTags);

test('nl.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(nlTags['draw-pdf']) && nlTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Dutch tag match finds draw-pdf', () => {
  expect(topKey('tekenen', nlIndex)).toBe('draw-pdf');
});

test('a typo of a Dutch tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('teknen', nlIndex)).toBe('draw-pdf');
});

test('Dutch query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('samenvoegen', nlIndex)).toBe('merge');
});

console.log('\nLocalized search (PL, via real js/locales/pl.js data):');

const plTags  = loadLocaleSearchTags('pl');
const plIndex = buildIndex(TOOLS, 'pl', plTags);

test('pl.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(plTags['draw-pdf']) && plTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Polish tag match finds draw-pdf', () => {
  expect(topKey('rysowanie', plIndex)).toBe('draw-pdf');
});

test('a typo of a Polish tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('rysowani', plIndex)).toBe('draw-pdf');
});

test('Polish query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('scal', plIndex)).toBe('merge');
});

console.log('\nLocalized search (ID, via real js/locales/id.js data):');

const idTags  = loadLocaleSearchTags('id');
const idIndex = buildIndex(TOOLS, 'id', idTags);

test('id.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(idTags['draw-pdf']) && idTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Indonesian tag match finds draw-pdf', () => {
  expect(topKey('anotasi', idIndex)).toBe('draw-pdf');
});

test('a typo of an Indonesian tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('anotsi', idIndex)).toBe('draw-pdf');
});

test('Indonesian query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('gabungkan', idIndex)).toBe('merge');
});

test('English tags still work on an Indonesian-language index (bilingual fallback)', () => {
  expect(topKey('compress', idIndex)).toBe('compress');
});

console.log('\nLocalized search (VI, via real js/locales/vi.js data):');

const viTags  = loadLocaleSearchTags('vi');
const viIndex = buildIndex(TOOLS, 'vi', viTags);

test('vi.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(viTags['draw-pdf']) && viTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Vietnamese tag match finds compress', () => {
  expect(topKey('nén', viIndex)).toBe('compress');
});

test('a typo of a Vietnamese tag (dropped diacritic) still finds compress (the reported bug)', () => {
  expect(topKey('nen', viIndex)).toBe('compress');
});

test('Vietnamese query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('ghép', viIndex)).toBe('merge');
});

test('English tags still work on a Vietnamese-language index (bilingual fallback)', () => {
  expect(topKey('compress', viIndex)).toBe('compress');
});

console.log('\nLocalized search (TR, via real js/locales/tr.js data):');

const trTags  = loadLocaleSearchTags('tr');
const trIndex = buildIndex(TOOLS, 'tr', trTags);

test('tr.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(trTags['draw-pdf']) && trTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Turkish tag match finds draw-pdf', () => {
  expect(topKey('vurgula', trIndex)).toBe('draw-pdf');
});

test('a typo of a Turkish tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('vurgla', trIndex)).toBe('draw-pdf');
});

test('Turkish query for merge finds merge, not an unrelated tool', () => {
  expect(topKey('birleştir', trIndex)).toBe('merge');
});

test('English tags still work on a Turkish-language index (bilingual fallback)', () => {
  expect(topKey('compress', trIndex)).toBe('compress');
});

console.log('\nLocalized search (JA, via real js/locales/ja.js data):');

const jaTags  = loadLocaleSearchTags('ja');
const jaIndex = buildIndex(TOOLS, 'ja', jaTags);

test('ja.js actually defines search_tags for draw-pdf (not just the {} scaffold)', () => {
  expect(Array.isArray(jaTags['draw-pdf']) && jaTags['draw-pdf'].length > 0).toBeTruthy();
});

test('exact Japanese tag match finds draw-pdf (katakana loanword form)', () => {
  expect(topKey('アノテーション', jaIndex)).toBe('draw-pdf');
});

test('a dropped-kana typo of a Japanese tag still finds draw-pdf (the reported bug)', () => {
  expect(topKey('アテーション', jaIndex)).toBe('draw-pdf');
});

test('Japanese query for merge (kanji) finds merge, not an unrelated tool', () => {
  expect(topKey('結合する', jaIndex)).toBe('merge');
});

test('English tags still work on a Japanese-language index (bilingual fallback)', () => {
  expect(topKey('compress', jaIndex)).toBe('compress');
});

// ── Summary ───────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
