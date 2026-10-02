// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Scores PDF→Markdown / PDF→Word structure against tests/corpus/groundtruth/ — PDFs
// rendered from a known source, so the true headings, paragraphs and reading order
// are exact. Runs the real pipeline in a real browser on the given build: pdf2md
// through js/pdf2mdCore.js with the same pdf.js the site loads (cdnjs 3.11.174);
// pdf2word through the tool page itself — file input, Convert, the downloaded
// .docx's word/document.xml (calling _buildPdf2WordDocxBlob directly returned an
// empty body outside the UI's own setup). Then compares blocks:
//   recall   share of true tokens present (multiset)
//   order    LCS of output vs true token sequence ÷ true length
//   para P   share of consecutive output blocks that really belong to different
//            true blocks (each output block placed by where its words align) —
//            low = paragraphs wrongly split
//   para R   share of true boundaries kept — a boundary is lost when one output
//            block holds a real share of both neighbours — low = paragraphs merged
//   head     true headings found as heading blocks / output headings that aren't true
// Tokens: words (letters/digits runs, NFKC, lower-case); CJK per character.
// `mupdf` column: the share of words MuPDF itself recovers from that PDF (the
// generator rejects documents below 0.85) — recall above it isn't possible.
//   pf       Arabic presentation-form characters (U+FB50–FDFF, U+FE70–FEFE) left in
//            the output: shaped glyph codes instead of letters — they display, but
//            break search, spell-check and screen readers (scored after NFKC above)
//   pdf2word, RTL documents only: share of RTL paragraphs marked w:bidi, and of
//            their runs marked w:rtl and sized for complex script (w:szCs)
//
// Usage: node scripts/corpus-diff/groundtruth.mjs [base-url] [--tool pdf2md|pdf2word] [--json out.json]
//        node scripts/corpus-diff/groundtruth.mjs --from-dir <dir> [--json out.json]
//   --from-dir scores ready-made <document>.docx files (another converter's
//   output for the same ground-truth PDFs) with exactly the same metrics;
//   documents without a .docx there are skipped and counted.
//   base-url defaults to http://localhost:8934 (python3 -m http.server 8934 --directory dist)

import { chromium } from 'playwright';
import JSZip from 'jszip';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRESENTATION_FORM, convertOnToolPage, tokens } from './gtCommon.mjs';

const args = process.argv.slice(2);
const base = (args.find(a => /^https?:/.test(a)) || 'http://localhost:8934').replace(/\/$/, '');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const fromDir = args.includes('--from-dir') ? args[args.indexOf('--from-dir') + 1] : null;
const tool = fromDir ? `docx files in ${fromDir}` : args.includes('--tool') ? args[args.indexOf('--tool') + 1] : 'pdf2md';
if (!fromDir && !['pdf2md', 'pdf2word'].includes(tool)) throw new Error(`unknown --tool ${tool}`);
const DIR = new URL('../../tests/corpus/groundtruth/', import.meta.url);
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';

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

// Flatten blocks into one token stream; blockOf[i] = which block token i came from.
function stream(blocks) {
  const toks = [], blockOf = [], heads = [];
  blocks.forEach((b, k) => {
    const t = tokens(b.text);
    toks.push(...t);
    blockOf.push(...t.map(() => k));
    if (b.type === 'heading' && t.length) heads.push(t);
  });
  return { toks, blockOf, heads };
}

function score(truth, out) {
  const T = stream(truth), O = stream(out);
  const bag = new Map();
  for (const t of O.toks) bag.set(t, (bag.get(t) || 0) + 1);
  let hit = 0;
  for (const t of T.toks) if (bag.get(t) > 0) { hit++; bag.set(t, bag.get(t) - 1); }
  const { map, lcs } = align(O.toks, T.toks);

  // Paragraph boundaries by block membership, so one mis-tokenized word (a lost
  // ZWNJ, a split ligature) can't move a boundary: count[k][j] = tokens of output
  // block k aligned into true block j.
  const count = out.map(() => new Map());
  map.forEach((j, i) => { if (j >= 0) { const m = count[O.blockOf[i]], tb = T.blockOf[j]; m.set(tb, (m.get(tb) || 0) + 1); } });
  const majority = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const placed = count.map(majority).filter(j => j !== undefined);
  // precision: consecutive output blocks belonging to different true blocks
  let pairs = 0, splitOk = 0;
  for (let k = 1; k < placed.length; k++) { pairs++; if (placed[k] !== placed[k - 1]) splitOk++; }
  // recall: a true boundary j|j+1 is lost when one output block holds a real share
  // (≥2 tokens and ≥10%) of both true blocks
  const size = truth.map((_, j) => T.blockOf.filter(b => b === j).length);
  const holds = (m, j) => (m.get(j) || 0) >= Math.max(2, 0.1 * size[j]);
  let merged = 0;
  for (let j = 0; j + 1 < truth.length; j++) if (count.some(m => holds(m, j) && holds(m, j + 1))) merged++;

  const overlap = (a, b) => { const st = new Set(b); return a.filter(x => st.has(x)).length / Math.max(a.length, 1); };
  const found = T.heads.filter(h => O.heads.some(o => overlap(h, o) >= 0.8 && overlap(o, h) >= 0.8)).length;
  const falseHeads = O.heads.filter(o => !T.heads.some(h => overlap(o, h) >= 0.8)).length;
  if (!placed.length) return { recall: 0, order: 0, paraP: 0, paraR: 0, headFound: `0/${T.heads.length}`, falseHeads: 0 };
  return {
    recall: hit / T.toks.length,
    order: lcs / T.toks.length,
    paraP: pairs ? splitOk / pairs : 1,
    paraR: 1 - merged / Math.max(truth.length - 1, 1),
    headFound: `${found}/${T.heads.length}`,
    falseHeads,
  };
}

const RTL_LETTER = /[\u0590-\u05FF\u0600-\u06FF\uFB1D-\uFDFF\uFE70-\uFEFE]/;
const xmlText = x => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// word/document.xml → blocks + RTL markup counts (paragraphs with RTL letters)
async function docxBlocks(b64) {
  const xml = await (await JSZip.loadAsync(Buffer.from(b64, 'base64'))).file('word/document.xml').async('string');
  const blocks = [], rtl = { paras: 0, bidi: 0, runs: 0, rtlRuns: 0, csRuns: 0 };
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    const text = (p.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) || []).map(t => xmlText(t.replace(/<[^>]+>/g, ''))).join('');
    if (!text.trim()) continue;
    blocks.push({ type: /<w:pStyle w:val="(Heading|Title)/.test(p) ? 'heading' : 'para', text });
    if (!RTL_LETTER.test(text)) continue;
    rtl.paras++;
    if (/<w:bidi\/>|<w:bidi w:val="(1|true|on)"\/>/.test(p)) rtl.bidi++;
    for (const r of p.match(/<w:r>[\s\S]*?<\/w:r>|<w:r [\s\S]*?<\/w:r>/g) || []) {
      const t = (r.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/) || [])[1] || '';
      if (!RTL_LETTER.test(t)) continue;
      rtl.runs++;
      if (/<w:rtl\/>|<w:rtl w:val="(1|true|on)"\/>/.test(r)) rtl.rtlRuns++;
      if (/<w:szCs /.test(r)) rtl.csRuns++;
    }
  }
  return { blocks, rtl };
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

// pdf2word: the real tool page (see convertOnToolPage)
const PDF2WORD = { slug: 'pdf-to-word', panel: '#pdf2wordOptions', ready: /Output mode/, mime: /officedocument/ };

const rows = [];
let skipped = 0;
for (const { name, truth } of docs) {
  const pdfPath = new URL(`${name}.pdf`, DIR);
  let out, rtl = null;
  if (fromDir) {
    const file = `${fromDir.replace(/\/$/, '')}/${name}.docx`;
    if (!existsSync(file)) { skipped++; continue; }
    ({ blocks: out, rtl } = await docxBlocks(readFileSync(file).toString('base64')));
  } else if (tool === 'pdf2word') {
    ({ blocks: out, rtl } = await docxBlocks(await convertOnToolPage(browser, base, PDF2WORD, fileURLToPath(pdfPath))));
  } else {
    out = await page.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const { _p2mdExtractText } = await import('/js/pdf2mdCore.js');
      const pdfDoc = await window.pdfjsLib.getDocument({
        isEvalSupported: false, data, useSystemFonts: false, verbosity: 0, disableJavaScript: true,
      }).promise;
      const blocks = await _p2mdExtractText(pdfDoc, { canvasFactory: null });
      return blocks.map(b => ({ type: b.type, text: b.text ?? (b.runs || []).map(r => r.text).join('') }));
    }, readFileSync(pdfPath).toString('base64'));
  }
  const all = out.map(b => b.text).join('');
  const pf = (all.match(PRESENTATION_FORM) || []).length / Math.max((all.match(/\p{L}/gu) || []).length, 1);
  rows.push({ name, lang: truth.lang, layout: truth.layout, mupdf: truth.oracleRecall, pf, rtl, ...score(truth.blocks, out) });
}
await browser.close();

const pct = v => (v * 100).toFixed(0).padStart(4);
console.log(`ground truth — ${tool} on ${base}`);
console.log('document              mupdf recall order paraP paraR  head  falseH    pf  bidi rtlRun szCs');
for (const r of rows) {
  const share = (k, of) => (r.rtl && r.rtl[of] ? `${pct(r.rtl[k] / r.rtl[of])}%` : '    -');
  console.log(`${r.name.padEnd(20)} ${pct(r.mupdf)}% ${pct(r.recall)}% ${pct(r.order)}% ${pct(r.paraP)}% ${pct(r.paraR)}%  ${r.headFound.padStart(4)}  ${String(r.falseHeads).padStart(5)} ${pct(r.pf)}% ${share('bidi', 'paras')} ${share('rtlRuns', 'runs')} ${share('csRuns', 'runs')}`);
}
const mean = (list, k) => list.reduce((s, r) => s + r[k], 0) / list.length;
for (const key of ['lang', 'layout']) {
  console.log(`\nby ${key}:`);
  for (const g of [...new Set(rows.map(r => r[key]))]) {
    const rs = rows.filter(r => r[key] === g);
    console.log(`  ${g.padEnd(8)} recall ${pct(mean(rs, 'recall'))}%  order ${pct(mean(rs, 'order'))}%  paraP ${pct(mean(rs, 'paraP'))}%  paraR ${pct(mean(rs, 'paraR'))}%`);
  }
}
if (skipped) console.log(`\n${skipped} document(s) skipped — no .docx in ${fromDir}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
