// SPDX-License-Identifier: AGPL-3.0-only
// Pure search logic — no DOM, no side-effects on import.

const MISS_KEY = 'pdfree_search_misses';

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
      name:       (t.titles?.[lang] || t.title || '').toLowerCase(),
      nameEn:     (t.title || '').toLowerCase(),
      // The tool's own internal identifier (e.g. 'pdf2word', 'draw-pdf') is
      // itself a recognizable, languageless term some users type verbatim —
      // index it (and a no-hyphen variant, since 'draw-pdf' vs 'drawpdf' is
      // an easy thing to not realize matters) alongside the translated name.
      keyTerms:   [key, key.replace(/-/g, '')].map(s => s.toLowerCase()),
      desc:       (t.descs?.[lang]  || t.desc  || '').toLowerCase(),
      tags:       [...(t.tags || []), ...(localeTags?.[key] || [])].map(s => s.toLowerCase()),
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
function minQueryLength(q) {
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
  const q = query.toLowerCase().trim();
  if (q.length < minQueryLength(q)) return [];

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
      else {
        let dist = Infinity;
        if (!NO_FUZZY_RE.test(q)) {
          const nameDist = Math.min(...names.map(n => bestWordDistance(q, n)));
          const tagDist  = entry.tags.reduce((min, t) => Math.min(min, bestWordDistance(q, t)), Infinity);
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

/**
 * Persist a missed query to localStorage for product analytics.
 * Cap at 200 entries. Stored as JSON array of {q, ts}.
 * Read in DevTools console:
 *   JSON.parse(localStorage.getItem('pdfree_search_misses'))
 */
export function trackMiss(query) {
  try {
    const raw    = localStorage.getItem(MISS_KEY);
    const misses = raw ? JSON.parse(raw) : [];
    misses.push({ q: query.trim(), ts: Date.now() });
    localStorage.setItem(MISS_KEY, JSON.stringify(misses.slice(-200)));
  } catch {
    // localStorage may be blocked in private mode
  }
}
