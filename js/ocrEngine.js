// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ── ocrEngine.js ─────────────────────────────────────────────────────────────
// The OCR engine, without UI: Tesseract.js loading, language detection, page
// preprocessing and recognition. Shared by the OCR tool (js/ocrUI.js) and by
// PDF→Word's OCR layer for scanned pages, so both read a scan the same way.
// Everything runs in the browser — the page image never leaves the device.
// ─────────────────────────────────────────────────────────────────────────────

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
// Subresource Integrity — same reasoning as every loader in js/lazyLibs.js (see that
// file's header comment): CSP allowlists jsdelivr but doesn't verify WHAT it serves.
// Hash computed by curling this exact pinned-version URL.
const TESSERACT_SRI = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F';

// Resolution profile per script family.
// CJK ideographs are small and dense — need higher resolution for stroke preservation.
// Arabic and Devanagari have connected ligatures that benefit from slightly more pixels.
// Latin/Cyrillic are accurate at 3000px (~240 DPI on A4).
// New languages should be added to the appropriate bucket; no per-lang if-chains needed.
export const SCRIPT_PROFILE = {
  latin:   3000,
  complex: 3200,
  cjk:     4200,  // Japanese/Chinese kanji are dense — extra pixels improve stroke recognition
};
export const CJK_LANGS = new Set(['jpn', 'chi_sim', 'chi_tra', 'kor']);

// Non-Latin scripts where Tesseract confidence is structurally lower even for correct text.
// Used for two purposes:
//   1. Lower confidence threshold (45 vs 55) so valid glyphs aren't discarded.
//   2. Skip OCR quality score display — calibrated Latin tiers (90/80/60%) mislead
//      users of these scripts until per-language baselines are established from real data.
// Note: kor (Korean) included — Hangul confidence patterns match other complex scripts.
export const COMPLEX_LANGS = new Set(['ara', 'fas', 'jpn', 'chi_sim', 'chi_tra', 'kor', 'hin', 'tha']);

// Script family classification. To add a new language, put it in the right group —
// no other table needs updating.
export const SCRIPT_GROUPS = {
  latin:      ['eng', 'fra', 'deu', 'spa', 'ita', 'por', 'nld', 'pol', 'tur', 'uzb'],
  cyrillic:   ['rus'],
  rtl:        ['ara', 'fas'],
  cjk:        ['jpn', 'chi_sim', 'chi_tra', 'kor'],
  devanagari: ['hin'],
  thai:       ['tha'],
};

// For combined codes like 'jpn+eng' or 'chi_sim+eng', return the primary
// (non-Latin) script so set lookups against COMPLEX_LANGS / CJK_LANGS work.
export function primaryScript(lang) { return lang.split('+')[0]; }

function _scriptGroupOf(lang) {
  for (const [group, langs] of Object.entries(SCRIPT_GROUPS)) {
    if (langs.includes(lang)) return group;
  }
  return 'latin';
}

// ── Engine loading ────────────────────────────────────────────────────────────

let _tesseractLoading = null;
// Loads Tesseract.js once (script tag, SRI-checked). Rejects on network failure;
// a later call retries.
export function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  _tesseractLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src         = TESSERACT_CDN;
    s.integrity   = TESSERACT_SRI;
    s.crossOrigin = 'anonymous';
    s.onload  = resolve;
    s.onerror = () => { _tesseractLoading = null; reject(new Error('Failed to load Tesseract.js')); };
    document.head.appendChild(s);
  });
  return _tesseractLoading;
}

// Japanese needs its vertical model too (horizontal + vertical recognition).
function _tesseractLang(lang) {
  return lang === 'jpn' ? 'jpn+jpn_vert' : lang === 'jpn+eng' ? 'jpn+jpn_vert+eng' : lang;
}

// PSM 11 (sparse text) works better for CJK invoice/table layouts than PSM 3 (auto).
// PSM 3 may group kanji blocks suboptimally; PSM 11 finds text anywhere on the page.
async function _applyLangParams(worker, lang) {
  if (CJK_LANGS.has(primaryScript(lang))) {
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
  }
}

// tesseract.js 5.1.1 (src/createWorker.js) on a failed job: rejects the
// job's promise AND, with no errorHandler, throws from its message handler —
// an uncaught error per failure, which flooded analytics (one PDF→Word session:
// 714 js_error, 2026-10-09). And when a language model fails to download, the
// promise createWorker returns never settles (its load chain ends in
// .catch(() => {}), and only a failed 'load' step rejects it): PDF→Word hung for
// good, reproduced by blocking the model request. So: errors while the worker
// is being created reject here at once; after that they only reject their own
// job's promise; and a load that hangs gives up after _OCR_LOAD_TIMEOUT_MS.
const _OCR_LOAD_TIMEOUT_MS = 120000;
function _withTimeout(promise, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), _OCR_LOAD_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}
export async function createOcrWorker(lang, logger) {
  let failLoad;
  const loadFailed = new Promise((_, reject) => { failLoad = reject; });
  let ready = false;
  const created = window.Tesseract.createWorker(_tesseractLang(lang), 1, {
    // never `logger: undefined`: it overrides tesseract.js's own no-op, and
    // every progress message then threw "b is not a function" — dozens per
    // page of every PDF→Word scan, the bulk of the js_error flood
    logger: logger ?? (() => {}),
    errorHandler: err => { if (!ready) failLoad(new Error(`OCR engine: ${err}`)); },
  });
  const worker = await _withTimeout(Promise.race([created, loadFailed]), 'OCR engine load');
  ready = true;
  await _applyLangParams(worker, lang);
  return worker;
}

// reinitialize() resets engine params — they are re-applied for the new language.
export async function switchOcrLanguage(worker, lang) {
  await _withTimeout(worker.reinitialize(_tesseractLang(lang)), 'OCR language load');
  await _applyLangParams(worker, lang);
}

// Adaptive confidence threshold — see COMPLEX_LANGS.
// Latin (eng/fra/…): 55% — Tesseract is reliable; below 55% is almost always garbage.
// Complex (ara/jpn/kor/hin/tha/…): 45% — correct glyphs routinely score 40–50%,
// so 55% would silently discard real text for these scripts.
export function minConfidence(lang) {
  return COMPLEX_LANGS.has(primaryScript(lang)) ? 45 : 55;
}

// ── Language detection ───────────────────────────────────────────────────────

// Analyse unicode codepoints of OCR text and return the most likely Tesseract
// language code. Only dominant script is checked — mixing models degrades quality.
// Returns { lang, confident } where confident=false means mixed/ambiguous content.
// ocrConf: Tesseract word confidence (0-100) from the quick OCR pass — used to
// lower confidence when the OCR engine itself was uncertain about the text.
function _detectScriptFromText(text, ocrConf = 100) {
  if (!text || text.trim().length < 10) return { lang: 'eng', confident: false };
  let lat = 0, cyr = 0, ara = 0, jpnKana = 0, cjk = 0, han = 0, dev = 0, tha = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x0041 && cp <= 0x024F)       lat++;
    else if (cp >= 0x0400 && cp <= 0x04FF)  cyr++;
    else if (cp >= 0x0600 && cp <= 0x06FF)  ara++;
    else if (cp >= 0x3040 && cp <= 0x30FF)  jpnKana++;
    else if (cp >= 0x4E00 && cp <= 0x9FFF)  cjk++;
    else if (cp >= 0xAC00 && cp <= 0xD7A3)  han++;
    else if (cp >= 0x0900 && cp <= 0x097F)  dev++;
    else if (cp >= 0x0E00 && cp <= 0x0E7F)  tha++;
  }
  const total = lat + cyr + ara + jpnKana + cjk + han + dev + tha || 1;

  let lang = 'eng';
  if (jpnKana > 3)                   lang = 'jpn';
  else if (han > 5)                  lang = 'kor';
  else if (cjk > 10 && jpnKana > 0) lang = 'jpn';
  else if (cjk > 10)                lang = 'chi_sim';
  else if (ara > 5)                  lang = 'ara';
  else if (dev > 5)                  lang = 'hin';
  else if (tha > 5)                  lang = 'tha';
  else if (cyr > lat * 0.25 && cyr > 5) lang = 'rus';

  const dominant = { eng: lat, rus: cyr, ara, jpn: jpnKana + cjk, chi_sim: cjk, kor: han, hin: dev, tha }[lang] ?? lat;
  // Confidence is also reduced when the OCR engine itself was uncertain (ocrConf < 55):
  // a Russian scan processed with `eng` produces Latin-looking garbage with low OCR confidence.
  const confident = total >= 30 && (dominant / total) > 0.5 && ocrConf >= 55;

  return { lang, confident };
}

// Sample pages [1, middle, last] — stop as soon as enough text is found.
// Prefers the existing text layer (free) over a quick OCR pass (cheap).
// 1600px, not 800: an A4 page at 800px is ~70 dpi, where Tesseract is unsure
// of every script — an Arabic scan read with `ara` scored 47–57, under the 65
// a probe needs, so every Arabic scan stopped at "Select a language first" and
// a phone photo of one was taken for English (2026-10-08, synthetic scans of
// the prose ground truth). At 1600px: 75–77 on Arabic scans, Russian photo
// 54 → 94, English unchanged.
const DETECT_PX = 1600;

// When detection of a script family looks suspicious, try these probe languages.
// Each entry { group, probe } names the script family being tested and the single
// representative language used for the confidence comparison.
// cjk is intentionally omitted from latin fallbacks: jpn/chi_sim models are 10–15 MB
// each — downloading them during auto-detection would be too slow for most users.
// Each probe entry: { group, probe, signal }
//   group  — script family being tested
//   probe  — representative language for the confidence comparison
//   signal — which suspicion signal this probe is designed to catch
//            (documentation only for now; all probes run when ANY signal fires)
//
// Lazy-loading: each probe only runs if the previous one didn't gain ≥15%.
// Arabic docs exit at step 2; Japanese at step 3; Chinese at step 4.
// CJK models (10–15 MB) are only downloaded when Cyrillic + RTL both fail,
// and the download is reused for full OCR — no extra cost.
const FALLBACK_PROBES = {
  latin: [
    { group: 'cyrillic', probe: 'rus',     signal: 'low_confidence' },
    { group: 'rtl',      probe: 'ara',     signal: 'digit_heavy'    },
    { group: 'cjk',      probe: 'jpn',     signal: 'no_letters'     },
    { group: 'cjk',      probe: 'chi_sim', signal: 'no_letters'     },
  ],
  cjk: [
    { group: 'cjk', probe: 'chi_sim', signal: 'cjk_disambiguation' },
  ],
};

// Multi-signal suspicion check — returns true when OCR output looks like
// misidentification. Two independent signals:
//
//  Signal A — low confidence (< 60): catches Cyrillic.
//    eng model maps Ц→U, Г→T etc.; word confidence drops because combinations
//    don't match English dictionary ("Horosop", "MockBa").
//
//  Signal B — low letter ratio: catches Arabic (and potentially CJK).
//    Arabic chars have no Latin look-alikes → eng OCR produces mostly numbers
//    (42, 2024, 50,000). Ratio = letters / (letters + digits): spaces and
//    punctuation are excluded from the denominator — a short invoice like
//    "Invoice: Total: $500" has lots of colons/spaces that would otherwise
//    dilute the signal and falsely trigger the fallback.
function _isDetectionSuspicious(txt, conf) {
  if (conf < 60) return true;
  const letters    = (txt.match(/[a-zA-Z]/g) ?? []).length;
  const digits     = (txt.match(/[0-9]/g)    ?? []).length;
  const meaningful = letters + digits;
  return meaningful > 5 && (letters / (meaningful || 1)) < 0.25;
}

// Detects a document's language: samples pages [1, middle, last] with `worker`
// (left set to the detected language when a probe wins, else to its initial
// language). Returns { lang, confident, metrics } — metrics describe how the
// decision was reached (source, probes tried, winning confidence).
// `ignoreTextLayer`: judge from the page image only — for pages whose text
// layer is garbage (PDF→Word's OCR layer reads only such pages and scans).
export async function detectOcrLanguage(pdfDoc, worker, { ignoreTextLayer = false } = {}) {
  const total = pdfDoc.numPages;
  const pages = [...new Set([1, Math.ceil(total / 2), total])];

  for (const p of pages) {
    const page = await pdfDoc.getPage(p);

    // 1. Check text layer first — zero cost, unicode analysis is accurate here
    const layerText = ignoreTextLayer ? '' : (await page.getTextContent()).items.map(i => i.str).join('');
    if (layerText.trim().length >= 50) {
      const result = _detectScriptFromText(layerText, 100);
      return { ...result, metrics: {
        source: 'text-layer', initial: result.lang, suspicious: false,
        tried: [], winner: result.lang, winnerConfidence: 100, switched: false,
      } };
    }

    // 2. Render low-res canvas — keep alive until ALL detection for this page is done
    const vp0  = page.getViewport({ scale: 1 });
    const scale = DETECT_PX / Math.max(vp0.width, vp0.height);
    const vp   = page.getViewport({ scale });
    const cvs  = document.createElement('canvas');
    cvs.width  = Math.round(vp.width);
    cvs.height = Math.round(vp.height);
    await page.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;

    // 3. Quick OCR pass — primary detection. On the plain render: Enhance
    // (see _enhanceForOcrAsync), tuned for full resolution, lowered the `ara`
    // probe on clean and office scans at this size (77 → 62, 75 → 54).
    const res  = await worker.recognize(cvs);
    const txt  = res?.data?.text ?? '';
    const conf = res?.data?.confidence ?? 0;

    if (txt.trim().length >= 20) {
      const primary    = _detectScriptFromText(txt, conf);
      const suspicious = _isDetectionSuspicious(txt, conf);
      const probes     = suspicious ? (FALLBACK_PROBES[_scriptGroupOf(primary.lang)] ?? []) : [];
      const tried      = [];  // track every probe attempted

      // 4. Multi-signal fallback: try probes sequentially, stop on first gain ≥15%
      for (const { probe } of probes) {
        tried.push(probe);
        await worker.reinitialize(probe);
        const fbRes  = await worker.recognize(cvs);
        const fbConf = fbRes?.data?.confidence ?? 0;

        if (fbConf > conf + 15) {
          let winner = probe, winnerConf = fbConf;
          // Arabic and Persian share a script, and the `ara` model never
          // outputs Persian's own letters (پ چ ژ گ ک ی: 0 in 24 scans), so
          // only the two models' confidence tells them apart: on Persian scans
          // `fas` is within 2 of `ara`, on Arabic ones 12–25 below (2026-10-08).
          // Read with `fas`, Persian scans have 85–88 % of words right, not 72–75.
          if (probe === 'ara') {
            tried.push('fas');
            await worker.reinitialize('fas');
            const fasConf = (await worker.recognize(cvs))?.data?.confidence ?? 0;
            if (fasConf >= fbConf - 6) { winner = 'fas'; winnerConf = fasConf; }
          }
          cvs.width = 0; cvs.height = 0;
          // Arabic-script models score low even on correct text: a phone photo
          // of an Arabic or Persian page scored 48–64 (`ara`), short of 65, so
          // it always stopped at "Select a language first" though the language
          // was right. A clear lead over English — 19–32 points on those photos,
          // at most 14 on Hebrew scans, for which there is no model — is
          // evidence enough from 45 up (synthetic scans, 2026-10-08).
          const rtlLead = SCRIPT_GROUPS.rtl.includes(winner) && winnerConf >= 45 && winnerConf - conf >= 17;
          return { lang: winner, confident: winnerConf >= 65 || rtlLead, metrics: {
            source: 'ocr-fallback',
            initial: primary.lang, suspicious,
            tried, winner, winnerConfidence: winnerConf,
            switched: true, confidenceInitial: conf,
          } };
        }
        // Probe didn't win — restore to initial lang before trying next
        await worker.reinitialize(primary.lang);
      }

      cvs.width = 0; cvs.height = 0;
      return { ...primary, metrics: {
        source: 'ocr-primary',
        initial: primary.lang, suspicious,
        tried, winner: primary.lang, winnerConfidence: conf,
        switched: false,
      } };
    }

    cvs.width = 0; cvs.height = 0;
    // Not enough text on this page — try next sample page
  }

  return { lang: 'eng', confident: false, metrics: {
    source: 'fallback-default', initial: 'eng', suspicious: false,
    tried: [], winner: 'eng', winnerConfidence: 0, switched: false,
  } };
}

// ── Page preprocessing ───────────────────────────────────────────────────────

// Grayscale (+ Otsu binarization for CJK) in a dedicated worker — the pixel
// loop used to run on the main thread before recognize() and caused a 240ms
// frame gap on a real 6.3MB scan (4x CPU throttle; see js/ocrGrayscaleWorker.js).
let _grayscaleWorker = null;
function _ensureGrayscaleWorker() {
  if (!_grayscaleWorker) {
    _grayscaleWorker = new Worker(new URL('./ocrGrayscaleWorker.js', import.meta.url));
  }
  return _grayscaleWorker;
}

// Clean Scan's Enhance (js/cleanScanWorker.js: background flattening, denoise,
// contrast — no binarization) before Tesseract. Measured through the OCR tool on
// synthetic scans with known text (2026-10-08), share of words found / share
// of output words right:
//   Arabic + Persian phone photos (shadow, tilt)   47 / 27 % → 76 / 72 %
//   Arabic + Persian office scans (200 dpi)        74 / 72 % → 76 / 69 %
//                                                  (single pages ±5 either way)
//   Arabic + Persian clean scans (300 dpi)         80 / 78 % → 81 / 79 %,
//                                                  ~2 s slower per page
//   English, Russian                               unchanged (99–100 %),
//                                                  photos 2–3× faster
// Clean Scan's Clean mode (binarized) did worse on photos (68 / 54 %). Rejects
// where OffscreenCanvas 2D is missing (Safari < 16.4) — callers fall back to
// plain grayscale.
let _enhanceWorker = null;
// Also deskews (see cleanScanWorker's _estimateSkewDeg): resolves to
// { canvas, skewDeg }, skewDeg the rotation applied about the canvas centre.
async function _enhanceForOcrAsync(src) {
  _enhanceWorker ??= new Worker(new URL('./cleanScanWorker.js', import.meta.url));
  const bitmap = await createImageBitmap(src);
  const { data, width, height, skewDeg } = await new Promise((resolve, reject) => {
    _enhanceWorker.onmessage = (e) => {
      if (e.data.type === 'ocrImage') resolve(e.data);
      else if (e.data.type === 'error') reject(new Error(e.data.message));
    };
    _enhanceWorker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    _enhanceWorker.postMessage({ type: 'enhanceForOcr', bitmap }, [bitmap]);
  });
  const dst = document.createElement('canvas');
  dst.width  = width;
  dst.height = height;
  dst.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return { canvas: dst, skewDeg: skewDeg || 0 };
}

// A box from the deskewed image back to the image before deskew: its centre
// rotated by −skewDeg about the image centre, its size kept. Not the box
// around the rotated corners — at 2.5° that grows a 1775px-wide, 68px-high
// line to 145px, which read as text twice the size (21pt instead of 10.5pt)
// and ran every paragraph together.
function _unskewBbox({ x0, y0, x1, y1 }, skewDeg, W, H) {
  if (!skewDeg) return { x0, y0, x1, y1 };
  const r = -skewDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const mx = (x0 + x1) / 2 - W / 2, my = (y0 + y1) / 2 - H / 2;
  const dx = W / 2 + mx * c - my * s - (x0 + x1) / 2;
  const dy = H / 2 + mx * s + my * c - (y0 + y1) / 2;
  return { x0: x0 + dx, y0: y0 + dy, x1: x1 + dx, y1: y1 + dy };
}

async function _toGrayscaleAsync(src, binarize) {
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d');
  const imageData = ctx.getImageData(0, 0, w, h);
  const worker = _ensureGrayscaleWorker();

  const result = await new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'error') { reject(new Error(d.message)); return; }
      resolve(d);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker error'));
    worker.postMessage(
      { type: 'grayscale', data: imageData.data, w, h, binarize },
      [imageData.data.buffer]
    );
  });

  const dst = document.createElement('canvas');
  dst.width  = w;
  dst.height = h;
  dst.getContext('2d').putImageData(new ImageData(result.data, w, h), 0, 0);
  return dst;
}

// Rotate canvas by -R degrees so upside-down/sideways scans become upright
// before being passed to Tesseract. A separate canvas is returned; caller must
// release it (set width=0, height=0) after recognize() completes.
function _counterRotateCanvas(src, R) {
  const swap = R === 90 || R === 270;
  const dst  = document.createElement('canvas');
  dst.width  = swap ? src.height : src.width;
  dst.height = swap ? src.width  : src.height;
  const ctx  = dst.getContext('2d');
  ctx.translate(dst.width / 2, dst.height / 2);
  ctx.rotate(-R * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return dst;
}

// Map a Tesseract bbox from counter-rotated (ocrCanvas) space back to the
// original display canvas space so callers can apply vpTransform without
// modification. Derivation: invert the affine applied by _counterRotateCanvas
// for each of the four standard PDF rotation values. W, H are the display
// canvas (pre-rotation) dimensions.
function _rotateBackBbox({ x0, y0, x1, y1 }, R, W, H) {
  if (R === 90)  return { x0: W - y1, y0: x0,     x1: W - y0, y1: x1     };
  if (R === 180) return { x0: W - x1, y0: H - y1, x1: W - x0, y1: H - y0 };
  if (R === 270) return { x0: y0,     y0: H - x1, x1: y1,     y1: H - x0 };
  return { x0, y0, x1, y1 };
}

// ── Page recognition ─────────────────────────────────────────────────────────

// Renders one pdf.js page and recognizes it with `worker` (set to `lang`).
// Returns, in display-canvas pixels of a viewport `vpTransform` maps PDF user
// space to:
//   words  — [{ text, confidence, bbox }] at or above minConfidence(lang)
//   lines  — Tesseract's lines, every word with `kept` (false below the
//            confidence threshold — its box still marks where text stands):
//            [{ words: [{ text, confidence, bbox, kept, ink }], bbox, baseline, stroke }]
//            ink: { dark, edge } — a word's ink pixels and ink-edge pixels;
//            stroke: the line's strokes' thickness, Σdark ÷ Σedge over its
//            words — bold sets thicker strokes (2026-10-09:
//            bold headings 1.36–2.12× the page median, body lines ≤ 1.05×).
//            The share of ink in the boxes told bold apart in Latin and
//            Persian but not in Amiri, whose words leave much of their box
//            empty (body lines up to 1.22×, a heading 1.26×).
//   text   — the page as plain text, paragraphs separated by a blank line
//   canvasW, canvasH, vpTransform, rotation
// Boxes sit where the text stands on the page image (to lay text over it), or
// with `level` where it stands once the page is deskewed: text lines level,
// for layout reconstruction. Mapped back onto a page tilted 2.5°, a short line
// lands ~10pt above or below a full one, and line gaps of 16.5/24.8pt (line /
// paragraph) read as 15–26pt — paragraph breaks lost in the noise.
// Canvases are released before returning.
export async function recognizePage(worker, page, lang, { level = false } = {}) {
  // Adaptive scale — aim for the script profile's size on the longest side, as
  // a hard cap. Old logic (scale=2 default) downsampled high-DPI CamScanner
  // pages from ~2480px to ~1190px before Tesseract, losing fraction bars and
  // small text — fixed by scaling up to the cap. A `Math.max(2, ...)` floor was
  // added at the same time to guarantee that minimum, but it let oversized
  // physical pages (A2/A1 scans, posters) blow past the cap, risking a Mobile
  // Safari tab kill under memory pressure. Removed: the cap must stay a true
  // cap, even at the cost of quality on rare oversized pages.
  const vp0 = page.getViewport({ scale: 1 });
  const ps    = primaryScript(lang);
  const maxPx = CJK_LANGS.has(ps)     ? SCRIPT_PROFILE.cjk
              : COMPLEX_LANGS.has(ps) ? SCRIPT_PROFILE.complex
              : SCRIPT_PROFILE.latin;
  const scale = Math.min(maxPx / vp0.width, maxPx / vp0.height);
  const vp = page.getViewport({ scale });

  let canvas, ocrCanvas;
  try {
    canvas        = document.createElement('canvas');
    canvas.width  = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    // Counter-rotate so Tesseract always receives an upright image.
    // PDFs with /Rotate 180 or 270 would otherwise produce garbage confidence.
    const rotation = page.rotate || 0;
    ocrCanvas = rotation !== 0 ? _counterRotateCanvas(canvas, rotation) : canvas;

    // CJK keeps its own grayscale + Otsu path (not measured with Enhance).
    const { canvas: gray, skewDeg } = CJK_LANGS.has(ps)
      ? { canvas: await _toGrayscaleAsync(ocrCanvas, true), skewDeg: 0 }
      : await _enhanceForOcrAsync(ocrCanvas)
        .catch(async () => ({ canvas: await _toGrayscaleAsync(ocrCanvas, false), skewDeg: 0 }));
    const result = await worker.recognize(gray);
    const W = gray.width, H = gray.height;
    const px = gray.getContext('2d').getImageData(0, 0, W, H).data;
    const ink = (x, y) => x >= 0 && y >= 0 && x < W && y < H && px[(y * W + x) * 4] < 128;
    const inkOf = bbox => {
      let dark = 0, edge = 0;
      for (let y = Math.max(0, Math.round(bbox.y0)); y < Math.min(H, bbox.y1); y++) {
        for (let x = Math.max(0, Math.round(bbox.x0)); x < Math.min(W, bbox.x1); x++) {
          if (!ink(x, y)) continue;
          dark++;
          if (!ink(x - 1, y) || !ink(x + 1, y) || !ink(x, y - 1) || !ink(x, y + 1)) edge++;
        }
      }
      return { dark, edge };
    };
    const strokeOf = words => {
      const dark = words.reduce((s, w) => s + w.ink.dark, 0), edge = words.reduce((s, w) => s + w.ink.edge, 0);
      return edge ? dark / edge : 0;
    };

    const minConf = minConfidence(lang);
    // Deskewed image → image before deskew (unless `level`) → display canvas (page /Rotate).
    const back = bbox => {
      const unskewed = level ? bbox : _unskewBbox(bbox, skewDeg, gray.width, gray.height);
      return rotation !== 0 ? _rotateBackBbox(unskewed, rotation, canvas.width, canvas.height) : unskewed;
    };
    const keep = w => w.text.normalize('NFC').trim() && w.confidence >= minConf;
    const toWord = w => ({ text: w.text.normalize('NFC').trim(), confidence: w.confidence, bbox: back(w.bbox) });

    const words = result.data.words.filter(keep).map(toWord);
    const lines = (result.data.lines || []).map(line => {
      const lineWords = line.words.filter(w => w.text.trim()).map(w => ({ ...toWord(w), kept: !!keep(w), ink: inkOf(w.bbox) }));
      return {
        words:    lineWords,
        bbox:     back(line.bbox),
        // Mapped back like a box: level, at the line's height at mid-line.
        baseline: line.baseline && { ...back(line.baseline), has_baseline: line.baseline.has_baseline },
        stroke:   strokeOf(lineWords),
      };
    }).filter(line => line.words.some(w => w.kept));

    // Plain text from paragraph/line structure
    const paragraphs = result.data.paragraphs
      .map(para => para.lines
        .map(line => line.words.map(w => w.text).join(' ').trim())
        .filter(Boolean)
        .join('\n'))
      .filter(Boolean);

    return {
      words, lines,
      text: paragraphs.join('\n\n') || result.data.text.trim(),
      canvasW: canvas.width, canvasH: canvas.height,
      vpTransform: Array.from(vp.transform),
      rotation,
    };
  } finally {
    // Always release canvas memory regardless of success or error
    if (ocrCanvas && ocrCanvas !== canvas) { ocrCanvas.width = 0; ocrCanvas.height = 0; }
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
