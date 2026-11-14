// SPDX-License-Identifier: AGPL-3.0-only
// The editor's words in the site's language (2026-11-14). English is the key:
// tr('Question {n}', { n }) looks the sentence up in strings.js and falls back to
// English for a sentence not translated yet. localizeDom() does the same for
// index.html's text, labels and tooltips, so the page stays plain HTML.
// The language comes from the PDF → PowerPoint page that opens the editor
// (?lang=), and only from the site's own list.
import { STRINGS } from './strings.js';

const params = new URLSearchParams(location.search);
const asked = params.get('lang') || '';
export const LANG = Object.hasOwn(STRINGS, asked) ? asked : 'en';
const table = STRINGS[LANG] || {};

export function tr(text, vars = {}) {
  const out = table[text] ?? text;
  return out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];
export function localizeDom(root = document) {
  document.documentElement.lang = LANG;
  document.documentElement.dir = ['ar', 'fa', 'he', 'ur'].includes(LANG) ? 'rtl' : 'ltr';
  if (LANG === 'en') return;
  document.title = tr(document.title);
  const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text && table[text]) node.nodeValue = node.nodeValue.replace(text, table[text]);
  }
  for (const el of (root.body || root).querySelectorAll(ATTRS.map(a => `[${a}]`).join(','))) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && table[v]) el.setAttribute(a, table[v]);
    }
  }
}
