#!/usr/bin/env node
// ── scripts/pdf2md_capability_map.mjs ───────────────────────────────────────
// pdf2md's equivalent of scripts/pdf2word_capability_map.mjs — real, measured
// percentages instead of code-reading claims, for the priority-4 item in the
// pdf2md analysis (see memory: pdf2md_tool_analysis.md).
//
// Simpler pipeline than pdf2word's, for one structural reason: pdf2md's
// INPUT is already a PDF, so ground truth is built directly with pdf-lib —
// no docx.js → LibreOffice PDF-export round trip needed (that round trip
// exists in pdf2word's script specifically to destroy DOCX style tags and
// simulate an untagged real-world PDF; here there's nothing to destroy,
// pdf-lib output already IS an untagged PDF). Scoring is also simpler: the
// output is plain Markdown text, not a DOCX's zipped XML — no zip/XML
// parsing, just marker-based substring/line checks against the flat string.
//
// Pipeline:
//   1. Build ~10 synthetic ground-truth PDFs directly with pdf-lib — each
//      isolates one structural feature (a heading level, a list type, a
//      table, a bold run...). Markers ([P001] etc, embedded in the drawn
//      text) are the ground truth; no manual labeling.
//   2. Drive the real, shipped pdf2md tool via Playwright against a local
//      static server — exercises production code exactly as a user would.
//   3. Score the produced .md text against each case's expected marker
//      position/formatting.
//   4. Also scores the same 5 real, license-verified 2-column arXiv papers
//      pdf2word's own capability map uses (tests/fixtures/columns/), with
//      the identical anchors — same underlying column-detection code
//      (pdf2wordColumns.js), reused as-is since priority 2 ported it in.
//   5. Print a report table with real measured percentages.
//
// Standalone diagnostic script. Not wired into `npm test`/`npm run lint`/
// `scripts/build.py`. Does not touch the production conversion pipeline.
//
// Prerequisites (checked at startup, fails fast with instructions if missing):
//   - `npm run build` already run (dist/ must exist)
//   - Playwright installed globally (`npm install -g playwright` +
//     `playwright install chromium`) — deliberately NOT a project
//     devDependency, same reasoning as pdf2word_capability_map.mjs.
//
// Run: node scripts/pdf2md_capability_map.mjs
// ─────────────────────────────────────────────────────────────────────────

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(import.meta.dirname, '..');

// ═══════════════════════════════════════════════════════════════════════
//  Prerequisite checks
// ═══════════════════════════════════════════════════════════════════════

function checkPrereqs() {
  const distEntry = path.join(ROOT, 'dist', 'pdf-to-markdown', 'index.html');
  if (!existsSync(distEntry)) {
    console.error(`✗ ${distEntry} not found. Run "npm run build" first.`);
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
//  Corpus — synthetic cases (built directly as PDFs) + real-PDF cases
// ═══════════════════════════════════════════════════════════════════════

let _markerSeq = 0;
function nextMarker() { return `[P${String(++_markerSeq).padStart(3, '0')}]`; }

const BODY_SIZE = 11;

function addFiller(page, font, n, startY) {
  let y = startY;
  for (let i = 0; i < n; i++) {
    page.drawText(
      `Filler body sentence ${i + 1} of ordinary length, present only so the page median font size stays anchored at normal body size.`,
      { x: 50, y, size: BODY_SIZE, font, color: rgb(0, 0, 0) }
    );
    y -= 20;
  }
  return y;
}

const CASES = [];

// ── Category: headingLevel ──────────────────────────────────────────────
// Thresholds under test (js/processor.js _p2mdExtractText): maxFont >=
// median*2.2 -> H1, >=1.7 -> H2, >=1.3 -> H3, else stays a paragraph.
function headingCase(id, sizeMultiplier, expectLevel) {
  return {
    id, category: 'headingLevel', expectLevel,
    async build(doc, font) {
      const marker = nextMarker();
      const page = doc.addPage([612, 792]);
      page.drawText(`${marker} Heading text for ${id}`, { x: 50, y: 700, size: BODY_SIZE * sizeMultiplier, font, color: rgb(0, 0, 0) });
      addFiller(page, font, 8, 660);
      return { marker };
    },
  };
}
CASES.push(headingCase('heading-h1', 2.3, 1));
CASES.push(headingCase('heading-h2', 1.8, 2));
CASES.push(headingCase('heading-h3', 1.5, 3));
CASES.push(headingCase('heading-below-threshold', 1.15, 0)); // 0 = must NOT become a heading

// ── Category: listType ───────────────────────────────────────────────────
function listCase(id, lineText, expectType) {
  return {
    id, category: 'listType', expectType,
    async build(doc, font) {
      const marker = nextMarker();
      const page = doc.addPage([612, 792]);
      page.drawText(`${lineText(marker)}`, { x: 50, y: 700, size: BODY_SIZE, font, color: rgb(0, 0, 0) });
      addFiller(page, font, 6, 660);
      return { marker };
    },
  };
}
CASES.push(listCase('list-bullet', m => `• Bulleted item ${m}`, 'bullet'));
CASES.push(listCase('list-numbered', m => `1. Numbered item ${m}`, 'numbered'));
// Decimal-number guard: NUMBERED_RE's (?!\d) lookahead must keep this prose,
// not a list — same real fix already pinned at tests/pdf2wordLists.test.js.
CASES.push(listCase('list-decimal-guard', m => `3.14 is an approximation of pi ${m}.`, 'none'));

// ── Category: table ────────────────────────────────────────────────────
CASES.push({
  id: 'table-simple', category: 'table', expectRows: 4, expectCols: 3,
  async build(doc, font) {
    const marker = nextMarker();
    const page = doc.addPage([612, 792]);
    const rows = [['Name', 'Role', 'Score'], [`Alice${marker}`, 'Engineer', '92'], ['Bob', 'Designer', '87'], ['Carol', 'Analyst', '81']];
    rows.forEach((row, r) => {
      const y = 700 - r * 20;
      page.drawText(row[0], { x: 50, y, size: BODY_SIZE, font, color: rgb(0, 0, 0) });
      page.drawText(row[1], { x: 220, y, size: BODY_SIZE, font, color: rgb(0, 0, 0) });
      page.drawText(row[2], { x: 390, y, size: BODY_SIZE, font, color: rgb(0, 0, 0) });
    });
    page.drawText('Text before the table.', { x: 50, y: 730, size: BODY_SIZE, font, color: rgb(0, 0, 0) });
    return { marker };
  },
});

// ── Category: boldRun (priority-3 fix) ───────────────────────────────────
CASES.push({
  id: 'bold-mid-paragraph', category: 'boldRun', expectBold: true,
  async build(doc, font, fontBold) {
    const marker = nextMarker();
    const page = doc.addPage([612, 792]);
    page.drawText('Plain text before the ', { x: 50, y: 700, size: BODY_SIZE, font, color: rgb(0, 0, 0) });
    page.drawText(`important${marker}phrase`, { x: 210, y: 700, size: BODY_SIZE, font: fontBold, color: rgb(0, 0, 0) });
    page.drawText(' and plain text after.', { x: 340, y: 700, size: BODY_SIZE, font, color: rgb(0, 0, 0) });
    addFiller(page, font, 6, 660);
    return { marker, needle: `important${marker}phrase` };
  },
});
// Same-size-but-bold line, followed by a paragraph: previously a documented
// gap (pdf2md had no bold-implies-heading path, unlike pdf2word's
// _isBoldHeadingLine) — now ported in, so this must be promoted to a real
// heading. Mixed-case marker text -> H2 (the ALL-CAPS-only path stays H1).
CASES.push({
  id: 'bold-same-size-heading-fallback', category: 'headingLevel', expectLevel: 2,
  async build(doc, font, fontBold) {
    const marker = nextMarker();
    const page = doc.addPage([612, 792]);
    page.drawText(`BoldSameSize${marker}Lookalike`, { x: 50, y: 700, size: BODY_SIZE, font: fontBold, color: rgb(0, 0, 0) });
    addFiller(page, font, 6, 660);
    return { marker };
  },
});

// The fallback's own guard: a same-size all-bold line with NOTHING after it
// (page ends right there) must NOT be promoted — real production coverage
// for the same guard tests/pdf2md.test.js already pins at the unit level.
CASES.push({
  id: 'bold-trailing-line-not-promoted', category: 'boldRun', expectBold: true, expectNotHeading: true,
  async build(doc, font, fontBold) {
    const marker = nextMarker();
    const page = doc.addPage([612, 792]);
    addFiller(page, font, 6, 700);
    page.drawText(`TrailingBold${marker}Signature`, { x: 50, y: 700 - 6 * 20, size: BODY_SIZE, font: fontBold, color: rgb(0, 0, 0) });
    return { marker, needle: `TrailingBold${marker}Signature` };
  },
});

// ── Category: columns — real-world corpus, reused from pdf2word's script ──
// Identical PDFs and anchors as scripts/pdf2word_capability_map.mjs — same
// underlying detection code (js/pdf2wordColumns.js), ported into pdf2md by
// the priority-2 fix, so the same real papers/anchors are the right measure.
const REAL_CASES_DIR = path.join(ROOT, 'tests', 'fixtures', 'columns');
const REAL_CASES = [
  { id: 'real-2608.11433', file: '2608.11433.pdf', anchors: [
    { text: 'HT ’26, September 14', col: 0 },
    { text: 'considerInformation Support', col: 0 },
    { text: 'Shirlene Rose Bandela, Karan Bindal', col: 1 },
    { text: 'Fine-grained Stigma Labeling', col: 1 },
  ]},
  { id: 'real-2608.11441', file: '2608.11441.pdf', anchors: [
    { text: 'demonstrating that linguistic and dataset char', col: 0 },
    { text: 'inspired learning-to-rank framework for donor se', col: 0 },
    { text: 'and analyze it on several nonstandard and minor', col: 1 },
    { text: 'languagefamiliesspokenacrossSub-Saharan', col: 1 },
  ]},
  { id: 'real-2608.11629', file: '2608.11629.pdf', anchors: [
    { text: 'vides a graphical interface for training Kaldi', col: 0 },
    { text: 'pact file sizes (less than 1 GB), we ensure that trained mod', col: 0 },
    { text: 'Screenshot of Easper Desktop Application', col: 1 },
    { text: 'through continuous recording sessions, such as a specific inter', col: 1 },
  ]},
  { id: 'real-2608.11694', file: '2608.11694.pdf', anchors: [
    { text: 'or hurt (Madaan et al., 2023; Khot et al., 2022', col: 0 },
    { text: 'that it only disturbs answers the model was unsure', col: 0 },
    { text: 'validator, and judge models. (4) Open release of', col: 1 },
    { text: 'The shared denominator makes the two directions', col: 1 },
  ]},
  { id: 'real-2608.11947', file: '2608.11947.pdf', anchors: [
    { text: 'the matcher cannot reliably map the free-text an', col: 0 },
    { text: 'tially when the options are reordered, which sug', col: 0 },
    { text: 'gests that multiple-choice evaluation may be mea', col: 1 },
    { text: 'instance of LLM-as-judge evaluation, since the', col: 1 },
  ]},
];

console.log(`Corpus: ${CASES.length} synthetic cases + ${REAL_CASES.length} real-PDF column cases.`);

// ═══════════════════════════════════════════════════════════════════════
//  Stage 1 — build ground-truth PDFs directly (no LibreOffice needed)
// ═══════════════════════════════════════════════════════════════════════

async function buildGroundTruth(workDir) {
  const built = [];
  for (const c of CASES) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const meta = await c.build(doc, font, fontBold);
    const bytes = await doc.save();
    const pdfPath = path.join(workDir, `${c.id}.pdf`);
    writeFileSync(pdfPath, bytes);
    built.push({ ...c, ...meta, pdfPath });
  }
  return built;
}

// ═══════════════════════════════════════════════════════════════════════
//  Stage 2 — drive the real site via Playwright, capture the produced .md
// ═══════════════════════════════════════════════════════════════════════

// pdf2md's Blob is plain text/markdown UNLESS the source PDF has extractable
// images, in which case it's a real .zip (document.md + images/*.png, see
// commit 8a5aa43) — reading every blob as text (the original approach here)
// silently corrupts scoring for any such case: a zip's binary bytes decoded
// as UTF-8 text balloon into hundreds of KB of garbage that no anchor/marker
// search will ever match, discovered directly when this script started
// reporting 0/4 anchors found on real papers that used to score fine.
// Capture as base64 + the real filename (via the download click, same
// createObjectURL hook technique pdf2word_capability_map.mjs already proved
// reliable) so a .zip can be unzipped for real instead of misread as text.
const BLOB_HOOK = () => {
  window.__cmapB64 = null;
  window.__cmapFilename = null;
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    if (blob instanceof Blob) {
      blob.arrayBuffer().then(buf => {
        let binary = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        window.__cmapB64 = btoa(binary);
      });
    }
    return origCreate(blob);
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    if (this.download) window.__cmapFilename = this.download;
    return origClick.apply(this, args);
  };
};

// Extracts document.md's real text whether the capture was a plain .md
// (base64 of the text itself) or a .zip (unzipped for real — `unzip` used
// directly rather than adding a JSZip Node dependency to this script).
function extractMarkdownText(base64, filename, workDir) {
  const buf = Buffer.from(base64, 'base64');
  if (!filename || !filename.endsWith('.zip')) return buf.toString('utf8');
  const zipWork = mkdtempSync(path.join(workDir, 'zip-'));
  const zipPath = path.join(zipWork, 'out.zip');
  writeFileSync(zipPath, buf);
  execSync(`unzip -o -q ${JSON.stringify(zipPath)} -d ${JSON.stringify(zipWork)}`);
  return readFileSync(path.join(zipWork, 'document.md'), 'utf8');
}

async function runConversions(cases, workDir, pwPath, port) {
  const { chromium } = await import(pathToFileURL(pwPath).href);
  const { spawn } = await import('child_process');
  const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', path.join(ROOT, 'dist')], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));

  const browser = await chromium.launch();
  const context = await browser.newContext();

  console.log('Warming up CDN cache (pdf.js)...');
  {
    const warmPage = await context.newPage();
    await warmPage.addInitScript(BLOB_HOOK);
    await warmPage.goto(`http://localhost:${port}/pdf-to-markdown/`, { waitUntil: 'load', timeout: 20000 });
    await warmPage.setInputFiles('#fileInput', cases[0].pdfPath);
    await warmPage.waitForTimeout(400);
    await warmPage.click('#mergeBtn');
    for (let i = 0; i < 150; i++) {
      const t = await warmPage.evaluate(() => window.__cmapB64).catch(() => null);
      if (t) break;
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
          await page.goto(`http://localhost:${port}/pdf-to-markdown/`, { waitUntil: 'load', timeout: 20000 });
          await page.setInputFiles('#fileInput', c.pdfPath);
          await page.waitForTimeout(400);
          await page.click('#mergeBtn');

          let b64 = null;
          for (let i = 0; i < 150; i++) {
            b64 = await page.evaluate(() => window.__cmapB64);
            if (b64) break;
            await page.waitForTimeout(200);
          }
          if (!b64) throw new Error('no blob captured within 30s (conversion did not complete)');
          const filename = await page.evaluate(() => window.__cmapFilename);

          c.producedText = extractMarkdownText(b64, filename, workDir);
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
//  Stage 3 — scoring (plain-text marker search, no zip/XML parsing needed)
// ═══════════════════════════════════════════════════════════════════════

// Same metric as pdf2word_capability_map.mjs's columnSwitchScore — counts
// how many times the actual output sequence switches which column-group an
// anchor came from, vs. the minimum possible. Whitespace-insensitive
// substring match for the same reason documented there: pdf.js extraction
// and PDFree's own gap-based space-insertion can each legitimately add/omit
// a space at a word boundary.
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
  for (let i = 1; i < found.length; i++) if (found[i].col !== found[i - 1].col) switches++;
  const distinctCols = new Set(anchors.map(a => a.col)).size;
  const idealMin = Math.max(0, distinctCols - 1);
  const denominator = Math.max(switches, idealMin, 1);
  const score = found.length === anchors.length ? idealMin / denominator : 0;
  return { switches, idealMin, foundCount: found.length, totalCount: anchors.length, score, order: found.map(f => f.text) };
}

function lineWithMarker(md, marker) {
  return md.split('\n').find(l => l.includes(marker));
}

function scoreCase(c, categoryTallies) {
  if (c.error) {
    categoryTallies[c.category].total++;
    categoryTallies[c.category].misses.push(`${c.id}: conversion failed — ${c.error.split('\n')[0]}`);
    return;
  }
  const md = c.producedText;

  if (c.category === 'headingLevel') {
    const t = categoryTallies.headingLevel;
    t.total++;
    const line = lineWithMarker(md, c.marker);
    const m = line && line.match(/^(#{1,6})\s/);
    const actualLevel = m ? m[1].length : 0;
    if (actualLevel === c.expectLevel) t.correct++;
    else t.misses.push(`${c.id}: expected level ${c.expectLevel || '(paragraph, no heading)'}, got ${actualLevel || '(paragraph, no heading)'}${line ? ` — line: "${line.slice(0, 70)}"` : ' — MARKER NOT FOUND'}`);

  } else if (c.category === 'listType') {
    const t = categoryTallies.listType;
    t.total++;
    const line = lineWithMarker(md, c.marker);
    let actual = 'none';
    if (line && /^-\s/.test(line)) actual = 'bullet';
    else if (line && /^\d+\.\s/.test(line)) actual = 'numbered';
    if (actual === c.expectType) t.correct++;
    else t.misses.push(`${c.id}: expected ${c.expectType}, got ${line ? actual : 'MARKER NOT FOUND'}`);

  } else if (c.category === 'table') {
    const t = categoryTallies.table;
    t.total++;
    const lines = md.split('\n');
    const idx = lines.findIndex(l => l.includes(c.marker));
    if (idx === -1 || !lines[idx].trim().startsWith('|')) {
      t.misses.push(`${c.id}: MARKER NOT FOUND in a table row (got: ${idx === -1 ? 'not found at all' : `"${lines[idx].slice(0, 60)}"`})`);
    } else {
      let start = idx, end = idx;
      while (start > 0 && lines[start - 1].trim().startsWith('|')) start--;
      while (end < lines.length - 1 && lines[end + 1].trim().startsWith('|')) end++;
      const tableLines = lines.slice(start, end + 1).filter(l => l.trim());
      const rowCount = tableLines.length - 1; // minus the "| --- |" separator row
      const colCount = (tableLines[0].match(/\|/g) || []).length - 1;
      if (rowCount === c.expectRows && colCount === c.expectCols) t.correct++;
      else t.misses.push(`${c.id}: expected ${c.expectRows}x${c.expectCols} table, got ${rowCount}x${colCount}`);
    }

  } else if (c.category === 'boldRun') {
    const t = categoryTallies.boldRun;
    t.total++;
    const wantsBold = `**${c.needle}**`;
    const isBold = md.includes(wantsBold);
    const notPromotedOk = c.expectNotHeading ? !new RegExp(`^#+\\s.*${c.needle.replace(/[[\]]/g, '\\$&')}`, 'm').test(md) : true;
    if (isBold && notPromotedOk) t.correct++;
    else t.misses.push(`${c.id}: expected "${wantsBold}"${c.expectNotHeading ? ' as a plain paragraph, not a heading' : ''} — bold found: ${isBold}, stayed non-heading: ${notPromotedOk}`);

  } else if (c.category === 'columns') {
    const t = categoryTallies.columns;
    t.total += 1;
    const r = columnSwitchScore(c.anchors, md);
    t.correct += r.score;
    if (r.score < 1) {
      t.misses.push(`${c.id}: found ${r.foundCount}/${r.totalCount} anchors, ${r.switches} column switches ` +
        `(ideal ${r.idealMin}) — actual order: ${r.order.join(' | ')}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Stage 4 — report
// ═══════════════════════════════════════════════════════════════════════

function printReport(categoryTallies) {
  const labels = {
    headingLevel: 'Heading level',
    listType:     'List type',
    table:        'Table structure',
    boldRun:      'Bold run (per-word, priority-3)',
    columns:      'Columns (real papers)',
  };
  console.log('\n' + '═'.repeat(64));
  console.log('pdf2md capability map');
  console.log('═'.repeat(64));
  for (const key of ['headingLevel', 'listType', 'table', 'boldRun', 'columns']) {
    const t = categoryTallies[key];
    const pct = t.total > 0 ? ((t.correct / t.total) * 100).toFixed(1) : 'N/A';
    console.log(`${labels[key].padEnd(32)} ${pct}%  (${t.correct}/${t.total})`);
  }
  console.log('═'.repeat(64));
  for (const key of ['headingLevel', 'listType', 'table', 'boldRun', 'columns']) {
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

  const workDir = mkdtempSync(path.join(tmpdir(), 'pdf2md-capmap-'));
  console.log(`Work dir: ${workDir}`);

  const syntheticCases = await buildGroundTruth(workDir);

  for (const rc of REAL_CASES) {
    const realPdfPath = path.join(REAL_CASES_DIR, rc.file);
    if (!existsSync(realPdfPath)) {
      console.error(`✗ ${realPdfPath} not found — see tests/fixtures/columns/SOURCES.md`);
      process.exit(1);
    }
  }
  const realCases = REAL_CASES.map(rc => ({ id: rc.id, category: 'columns', anchors: rc.anchors, pdfPath: path.join(REAL_CASES_DIR, rc.file) }));

  const cases = [...syntheticCases, ...realCases];
  await runConversions(cases, workDir, pwPath, 8974);

  const categoryTallies = {
    headingLevel: { correct: 0, total: 0, misses: [] },
    listType:     { correct: 0, total: 0, misses: [] },
    table:        { correct: 0, total: 0, misses: [] },
    boldRun:      { correct: 0, total: 0, misses: [] },
    columns:      { correct: 0, total: 0, misses: [] },
  };
  for (const c of cases) scoreCase(c, categoryTallies);

  printReport(categoryTallies);
  console.log(`\nGround-truth/produced files kept at: ${workDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
