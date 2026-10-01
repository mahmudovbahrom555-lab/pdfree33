// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Scores PDF→Markdown structure against tests/corpus/groundtruth/ — PDFs rendered
// from a known source, so the true headings, paragraphs and reading order are
// exact. Runs the real js/pdf2mdCore.js in a real browser on the given build, with
// the same pdf.js the site loads (cdnjs 3.11.174), then compares blocks:
//   recall   share of true tokens present (multiset)
//   order    LCS of output vs true token sequence ÷ true length
//   para P/R paragraph-boundary precision/recall (output breaks mapped onto the
//            true text through the LCS alignment; a break the truth lacks = a
//            paragraph wrongly split, a missing one = two paragraphs merged)
//   head     true headings found as heading blocks / output headings that aren't true
// Tokens: words (letters/digits runs, NFKC, lower-case); CJK per character.
// `mupdf` column: the share of words MuPDF itself recovers from that PDF (the
// generator rejects documents below 0.85) — recall above it isn't possible.
//
// Usage: node scripts/corpus-diff/groundtruth.mjs [base-url] [--json out.json]
//   base-url defaults to http://localhost:8934 (python3 -m http.server 8934 --directory dist)

import { chromium } from 'playwright';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const base = (args.find(a => /^https?:/.test(a)) || 'http://localhost:8934').replace(/\/$/, '');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const DIR = new URL('../../tests/corpus/groundtruth/', import.meta.url);
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';

const CJK = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff';
const TOKEN = new RegExp(`[${CJK}]|[^\\s\\p{P}\\p{S}${CJK}]+`, 'gu');
// Marks (harakat, niqqud) and tatweel ignored — optional diacritics, not words;
// same tokens as the generator's MuPDF oracle check.
const tokens = text => (text.normalize('NFKC').toLowerCase().replace(/\u200c/g, ' ')
  .replace(/[\p{Mn}\u0640]/gu, '').match(TOKEN) || []);

// LCS alignment: map[i] = index in `b` matched to a[i], or -1.
function align(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const map = new Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { map[i] = j; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return { map, lcs: dp[0][0] };
}

// Flatten blocks into one token stream + the token index ending each block.
function stream(blocks) {
  const toks = [], ends = [], heads = [];
  for (const b of blocks) {
    const t = tokens(b.text);
    if (!t.length) continue;
    toks.push(...t);
    ends.push(toks.length - 1);
    if (b.type === 'heading') heads.push(t);
  }
  return { toks, ends, heads };
}

function score(truth, out) {
  const T = stream(truth), O = stream(out);
  const bag = new Map();
  for (const t of O.toks) bag.set(t, (bag.get(t) || 0) + 1);
  let hit = 0;
  for (const t of T.toks) if (bag.get(t) > 0) { hit++; bag.set(t, bag.get(t) - 1); }
  const { map, lcs } = align(O.toks, T.toks);
  // Boundaries in truth coordinates, the document's own end excluded.
  const trueB = new Set(T.ends.slice(0, -1));
  const predB = new Set();
  for (const e of O.ends.slice(0, -1)) {
    let i = e;
    while (i >= 0 && map[i] < 0) i--; // last aligned token of that output block
    if (i >= 0) predB.add(map[i]);
  }
  const both = [...predB].filter(b => trueB.has(b)).length;
  const overlap = (a, b) => { const s = new Set(b); return a.filter(x => s.has(x)).length / Math.max(a.length, 1); };
  const found = T.heads.filter(h => O.heads.some(o => overlap(h, o) >= 0.8 && overlap(o, h) >= 0.8)).length;
  const falseHeads = O.heads.filter(o => !T.heads.some(h => overlap(o, h) >= 0.8)).length;
  return {
    recall: hit / T.toks.length,
    order: lcs / T.toks.length,
    paraP: predB.size ? both / predB.size : 1,
    paraR: trueB.size ? both / trueB.size : 1,
    headFound: `${found}/${T.heads.length}`,
    falseHeads,
  };
}

const docs = readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
  .map(f => ({ name: f.replace(/\.json$/, ''), truth: JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) }));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + '/', { waitUntil: 'load' });
await page.addScriptTag({ url: PDFJS });
await page.evaluate(() => {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('/js/vendor/pdf.worker.min.js', location.origin).toString();
});

const rows = [];
for (const { name, truth } of docs) {
  const bytes = readFileSync(new URL(`${name}.pdf`, DIR)).toString('base64');
  const out = await page.evaluate(async (b64) => {
    const { _p2mdExtractText } = await import('/js/pdf2mdCore.js');
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const pdfDoc = await window.pdfjsLib.getDocument({
      isEvalSupported: false, data, useSystemFonts: false, verbosity: 0, disableJavaScript: true,
    }).promise;
    const blocks = await _p2mdExtractText(pdfDoc, { canvasFactory: null });
    return blocks.map(b => ({ type: b.type, text: b.text ?? (b.runs || []).map(r => r.text).join('') }));
  }, bytes);
  rows.push({ name, lang: truth.lang, layout: truth.layout, mupdf: truth.oracleRecall, ...score(truth.blocks, out) });
}
await browser.close();

const pct = v => (v * 100).toFixed(0).padStart(4);
console.log(`ground truth — pdf2md on ${base}`);
console.log('document              mupdf recall order paraP paraR  head  falseH');
for (const r of rows) {
  console.log(`${r.name.padEnd(20)} ${pct(r.mupdf)}% ${pct(r.recall)}% ${pct(r.order)}% ${pct(r.paraP)}% ${pct(r.paraR)}%  ${r.headFound.padStart(4)}  ${String(r.falseHeads).padStart(5)}`);
}
const mean = (list, k) => list.reduce((s, r) => s + r[k], 0) / list.length;
for (const key of ['lang', 'layout']) {
  console.log(`\nby ${key}:`);
  for (const g of [...new Set(rows.map(r => r[key]))]) {
    const rs = rows.filter(r => r[key] === g);
    console.log(`  ${g.padEnd(8)} recall ${pct(mean(rs, 'recall'))}%  order ${pct(mean(rs, 'order'))}%  paraP ${pct(mean(rs, 'paraP'))}%  paraR ${pct(mean(rs, 'paraR'))}%`);
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
