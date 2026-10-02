// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Shared by the ground-truth scorers (groundtruth.mjs: prose, groundtruth-tables.mjs:
// tables): the word tokens both count, and running a PDF through a real tool page.

const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff';
const TOKEN = new RegExp(`[${CJK}]|[^\\s\\p{P}\\p{S}${CJK}]+`, 'gu');
// Tokens: words (letters/digits runs, NFKC, lower-case); CJK per character. Marks
// (harakat, niqqud) and tatweel ignored — optional diacritics, not words; same
// tokens as the generator's MuPDF oracle check.
export const tokens = text => (text.normalize('NFKC').toLowerCase().replace(/\u200C/g, ' ')
  .replace(/[\p{Mn}\u0640]/gu, '').match(TOKEN) || []);

// Arabic presentation-form characters (U+FB50–FDFF, U+FE70–FEFE): shaped glyph
// codes instead of letters — they display, but break search, spell-check and
// screen readers.
export const PRESENTATION_FORM = /[\uFB50-\uFDFF\uFE70-\uFEFE]/g;

// The real tool page — upload, Convert, catch the file it downloads (base64).
// jsdelivr is refused outright so the Office libraries come straight from the
// fallback CDN: this measures conversion quality, and a slow or hanging primary
// CDN would only add minutes (CDN fallback has its own test, cdn-fallback.e2e.mjs).
// `ready`: the options panel's text once the page's own PDF analysis is done —
// the button enables before that, and a click while "Analysing PDF…" shows is
// swallowed. `mime`: the result blob's type.
export async function convertOnToolPage(browser, base, { slug, panel, ready, mime }, pdfPath) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await ctx.route('**://cdn.jsdelivr.net/**', route => route.abort());
    const tab = await ctx.newPage();
    await tab.addInitScript(() => {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob instanceof Blob) window.__blob = blob; return orig(blob); };
    });
    await tab.goto(`${base}/${slug}/`, { waitUntil: 'load' });
    await tab.setInputFiles('#fileInput', pdfPath);
    await tab.waitForFunction(([panelSel, readySrc]) => !document.querySelector('#mergeBtn')?.disabled
      && !/Analys/.test(document.querySelector('#toast')?.textContent || '')
      && !/Analys/.test(document.querySelector(panelSel)?.textContent || '')
      && new RegExp(readySrc).test(document.querySelector(panelSel)?.textContent || ''),
    [panel, ready.source], { timeout: 60000 });
    await tab.evaluate(() => { window.__blob = null; });
    await tab.click('#mergeBtn');
    await tab.waitForFunction(mimeSrc => window.__blob && new RegExp(mimeSrc).test(window.__blob.type), mime.source, { timeout: 90000 })
      .catch(async () => {
        const state = await tab.evaluate(() => [document.querySelector('#toast')?.textContent,
          document.querySelector('#progressLabel')?.textContent].map(x => (x || '').trim()).join(' | '));
        throw new Error(`${pdfPath}: no ${slug} result within 90s (toast | progress: ${state})`);
      });
    return await tab.evaluate(async () => {
      const buf = new Uint8Array(await window.__blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    });
  } finally {
    await ctx.close();
  }
}
