// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ── ocrEngine.js ─────────────────────────────────────────────────────────────
// The OCR engine, without UI: Tesseract.js loading, language detection, page
// preprocessing and recognition. Shared by the OCR tool (js/ocrUI.js) and by
// PDF→Word's OCR layer for scanned pages, so both read a scan the same way.
// Everything runs in the browser — the page image never leaves the device.
// ─────────────────────────────────────────────────────────────────────────────

import { cjkJoin } from './cjkText.js';

// tesseract.js 5.1.1, its worker, its WASM core and the language models come
// from pdfree.io (js/vendor/tesseract/, js/vendor/tessdata/), not jsdelivr:
// "Failed to load Tesseract.js" for 4 people 2026-10-01..24, 3 in mainland
// China, where jsdelivr is unreliable. The same files byte for byte (the
// sha384 below is the jsdelivr one; core and models checked equal on
// jsdelivr and unpkg, js/vendor/SOURCE.txt). cachePath unchanged (owner,
// 2026-10-24): a model already in a browser's IndexedDB is the same model.
const TESSERACT_URL = new URL('./vendor/tesseract/tesseract.min.js', import.meta.url).href;
const TESSERACT_SRI = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F';
const TESSERACT_PATHS = {
  workerPath: new URL('./vendor/tesseract/worker.min.js', import.meta.url).href,
  corePath:   new URL('./vendor/tesseract/core/', import.meta.url).href,
  langPath:   new URL('./vendor/tessdata/', import.meta.url).href,
};

// Resolution profile per script family.
// CJK ideographs are small and dense — need higher resolution for stroke preservation.
// Arabic and Devanagari have connected ligatures that benefit from slightly more pixels.
// Latin/Cyrillic are accurate at 3000px (~240 DPI on A4).
// New languages should be added to the appropriate bucket; no per-lang if-chains needed.
export const SCRIPT_PROFILE = {
  latin:   3000,
  complex: 3200,
  cjk:     4200,  // Japanese/Chinese kanji are dense — extra pixels improve stroke recognition
};
export const CJK_LANGS = new Set(['jpn', 'chi_sim', 'chi_tra', 'kor']);

// Non-Latin scripts where Tesseract confidence is structurally lower even for correct text.
// Used for two purposes:
//   1. Lower confidence threshold (45 vs 55) so valid glyphs aren't discarded.
//   2. Skip OCR quality score display — calibrated Latin tiers (90/80/60%) mislead
//      users of these scripts until per-language baselines are established from real data.
// Note: kor (Korean) included — Hangul confidence patterns match other complex scripts.
export const COMPLEX_LANGS = new Set(['ara', 'fas', 'heb', 'jpn', 'chi_sim', 'chi_tra', 'kor', 'hin', 'tha']);

// For combined codes like 'jpn+eng' or 'chi_sim+eng', return the primary
// (non-Latin) script so set lookups against COMPLEX_LANGS / CJK_LANGS work.
export function primaryScript(lang) { return lang.split('+')[0]; }

// ── Engine loading ────────────────────────────────────────────────────────────

let _tesseractLoading = null;
// Loads Tesseract.js once (script tag, SRI-checked). Rejects on network failure;
// a later call retries.
export function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  _tesseractLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src         = TESSERACT_URL;
    s.integrity   = TESSERACT_SRI;
    s.crossOrigin = 'anonymous';
    s.onload  = resolve;
    s.onerror = () => { _tesseractLoading = null; reject(new Error('Failed to load Tesseract.js')); };
    document.head.appendChild(s);
  });
  return _tesseractLoading;
}

// Japanese needs its vertical model too (horizontal + vertical recognition).
function _tesseractLang(lang) {
  return lang === 'jpn' ? 'jpn+jpn_vert' : lang === 'jpn+eng' ? 'jpn+jpn_vert+eng' : lang;
}

// PSM 11 (sparse text) works better for CJK invoice/table layouts than PSM 3 (auto).
// PSM 3 may group kanji blocks suboptimally; PSM 11 finds text anywhere on the page.
async function _applyLangParams(worker, lang) {
  if (CJK_LANGS.has(primaryScript(lang))) {
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
  }
}

// tesseract.js 5.1.1 (src/createWorker.js) on a failed job: rejects the
// job's promise AND, with no errorHandler, throws from its message handler —
// an uncaught error per failure, which flooded analytics (one PDF→Word session:
// 714 js_error, 2026-10-09). And when a language model fails to download, the
// promise createWorker returns never settles (its load chain ends in
// .catch(() => {}), and only a failed 'load' step rejects it): PDF→Word hung for
// good, reproduced by blocking the model request. So: errors while the worker
// is being created reject here at once; after that they only reject their own
// job's promise; and a load that hangs gives up after _OCR_LOAD_TIMEOUT_MS.
const _OCR_LOAD_TIMEOUT_MS = 120000;
function _withTimeout(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), _OCR_LOAD_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}
export async function createOcrWorker(lang, logger) {
  let failLoad;
  const loadFailed = new Promise((_, reject) => { failLoad = reject; });
  let ready = false;
  const created = window.Tesseract.createWorker(_tesseractLang(lang), 1, {
    ...TESSERACT_PATHS,
    // never `logger: undefined`: it overrides tesseract.js's own no-op, and
    // every progress message then threw "b is not a function" — dozens per
    // page of every PDF→Word scan, the bulk of the js_error flood
    logger: logger ?? (() => {}),
    errorHandler: err => { if (!ready) failLoad(new Error(`OCR engine: ${err}`)); },
  });
  const worker = await _withTimeout(Promise.race([created, loadFailed]), 'OCR engine load');
  ready = true;
  await _applyLangParams(worker, lang);
  return worker;
}

// A line's OCR words as text. Tesseract splits Chinese and Japanese into
// "words" too: a space between each pair came out in Word, 500–600 per page
// of every Chinese or Japanese scan (2026-10-10) — see cjkJoin.
export function joinOcrWords(words) {
  let out = '';
  for (const w of words) {
    if (!w) continue;
    out += out && !cjkJoin(out, w) ? ` ${w}` : w;
  }
  return out;
}

// Adaptive confidence threshold — see COMPLEX_LANGS.
// Latin (eng/fra/…): 55% — Tesseract is reliable; below 55% is almost always garbage.
// Complex (ara/jpn/kor/hin/tha/…): 45% — correct glyphs routinely score 40–50%,
// so 55% would silently discard real text for these scripts.
export function minConfidence(lang) {
  return COMPLEX_LANGS.has(primaryScript(lang)) ? 45 : 55;
}

// ── Language detection ───────────────────────────────────────────────────────

// Analyse unicode codepoints of text (a text layer, or `eng`'s quick read) and
// return the most likely Tesseract language code. Only dominant script is checked.
// Returns { lang, confident } where confident=false means mixed/ambiguous content.
// ocrConf: Tesseract word confidence (0-100) from the quick OCR pass — used to
// lower confidence when the OCR engine itself was uncertain about the text.
function _detectScriptFromText(text, ocrConf = 100) {
  if (!text || text.trim().length < 10) return { lang: 'eng', confident: false };
  let lat = 0, cyr = 0, ara = 0, heb = 0, jpnKana = 0, cjk = 0, han = 0, dev = 0, tha = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x0041 && cp <= 0x024F)       lat++;
    else if (cp >= 0x0400 && cp <= 0x04FF)  cyr++;
    else if (cp >= 0x0590 && cp <= 0x05FF)  heb++;
    else if (cp >= 0x0600 && cp <= 0x06FF)  ara++;
    else if (cp >= 0x3040 && cp <= 0x30FF)  jpnKana++;
    // from 0x4E01: 一 (U+4E00) is how the CJK models read table rules
    else if (cp >= 0x4E01 && cp <= 0x9FFF)  cjk++;
    else if (cp >= 0xAC00 && cp <= 0xD7A3)  han++;
    else if (cp >= 0x0900 && cp <= 0x097F)  dev++;
    else if (cp >= 0x0E00 && cp <= 0x0E7F)  tha++;
  }
  const total = lat + cyr + ara + heb + jpnKana + cjk + han + dev + tha || 1;

  let lang = 'eng';
  if (jpnKana > 3)                   lang = 'jpn';
  else if (han > 5)                  lang = 'kor';
  else if (cjk > 10 && jpnKana > 0) lang = 'jpn';
  else if (cjk > 10)                lang = 'chi_sim';
  else if (ara > 5)                  lang = 'ara';
  else if (heb > 5)                  lang = 'heb';
  else if (dev > 5)                  lang = 'hin';
  else if (tha > 5)                  lang = 'tha';
  else if (cyr > lat * 0.25 && cyr > 5) lang = 'rus';

  const dominant = { eng: lat, rus: cyr, ara, heb, jpn: jpnKana + cjk, chi_sim: cjk, kor: han, hin: dev, tha }[lang] ?? lat;
  // Confidence is also reduced when the OCR engine itself was uncertain (ocrConf < 55):
  // a Russian scan processed with `eng` produces Latin-looking garbage with low OCR confidence.
  const confident = total >= 30 && (dominant / total) > 0.5 && ocrConf >= 55;
  if (lang === 'eng') lang = latinLanguage(text).lang;
  // Russian with English: rus+eng reads both — and Russian alone better too,
  // its Latin terms (PDF, names) included: 93.9 → 98.1 % of words on a
  // Russian scan, 40–60 → 92–99 % on Russian and English paragraphs in turn
  // (synthetic scans, 2026-10-16)
  if (lang === 'rus') lang = 'rus+eng';
  return { lang, confident };
}

// Which Latin-script language `text` is in, by its commonest words — `eng`
// reads every Latin page well enough for them (its own letters lost: "für" →
// "fur", "của" → "cua", so both spellings). Read with its own model, a page
// has far more words right: German 78–89 → 96–99.7 %, Polish 60–73 → 94–100 %,
// Turkish 40–61 → 85–99 %, Vietnamese 20–30 → 78–97 % (synthetic scans,
// 2026-10-16). Words more than one language uses are left out — "de", "la"
// say nothing; with the rest, every one of 48 scans of 10 languages read
// as its own, at least twice the next. { lang, next }: the runner-up, if any.
const _COMMON_WORDS = {
  eng: 'the and of to is in that for it with as are on be this by or from your you can a i',
  fra: 'le la les des est et une un du pour que dans pas sur vous qui avec sont au ne ce votre plus',
  deu: 'der die und das ist nicht ein eine den mit auf für fur sie es dem zu von werden wird sich auch oder bei',
  spa: 'el la los las de que y en un una es para por con del se su no al como sus más mas',
  ita: 'il la di che e è per un una del della sono con non le gli dei alla nel si come più piu senza nessun nessuna tutti puoi vuoi sul tuo suoi questo questa viene ogni anche',
  por: 'o a os as de que e do da em um uma para com não nao no na se por dos das seu sua',
  nld: 'de het een en van is in dat op te met voor zijn niet je die worden wordt ook aan bij',
  pol: 'i w z na do się sie nie to jest że ze o jak lub od po dla są sa przez co',
  tur: 've bir bu için icin ile da de olarak daha olan gibi veya her çok cok en ama sonra kadar',
  vie: 'và của là các có trong cho được không những một với này để khi từ người mot khong cua cac voi nhung duoc nay hoac nhieu cung',
  uzb: 'uchun bilan esa yoki emas kabi mumkin hamda orqali qilish barcha faqat agar lekin',
  ind: 'dan yang di ini untuk dengan dari tidak ke anda dalam akan atau pada adalah bisa juga',
};
const _LANG_OF_WORD = (() => {
  const seen = new Map();
  for (const [lang, words] of Object.entries(_COMMON_WORDS)) {
    for (const w of new Set(words.split(' '))) seen.set(w, seen.has(w) ? null : lang);
  }
  return seen;
})();
export function latinLanguage(text) {
  const count = {};
  let words = 0;
  // two letters or more: an unreadable page read with `eng` is strewn with
  // single letters — "y", "e", "w" — that made an Arabic page Spanish
  for (const w of text.toLowerCase().match(/\p{L}{2,}/gu) ?? []) {
    words++;
    const lang = _LANG_OF_WORD.get(w);
    if (lang) count[lang] = (count[lang] ?? 0) + 1;
  }
  // English left out: a page half German, half English is German — `deu`
  // read 94–100 % of its words, `eng` 86–95 %; an English page only English
  // (`deu` 94–100 %, `eng` 98–100 %)
  const [first, second] = Object.entries(count).filter(([lang]) => lang !== 'eng').sort((a, b) => b[1] - a[1]);
  if (!first || first[1] < 0.03 * words || first[1] < 2 * (second?.[1] ?? 0)) return { lang: 'eng', next: first?.[0] ?? null };
  return { lang: first[0], next: second?.[0] ?? 'eng' };
}

// Sample pages [1, middle, last] — stop as soon as enough text is found.
// Prefers the existing text layer (free) over a quick OCR pass (cheap).
// 1600px, not 800: an A4 page at 800px is ~70 dpi, where Tesseract is unsure
// of every script — an Arabic scan read with `ara` scored 47–57, under the 65
// a probe needs, so every Arabic scan stopped at "Select a language first" and
// a phone photo of one was taken for English (2026-10-08, synthetic scans of
// the prose ground truth). At 1600px: 75–77 on Arabic scans, Russian photo
// 54 → 94, English unchanged.
const DETECT_PX = 1600;

// The scripts a page can be in besides Latin, each probed with its model
// paired with English, and its letters. Probing a model alone, by how much
// it raised the page's confidence over `eng`, missed every page with English
// on it — Russian and English paragraphs in turn read 69–71 with `eng`, less
// with `rus`, and went to English, the Russian half lost; Korean and Japanese
// the same (9 of 42 mixed scans right) — and model words counted alone lie:
// `rus` reads an English page as 26 % "Cyrillic" words with confidence. Paired,
// the model reads each word in the script that fits it: a page's own script
// is 19–90 % of its confident words, another's at most 7 % (synthetic scans
// of 13 languages and their mixes with English, 2026-10-16). Cheapest models
// first; Japanese counts its kanji too, so Chinese and Japanese are told
// apart by which reads more of the page.
const SCRIPT_PROBES = [
  { lang: 'ara',     own: /[؀-ۿ]/ },
  { lang: 'heb',     own: /[֐-׿]/ },
  { lang: 'kor',     own: /[가-힣]/ },
  { lang: 'rus',     own: /[Ѐ-ӿ]/ },
  { lang: 'chi_sim', own: /[一-鿿]/ },
  { lang: 'jpn',     own: /[぀-ヿ一-鿿]/ },
];
const _CJK_PROBES = ['chi_sim', 'jpn'];

// Multi-signal suspicion check — returns true when OCR output looks like
// misidentification. Three independent signals:
//
//  Signal A — low confidence (< 60): catches Cyrillic.
//    eng model maps Ц→U, Г→T etc.; word confidence drops because combinations
//    don't match English dictionary ("Horosop", "MockBa").
//
//  Signal B — low letter ratio: catches Arabic (and potentially CJK).
//    Arabic chars have no Latin look-alikes → eng OCR produces mostly numbers
//    (42, 2024, 50,000). Ratio = letters / (letters + digits): spaces and
//    punctuation are excluded from the denominator — a short invoice like
//    "Invoice: Total: $500" has lots of colons/spaces that would otherwise
//    dilute the signal and falsely trigger the fallback.
function _isDetectionSuspicious(txt, conf, words = []) {
  if (conf < 60) return true;
  // Signal C — part of the page unreadable: English and Chinese paragraphs
  // in turn read 61–74 with `eng` (each Chinese one garbage), with 19–35 % of
  // words under 40; English pages 80–95, at most 12 % (2026-10-10).
  const read = words.filter(w => w.text?.trim());
  if (conf < 80 && read.length >= 20 && read.filter(w => w.confidence < 40).length >= 0.15 * read.length) return true;
  const letters    = (txt.match(/[a-zA-Z]/g) ?? []).length;
  const digits     = (txt.match(/[0-9]/g)    ?? []).length;
  const meaningful = letters + digits;
  return meaningful > 5 && (letters / (meaningful || 1)) < 0.25;
}

// The OCR model for a site locale — the language a document opened on that
// page most likely is (see detectOcrLanguage's `hint`). null: no model.
const _LOCALE_OCR = { 'zh-CN': 'chi_sim', ja: 'jpn', ko: 'kor', ar: 'ara', fa: 'fas', he: 'heb', ru: 'rus' };
export function ocrLangForLocale(locale) {
  return _LOCALE_OCR[locale] ?? null;
}

// A model's confident words (70+): what decides between models, not the page's
// mean confidence, which a page of two scripts holds down for every model.
const _confidentWords = words => words.filter(w => w.text?.trim() && w.confidence >= 70);
const _LATIN = /[A-Za-zÀ-ɏ]/;

// Judges one image of a page: a quick OCR pass with `worker`, then — when that
// looks wrong, or the site's language has its own script — each script's
// model paired with English, on workers of their own. Returns detectOcrLanguage's
// result, without switching `worker` (the caller does, once it has its
// answer), or null when the image has too little text to judge.
async function _judgeImage(cvs, worker, hint, newWorker, layerLang = null) {
  const res  = await worker.recognize(cvs);
  const txt  = res?.data?.text ?? '';
  const conf = res?.data?.confidence ?? 0;
  if (txt.trim().length < 20) return null;

  const primary    = _detectScriptFromText(txt, conf);
  const suspicious = _isDetectionSuspicious(txt, conf, res?.data?.words);
  // `hint`: the site locale's model (ocrLangForLocale) — probed first and
  // always, even when English reads the page with confidence: a Chinese
  // invoice scan read 67 with `eng` (garbage) and 80 with chi_sim. An English
  // scan there still reads its words in Latin and stays English.
  const hinted = SCRIPT_PROBES.find(p => p.lang === (hint === 'fas' ? 'ara' : hint));
  const probes = suspicious ? [...new Set([hinted, ...SCRIPT_PROBES])].filter(Boolean) : hinted ? [hinted] : [];

  const tried = [];
  const read = {};   // each model's reading of the page
  // A worker per model: one taken from model to model keeps the first one's
  // settings — an English invoice probed with chi_sim, then read with `eng`
  // again, lost a third of its words (70 → 47).
  const tryModel = async lang => {
    if (read[lang]) return read[lang];
    tried.push(lang);
    const w = await newWorker(lang);
    try {
      const r = await w.recognize(cvs);
      return (read[lang] = { lang, conf: r?.data?.confidence ?? 0, text: r?.data?.text ?? '', words: r?.data?.words ?? [] });
    } finally {
      await w.terminate();
    }
  };
  const scored = [];
  for (const p of probes) {
    const r = await tryModel(`${p.lang}+eng`);
    const sure = _confidentWords(r.words);
    const own = sure.filter(w => p.own.test(w.text)).length;
    scored.push({ ...p, r, own, latin: sure.filter(w => !p.own.test(w.text) && _LATIN.test(w.text)).length, share: own / (r.words.filter(w => w.text?.trim()).length || 1) });
    const best = scored.reduce((a, b) => (b.own > a.own ? b : a));
    // a clear winner ends the probing; Chinese and Japanese each need the other's say
    if (best.share >= 0.25 && best.own >= 15 && (!_CJK_PROBES.includes(best.lang) || _CJK_PROBES.every(l => tried.includes(`${l}+eng`)))) break;
    // The page's own text layer — broken or thin, so not read — is in this
    // script: a lower bar. A two-page scan probed all six script models before
    // `ara` won (3508224-like, 61–75 s of detection); with the layer's script,
    // 4 of 8 such documents stop after the first, 20–43 s faster each, and all
    // 36 OCRed documents of the Arabic corpus come out the same (2026-10-18).
    if (layerLang && best.lang === layerLang && best.own >= 8 && best.share >= 0.15) break;
  }
  const ranked = scored.filter(s => s.own >= 15 && s.share >= 0.12).sort((a, b) => b.own - a.own);
  const metrics = { initial: primary.lang, suspicious, tried, confidenceInitial: conf };

  if (!ranked.length) {
    const alternatives = [latinLanguage(txt).next, ...scored.filter(s => s.own >= 5).sort((a, b) => b.own - a.own).map(s => s.lang)].filter(Boolean);
    return { ...primary, alternatives, metrics: { ...metrics, source: 'ocr-primary', winner: primary.lang, winnerConfidence: conf, switched: false } };
  }
  const win = ranked[0];
  let lang = win.lang;
  // Arabic and Persian share a script, and the `ara` model never outputs
  // Persian's own letters (پ چ ژ گ ک ی: 0 in 24 scans), so only the two
  // models' confidence tells them apart: on Persian scans `fas` is within 2 of
  // `ara`, on Arabic ones 12–25 below (2026-10-08) — 4–12 below on Arabic
  // and English paragraphs in turn, 2 above to 2 below on Persian and English
  // ones (2026-10-16). Read with `fas`, Persian scans have 85–88 % of words
  // right, not 72–75.
  if (lang === 'ara') {
    const [a, f] = [await tryModel('ara'), await tryModel('fas')];
    if (f.conf >= a.conf - 3) lang = 'fas';
  }
  // With English, if the page has it: ara/fas/heb/kor alone read every Latin
  // word as garbage in their own script ("PDF" → "۳۵۴"); Korean and English
  // paragraphs in turn: 8–24 → 40–73 % of words right with kor+eng. Chinese
  // from a fifth of the words Latin: chi_sim+eng is 35 % slower and gains on
  // English passages — 87–89 → 92–96 % of a page's words, photos 76–78 → 89–91,
  // English a quarter of the paragraphs 89 → 92; Japanese stays alone —
  // jpn+eng read Japanese and English paragraphs in turn worse as often as
  // better (2026-10-10, 2026-10-16). Russian always (see _detectScriptFromText).
  const latinShare = win.latin / ((win.latin + win.own) || 1);
  if (lang === 'rus' || (['ara', 'fas', 'heb', 'kor'].includes(lang) && latinShare >= 0.1)
    || (lang === 'chi_sim' && latinShare >= 0.2)) lang = `${lang}+eng`;
  const alternatives = [...ranked.slice(1).map(s => s.lang), ...(lang === 'fas' || lang === 'fas+eng' ? ['ara'] : lang.startsWith('ara') ? ['fas'] : []), 'eng'];
  return { lang, confident: true, alternatives, metrics: {
    ...metrics, source: 'ocr-fallback', winner: lang, winnerConfidence: win.r.conf, switched: true,
  } };
}

// Detects a document's language: samples pages [1, middle, last] with `worker`
// (an `eng` one). Returns { lang, confident, alternatives, metrics } —
// alternatives: other languages the document may be in, likeliest first;
// metrics describe how the decision was reached (source, probes tried,
// winning confidence). The document is read by a new worker made for `lang`,
// not by `worker` taken to it: a worker that has read a page with `eng` reads
// worse with any model after reinitialize() — Latin words ran together ("fade
// or remove" → "fadeorremove", 73–81 % of a Chinese–English document's
// English words instead of 87–96 %) (2026-10-10).
// `ignoreTextLayer`: judge from the page image only — for pages whose text
// layer is garbage (PDF→Word's OCR layer reads only such pages and scans).
// `newWorker`: how a probe worker is made (createOcrWorker; tests pass a stub).
// `layerLang`: a script probe the page's own (unread) text layer is written
// in — taken at a lower bar when it comes first (see _judgeImage).
export async function detectOcrLanguage(pdfDoc, worker, { ignoreTextLayer = false, hint = null, newWorker = createOcrWorker, layerLang = null } = {}) {
  const total = pdfDoc.numPages;
  const pages = [...new Set([1, Math.ceil(total / 2), total])];

  for (const p of pages) {
    const page = await pdfDoc.getPage(p);

    // 1. Check text layer first — zero cost, unicode analysis is accurate here
    const layerText = ignoreTextLayer ? '' : (await page.getTextContent()).items.map(i => i.str).join(' ');
    if (layerText.trim().length >= 50) {
      const result = _detectScriptFromText(layerText, 100);
      return { ...result, alternatives: ['eng'], metrics: {
        source: 'text-layer', initial: result.lang, suspicious: false,
        tried: [], winner: result.lang, winnerConfidence: 100, switched: false,
      } };
    }

    // 2. Render low-res canvas — keep alive until ALL detection for this page is done
    const vp0  = page.getViewport({ scale: 1 });
    const scale = DETECT_PX / Math.max(vp0.width, vp0.height);
    const vp   = page.getViewport({ scale });
    const cvs  = document.createElement('canvas');
    cvs.width  = Math.round(vp.width);
    cvs.height = Math.round(vp.height);
    await page.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;

    // 3. Judge the plain render; when that leaves it unsure, the Enhanced
    // one. Not Enhanced first: tuned for full resolution, it lowered the `ara`
    // probe on clean and office scans at this size (77 → 62, 75 → 54). A phone photo (shadow, tilt) reads at 14–33 with every model on
    // the plain render — never sure, so PDF→Word left it a picture, an English
    // invoice photo included — and at 46–72 Enhanced (2026-10-10).
    let d = await _judgeImage(cvs, worker, hint, newWorker, layerLang);
    if (!d?.confident) {
      const enh = await _enhanceForOcrAsync(cvs).catch(() => null);
      if (enh) {
        const e = await _judgeImage(enh.canvas, worker, hint, newWorker, layerLang);
        enh.canvas.width = 0; enh.canvas.height = 0;
        if (e?.confident) d = { ...e, metrics: { ...e.metrics, enhanced: true } };
      }
    }
    cvs.width = 0; cvs.height = 0;
    if (d) return d;
    // Not enough text on this page — try next sample page
  }

  return { lang: 'eng', confident: false, alternatives: [], metrics: {
    source: 'fallback-default', initial: 'eng', suspicious: false,
    tried: [], winner: 'eng', winnerConfidence: 0, switched: false,
  } };
}

// ── Page preprocessing ───────────────────────────────────────────────────────

// Grayscale (Enhance's fallback) in a dedicated worker — the pixel
// loop used to run on the main thread before recognize() and caused a 240ms
// frame gap on a real 6.3MB scan (4x CPU throttle; see js/ocrGrayscaleWorker.js).
let _grayscaleWorker = null;
function _ensureGrayscaleWorker() {
  if (!_grayscaleWorker) {
    _grayscaleWorker = new Worker(new URL('./ocrGrayscaleWorker.js', import.meta.url));
  }
  return _grayscaleWorker;
}

// Clean Scan's Enhance (js/cleanScanWorker.js: background flattening, denoise,
// contrast — no binarization) before Tesseract. Measured through the OCR tool on
// synthetic scans with known text (2026-10-08), share of words found / share
// of output words right:
//   Arabic + Persian phone photos (shadow, tilt)   47 / 27 % → 76 / 72 %
//   Arabic + Persian office scans (200 dpi)        74 / 72 % → 76 / 69 %
//                                                  (single pages ±5 either way)
//   Arabic + Persian clean scans (300 dpi)         80 / 78 % → 81 / 79 %,
//                                                  ~2 s slower per page
//   English, Russian                               unchanged (99–100 %),
//                                                  photos 2–3× faster
// Clean Scan's Clean mode (binarized) did worse on photos (68 / 54 %). Rejects
// where OffscreenCanvas 2D is missing (Safari < 16.4) — callers fall back to
// plain grayscale.
let _enhanceWorker = null;
// Also deskews (see cleanScanWorker's _estimateSkewDeg): resolves to
// { canvas, skewDeg }, skewDeg the rotation applied about the canvas centre.
async function _enhanceForOcrAsync(src) {
  _enhanceWorker ??= new Worker(new URL('./cleanScanWorker.js', import.meta.url));
  const bitmap = await createImageBitmap(src);
  const { data, width, height, skewDeg } = await new Promise((resolve, reject) => {
    _enhanceWorker.onmessage = (e) => {
      if (e.data.type === 'ocrImage') resolve(e.data);
      else if (e.data.type === 'error') reject(new Error(e.data.message));
    };
    _enhanceWorker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    _enhanceWorker.postMessage({ type: 'enhanceForOcr', bitmap }, [bitmap]);
  });
  const dst = document.createElement('canvas');
  dst.width  = width;
  dst.height = height;
  dst.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return { canvas: dst, skewDeg: skewDeg || 0 };
}

// A box from the deskewed image back to the image before deskew: its centre
// rotated by −skewDeg about the image centre, its size kept. Not the box
// around the rotated corners — at 2.5° that grows a 1775px-wide, 68px-high
// line to 145px, which read as text twice the size (21pt instead of 10.5pt)
// and ran every paragraph together.
function _unskewBbox({ x0, y0, x1, y1 }, skewDeg, W, H) {
  if (!skewDeg) return { x0, y0, x1, y1 };
  const r = -skewDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const mx = (x0 + x1) / 2 - W / 2, my = (y0 + y1) / 2 - H / 2;
  const dx = W / 2 + mx * c - my * s - (x0 + x1) / 2;
  const dy = H / 2 + mx * s + my * c - (y0 + y1) / 2;
  return { x0: x0 + dx, y0: y0 + dy, x1: x1 + dx, y1: y1 + dy };
}

// Words Tesseract read twice. On a two-column page it can read a stretch of
// one column's heading again as part of a line that runs on into the other
// column: "آیا برای ادغام فایل‌های …" and then "یا برای ادغام فایل‌های ادغام
// کرد؟" (fa-cols2) — heading fragments and false headings in Word. A word of
// a later line is a repeat when an earlier line has a word that contains it
// (or is contained in it) at the same place: centres closer than the wider
// word across, and than half the lower box's height down — 9–20 px for
// repeats, a line pitch (~57 px at 300 dpi) for the next line, whose tall
// Arabic boxes still overlap this one's by more than half ("لصفحة" under
// "صفحة" was dropped when overlap decided). Keyed by box and
// text: data.words and data.lines hold their own copies.
export const _wordKey = w => `${w.bbox.x0},${w.bbox.y0},${w.bbox.x1},${w.bbox.y1}|${w.text}`;
export function _duplicateWords(lines) {
  const seen = [], dup = new Set();
  for (const line of lines) {
    const own = [];
    for (const w of line.words) {
      const t = w.text.normalize('NFC').trim();
      if (!t) continue;
      const { x0, x1, y0, y1 } = w.bbox, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      if (t.length >= 2 && seen.some(e => (e.t.includes(t) || t.includes(e.t))
          && Math.abs(cx - e.cx) < Math.max(x1 - x0, e.w)
          && Math.abs(cy - e.cy) < 0.5 * Math.min(y1 - y0, e.h))) {
        dup.add(_wordKey(w));
        continue;
      }
      own.push({ t, cx, cy, w: x1 - x0, h: y1 - y0 });
    }
    seen.push(...own);
  }
  return dup;
}

async function _toGrayscaleAsync(src) {
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const worker = _ensureGrayscaleWorker();

  const result = await new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'error') { reject(new Error(d.message)); return; }
      resolve(d);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage(
      { type: 'grayscale', data: imageData.data, w, h },
      [imageData.data.buffer]
    );
  });

  const dst = document.createElement('canvas');
  dst.width  = w;
  dst.height = h;
  dst.getContext('2d').putImageData(new ImageData(result.data, w, h), 0, 0);
  return dst;
}

// ── Page recognition ─────────────────────────────────────────────────────────

// Renders one pdf.js page and recognizes it with `worker` (set to `lang`).
// Returns, in display-canvas pixels of a viewport `vpTransform` maps PDF user
// space to:
//   words  — [{ text, confidence, bbox }] at or above minConfidence(lang)
//   lines  — Tesseract's lines, every word with `kept` (false below the
//            confidence threshold — its box still marks where text stands):
//            [{ words: [{ text, confidence, bbox, kept, ink }], bbox, baseline, stroke }]
//            ink: { dark, edge } — a word's ink pixels and ink-edge pixels;
//            stroke: the line's strokes' thickness, Σdark ÷ Σedge over its
//            words — bold sets thicker strokes (2026-10-09:
//            bold headings 1.36–2.12× the page median, body lines ≤ 1.05×).
//            The share of ink in the boxes told bold apart in Latin and
//            Persian but not in Amiri, whose words leave much of their box
//            empty (body lines up to 1.22×, a heading 1.26×).
//   text   — the page as plain text, paragraphs separated by a blank line
//   canvasW, canvasH, vpTransform, rotation
// Boxes sit where the text stands on the page image (to lay text over it), or
// with `level` where it stands once the page is deskewed: text lines level,
// for layout reconstruction. Mapped back onto a page tilted 2.5°, a short line
// lands ~10pt above or below a full one, and line gaps of 16.5/24.8pt (line /
// paragraph) read as 15–26pt — paragraph breaks lost in the noise.
// Canvases are released before returning.
export async function recognizePage(worker, page, lang, { level = false } = {}) {
  // Adaptive scale — aim for the script profile's size on the longest side, as
  // a hard cap. Old logic (scale=2 default) downsampled high-DPI CamScanner
  // pages from ~2480px to ~1190px before Tesseract, losing fraction bars and
  // small text — fixed by scaling up to the cap. A `Math.max(2, ...)` floor was
  // added at the same time to guarantee that minimum, but it let oversized
  // physical pages (A2/A1 scans, posters) blow past the cap, risking a Mobile
  // Safari tab kill under memory pressure. Removed: the cap must stay a true
  // cap, even at the cost of quality on rare oversized pages.
  const vp0 = page.getViewport({ scale: 1 });
  const ps    = primaryScript(lang);
  const maxPx = CJK_LANGS.has(ps)     ? SCRIPT_PROFILE.cjk
              : COMPLEX_LANGS.has(ps) ? SCRIPT_PROFILE.complex
              : SCRIPT_PROFILE.latin;
  const scale = Math.min(maxPx / vp0.width, maxPx / vp0.height);
  const vp = page.getViewport({ scale });

  let canvas;
  try {
    canvas        = document.createElement('canvas');
    canvas.width  = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    // The page as shown: pdf.js renders /Rotate in. It used to be turned back
    // by /Rotate here as well — a scan stored sideways and shown upright went
    // to Tesseract sideways again, and came out as noise (corpus class C1,
    // 2026-10-18: an exam scan with /Rotate 270, 27 "lines" of loose letters).
    const rotation = page.rotate || 0;

    // Enhance (and its deskew) for every script. CJK had its own grayscale +
    // Otsu path, never measured against it: on tilted Chinese and Japanese
    // phone photos its reading order was 41–69%, Enhanced 96–99%, paragraphs
    // and headings with it (2026-10-09, synthetic scans).
    const { canvas: gray, skewDeg } = await _enhanceForOcrAsync(canvas)
      .catch(async () => ({ canvas: await _toGrayscaleAsync(canvas), skewDeg: 0 }));
    const result = await worker.recognize(gray);
    const W = gray.width, H = gray.height;
    const px = gray.getContext('2d').getImageData(0, 0, W, H).data;
    const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && px[(y * W + x) * 4] < 128;
    const inkOf = bbox => {
      let dark = 0, edge = 0;
      for (let y = Math.max(0, Math.round(bbox.y0)); y < Math.min(H, bbox.y1); y++) {
        for (let x = Math.max(0, Math.round(bbox.x0)); x < Math.min(W, bbox.x1); x++) {
          if (!ink(x, y)) continue;
          dark++;
          if (!ink(x - 1, y) || !ink(x + 1, y) || !ink(x, y - 1) || !ink(x, y + 1)) edge++;
        }
      }
      return { dark, edge };
    };
    const strokeOf = words => {
      const dark = words.reduce((s, w) => s + w.ink.dark, 0), edge = words.reduce((s, w) => s + w.ink.edge, 0);
      return edge ? dark / edge : 0;
    };

    const minConf = minConfidence(lang);
    // Deskewed image → image before deskew (unless `level`): the display canvas.
    const back = bbox => (level ? bbox : _unskewBbox(bbox, skewDeg, gray.width, gray.height));
    const dup = _duplicateWords(result.data.lines || []);
    const keep = w => w.text.normalize('NFC').trim() && w.confidence >= minConf && !dup.has(_wordKey(w));
    const toWord = w => ({ text: w.text.normalize('NFC').trim(), confidence: w.confidence, bbox: back(w.bbox) });

    const words = result.data.words.filter(keep).map(toWord);
    const lines = (result.data.lines || []).map(line => {
      const lineWords = line.words.filter(w => w.text.trim() && !dup.has(_wordKey(w))).map(w => ({ ...toWord(w), kept: !!keep(w), ink: inkOf(w.bbox) }));
      return {
        words:    lineWords,
        bbox:     back(line.bbox),
        // Mapped back like a box: level, at the line's height at mid-line.
        baseline: line.baseline && { ...back(line.baseline), has_baseline: line.baseline.has_baseline },
        stroke:   strokeOf(lineWords),
      };
    }).filter(line => line.words.some(w => w.kept));

    // Plain text from paragraph/line structure
    const paragraphs = result.data.paragraphs
      .map(para => para.lines
        .map(line => joinOcrWords(line.words.filter(w => !dup.has(_wordKey(w))).map(w => w.text.trim())))
        .filter(Boolean)
        .join('\n'))
      .filter(Boolean);

    return {
      words, lines,
      text: paragraphs.join('\n\n') || result.data.text.trim(),
      canvasW: canvas.width, canvasH: canvas.height,
      vpTransform: Array.from(vp.transform),
      rotation,
    };
  } finally {
    // Always release canvas memory regardless of success or error
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
