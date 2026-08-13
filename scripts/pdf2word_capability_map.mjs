#!/usr/bin/env node
// ── scripts/pdf2word_capability_map.mjs ─────────────────────────────────────
// Phase 1 of the PDF→Word semantic-reconstruction TZ (Section 5.1): measures
// how well the SHIPPED pdf2word converter recovers Word structure across 5
// categories, against a real DOCX→PDF→DOCX round trip — not a mock.
//
// Standalone diagnostic script. Not wired into `npm test`/`npm run lint`/
// `scripts/build.py`. Does not touch the production conversion pipeline.
//
// Pipeline:
//   1. Build ~16 synthetic .docx documents with docx.js — each isolates one
//      structural feature (a heading level, a list type, a table shape, a
//      column layout...). The .docx IS the ground truth; no manual labeling.
//   2. Export each to PDF via LibreOffice headless — this is the step that
//      destroys semantic style tags, simulating a real untagged PDF (per the
//      TZ's own validated spike: every named Word style round-trips to
//      "Normal" once flattened through a PDF).
//   3. Drive the real, shipped pdf2word tool via Playwright against a local
//      static server — exercises production code exactly as a user would.
//   4. Score the produced .docx against each case's ground truth.
//   5. Print the TZ's Section 5.1 table with real measured percentages.
//
// Prerequisites (checked at startup, fails fast with instructions if missing):
//   - `npm run build` already run (dist/ must exist)
//   - LibreOffice (`soffice`) on PATH
//   - Playwright installed globally (`npm install -g playwright` +
//     `playwright install chromium`) — deliberately NOT a project
//     devDependency: it's a large, browser-binary-heavy package that would
//     never run in CI (this script isn't wired into npm test), so formalizing
//     it in package.json buys nothing.
//
// Run: node scripts/pdf2word_capability_map.mjs
//
// ── Why dissect() (js/eriAnatomy.js) is only used for the Table category ───
// dissect()'s actual output shape is `Para: {text, inTextbox, inTable,
// hasNumPr, brCount}` / `Tbl: {rows, cols, inTextbox, chars, regular}` — no
// paragraph style name, no numbering.xml resolution beyond "is this a list
// at all", no section/column info. That's enough for Table (rows/cols,
// gridSpan-aware `regular`), but not for heading level, bullet-vs-numbered,
// or columns. Rather than extend eriAnatomy.js — whose header explicitly
// says it's parity-tested against Atlas_DR's Python implementation via
// tests/eriScore.test.js and warns to check that file before changing it —
// this script has its own small, local paragraph walker (extractParagraphs)
// for everything dissect() doesn't cover. The Node-side "run dissect()
// without a browser" trick (stub window/document/DOMParser with
// @xmldom/xmldom) is copied verbatim from tests/eriScore.test.js, which
// already proved it works.
// ─────────────────────────────────────────────────────────────────────────

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, SectionType,
  Table, TableRow, TableCell, WidthType,
} from 'docx';
import { DOMParser as XmldomParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

// ═══════════════════════════════════════════════════════════════════════
//  Prerequisite checks
// ═══════════════════════════════════════════════════════════════════════

function checkPrereqs() {
  const distEntry = path.join(ROOT, 'dist', 'pdf-to-word', 'index.html');
  if (!existsSync(distEntry)) {
    console.error(`✗ ${distEntry} not found. Run "npm run build" first.`);
    process.exit(1);
  }
  try {
    execFileSync('soffice', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('✗ "soffice" (LibreOffice) not found on PATH.');
    process.exit(1);
  }
  let globalRoot;
  try {
    globalRoot = execSync('npm root -g').toString().trim();
  } catch {
    console.error('✗ Could not resolve global npm root.');
    process.exit(1);
  }
  const pwPath = path.join(globalRoot, 'playwright', 'index.mjs');
  if (!existsSync(pwPath)) {
    console.error(`✗ playwright not found at ${pwPath}.\n` +
      '  Install with: npm install -g playwright && playwright install chromium');
    process.exit(1);
  }
  return { pwPath };
}

// ═══════════════════════════════════════════════════════════════════════
//  Corpus — ~16 hand-authored documents, one isolated variable each
// ═══════════════════════════════════════════════════════════════════════

let _markerSeq = 0;
function nextMarker() { return `[P${String(++_markerSeq).padStart(3, '0')}]`; }

const BODY_PT = 11;
const BODY_SIZE = BODY_PT * 2; // docx.js sizes are half-points

function bodyPara(text) {
  return new Paragraph({ children: [new TextRun({ text, size: BODY_SIZE })] });
}
// Ordinary body-text filler so the page's median font size stays anchored at
// BODY_PT regardless of how many heading/list lines share the page — pdf2word
// computes its median from ALL text on the page, not just the case under test.
function filler(n = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(bodyPara(
      `Filler body sentence ${i + 1} of ordinary length, present only so the ` +
      'page median font size stays anchored at normal body size regardless of ' +
      'any nearby heading or list markup under test.'
    ));
  }
  return out;
}
function headingPara(text, sizePt, bold = true) {
  return new Paragraph({ children: [new TextRun({ text, size: sizePt * 2, bold })] });
}

const CASES = [];

// ── Category: headingLevel ──────────────────────────────────────────────
// Thresholds under test (js/processor.js _flushPara): maxFont >= median*2.2
// -> H1, >=1.7 -> H2, >=1.3 -> H3. PDFree has no separate "Title" tier — the
// Title case is included anyway because the TZ's category explicitly asks
// for it; expect it to always miss (Heading1 recovered, not Title) and
// report that as a real, informative finding, not a bug in the tool.
function headingLevelCase(id, label, sizePt, expectStyle) {
  return {
    id, category: 'headingLevel',
    build() {
      const m = nextMarker();
      return {
        children: [headingPara(`${m} ${label}`, sizePt), ...filler(3)],
        groundTruth: [{ type: 'style', marker: m, expect: expectStyle }],
      };
    },
  };
}
CASES.push(headingLevelCase('heading-title', 'Document Title Text', BODY_PT * 3.0, 'Title'));
CASES.push(headingLevelCase('heading-h1', 'Top Level Heading', BODY_PT * 2.3, 'Heading1'));
CASES.push(headingLevelCase('heading-h2', 'Second Level Heading', BODY_PT * 1.8, 'Heading2'));
CASES.push(headingLevelCase('heading-h3', 'Third Level Heading', BODY_PT * 1.5, 'Heading3'));
CASES.push({
  // Same-size-but-bold heading path (_isBoldHeadingLine) — no font-size jump.
  id: 'heading-bold-same-size', category: 'headingLevel',
  build() {
    const m = nextMarker();
    return {
      children: [
        new Paragraph({ children: [new TextRun({ text: `${m} Bold Section Title`, size: BODY_SIZE, bold: true })] }),
        ...filler(3),
      ],
      groundTruth: [{ type: 'style', marker: m, expect: 'Heading2' }],
    };
  },
});

// ── Category: headingBoundary ───────────────────────────────────────────
// TZ's own documented spike finding: a converter glues a heading to its
// immediately-following body paragraph via a <w:br/> inside one <w:p>
// instead of a real paragraph break. "Correct" = the two markers land in
// two DIFFERENT output <w:p> elements.
CASES.push({
  id: 'boundary-heading-then-body', category: 'headingBoundary',
  build() {
    const mHead = nextMarker(), mBody = nextMarker();
    return {
      children: [
        headingPara(`${mHead} Heading Immediately Before Body`, BODY_PT * 1.8),
        bodyPara(`${mBody} Body paragraph that immediately follows the heading above, testing whether the two stay split.`),
        ...filler(2),
      ],
      groundTruth: [{ type: 'boundaryPair', a: mHead, b: mBody }],
    };
  },
});
CASES.push({
  id: 'boundary-bold-heading-then-body', category: 'headingBoundary',
  build() {
    const mHead = nextMarker(), mBody = nextMarker();
    return {
      children: [
        new Paragraph({ children: [new TextRun({ text: `${mHead} Bold Same-Size Section Heading`, size: BODY_SIZE, bold: true })] }),
        bodyPara(`${mBody} Body paragraph right after the bold same-size heading above.`),
        ...filler(2),
      ],
      groundTruth: [{ type: 'boundaryPair', a: mHead, b: mBody }],
    };
  },
});
CASES.push({
  id: 'boundary-heading-then-heading', category: 'headingBoundary',
  build() {
    const mHead1 = nextMarker(), mHead2 = nextMarker();
    return {
      children: [
        headingPara(`${mHead1} First Heading`, BODY_PT * 2.3),
        headingPara(`${mHead2} Second Heading Right After`, BODY_PT * 1.8),
        ...filler(3),
      ],
      groundTruth: [{ type: 'boundaryPair', a: mHead1, b: mHead2 }],
    };
  },
});

// ── Category: listType ──────────────────────────────────────────────────
CASES.push({
  id: 'list-bullet', category: 'listType',
  build() {
    const markers = [nextMarker(), nextMarker(), nextMarker()];
    const mPlain = nextMarker();
    return {
      children: [
        bodyPara('Introductory paragraph before the bullet list below.'),
        ...markers.map((m, i) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: `${m} Bullet item number ${i + 1}`, size: BODY_SIZE })] })),
        bodyPara(`${mPlain} Plain closing paragraph, not part of the list.`),
      ],
      groundTruth: [
        ...markers.map(m => ({ type: 'listType', marker: m, expect: 'bullet' })),
        { type: 'listType', marker: mPlain, expect: 'none' },
      ],
    };
  },
});
CASES.push({
  id: 'list-numbered', category: 'listType',
  build() {
    const markers = [nextMarker(), nextMarker(), nextMarker()];
    const mPlain = nextMarker();
    return {
      children: [
        bodyPara('Introductory paragraph before the numbered list below.'),
        ...markers.map((m, i) => new Paragraph({ numbering: { reference: 'cm-numbered', level: 0 }, children: [new TextRun({ text: `${m} Numbered item ${i + 1}`, size: BODY_SIZE })] })),
        bodyPara(`${mPlain} Plain closing paragraph, not part of the list.`),
      ],
      groundTruth: [
        ...markers.map(m => ({ type: 'listType', marker: m, expect: 'numbered' })),
        { type: 'listType', marker: mPlain, expect: 'none' },
      ],
    };
  },
});
CASES.push({
  id: 'list-mixed', category: 'listType',
  build() {
    const mb1 = nextMarker(), mb2 = nextMarker();
    const mn1 = nextMarker(), mn2 = nextMarker();
    const mPlain = nextMarker();
    return {
      children: [
        new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: `${mb1} First bullet`, size: BODY_SIZE })] }),
        new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: `${mb2} Second bullet`, size: BODY_SIZE })] }),
        new Paragraph({ numbering: { reference: 'cm-numbered', level: 0 }, children: [new TextRun({ text: `${mn1} First numbered item`, size: BODY_SIZE })] }),
        new Paragraph({ numbering: { reference: 'cm-numbered', level: 0 }, children: [new TextRun({ text: `${mn2} Second numbered item`, size: BODY_SIZE })] }),
        bodyPara(`${mPlain} Trailing plain paragraph after the mixed list.`),
      ],
      groundTruth: [
        { type: 'listType', marker: mb1, expect: 'bullet' },
        { type: 'listType', marker: mb2, expect: 'bullet' },
        { type: 'listType', marker: mn1, expect: 'numbered' },
        { type: 'listType', marker: mn2, expect: 'numbered' },
        { type: 'listType', marker: mPlain, expect: 'none' },
      ],
    };
  },
});

// ── Category: table ──────────────────────────────────────────────────────
function cell(text) {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, size: BODY_SIZE })] })] });
}
CASES.push({
  id: 'table-simple', category: 'table',
  build() {
    const rows = [
      ['Name', 'Role', 'Score'],
      ['Alice', 'Engineer', '92'],
      ['Bob', 'Designer', '87'],
    ];
    return {
      children: [
        bodyPara('A simple 3x3 table follows.'),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map(r => new TableRow({ children: r.map(cell) })) }),
        bodyPara('Text after the table.'),
      ],
      groundTruth: [{ type: 'table', expectRows: 3, expectCols: 3 }],
    };
  },
});
CASES.push({
  id: 'table-merged-cell', category: 'table',
  build() {
    return {
      children: [
        bodyPara('A table with one merged header cell follows.'),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [cell('Header'), cell('Q1'), cell('Q2')] }),
            new TableRow({ children: [new TableCell({ columnSpan: 2, children: [new Paragraph({ children: [new TextRun({ text: 'Merged Region', size: BODY_SIZE })] })] }), cell('Note')] }),
            new TableRow({ children: [cell('Row3A'), cell('Row3B'), cell('Row3C')] }),
          ],
        }),
        bodyPara('Text after the merged-cell table.'),
      ],
      groundTruth: [{ type: 'table', expectRows: 3, expectCols: 3 }],
    };
  },
});
CASES.push({
  id: 'table-large', category: 'table',
  build() {
    const header = ['Item', 'Qty', 'Unit', 'Total'];
    const rows = [header];
    for (let i = 1; i <= 7; i++) rows.push([`Item ${i}`, String(i), 'pcs', String(i * 10)]);
    return {
      children: [
        bodyPara('A larger 8x4 table follows.'),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: rows.map(r => new TableRow({ children: r.map(cell) })) }),
        bodyPara('Text after the large table.'),
      ],
      groundTruth: [{ type: 'table', expectRows: 8, expectCols: 4 }],
    };
  },
});

// ── Category: columns ─────────────────────────────────────────────────────
// Word/LibreOffice fill column 1 top-to-bottom before flowing into column 2,
// so listing markers in document order IS the intended reading order —
// "correct" means the OUTPUT preserves that same relative order. PDFree's
// converter has no column-awareness (confirmed in Phase 0: _p2wBuildParagraphs
// walks lines purely by Y-position), so a real column PDF is hypothesized to
// come out row-interleaved instead.
//
// itemsPerCol=22 is not arbitrary: empirically verified (via a throwaway
// pdf.js position dump against a LibreOffice-exported PDF) that ~33pt per
// single-line item at this size/spacing needs ~21-22 items to fill a ~700pt
// usable column height on an A4 page — fewer than that and LibreOffice never
// actually uses the second column at all (everything fits in column 1), which
// silently turns the case into a single-column document that trivially
// "passes" regardless of whether the converter has any column-awareness.
// An earlier version of this corpus used 3-4 items/column and produced a
// false 100% — caught only by manually re-deriving each item's real (x,y)
// from the ground-truth PDF and finding every item at the same X.
function columnsCase(id, colCount, itemsPerCol) {
  return {
    id, category: 'columns',
    build() {
      const markers = [];
      const total = colCount * itemsPerCol;
      for (let i = 0; i < total; i++) markers.push(nextMarker());
      return {
        sectionProperties: { type: SectionType.CONTINUOUS, column: { count: colCount, space: 400 } },
        children: markers.map((m, i) => new Paragraph({ children: [new TextRun({ text: `${m} Column item ${i + 1}`, size: BODY_SIZE })], spacing: { after: 400 } })),
        // col = which column this item was authored into (Word/LibreOffice
        // fill column 0 fully before flowing into column 1, etc.) — the
        // scorer only cares about which column-group an anchor belongs to
        // and whether groups stay contiguous in the output, not exact
        // per-item order within a column (see columnSwitchScore below).
        groundTruth: [{ type: 'order', anchors: markers.map((text, i) => ({ text, col: Math.floor(i / itemsPerCol) })) }],
      };
    },
  };
}
CASES.push(columnsCase('columns-2', 2, 22));
CASES.push(columnsCase('columns-3', 3, 22));

// ── Category: columns, real-world corpus ────────────────────────────────
// tests/fixtures/columns/*.pdf — real, license-verified (CC BY 4.0) arXiv
// papers with confirmed genuine 2-column layouts (see SOURCES.md for
// provenance + how column layout was independently verified, not assumed
// from the arXiv category). These have no synthetic ground-truth docx —
// each one's ground truth is 4 short, hand-picked natural-text anchors from
// page 2 (2 from column 1's start/end, 2 from column 2's start/end),
// verified by reading the actual PDF once. No LibreOffice export needed —
// these already ARE PDFs; `realPdfPath` is used directly.
const REAL_CASES_DIR = path.join(ROOT, 'tests', 'fixtures', 'columns');
function realColumnsCase(id, filename, anchors) {
  return { id, category: 'columns', realPdfPath: path.join(REAL_CASES_DIR, filename), groundTruth: [{ type: 'order', anchors }] };
}
const REAL_CASES = [
  realColumnsCase('real-2608.11433', '2608.11433.pdf', [
    { text: 'HT ’26, September 14', col: 0 },
    { text: 'considerInformation Support', col: 0 },
    { text: 'Shirlene Rose Bandela, Karan Bindal', col: 1 },
    { text: 'Fine-grained Stigma Labeling', col: 1 },
  ]),
  realColumnsCase('real-2608.11441', '2608.11441.pdf', [
    { text: 'demonstrating that linguistic and dataset char', col: 0 },
    { text: 'inspired learning-to-rank framework for donor se', col: 0 },
    { text: 'and analyze it on several nonstandard and minor', col: 1 },
    { text: 'languagefamiliesspokenacrossSub-Saharan', col: 1 },
  ]),
  realColumnsCase('real-2608.11629', '2608.11629.pdf', [
    { text: 'vides a graphical interface for training Kaldi', col: 0 },
    { text: 'pact file sizes (less than 1 GB), we ensure that trained mod', col: 0 },
    { text: 'Screenshot of Easper Desktop Application', col: 1 },
    { text: 'through continuous recording sessions, such as a specific inter', col: 1 },
  ]),
  realColumnsCase('real-2608.11694', '2608.11694.pdf', [
    { text: 'or hurt (Madaan et al., 2023; Khot et al., 2022', col: 0 },
    { text: 'that it only disturbs answers the model was unsure', col: 0 },
    { text: 'validator, and judge models. (4) Open release of', col: 1 },
    { text: 'The shared denominator makes the two directions', col: 1 },
  ]),
  realColumnsCase('real-2608.11947', '2608.11947.pdf', [
    { text: 'the matcher cannot reliably map the free-text an', col: 0 },
    { text: 'tially when the options are reordered, which sug', col: 0 },
    { text: 'gests that multiple-choice evaluation may be mea', col: 1 },
    { text: 'instance of LLM-as-judge evaluation, since the', col: 1 },
  ]),
];

console.log(`Corpus: ${CASES.length} synthetic cases + ${REAL_CASES.length} real-PDF cases.`);

// ═══════════════════════════════════════════════════════════════════════
//  Stage 1 — build ground-truth .docx files
// ═══════════════════════════════════════════════════════════════════════

async function buildGroundTruth(workDir) {
  const built = [];
  for (const c of CASES) {
    const { children, groundTruth, sectionProperties } = c.build();
    const doc = new Document({
      sections: [{
        properties: sectionProperties || {},
        children,
      }],
      numbering: {
        config: [{ reference: 'cm-numbered', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'start' }] }],
      },
    });
    const buf = await Packer.toBuffer(doc);
    const docxPath = path.join(workDir, `${c.id}.docx`);
    writeFileSync(docxPath, buf);
    built.push({ ...c, groundTruth, docxPath, pdfPath: path.join(workDir, `${c.id}.pdf`) });
  }
  return built;
}

// ═══════════════════════════════════════════════════════════════════════
//  Stage 2 — LibreOffice batch PDF export
// ═══════════════════════════════════════════════════════════════════════

function exportToPdf(workDir, cases) {
  console.log('Exporting to PDF via LibreOffice...');
  execFileSync('soffice', [
    '--headless', '--convert-to', 'pdf', '--outdir', workDir,
    ...cases.map(c => c.docxPath),
  ], { stdio: 'pipe' });
  for (const c of cases) {
    if (!existsSync(c.pdfPath)) throw new Error(`PDF export failed for ${c.id}: ${c.pdfPath} missing`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Stage 3 — drive the real site via Playwright, capture produced .docx
// ═══════════════════════════════════════════════════════════════════════

// Chromium's headless download-event handling for blob: URLs triggered via a
// synthetic <a> click (exactly how js/app.js's _handleSuccess auto-downloads
// results, js/app.js:340/373-375) turned out flaky in this environment —
// page.waitForEvent('download') timed out unpredictably even on a file that
// had just succeeded moments earlier, with no correlation to PDF content.
// More reliable: hook URL.createObjectURL in-page (before navigation, via
// addInitScript so it's installed before any site script runs) to capture
// the Blob's bytes directly via FileReader, sidestepping the OS-level
// download mechanism entirely.
const BLOB_HOOK = () => {
  window.__cmapBlobBase64 = null;
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    if (blob instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => { window.__cmapBlobBase64 = reader.result.split(',')[1]; };
      reader.readAsDataURL(blob);
    }
    return origCreate(blob);
  };
};

async function runConversions(cases, workDir, pwPath, port) {
  const { chromium } = await import(pathToFileURL(pwPath).href);
  const { spawn } = await import('child_process');
  const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', path.join(ROOT, 'dist')], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));

  const browser = await chromium.launch();
  // ONE shared context (and its HTTP cache) across all cases. pdf.js and docx
  // are lazy-loaded from external CDNs at runtime (js/lazyLibs.js) — a fresh
  // context per case was discarding that cache and forcing a cold CDN fetch
  // every single time, which is what made every case flaky/slow, not the
  // conversion logic itself (confirmed: 1st case in a shared context pays
  // the CDN cold-start cost, every case after it completes in ~1s).
  const context = await browser.newContext();

  // Warm-up pass: absorb the CDN cold-start once, up front, outside the
  // per-case timing/retry budget below.
  console.log('Warming up CDN cache (pdf.js/docx)...');
  {
    const warmPage = await context.newPage();
    await warmPage.addInitScript(BLOB_HOOK);
    await warmPage.goto(`http://localhost:${port}/pdf-to-word/`, { waitUntil: 'load', timeout: 20000 });
    await warmPage.setInputFiles('#fileInput', cases[0].pdfPath);
    await warmPage.waitForTimeout(400);
    await warmPage.click('#mergeBtn');
    for (let i = 0; i < 150; i++) { // up to 30s, cold-start budget
      const b64 = await warmPage.evaluate(() => window.__cmapBlobBase64).catch(() => null);
      if (b64) break;
      await warmPage.waitForTimeout(200);
    }
    await warmPage.close();
  }

  const MAX_ATTEMPTS = 3;
  try {
    for (const c of cases) {
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const page = await context.newPage();
        try {
          await page.addInitScript(BLOB_HOOK);
          await page.goto(`http://localhost:${port}/pdf-to-word/`, { waitUntil: 'load', timeout: 20000 });
          await page.setInputFiles('#fileInput', c.pdfPath);
          await page.waitForTimeout(400);
          await page.click('#mergeBtn');

          let b64 = null;
          for (let i = 0; i < 150; i++) { // up to 30s
            b64 = await page.evaluate(() => window.__cmapBlobBase64);
            if (b64) break;
            await page.waitForTimeout(200);
          }
          if (!b64) throw new Error('no blob captured within 30s (conversion did not complete)');

          const producedPath = path.join(workDir, `${c.id}.produced.docx`);
          writeFileSync(producedPath, Buffer.from(b64, 'base64'));
          c.producedPath = producedPath;
          console.log(`  ✓ ${c.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          console.log(`  … ${c.id} attempt ${attempt}/${MAX_ATTEMPTS} failed — ${e.message.split('\n')[0]}`);
        } finally {
          await page.close();
        }
      }
      if (lastErr) {
        console.log(`  ✗ ${c.id} — gave up after ${MAX_ATTEMPTS} attempts`);
        c.error = lastErr.message;
      }
    }
  } finally {
    await context.close();
    await browser.close();
    server.kill();
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Stage 4 — scoring
// ═══════════════════════════════════════════════════════════════════════

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MARKER_RE = /\[P\d{3}\]/;

function childEl(el, localName) {
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 1 && c.namespaceURI === W_NS && c.localName === localName) return c;
  }
  return null;
}
function childEls(el, localName) {
  const out = [];
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 1 && c.namespaceURI === W_NS && c.localName === localName) out.push(c);
  }
  return out;
}
function parseXml(xmlText) {
  return new XmldomParser().parseFromString(xmlText, 'application/xml');
}
async function readZipEntry(buffer, filePath) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(filePath);
  return entry ? entry.async('string') : null;
}

// One entry per [Pxxx] marker found, in document order: {marker, text, style,
// numId, brCount, paraIndex}. A single output <w:p> can legitimately contain
// MULTIPLE markers — e.g. two source lines the converter merged into one
// paragraph, exactly the "boundary" failure this tool measures — so this
// must not stop at the first match per paragraph (an earlier version used
// String.match() without /g and silently dropped every marker after the
// first in any merged paragraph, corrupting the columns/order category's
// marker sequence and any category relying on complete marker coverage).
function extractParagraphs(documentXmlText) {
  const doc = parseXml(documentXmlText);
  const ps = doc.getElementsByTagNameNS(W_NS, 'p');
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    let text = '';
    const ts = p.getElementsByTagNameNS(W_NS, 't');
    for (let j = 0; j < ts.length; j++) text += ts[j].textContent || '';
    const matches = text.match(new RegExp(MARKER_RE, 'g'));
    if (!matches) continue;
    const pPr = childEl(p, 'pPr');
    const styleEl = pPr && childEl(pPr, 'pStyle');
    const style = styleEl ? styleEl.getAttributeNS(W_NS, 'val') : null;
    const numPr = pPr && childEl(pPr, 'numPr');
    const numIdEl = numPr && childEl(numPr, 'numId');
    const numId = numIdEl ? numIdEl.getAttributeNS(W_NS, 'val') : null;
    const brCount = p.getElementsByTagNameNS(W_NS, 'br').length;
    for (const marker of matches) {
      out.push({ marker, text, style, numId, brCount, paraIndex: i, mergedWithOthers: matches.length > 1 });
    }
  }
  return out;
}

// numId -> 'bullet' | 'numbered' | null, via numId -> abstractNumId -> numFmt.
function resolveNumFmt(numberingXmlText, numId) {
  if (!numberingXmlText || !numId) return null;
  const doc = parseXml(numberingXmlText);
  const nums = doc.getElementsByTagNameNS(W_NS, 'num');
  let abstractId = null;
  for (let i = 0; i < nums.length; i++) {
    if (nums[i].getAttributeNS(W_NS, 'numId') === numId) {
      const a = childEl(nums[i], 'abstractNumId');
      abstractId = a ? a.getAttributeNS(W_NS, 'val') : null;
      break;
    }
  }
  if (abstractId == null) return null;
  const abstractNums = doc.getElementsByTagNameNS(W_NS, 'abstractNum');
  for (let i = 0; i < abstractNums.length; i++) {
    if (abstractNums[i].getAttributeNS(W_NS, 'abstractNumId') === abstractId) {
      const lvls = childEls(abstractNums[i], 'lvl');
      const lvl0 = lvls.find(l => l.getAttributeNS(W_NS, 'ilvl') === '0') || lvls[0];
      const fmtEl = lvl0 && childEl(lvl0, 'numFmt');
      const fmt = fmtEl ? fmtEl.getAttributeNS(W_NS, 'val') : null;
      if (!fmt) return null;
      return fmt === 'bullet' ? 'bullet' : 'numbered';
    }
  }
  return null;
}

// The whole document's text, in document order, as ONE concatenated string
// — unlike extractParagraphs() this is NOT filtered to [Pxxx]-marker
// paragraphs (anchors, for the real-PDF corpus, are natural text
// substrings, not a fixed marker pattern) and NOT split per-paragraph.
// Position must be resolved at the CHARACTER level, not the paragraph
// level: found via a real spot-check where PDFree glued an entire page's
// text (both columns) into ONE giant output paragraph — every anchor
// technically had the same "paragraph index", which made an earlier
// per-paragraph version of this function score it a false 100% (ties broke
// in whatever order the anchors array happened to be authored in, not the
// real interleaving inside that merged blob). A flat string with `indexOf`
// exposes the real character-level order regardless of paragraph
// boundaries.
function extractFullText(documentXmlText) {
  const doc = parseXml(documentXmlText);
  const ps = doc.getElementsByTagNameNS(W_NS, 'p');
  let text = '';
  for (let i = 0; i < ps.length; i++) {
    const ts = ps[i].getElementsByTagNameNS(W_NS, 't');
    for (let j = 0; j < ts.length; j++) text += ts[j].textContent || '';
    text += '\n';
  }
  return text;
}

// Replaces an earlier pairwise Kendall-tau-style metric that stayed
// misleadingly high (~73-88%) under a clearly-wrong round-robin column
// interleave — round-robin interleaving of N already-sorted streams keeps
// every WITHIN-stream pair "correctly ordered", which pairwise concordance
// rewards even though a human opening the document sees obvious garbage.
// This instead counts how many times the actual output sequence switches
// which column-group an item came from, compared against the minimum
// possible (colCount - 1, i.e. finish column 0 entirely, then column 1,
// etc.) — a direct, legible measure of "how interleaved does this look".
// Whitespace-insensitive substring match: pdf.js's raw text extraction and
// PDFree's own gap-based space-insertion heuristic (js/processor.js) can
// each legitimately add or omit a space at a word boundary — found via a
// real spot-check where an anchor copied verbatim from the SOURCE PDF's
// extraction ("...considerInformation Support...", no space) correctly
// became "...consider Information Support..." in PDFree's OUTPUT once its
// own space-insertion ran. That's PDFree behaving correctly, not a bug —
// comparing with whitespace stripped from both sides avoids the scorer
// being fooled by incidental spacing differences that have nothing to do
// with reading order.
const _stripWs = (s) => s.replace(/\s+/g, '');
function columnSwitchScore(anchors, fullText) {
  const normFullText = _stripWs(fullText);
  const found = [];
  for (const a of anchors) {
    const idx = normFullText.indexOf(_stripWs(a.text));
    if (idx !== -1) found.push({ ...a, pos: idx });
  }
  found.sort((a, b) => a.pos - b.pos);
  let switches = 0;
  for (let i = 1; i < found.length; i++) {
    if (found[i].col !== found[i - 1].col) switches++;
  }
  const distinctCols = new Set(anchors.map(a => a.col)).size;
  const idealMin = Math.max(0, distinctCols - 1);
  const denominator = Math.max(switches, idealMin, 1);
  const score = found.length === anchors.length ? idealMin / denominator : 0;
  return { switches, idealMin, foundCount: found.length, totalCount: anchors.length, score, order: found.map(f => f.text) };
}

async function scoreCase(c, categoryTallies, dissect) {
  if (c.error) {
    for (const g of c.groundTruth) {
      const cat = g.type === 'style' ? 'headingLevel' : g.type === 'listType' ? 'listType'
        : g.type === 'boundaryPair' ? 'headingBoundary' : g.type === 'table' ? 'table' : 'columns';
      categoryTallies[cat].total++;
      categoryTallies[cat].misses.push(`${c.id}: conversion failed — ${c.error.split('\n')[0]}`);
    }
    return;
  }
  const buffer = readFileSync(c.producedPath);
  const documentXml = await readZipEntry(buffer, 'word/document.xml');
  const numberingXml = await readZipEntry(buffer, 'word/numbering.xml');
  const paras = extractParagraphs(documentXml);
  const byMarker = new Map(paras.map(p => [p.marker, p]));

  for (const g of c.groundTruth) {
    if (g.type === 'style') {
      const t = categoryTallies.headingLevel;
      t.total++;
      const found = byMarker.get(g.marker);
      if (found && found.style === g.expect) t.correct++;
      else t.misses.push(`${c.id} ${g.marker}: expected style ${g.expect}, got ${found ? (found.style || 'none') : 'MARKER NOT FOUND'}`);
    } else if (g.type === 'listType') {
      const t = categoryTallies.listType;
      t.total++;
      const found = byMarker.get(g.marker);
      let actual = 'none';
      if (found && found.numId) actual = resolveNumFmt(numberingXml, found.numId) || 'unknown';
      if (actual === g.expect) t.correct++;
      else t.misses.push(`${c.id} ${g.marker}: expected ${g.expect}, got ${found ? actual : 'MARKER NOT FOUND'}`);
    } else if (g.type === 'boundaryPair') {
      const t = categoryTallies.headingBoundary;
      t.total++;
      const pa = byMarker.get(g.a), pb = byMarker.get(g.b);
      if (pa && pb && pa.paraIndex !== pb.paraIndex) t.correct++;
      else t.misses.push(`${c.id}: ${g.a} and ${g.b} ${(!pa || !pb) ? 'MARKER(S) NOT FOUND' : 'glued into the same output paragraph'}`);
    } else if (g.type === 'table') {
      const t = categoryTallies.table;
      t.total++;
      const anatomy = await dissect(buffer);
      const tbl = anatomy.tables[0];
      if (tbl && tbl.rows === g.expectRows && tbl.cols === g.expectCols) t.correct++;
      else t.misses.push(`${c.id}: expected ${g.expectRows}x${g.expectCols} table, got ${tbl ? `${tbl.rows}x${tbl.cols}` : (anatomy.tables.length ? `${anatomy.tables.length} tables, first mismatched` : 'NO TABLE (flattened to paragraphs)')}`);
    } else if (g.type === 'order') {
      // Each case counts as one unit (not one per anchor/pair) — the
      // column-switch score is already a single 0-1 judgment of "how
      // interleaved does this whole case look", not a per-item tally.
      const t = categoryTallies.columns;
      t.total += 1;
      const r = columnSwitchScore(g.anchors, extractFullText(documentXml));
      t.correct += r.score;
      if (r.score < 1) {
        t.misses.push(`${c.id}: found ${r.foundCount}/${r.totalCount} anchors, ${r.switches} column switches ` +
          `(ideal ${r.idealMin}) — actual order: ${r.order.join(' | ')}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Stage 5 — report
// ═══════════════════════════════════════════════════════════════════════

function printReport(categoryTallies) {
  const labels = {
    headingBoundary: 'Paragraph/heading boundary',
    headingLevel:    'Heading level',
    listType:        'List type',
    table:           'Table structure',
    columns:         'Columns',
  };
  console.log('\n' + '═'.repeat(60));
  console.log('Capability map — TZ Section 5.1');
  console.log('═'.repeat(60));
  for (const key of ['headingBoundary', 'headingLevel', 'listType', 'table', 'columns']) {
    const t = categoryTallies[key];
    const pct = t.total > 0 ? ((t.correct / t.total) * 100).toFixed(1) : 'N/A';
    console.log(`${labels[key].padEnd(28)} ${pct}%  (${t.correct}/${t.total})`);
  }
  console.log('═'.repeat(60));
  for (const key of ['headingBoundary', 'headingLevel', 'listType', 'table', 'columns']) {
    const t = categoryTallies[key];
    if (!t.misses.length) continue;
    console.log(`\n${labels[key]} — misses:`);
    for (const m of t.misses) console.log(`  ✗ ${m}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const { pwPath } = checkPrereqs();

  // Node-side dissect() — same stub pattern as tests/eriScore.test.js.
  global.window = { JSZip };
  global.document = { createElement: () => ({}), head: { appendChild: () => {} } };
  global.DOMParser = XmldomParser;
  const { dissect } = await import('../js/eriAnatomy.js');

  const workDir = mkdtempSync(path.join(tmpdir(), 'pdf2word-capmap-'));
  console.log(`Work dir: ${workDir}`);

  const syntheticCases = await buildGroundTruth(workDir);
  exportToPdf(workDir, syntheticCases);

  // Real-PDF cases need no ground-truth generation or LibreOffice export —
  // they already ARE the PDF, referenced directly from tests/fixtures/columns/.
  for (const rc of REAL_CASES) {
    if (!existsSync(rc.realPdfPath)) {
      console.error(`✗ ${rc.realPdfPath} not found — see tests/fixtures/columns/SOURCES.md`);
      process.exit(1);
    }
  }
  const realCases = REAL_CASES.map(rc => ({ ...rc, pdfPath: rc.realPdfPath }));

  const cases = [...syntheticCases, ...realCases];
  await runConversions(cases, workDir, pwPath, 8973);

  const categoryTallies = {
    headingBoundary: { correct: 0, total: 0, misses: [] },
    headingLevel:    { correct: 0, total: 0, misses: [] },
    listType:        { correct: 0, total: 0, misses: [] },
    table:           { correct: 0, total: 0, misses: [] },
    columns:         { correct: 0, total: 0, misses: [] },
  };
  for (const c of cases) await scoreCase(c, categoryTallies, dissect);

  printReport(categoryTallies);
  console.log(`\nGround-truth/produced files kept at: ${workDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
