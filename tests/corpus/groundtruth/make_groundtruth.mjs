// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Ground-truth PDFs: documents rendered FROM a known source, so the correct
// headings, paragraphs and reading order are known exactly — no hand labelling.
// Text is the project's own translated FAQ copy (data/content/<lang>/*-faq.json:
// real prose in each language, owned by the project), fonts are Noto (SIL OFL,
// embeddable). Fonts are static 400/700 instances cut from google/fonts' variable
// TTFs with fontTools: Chromium writes variable fonts, Google-Fonts-served woff2
// and CFF-outline OTFs as Type3 glyph drawings, while static TrueType comes out as
// ordinary Type0/CID text like real documents (checked with PyMuPDF). Each
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
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const OUT = new URL('./', import.meta.url);

// Fonts per script, from google/fonts (ofl/...): a variable TTF ("[axes]" in the
// name) is cut into static 400/700 instances, otherwise the two static files.
// Chosen by measurement, not looks: the text layer Chromium writes depends on the
// font, and MuPDF recovered only 19% of the Arabic words from Noto Sans/Naskh
// Arabic (dotless base glyphs + separate dots) vs 95% from Amiri; Vazirmatn is a
// Persian-designed face. NotoSans is every document's Latin fallback, so no
// system font ever gets embedded.
const LATIN = 'notosans/NotoSans[wdth,wght].ttf';
const LANGS = {
  en: { dir: 'ltr', font: LATIN },
  ru: { dir: 'ltr', font: LATIN },
  ar: { dir: 'rtl', font: { 400: 'amiri/Amiri-Regular.ttf', 700: 'amiri/Amiri-Bold.ttf' } },
  fa: { dir: 'rtl', font: 'vazirmatn/Vazirmatn[wght].ttf' },
  he: { dir: 'rtl', font: 'notosanshebrew/NotoSansHebrew[wdth,wght].ttf' },
  ja: { dir: 'ltr', font: 'notosansjp/NotoSansJP[wght].ttf' },
  'zh-CN': { dir: 'ltr', font: 'notosanssc/NotoSansSC[wght].ttf' },
  ko: { dir: 'ltr', font: 'notosanskr/NotoSansKR[wght].ttf' },
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

const FONT_CACHE = new URL('.fonts/', OUT);
const cached = name => fileURLToPath(new URL(name, FONT_CACHE));
function download(path) {
  const file = cached(path.split('/')[1].replace(/\[.*\]/, '-VF'));
  if (!existsSync(file)) {
    execFileSync('curl', ['-sfL', '-o', file, `https://github.com/google/fonts/raw/main/ofl/${path.replace('[', '%5B').replace(']', '%5D')}`]);
  }
  return file;
}
// @font-face rules (base64) for one family's 400 and 700 weights.
function fontFaces(family, spec) {
  mkdirSync(FONT_CACHE, { recursive: true });
  return [400, 700].map(wght => {
    let file;
    if (typeof spec === 'object') file = download(spec[wght]);
    else {
      const vf = download(spec);
      file = vf.replace(/-VF\.ttf$/, `-${wght}.ttf`);
      if (!existsSync(file)) {
        const axes = [`wght=${wght}`, ...(spec.includes('wdth') ? ['wdth=100'] : [])];
        execFileSync('python3', ['-m', 'fontTools.varLib.instancer', vf, ...axes, '--update-name-table', '-q', '-o', file]);
      }
    }
    return `@font-face { font-family: '${family}'; font-weight: ${wght}; src: url(data:font/ttf;base64,${readFileSync(file).toString('base64')}); }`;
  }).join('\n');
}

// Share of the true words MuPDF (an independent extractor) recovers from the
// PDF: a document whose own text layer is broken can't grade pdf2md. Marks
// (harakat, niqqud) and tatweel are ignored — optional diacritics, not words;
// CJK counts per character (no spaces to split on), as in check.py.
const ORACLE_MIN = 0.85;
function oracleRecall(pdfPath, blocks) {
  return Number(execFileSync('python3', ['-c', String.raw`
import sys, json, re, unicodedata, fitz
from collections import Counter
def tok(s):
    s = unicodedata.normalize('NFKC', s).lower().replace('\u200c', ' ')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn' and c != '\u0640')
    cjk = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff'
    return Counter(re.findall(rf'[{cjk}]|[^\W\d_{cjk}]+|\d+', s))
truth = tok(' '.join(json.load(sys.stdin)))
got = tok(''.join(p.get_text() for p in fitz.open(sys.argv[1])))
print(sum((truth & got).values()) / sum(truth.values()))`, pdfPath],
  { input: JSON.stringify(blocks.map(b => b.text)) }).toString());
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
${font === LATIN ? '' : fontFaces('GTLatin', LATIN)}
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
