// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Shared by the ground-truth generators (make_groundtruth.mjs: prose,
// make_tables.mjs: tables): embeddable static fonts and the MuPDF oracle check.
// Fonts are static 400/700 instances cut from google/fonts' variable TTFs with
// fontTools: Chromium writes variable fonts, Google-Fonts-served woff2 and
// CFF-outline OTFs as Type3 glyph drawings, while static TrueType comes out as
// ordinary Type0/CID text like real documents (checked with PyMuPDF).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Fonts per script, from google/fonts (ofl/...): a variable TTF ("[axes]" in the
// name) is cut into static 400/700 instances, otherwise the two static files.
// Chosen by measurement, not looks: the text layer Chromium writes depends on the
// font, and MuPDF recovered only 19% of the Arabic words from Noto Sans/Naskh
// Arabic (dotless base glyphs + separate dots) vs 95% from Amiri; Vazirmatn is a
// Persian-designed face. NotoSans (latin) is every document's Latin fallback, so
// no system font ever gets embedded.
export const FONTS = {
  latin: 'notosans/NotoSans[wdth,wght].ttf',
  ar: { 400: 'amiri/Amiri-Regular.ttf', 700: 'amiri/Amiri-Bold.ttf' },
  fa: 'vazirmatn/Vazirmatn[wght].ttf',
  he: 'notosanshebrew/NotoSansHebrew[wdth,wght].ttf',
  ja: 'notosansjp/NotoSansJP[wght].ttf',
  'zh-CN': 'notosanssc/NotoSansSC[wght].ttf',
  ko: 'notosanskr/NotoSansKR[wght].ttf',
};

const FONT_CACHE = new URL('.fonts/', import.meta.url);
const cached = name => fileURLToPath(new URL(name, FONT_CACHE));
function download(path) {
  const file = cached(path.split('/')[1].replace(/\[.*\]/, '-VF'));
  if (!existsSync(file)) {
    execFileSync('curl', ['-sfL', '-o', file, `https://github.com/google/fonts/raw/main/ofl/${path.replace('[', '%5B').replace(']', '%5D')}`]);
  }
  return file;
}
// @font-face rules (base64) for one family's 400 and 700 weights.
export function fontFaces(family, spec) {
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
// digitsAnyOrder: compare a number's digits regardless of order — MuPDF runs
// Arabic-Indic numbers through its bidi pass and writes "١٢" as "٢١" although the
// page shows them right; the oracle checks glyph mapping, not reading order.
export const ORACLE_MIN = 0.85;
export function oracleRecall(pdfPath, blocks, { digitsAnyOrder = false } = {}) {
  return Number(execFileSync('python3', ['-c', String.raw`
import sys, json, re, unicodedata, fitz
from collections import Counter
def tok(s):
    s = unicodedata.normalize('NFKC', s).lower().replace('\u200c', ' ')
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn' and c != '\u0640')
    cjk = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff'
    toks = re.findall(rf'[{cjk}]|[^\W\d_{cjk}]+|\d+', s)
    return Counter(''.join(sorted(t)) if sys.argv[2] == '1' and t.isdigit() else t for t in toks)
truth = tok(' '.join(json.load(sys.stdin)))
got = tok(''.join(p.get_text() for p in fitz.open(sys.argv[1])))
print(sum((truth & got).values()) / sum(truth.values()))`, pdfPath, digitsAnyOrder ? '1' : '0'],
  { input: JSON.stringify(blocks.map(b => b.text)) }).toString());
}
