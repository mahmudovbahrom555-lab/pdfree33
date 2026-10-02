// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Ground-truth PDFs: documents rendered FROM a known source, so the correct
// headings, paragraphs and reading order are known exactly — no hand labelling.
// Text is the project's own translated FAQ copy (data/content/<lang>/*-faq.json:
// real prose in each language, owned by the project), fonts per script from
// gtShared.mjs (SIL OFL, embeddable, static TrueType — see there why). Each
// document: heading, three paragraphs, heading, three paragraphs, laid out four
// ways that stress the paragraph/heading heuristics:
//   web    line-height 1.5, space between paragraphs
//   tight  line-height 1.2, no space, first-line indent (book style)
//   loose  line-height 1.8, space between paragraphs
//   cols2  two columns
// Output: <lang>-<layout>.pdf + <lang>-<layout>.json ({ lang, dir, layout, oracleRecall, blocks }).
// Regenerate: node tests/corpus/groundtruth/make_groundtruth.mjs (needs network
// and `pip install fonttools`; fonts are cached in .fonts/, not committed). The
// PDFs are committed — Chromium/font updates would otherwise shift every
// measurement.

import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FONTS, fontFaces, oracleRecall, ORACLE_MIN } from './gtShared.mjs';

const ROOT = new URL('../../../', import.meta.url);
const OUT = new URL('./', import.meta.url);

const LANGS = {
  en: { dir: 'ltr', font: FONTS.latin },
  ru: { dir: 'ltr', font: FONTS.latin },
  ar: { dir: 'rtl', font: FONTS.ar },
  fa: { dir: 'rtl', font: FONTS.fa },
  he: { dir: 'rtl', font: FONTS.he },
  ja: { dir: 'ltr', font: FONTS.ja },
  'zh-CN': { dir: 'ltr', font: FONTS['zh-CN'] },
  ko: { dir: 'ltr', font: FONTS.ko },
};
const LAYOUTS = {
  web:   'p { line-height: 1.5; margin: 0 0 0.75em; }',
  tight: 'p { line-height: 1.2; margin: 0; text-indent: 1.5em; }',
  loose: 'p { line-height: 1.8; margin: 0 0 0.75em; }',
  cols2: 'main { column-count: 2; column-gap: 24pt; } p { line-height: 1.4; margin: 0 0 0.6em; }',
};

// First six FAQ entries (files in name order) whose answer is long enough to
// wrap onto several lines — deterministic, so regeneration picks the same text.
function faqPairs(lang) {
  const dir = new URL(`data/content/${lang}/`, ROOT);
  const pairs = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith('-faq.json')).sort()) {
    const data = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    for (const q of Array.isArray(data) ? data : data.mainEntity || []) {
      const a = q.acceptedAnswer?.text || '';
      if (a.length >= 120 && q.name.length <= 110) pairs.push({ q: q.name, a });
      if (pairs.length === 6) return pairs;
    }
  }
  throw new Error(`${lang}: fewer than 6 usable FAQ entries`);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [lang, { dir, font }] of Object.entries(LANGS)) {
  const p = faqPairs(lang);
  const blocks = [
    { type: 'heading', text: p[0].q }, { type: 'para', text: p[0].a },
    { type: 'para', text: p[1].a }, { type: 'para', text: p[2].a },
    { type: 'heading', text: p[3].q }, { type: 'para', text: p[3].a },
    { type: 'para', text: p[4].a }, { type: 'para', text: p[5].a },
  ];
  for (const [layout, css] of Object.entries(LAYOUTS)) {
    const html = `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">
<style>${fontFaces('GT', font)}
${font === FONTS.latin ? '' : fontFaces('GTLatin', FONTS.latin)}
body { font-family: 'GT', 'GTLatin'; font-size: 11pt; margin: 0; }
h2 { font-size: 15pt; font-weight: 700; margin: 1em 0 0.5em; } ${css}</style></head>
<body><main>${blocks.map(b => b.type === 'heading' ? `<h2>${esc(b.text)}</h2>` : `<p>${esc(b.text)}</p>`).join('\n')}</main></body></html>`;
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    const name = `${lang}-${layout}`;
    const pdfPath = fileURLToPath(new URL(`${name}.pdf`, OUT));
    writeFileSync(pdfPath, await page.pdf({
      format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
    }));
    const oracle = oracleRecall(pdfPath, blocks);
    if (oracle < ORACLE_MIN) throw new Error(`${name}: MuPDF recovers only ${oracle.toFixed(3)} of the words — broken text layer, pick another font`);
    writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify({ lang, dir, layout, oracleRecall: +oracle.toFixed(3), blocks }, null, 1) + '\n');
    console.log(name, 'oracle recall', oracle.toFixed(3));
  }
}
await browser.close();
