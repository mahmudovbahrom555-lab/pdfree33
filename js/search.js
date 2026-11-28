// SPDX-License-Identifier: AGPL-3.0-only
// Pure search logic — no DOM, no side-effects on import.

// Fold accented/diacritic characters to their plain-Latin base for matching
// (never for display) — e.g. Turkish "sıkıştır" (compress) should still be
// found by a user typing the ASCII "sikistir" on a non-Turkish keyboard, or
// dropping accents out of habit/speed in any language (French "compresser"
// typed "compreser" is a typo the fuzzy tier already catches at 1 edit, but
// "protéger" -> "proteger" is also an *accent* difference some fuzzy-tier
// length budgets don't cover once a word has several accented letters).
// Standard Unicode NFD decomposition + stripping combining marks (U+0300–
// U+036F) handles most of this (ö→o, ü→u, ç→c, ş→s, ğ→g, é→e, Vietnamese's
// stacked tone marks like ệ→e, ả→a...). A few base letters are visually
// "accented" but don't have an NFD decomposition — they're distinct code
// points, not letter+combining-mark — so they're folded explicitly. Found
// by scanning every character actually used across all 13 locales'
// search_tags data and checking which ones don't decompose (not by
// guessing language-by-language): Turkish dotless ı (U+0131), Vietnamese
// đ (U+0111, "d with stroke"), Polish ł (U+0142, "l with stroke"), and
// German ß (U+00DF, "sharp s" — folds to "ss", the standard ASCII
// transliteration, not "s"). Without this, e.g. Vietnamese typed "không
// dấu" (without diacritics — common on non-Vietnamese keyboards or just
// for speed) matched nothing at all: "đặt mật khẩu" (set password) has no
// NFD-decomposable letter until you also fold đ, so "dat mat khau" fell
// through every tier silently. Cyrillic and CJK characters are a
// different alphabet, not an "accented Latin letter" concept — left
// untouched.
function foldDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i').replace(/đ/g, 'd').replace(/ł/g, 'l').replace(/ß/g, 'ss');
}

// Traditional Chinese characters of PDF-tool queries → Simplified, the
// script our Chinese synonyms are in: "PDF轉成EXCEL" (Taiwan, Hong Kong — and
// /zh/ pages a browser translated to Traditional) found nothing (2026-10-13).
// Searched as an alternative, never instead: Japanese writes 書 編 頁 縮 as
// they are, and "スキャンした文書" mapped to "…文书" found the wrong tool.
const _T2S = Object.fromEntries([...'轉转換换檔档圖图頁页壓压縮缩併并編编輯辑單单簽签註注刪删鎖锁掃扫識识別别擷撷寫写對对讀读書书製制調调開开檢检碼码號号層层標标題题張张復复劃划線线變变為为從从個个機机電电腦脑網网載载傳传檔档護护頻频際际'
  .match(/../g)].map(([t, s]) => [t, s]));
function toSimplified(s) {
  return s.replace(/[\u3400-\u9FFF]/g, c => _T2S[c] || c);
}

/**
 * Build a flat search index from the TOOLS dict.
 * Called once at homepage init; result is passed to search().
 * @param {Record<string, object>} tools — TOOLS from config.js
 * @param {string} lang — current page language (en/de/es/fr/pt/...)
 * @param {Record<string, string[]>} [localeTags] — window.PDFREE_LOCALE.search_tags
 *   for the current page's language: { toolKey: [translated synonym, ...] }.
 *   English tags (t.tags in config.js) are always included too, so users
 *   typing an English tool name on a non-English page still get a match.
 */
export function buildIndex(tools, lang = 'en', localeTags = {}) {
  return Object.entries(tools)
    .filter(([, t]) => t.implemented)
    .map(([key, t]) => ({
      key,
      displayName: t.titles?.[lang] || t.title || key,
      icon:        t.icon || '📄',
      name:       foldDiacritics((t.titles?.[lang] || t.title || '').toLowerCase()),
      nameEn:     foldDiacritics((t.title || '').toLowerCase()),
      // The tool's own internal identifier (e.g. 'pdf2word', 'draw-pdf') is
      // itself a recognizable, languageless term some users type verbatim —
      // index it (and a no-hyphen variant, since 'draw-pdf' vs 'drawpdf' is
      // an easy thing to not realize matters) alongside the translated name.
      keyTerms:   [key, key.replace(/-/g, '')].map(s => foldDiacritics(s.toLowerCase())),
      desc:       foldDiacritics((t.descs?.[lang]  || t.desc  || '').toLowerCase()),
      tags:       [...(t.tags || []), ...(localeTags?.[key] || [])].map(s => foldDiacritics(s.toLowerCase())),
      accept:     t.accept || '.pdf',
      multi:      t.multi  || false,
      btn:        t.btns?.[lang] || t.btn || '',
    }));
}

/**
 * Levenshtein edit distance between two strings.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// How many edits still count as "probably the same word", scaled by query length —
// short queries (typo in "excel" → "exel") tolerate 1 edit, longer phrases tolerate more.
function maxEditsFor(len) {
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}

// Smallest edit distance between `query` and any single word in `text`,
// or Infinity if no word is within the length-scaled tolerance.
function bestWordDistance(query, text) {
  const maxDist = maxEditsFor(query.length);
  let best = Infinity;
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const d = levenshtein(query, word);
    if (d <= maxDist && d < best) best = d;
  }
  return best;
}

// Like bestWordDistance, but for multi-word queries: matches each query
// word to its own best word in `text` independently (order doesn't matter),
// so a typo in just ONE word of a phrase still resolves — e.g. Indonesian
// "tanda air" (watermark) typed "tada air" is a real, findable typo, but
// bestWordDistance alone can never catch it: it only ever compares the
// *entire* query as one unit against individual words of the target, which
// can't work once the query itself has more than one word. Returns the
// summed distance across all query words, or Infinity if the query is a
// single word (bestWordDistance already covers that) or if any one query
// word can't find a close-enough match at all — one unrelated word should
// disqualify the whole phrase rather than being silently ignored.
function bestPhraseDistance(query, text) {
  const queryWords = query.split(/\s+/).filter(Boolean);
  if (queryWords.length < 2) return Infinity;
  let total = 0;
  for (const w of queryWords) {
    const d = bestWordDistance(w, text);
    if (d === Infinity) return Infinity;
    total += d;
  }
  return total;
}

/**
 * Return every matching tool for the given query, best match first. Does
 * NOT cap the result count — callers decide how many to render (e.g. show
 * one confident result vs a narrowing list of several candidates).
 * Score table (higher wins):
 *   100 — exact match on localized name, EN name, or the tool's own key
 *    90 — exact tag match
 *    80 — localized/EN name or key starts with query
 *    70 — any tag starts with query
 *    60 — localized/EN name or key contains query
 *    50 — any tag contains query
 *  22-46 — query is a likely typo of a word in the name or a tag
 *          (closer typo wins; name matches get a slight edge over tag
 *          matches at the same distance) — skipped for queries containing
 *          a digit, see NO_FUZZY_RE below
 *    20 — description contains query
 */
// CJK scripts (Han/Kanji, Hiragana, Katakana, Hangul) pack far more meaning
// per character than Latin/Cyrillic text — a 2-character word like 結合
// (merge) or 압축 (compress) is a complete, common term, not an abbreviation.
// A flat "3 char minimum" query gate would silently reject these and make
// roughly half of ja/ko's natural search terms permanently unmatchable.
const CJK_RE = /[぀-ヿ一-鿿가-힣]/;
export function hasCjk(q) {
  return CJK_RE.test(q);
}
export function minQueryLength(q) {
  return CJK_RE.test(q) ? 2 : 3;
}

// A query with a digit in it (e.g. "pdf2", "pdf2w") is essentially never a
// typo of a dictionary word — real typos substitute/drop/transpose letters
// within the same alphabet, they don't introduce a digit that wasn't there.
// Without this guard, "pdf2" scored a 1-edit fuzzy "typo" match against the
// word "pdfs" (present in several unrelated tools' tags, e.g. merge's
// "multiple pdfs") purely because '2' and 's' are one substitution apart —
// a coincidental collision, not a real typo. Exact/prefix/substring tiers
// (and keyTerms, which handles "pdf2word" typed in full) are unaffected.
const NO_FUZZY_RE = /\d/;

export function search(query, index) {
  // NFKC: full-width letters a Japanese keyboard types ("ｐｐｔｘ") read as "pptx"
  const q = foldDiacritics(query.normalize('NFKC').toLowerCase().trim());
  // Below the minimum only a whole name or tag counts: "md" is PDF to
  // Markdown, but "pd" or "cl" (a word still being typed) finds nothing.
  const short = q.length < minQueryLength(q);
  if (short && q.length < 2) return [];
  const found = _searchVariants(q, index, short);
  if (found.length || short) return found;
  // Nothing found (Search Miss, 30 days to 2026-11-28): people write what they
  // want done. Page numbers in the request — "拆分52到110" (split 52 to 110),
  // "提取第3页第5页第7页" — hid the tool's name; a sentence — "edit the file",
  // "merge them all together" — had no tag as a whole.
  // numbers out, and in Chinese the words that frame them (第 3 页, 到, 至)
  let digitless = q.replace(/[\d]+(?:\s*[-–~,，、]\s*[\d]+)*/g, ' ');
  if (CJK_RE.test(q)) digitless = digitless.replace(/[第页頁到至和及、，,\s]/g, '');
  digitless = digitless.replace(/\s+/g, ' ').trim();
  if (digitless !== q && digitless.length >= minQueryLength(digitless)) {
    const hits = _searchVariants(digitless, index, false);
    if (hits.length) return hits.map(hit => ({ ...hit, score: hit.score - 5 }));
  }
  return _byWords(q, index);
}

function _searchVariants(q, index, short) {
  const simplified = toSimplified(q);
  const results = new Map();
  for (const variant of simplified === q ? [q] : [q, simplified]) {
    for (const hit of _search(variant, index)) {
      if (short && hit.score < 90) continue;
      if (!results.has(hit.key) || results.get(hit.key).score < hit.score) results.set(hit.key, hit);
    }
  }
  return [...results.values()].sort((a, b) => b.score - a.score);
}

// Words that say nothing about the tool, in the languages whose requests
// came as sentences; a request is searched word by word without them.
const _FILLER = new Set(('the a an and or to of in on into for with from my me it them this that all together ' +
  'file files pdf pdfs page pages please want need how can i make add get ' +
  'y de la el los las un una en para con mi ' +
  'le les des et pour mon ma ' +
  'e o os um uma em meu minha').split(' '));

// Each remaining word alone, a confident match only (a whole or leading part
// of a name or tag, score 70+); the tool most words name wins. Scores 30–39:
// below every direct match, so a real result always comes first.
function _byWords(q, index) {
  if (CJK_RE.test(q)) return [];
  const all = q.split(/\s+/);
  const kept = all.filter(word => !_FILLER.has(word));
  // the request without its filler words, as one phrase first: "add editable box" → "editable box"
  if (kept.length && kept.length < all.length) {
    const phrase = kept.join(' ');
    const hits = phrase.length >= minQueryLength(phrase) ? _searchVariants(phrase, index, false).filter(hit => hit.score >= 70) : [];
    if (hits.length) return hits.map(hit => ({ ...hit, score: 30 + Math.min(9, Math.floor(hit.score / 10)) }));
  }
  const words = kept.filter(word => word.length >= 3);
  if (words.length < 1 || words.length === all.length && words.length < 2) return [];
  const tally = new Map();
  for (const word of words) {
    const seen = new Set();
    for (const hit of _search(word, index)) {
      if (hit.score < 70 || seen.has(hit.key)) continue;
      seen.add(hit.key);
      const t = tally.get(hit.key) ?? { hit, words: 0, best: 0 };
      t.words++;
      t.best = Math.max(t.best, hit.score);
      tally.set(hit.key, t);
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.words - a.words || b.best - a.best)
    .map(({ hit, words: n }) => ({ ...hit, score: 30 + Math.min(9, n) }));
}

// What a Search Miss may carry (2026-11-28): people paste file names and the
// text of their documents into the box — a report named after a student, a
// ministry's letterhead, a book's title and author. None of it is sent: a
// file name, anything over 30 characters, a number of 6+ digits (an ID), an
// address with @. null = send that a search found nothing, not what it was.
export function missText(query) {
  const q = query.trim();
  if (q.length > 30 || /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|txt|epub|zip)\b/i.test(q) || /\d{6,}/.test(q) || q.includes('@')) return null;
  return q;
}

function _search(q, index) {
  return index
    .map(entry => {
      let score = 0;
      const names = [entry.name, entry.nameEn, ...entry.keyTerms];

      if (names.includes(q))                                score = 100;
      else if (entry.tags.includes(q))                       score = 90;
      else if (names.some(n => n.startsWith(q)))             score = 80;
      else if (entry.tags.some(t => t.startsWith(q)))        score = 70;
      else if (names.some(n => n.includes(q)))               score = 60;
      else if (entry.tags.some(t => t.includes(q)))          score = 50;
      // A Chinese/Japanese sentence holding a synonym: "PDF全部图片左旋转"
      // (rotate every page left) has 旋转 in it but matched nothing — CJK
      // users type the whole request. CJK synonyms of 2+ characters only;
      // the longest one found ranks highest.
      else if (CJK_RE.test(q) && entry.tags.some(t => t.length >= 2 && CJK_RE.test(t) && q.includes(t))) {
        score = 40 + Math.min(9, Math.max(...entry.tags.filter(t => t.length >= 2 && CJK_RE.test(t) && q.includes(t)).map(t => t.length)));
      }
      else {
        let dist = Infinity;
        if (!NO_FUZZY_RE.test(q)) {
          const nameDist = Math.min(...names.map(n => Math.min(bestWordDistance(q, n), bestPhraseDistance(q, n))));
          const tagDist  = entry.tags.reduce((min, t) => Math.min(min, bestWordDistance(q, t), bestPhraseDistance(q, t)), Infinity);
          dist = Math.min(nameDist, tagDist);
          if (dist < Infinity) score = 46 - dist * 4 + (nameDist <= tagDist ? 1 : 0);
        }
        if (dist === Infinity && entry.desc.includes(q)) score = 20;
      }

      return score > 0 ? { ...entry, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

