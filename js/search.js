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
    }));
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
      else if (entry.desc.includes(q))                                   score = 20;

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
