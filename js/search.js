// SPDX-License-Identifier: AGPL-3.0-only
// Pure search logic — no DOM, no side-effects on import.

const MISS_KEY = 'pdfree_search_misses';

/**
 * Build a flat search index from the TOOLS dict.
 * Called once at homepage init; result is passed to search().
 * @param {Record<string, object>} tools — TOOLS from config.js
 * @param {string} lang — current page language (en/de/es/fr/pt)
 */
export function buildIndex(tools, lang = 'en') {
  return Object.entries(tools)
    .filter(([, t]) => t.implemented)
    .map(([key, t]) => ({
      key,
      displayName: t.titles?.[lang] || t.title || key,
      icon:        t.icon || '📄',
      name:       (t.titles?.[lang] || t.title || '').toLowerCase(),
      nameEn:     (t.title || '').toLowerCase(),
      desc:       (t.descs?.[lang]  || t.desc  || '').toLowerCase(),
      tags:       (t.tags || []).map(s => s.toLowerCase()),
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
 * Return up to 3 ranked results for the given query.
 * Score table (higher wins):
 *   100 — exact match on localized name or EN name
 *    90 — exact tag match
 *    80 — localized/EN name starts with query
 *    70 — any tag starts with query
 *    60 — localized/EN name contains query
 *    50 — any tag contains query
 *  22-46 — query is a likely typo of a word in the name or a tag
 *          (closer typo wins; name matches get a slight edge over tag
 *          matches at the same distance)
 *    20 — description contains query
 */
export function search(query, index) {
  const q = query.toLowerCase().trim();
  if (q.length < 3) return [];

  return index
    .map(entry => {
      let score = 0;

      if (entry.name === q || entry.nameEn === q)                       score = 100;
      else if (entry.tags.includes(q))                                   score = 90;
      else if (entry.name.startsWith(q) || entry.nameEn.startsWith(q))  score = 80;
      else if (entry.tags.some(t => t.startsWith(q)))                   score = 70;
      else if (entry.name.includes(q) || entry.nameEn.includes(q))      score = 60;
      else if (entry.tags.some(t => t.includes(q)))                     score = 50;
      else {
        const nameDist = Math.min(bestWordDistance(q, entry.name), bestWordDistance(q, entry.nameEn));
        const tagDist  = entry.tags.reduce((min, t) => Math.min(min, bestWordDistance(q, t)), Infinity);
        const dist     = Math.min(nameDist, tagDist);
        if (dist < Infinity)             score = 46 - dist * 4 + (nameDist <= tagDist ? 1 : 0);
        else if (entry.desc.includes(q)) score = 20;
      }

      return score > 0 ? { ...entry, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
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
