// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ── pdf2pptLayered.js ─────────────────────────────────────────────────────────
// PDF→PowerPoint "editable text": each slide is the page drawn WITHOUT its text
// (the picture, chart, table rules, fills and logos all stay as they were) with
// the text laid back on top as real, positioned text boxes — size, weight,
// colour, font and right-to-left direction kept.
//
// What the slides used to be: text rebuilt as flowing paragraphs, tables and
// pictures cut out of the page as crops, and any page with columns crossed by a
// table turned into one picture. A Chinese user's report ("可编辑文本无法成功",
// 2026-10-15) and a corpus of 500 real presentations showed what that cost:
// charts and logos lost, tables scattered, whole slides with no text at all.
// The open converters that do this well (NBLM2PPTX, ppt-craft-editable,
// PDF-to-editable-PPTX, OCRPDF-TO-PPT) all split a slide the same way: a clean
// background, and text boxes over it.
//
// Pure functions — the page render and pptxgenjs calls live in processor.js.
// Coordinates: PDF points, y up (as pdf2readCore's items).
// ─────────────────────────────────────────────────────────────────────────────

import { joinSpacedItems } from './textLayoutUtils.js';

const _RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const _right = it => it.x + (it.width || 0);

/**
 * A canvas whose text, where a run will be laid back as a text box, is not
 * drawn: each glyph pdf.js paints with fillText/strokeText (every glyph of a
 * font it loaded) on one of `runs` is left out of the page picture and its
 * colour counted for that run. Any other glyph is drawn as usual — rotated
 * text, text that isn't in the text layer (an annotation's), so nothing is
 * lost. toPdf: (canvasX, canvasY) → [pdfX, pdfY] (viewport.convertToPdfPoint).
 * After the render: restore(), then each run has .color — its commonest glyph
 * colour, or null when none of its glyphs was painted (the hidden text layer of
 * a scanned or OCR'd PDF, a Type3 font drawn as shapes): such a run stays in
 * the slide invisible, as the picture beneath already shows it.
 */
export function captureText(ctx, toPdf, runs) {
  // an OCR guess (a line whose unsure words OCR left out) replaces nothing: the
  // page's own glyphs under it stay drawn — a broken text layer's caption came
  // back as "place Cen rg for Arts?" in white over the photo — and it stays
  // invisible
  const votes = new Map(runs.filter(r => !r.partial).map(r => [r, new Map()]));
  const live = [...votes.keys()];
  // glyphs filled and glyphs outlined per run: a font with no bold face is
  // made bold by drawing it filled AND stroked (Word, WPS) — a Chinese
  // report's FangSong headings came out regular
  const painted = new Map();   // item → { fill, stroke }
  const fill = ctx.fillText, stroke = ctx.strokeText;
  const take = (draw, colour, kind) => function (text, x, y, ...rest) {
    const m = ctx.getTransform();
    if (Math.abs(m.b) <= Math.abs(m.a) * 0.1 && Math.abs(m.c) <= Math.abs(m.d) * 0.1) {
      const [px, py] = toPdf(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f);
      const run = live.find(r => px >= r.x0 - 0.3 * r.fontSize && px <= r.x1 + 0.3 * r.fontSize &&
        Math.abs(py - r.y) <= 0.35 * r.fontSize);
      if (run) {
        const fs = run.fontSize;
        const item = run.pieces?.filter(p => p.item.str.trim())
          .find(p => px >= p.item.x - 0.1 * fs && px <= _right(p.item) + 0.1 * fs)?.item;
        if (item) {
          if (!painted.has(item)) painted.set(item, { fill: 0, stroke: 0 });
          painted.get(item)[kind]++;
        }
        if (kind === 'stroke' && votes.get(run).size) return;   // the outline of a filled glyph: colour already counted
        const c = colour() || '000000', v = votes.get(run);
        v.set(c, (v.get(c) || 0) + 1);
        return;
      }
    }
    return draw.call(ctx, text, x, y, ...rest);
  };
  ctx.fillText   = take(fill,   () => _hex(ctx.fillStyle), 'fill');
  ctx.strokeText = take(stroke, () => _hex(ctx.strokeStyle), 'stroke');
  return {
    restore: () => {
      ctx.fillText = fill; ctx.strokeText = stroke;
      for (const run of runs) {
        const v = votes.get(run);
        run.color = v?.size ? [...v].sort((a, b) => b[1] - a[1])[0][0] : null;
        // an item drawn filled and outlined is bold; the run is when all of its
        // words are (mixed lines keep their bold words: styledParts)
        for (const { item } of run.pieces || []) {
          const p = painted.get(item);
          if (p && p.fill > 0 && p.stroke >= 0.5 * p.fill) item.bold = true;
        }
        const words = (run.pieces || []).filter(p => p.item.str.trim());
        if (words.length) run.bold = words.every(p => p.item.bold);
      }
    },
  };
}

// '#rrggbb' / 'rgb(a)(…)' → 'RRGGBB'; a gradient or pattern → null
function _hex(style) {
  if (typeof style !== 'string') return null;
  if (/^#[0-9a-f]{6}$/i.test(style)) return style.slice(1).toUpperCase();
  const m = style.match(/rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  return m ? m.slice(1, 4).map(v => (+v).toString(16).padStart(2, '0')).join('').toUpperCase() : null;
}

/**
 * One text line's items as runs: pieces less than 0.6 em apart are one run (a
 * word, a sentence); a wider gap — a diagram label beside another — a jump in
 * size of over half (a small label before a title), or a table rule between them (`cuts`: the rules' x positions; a table's cells sit closer
 * than that: "総資産（百万円）17,722 20,813" was one box) starts a new run, each its
 * own box. A run's text keeps the line's own (logical) item order, so
 * right-to-left text reads right.
 */
export function lineRunsForSlide(line, cuts = []) {
  // a space item spans the whole gap it stands for — between two table cells
  // too — so only items with text mark where runs begin and end
  const byX = line.items.filter(it => it.str.trim() !== '').sort((a, b) => a.x - b.x);
  const wordGaps = _justified(byX);
  const groups = [];
  let right = -Infinity;
  for (const it of byX) {
    const em = it.fontSize || 10;
    const ruled = cuts.some(c => c > right - 2 && c < it.x + 2);
    const prev = groups.length ? [...groups[groups.length - 1]].pop() : null;
    const resized = prev && Math.max(em, prev.fontSize || 10) > 1.5 * Math.min(em, prev.fontSize || 10);
    if (!groups.length || (it.x - right >= 0.6 * em && !wordGaps) || ruled || resized) groups.push(new Set());
    groups[groups.length - 1].add(it);
    right = Math.max(groups[groups.length - 1].size > 1 ? right : -Infinity, _right(it));
  }
  return groups.map(set => {
    const inside = [...set];
    const gx0 = Math.min(...inside.map(it => it.x)), gx1 = Math.max(...inside.map(_right));
    // logical order, with the run's own space items; a space wherever the
    // pieces stand apart, measured either way — a Persian title's words, one
    // item each with no space items, came out as one glued word
    const items = line.items.filter(it => set.has(it) || (it.str.trim() === '' && it.x >= gx0 && _right(it) <= gx1 + 1));
    // each item's text with the space before it (joinSpacedItems' rule): the
    // pieces a box's text is made of, styled one by one (styledParts)
    const pieces = items.map((it, k) => ({ item: it, text: joinSpacedItems(items.slice(Math.max(0, k - 1), k + 1)).slice(k ? items[k - 1].str.length : 0) }));
    const text = _symbolBullets(joinSpacedItems(items).replace(/\s+/g, ' ').trim());
    if (!text) return null;
    const sizes = inside.map(it => it.fontSize || 10).sort((a, b) => a - b);
    return {
      text, x0: gx0, x1: gx1,
      y: [...inside].sort((a, b) => a.y - b.y)[inside.length >> 1].y,
      fontSize: sizes[sizes.length >> 1],
      bold: inside.every(it => it.bold), italic: inside.every(it => it.italic),
      fontFace: inside.find(it => it.fontFamily)?.fontFamily,
      rtl: _RTL_RE.test(text),
      partial: inside.some(it => it.partial),   // OCR left words out (pdf2wordOcr)
      pieces,
    };
  }).filter(Boolean);
}

// A justified line drawn one word per item: its widened word gaps reach
// 0.6 em and more, all about the same — read as separate runs, every word of
// an English manual became its own box and paragraphs were stacked word by
// word down the page. Two or more such gaps, none over 1.6 em, within a third
// of each other: word spacing, not a table's or a diagram's gaps.
function _justified(byX) {
  const gaps = [];
  for (let k = 1; k < byX.length; k++) {
    const em = byX[k].fontSize || 10;
    const gap = (byX[k].x - _right(byX[k - 1])) / em;
    if (gap >= 0.6) gaps.push(gap);
  }
  return gaps.length >= 2 && Math.max(...gaps) <= 1.6 && Math.max(...gaps) <= 1.3 * Math.min(...gaps);
}

// Bullets drawn with Symbol / Wingdings come through as their private-use
// codes (U+F0xx) — an empty box in PowerPoint ("" before every item of a
// Chinese white paper's lists); the characters they draw instead.
const _SYMBOL_BULLETS = { '\uF0B7': '•', '\uF06C': '●', '\uF0A7': '▪', '\uF06E': '■', '\uF0D8': '➢', '\uF0E8': '➔',
  '\uF0FC': '✓', '\uF076': '❖', '\uF0A8': '◆', '\uF071': '❑', '\uF0D2': '•', '\uF09F': '•' };
function _symbolBullets(text) {
  return text.replace(/[\uF000-\uF0FF]/g, ch => _SYMBOL_BULLETS[ch] ?? ch);
}

/**
 * Runs that make one paragraph — same left edge (right edge for right-to-left
 * text, centre for centred lines), size, weight and colour, each the next line
 * at a steady pitch, no table row rule between them (`grids`: the page's ruled
 * grids) — become one box with its lines broken where the page broke them:
 * edited as one, laid out as the page was. Runs top first.
 */
export function groupRuns(runs, grids = []) {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  // a table's row rule between two lines: each cell is a box of its own — a
  // Chinese table's columns were one box each, its rows read column by column
  const ruledBetween = (a, b) => grids.some(g => a.x0 >= g.x - 2 && a.x1 <= g.x + g.w + 2 &&
    g.rowYs.some(y => y < a.y && y > b.y));
  const blocks = [];
  const used = new Set();
  for (const r of sorted) {
    if (used.has(r)) continue;
    const block = { ...r, lines: [r.text], runs: [r], pitch: null };
    used.add(r);
    // how the lines line up — fixed by the first pair, held by every next
    // line: by "left or centre" each time, a hanging "a)" made a left-aligned
    // paragraph centred
    let align = r.rtl ? 'right' : null;
    let last = r;
    for (;;) {
      const fs = last.fontSize;
      const next = sorted.find(n => !used.has(n) && n.y < last.y && last.y - n.y <= 2 * fs &&
        Math.abs(n.fontSize - fs) <= 0.1 * fs && n.color === last.color && n.bold === last.bold &&
        n.rtl === last.rtl && (align ? _aligned(align, r, n, fs) : _alignOf(r, n, fs)) && !ruledBetween(last, n));
      if (!next) break;
      const pitch = last.y - next.y;
      if (pitch < 0.8 * fs || (block.pitch && Math.abs(pitch - block.pitch) > 0.15 * fs)) break;
      align = align ?? _alignOf(r, next, fs);
      block.pitch = block.pitch ?? pitch;
      block.lines.push(next.text);
      block.runs.push(next);
      block.x0 = Math.min(block.x0, next.x0); block.x1 = Math.max(block.x1, next.x1);
      used.add(next); last = next;
    }
    block.align = align ?? 'left';
    block.lang = _langOf(block.lines.join(''));
    blocks.push(block);
  }
  return blocks;
}

// 'left' / 'center' when two lines share that edge or centre, else null
function _alignOf(a, b, fs) {
  if (_aligned('left', a, b, fs)) return 'left';
  if (_aligned('center', a, b, fs)) return 'center';
  return null;
}

// Centred: both edges move by the same amount, in opposite directions — two
// lines of a hanging-indent paragraph happened to share a centre too
function _aligned(align, a, b, fs) {
  const tol = 0.5 * fs;
  if (align === 'right') return Math.abs(a.x1 - b.x1) <= tol;
  if (align === 'left') return Math.abs(a.x0 - b.x0) <= tol;
  return Math.abs((b.x0 - a.x0) + (b.x1 - a.x1)) <= tol;
}

// The language a box is marked with, by its script: PowerPoint picks the
// East Asian / complex-script font and the proofing language by it (every box
// said en-US, Chinese ones too). undefined → PowerPoint's own default.
function _langOf(text) {
  if (/[\u3040-\u30FF]/.test(text)) return 'ja-JP';
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko-KR';
  if (/[\u3400-\u9FFF]/.test(text)) return 'zh-CN';
  if (/[\u0600-\u06FF]/.test(text)) return /[\u067E\u0686\u0698\u06AF\u06CC]/.test(text) ? 'fa-IR' : 'ar-SA';
  if (/[\u0590-\u05FF]/.test(text)) return 'he-IL';
  return undefined;
}

/**
 * The x positions of the table rules a line crosses: the column lines of the
 * ruled grids (pdf2wordBorders' detectTableGrids) at the line's height.
 */
export function cutsForLine(line, grids) {
  return grids.filter(g => line.y >= g.y - 2 && line.y <= g.y + g.h + 2).flatMap(g => g.colXs);
}

/**
 * The font size that makes a block's widest line as wide on the slide as on
 * the page: PowerPoint sets it in whatever font it has, often wider than the
 * PDF's own (Chinese table text ran into the next cell; a Persian title in a
 * narrow Nastaliq ran off the slide). measure(text, size) gives a width in
 * points; only ever shrinks, by 40 % at most.
 */
export function fittedFontSize(block, measure) {
  const fs = block.fontSize;
  const widest = Math.max(...block.lines.map(t => measure(t, fs)));
  const ratio = widest > 0 ? (block.x1 - block.x0) / widest : 1;
  return ratio < 0.98 ? fs * Math.max(0.6, ratio) : fs;
}

/**
 * Text that is in the page picture but not drawn as text — a scan's words read
 * by OCR, the hidden text layer of a scanned PDF, a Type3 font — becomes a
 * visible text box only where it can be taken out of the picture cleanly: the
 * band around the run is one flat colour (a slide's background), so the run's
 * box is filled with it and the box's text takes the ink's colour. On a photo
 * or a pattern the picture is left alone and the run stays invisible: OCR read
 * a gallery photo's caption as "place Cen rg for Arts?" (2026-10-15). The open
 * converters do the same with an inpainting model (OCRPDF-TO-PPT: IOPaint).
 * img: { data, width, height } (RGBA, as ImageData); toPx: (pdfX, pdfY) →
 * [canvasX, canvasY]. Runs with a colour are left as they are.
 */
export function eraseUnpaintedRuns(img, runs, toPx) {
  const { data, width, height } = img;
  const at = (x, y) => (y * width + x) * 4;
  let erased = 0;
  for (const run of runs) {
    // a run of a line whose OCR dropped unsure words is a guess: it doesn't
    // replace what the picture shows ("place Cen rg for Arts?" for a caption
    // of 8 words)
    if (run.color !== null || run.partial) continue;
    const fs = run.fontSize;
    const [ax, ay] = toPx(run.x0 - 0.1 * fs, run.y + 0.95 * fs);
    const [bx, by] = toPx(run.x1 + 0.1 * fs, run.y - 0.3 * fs);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx))), x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by))), y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by)));
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const ring = [];
    for (let x = x0; x <= x1; x++) for (const y of [y0 - 2, y1 + 2]) if (y >= 0 && y < height) ring.push(at(x, y));
    for (let y = y0; y <= y1; y++) for (const x of [x0 - 2, x1 + 2]) if (x >= 0 && x < width) ring.push(at(x, y));
    if (ring.length < 8) continue;
    const bg = [0, 1, 2].map(c => _median(ring.map(i => data[i + c])));
    const spread = ring.reduce((sum, i) => sum + Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]), 0) / ring.length;
    if (spread > 6) continue;                        // not a flat background (dark water on a photo: 6–12)
    const ink = [[], [], []];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = at(x, y);
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 90) {
        for (let c = 0; c < 3; c++) ink[c].push(data[i + c]);
      }
    }
    if (ink[0].length < 3) continue;                 // nothing there to take out
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = at(x, y);
      data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2];
    }
    run.color = ink.map(v => _median(v).toString(16).padStart(2, '0')).join('').toUpperCase();
    erased++;
  }
  return erased;
}

function _median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[v.length >> 1];
}

/**
 * A run's text as parts of one weight each — consecutive pieces with the same
 * bold joined: a line "更值得一提的是，《自然》刊文称…" bold from its second
 * half was all bold or all regular as one run. Spacing and bullets as the
 * run's text has them.
 */
export function styledParts(run) {
  const parts = [];
  for (const { item, text } of run.pieces || [{ item: run, text: run.text }]) {
    const bold = !!item.bold, last = parts[parts.length - 1];
    if (last && last.bold === bold) last.text += text;
    else parts.push({ text, bold });
  }
  parts.forEach(p => { p.text = _symbolBullets(p.text.replace(/\s+/g, ' ')); });
  if (parts.length) {
    parts[0].text = parts[0].text.trimStart();
    parts[parts.length - 1].text = parts[parts.length - 1].text.trimEnd();
  }
  return parts.filter(p => p.text);
}

