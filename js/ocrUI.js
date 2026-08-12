// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

import { loadPdfJs } from './pdf2jpgUI.js';
import { loadPdfLib } from './lazyLibs.js';
import { t } from './i18n.js';
import { saveHandoff } from './handoff.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const TESSERACT_CDN       = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const TEXT_CHAR_THRESHOLD = 100; // min chars across sampled pages → classified as text PDF (items-count was 5 — too low)

// Locale-correct slugs for the "What to do next" handoff links below. The OCR
// tool page is served at a translated pathname in every non-English locale
// (e.g. /ru/raspoznat-tekst-pdf/), and so are its target pages — a bare
// English relative href (../pdf-to-word/) resolves to a URL that doesn't
// exist in that locale (e.g. /ru/pdf-to-word/ instead of /ru/pdf-v-word/),
// landing on an unstyled fallback instead of the real page. Mirrors the
// per-locale slugs in data/tools-config.json.
const NEXT_STEP_SLUGS = {
  pdf2word: { en: 'pdf-to-word', de: 'pdf-zu-word', es: 'pdf-a-word', fr: 'pdf-en-word', pt: 'pdf-para-word', id: 'pdf-ke-word', vi: 'pdf-sang-word', ru: 'pdf-v-word', ja: 'pdf-word-henkan', tr: 'pdf-word-donustur', it: 'pdf-in-word', ko: 'pdf-word-byeonhwan', nl: 'pdf-naar-word', pl: 'pdf-do-word' },
  split:    { en: 'split-pdf', de: 'pdf-aufteilen', es: 'dividir-pdf', fr: 'diviser-pdf', pt: 'dividir-pdf', id: 'pisah-pdf', vi: 'tach-pdf', ru: 'razdelit-pdf', ja: 'pdf-bunkatsu', tr: 'pdf-bol', it: 'dividi-pdf', ko: 'pdf-bunhal', nl: 'pdf-splitsen', pl: 'podziel-pdf' },
  compress: { en: 'compress-pdf', de: 'pdf-komprimieren', es: 'comprimir-pdf', fr: 'compresser-pdf', pt: 'comprimir-pdf', id: 'kompres-pdf', vi: 'nen-pdf', ru: 'szhat-pdf', ja: 'pdf-atsuryoku', tr: 'pdf-sikistir', it: 'comprimi-pdf', ko: 'pdf-apchuk', nl: 'pdf-comprimeren', pl: 'kompresuj-pdf' },
};
const NEXT_STEP_LOCALES = new Set(['de', 'es', 'fr', 'pt', 'id', 'vi', 'ru', 'ja', 'it', 'ko', 'nl', 'pl', 'tr']);

function _currentLocale() {
  const seg = location.pathname.split('/')[1];
  return NEXT_STEP_LOCALES.has(seg) ? seg : 'en';
}

function _nextStepHref(toolKey) {
  const lc   = _currentLocale();
  const slug = NEXT_STEP_SLUGS[toolKey][lc] || NEXT_STEP_SLUGS[toolKey].en;
  return lc === 'en' ? `/${slug}/` : `/${lc}/${slug}/`;
}

// Resolution profile per script family.
// CJK ideographs are small and dense — need higher resolution for stroke preservation.
// Arabic and Devanagari have connected ligatures that benefit from slightly more pixels.
// Latin/Cyrillic are accurate at 3000px (~240 DPI on A4).
// New languages should be added to the appropriate bucket; no per-lang if-chains needed.
const SCRIPT_PROFILE = {
  latin:   3000,
  complex: 3200,
  cjk:     4200,  // Japanese/Chinese kanji are dense — extra pixels improve stroke recognition
};
const CJK_LANGS = new Set(['jpn', 'chi_sim', 'chi_tra', 'kor']);

// Non-Latin scripts where Tesseract confidence is structurally lower even for correct text.
// Used for two purposes:
//   1. Lower confidence threshold (45 vs 55) so valid glyphs aren't discarded.
//   2. Skip OCR quality score display — calibrated Latin tiers (90/80/60%) mislead
//      users of these scripts until per-language baselines are established from real data.
// Note: kor (Korean) included — Hangul confidence patterns match other complex scripts.
const COMPLEX_LANGS = new Set(['ara', 'jpn', 'chi_sim', 'chi_tra', 'kor', 'hin', 'tha']);

// ── State ────────────────────────────────────────────────────────────────────
let _file            = null;
let _isTextPdf       = false;
let _ocrReady        = false;
let _loading         = false;
let _generation      = 0;        // incremented on each new file; stale _analyse calls bail early
let _deferredInstall = null;
let _selectedLang      = 'auto';  // 'auto' or specific lang code
let _detectedLang      = null;    // set after auto-detection; null when user chose manually
let _requiresManualLang = false;  // true when auto-detection was inconclusive — blocks OCR
let _downloadAsTxt      = false;
let _includeTxtHeader   = false;
const _langCache       = new Map(); // "filename:size" → detected lang — avoids re-detection

// ── Last result — stored so the download button in success card can re-trigger
let _lastResultBlob  = null;   // Blob for re-download from success card
let _lastResultName  = null;   // Download filename

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstall = e;
});

// ── Language definitions ─────────────────────────────────────────────────────
const LANGUAGES = {
  european: [
    { code: 'eng', name: 'English',    size: '4 MB',  isDefault: true },
    { code: 'fra', name: 'French',     size: '5 MB'  },
    { code: 'deu', name: 'German',     size: '6 MB'  },
    { code: 'spa', name: 'Spanish',    size: '5 MB'  },
    { code: 'ita', name: 'Italian',    size: '5 MB'  },
    { code: 'por', name: 'Portuguese', size: '5 MB'  },
    { code: 'rus', name: 'Russian',    size: '5 MB'  },
    { code: 'uzb', name: 'Uzbek',      size: '3 MB'  },
    { code: 'nld', name: 'Dutch',      size: '5 MB'  },
    { code: 'pol', name: 'Polish',     size: '5 MB'  },
    { code: 'tur', name: 'Turkish',    size: '4 MB'  },
  ],
  complex: [
    { code: 'ara',         name: 'Arabic',                        size: '1.5 MB', rtl: true },
    { code: 'jpn',         name: 'Japanese',                      size: '10 MB'  },
    { code: 'jpn+eng',     name: 'Japanese + English (bilingual)', size: '14 MB'  },
    { code: 'chi_sim',     name: 'Chinese (Simplified)',           size: '15 MB'  },
    { code: 'chi_sim+eng', name: 'Chinese + English (bilingual)',  size: '19 MB'  },
    { code: 'chi_tra',     name: 'Chinese (Traditional)',          size: '15 MB'  },
    { code: 'kor',         name: 'Korean',                        size: '5 MB'   },
    { code: 'hin',         name: 'Hindi',                         size: '5 MB'   },
    { code: 'tha',         name: 'Thai',                          size: '4 MB'   },
  ],
};


// ── Public API ───────────────────────────────────────────────────────────────
export function initOcrOptions(file) {
  const el = document.getElementById('ocrOptions');
  if (!el) return;
  el.style.display = '';
  _file              = file;
  _loading           = true;
  _selectedLang      = 'auto';
  _detectedLang      = null;
  _requiresManualLang = false;
  el.innerHTML = _spinnerHTML(t('val_analysing_pdf'));
  _bindMergeBtn();   // register listener immediately so loading-state clicks are handled
  _analyse(file, el);
}

export function hideOcrOptions() {
  const el = document.getElementById('ocrOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _file = null; _isTextPdf = false; _loading = false;
  _lastResultBlob = null; _lastResultName = null;
  _includeTxtHeader = false; _detectedLang = null; _requiresManualLang = false;
  _selectedLang = 'auto';
}

export function getOcrParams() {
  return {
    hasFile:    !!_file,
    loading:    _loading,
    isOcrReady: _ocrReady,
    isTextPdf:  _isTextPdf,
  };
}

// ── Auto-load Tesseract for returning users ───────────────────────────────────
async function _autoLoadIfInstalled() {
  let flag;
  try { flag = localStorage.getItem('pdfree_ocr_installed'); } catch { return; }
  if (flag !== '1') return;
  if (window.Tesseract) { _ocrReady = true; return; }
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src     = TESSERACT_CDN;
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    _ocrReady = true;
  } catch {
    // CDN unreachable — clear flag so install button shows normally
    try { localStorage.removeItem('pdfree_ocr_installed'); } catch { /* private browsing */ }
  }
}

// ── Analysis ─────────────────────────────────────────────────────────────────
async function _analyse(file, container) {
  const myGen = ++_generation;
  try {
    // Yield a microtask so files.js _updateMeta() can enable the button first,
    // then we re-disable it while analysis runs. Without this yield, the disable
    // would fire before _updateMeta() and be immediately overridden.
    await Promise.resolve();
    if (myGen !== _generation) return;
    const btn = document.getElementById('mergeBtn');
    if (btn && btn._ocrBound) { btn.disabled = true; btn.textContent = t('ocr_analysing_short'); }

    await loadPdfJs();
    if (myGen !== _generation) return;

    const buf = await file.arrayBuffer();
    let pdfDoc;
    try {
      pdfDoc = await window.pdfjsLib.getDocument({
        data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true, ignoreEncryption: true,
      }).promise;

      // Sample up to 3 pages per-page to detect hybrid PDFs.
      // A document-level total was wrong: a hybrid with a text page 1 (200 chars)
      // and a scanned page 2 (0 chars) would sum ≥ 100 → wrongly classified as
      // text PDF → page 2 scanned content silently lost.
      // Now: _isTextPdf = true only when ALL sampled pages clear the threshold.
      // Hybrid PDFs (mixed) → _isTextPdf = false → OCR path with per-page logic.
      const samplePages = Math.min(3, pdfDoc.numPages);
      let allPagesHaveText = true;
      for (let p = 1; p <= samplePages; p++) {
        const pg = await pdfDoc.getPage(p);
        const tc = await pg.getTextContent();
        const chars = tc.items.reduce((s, i) => s + i.str.trim().length, 0);
        if (chars < TEXT_CHAR_THRESHOLD) { allPagesHaveText = false; break; }
      }
      _isTextPdf = allPagesHaveText;
    } finally {
      pdfDoc?.destroy();
    }

    if (myGen !== _generation) return;

    // Auto-load Tesseract only for scanned PDFs — text PDFs never need it
    if (!_isTextPdf) await _autoLoadIfInstalled();

    if (myGen !== _generation) return;

    _loading = false;
    _renderUI(container);
    _syncBtnLabel();
  } catch (err) {
    if (myGen !== _generation) return;
    _loading = false;
    if (_isPasswordError(err)) {
      container.innerHTML = _errorHTML(
        t('ocr_password_protected_msg'),
        t('ocr_password_protected_title')
      );
    } else {
      container.innerHTML = _errorHTML(err.message);
    }
    const btn = document.getElementById('mergeBtn');
    if (btn && btn._ocrBound) {
      btn.disabled = false;
      _syncBtnLabel();
    }
  }
}

// ── Auto language detection ───────────────────────────────────────────────────

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
const DETECT_PX = 800;
// Script family classification. To add a new language, put it in the right group —
// no other table needs updating.
const SCRIPT_GROUPS = {
  latin:      ['eng', 'fra', 'deu', 'spa', 'ita', 'por', 'nld', 'pol', 'tur', 'uzb'],
  cyrillic:   ['rus'],
  rtl:        ['ara'],
  cjk:        ['jpn', 'chi_sim', 'chi_tra', 'kor'],
  devanagari: ['hin'],
  thai:       ['tha'],
};

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

function _scriptGroupOf(lang) {
  for (const [group, langs] of Object.entries(SCRIPT_GROUPS)) {
    if (langs.includes(lang)) return group;
  }
  return 'latin';
}

// For combined codes like 'jpn+eng' or 'chi_sim+eng', return the primary
// (non-Latin) script so set lookups against COMPLEX_LANGS / CJK_LANGS work.
function _primaryScript(lang) { return lang.split('+')[0]; }

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

// Last detection metrics — useful for debugging auto-detection behaviour.
// Exposed on window in dev builds; read via browser console if needed.
let _lastDetectionMetrics = null;

// Returns { lang, confident } — samples pages [1, middle, last] to detect script.
async function _detectLanguage(pdfDoc, worker) {
  const total = pdfDoc.numPages;
  const pages = [...new Set([1, Math.ceil(total / 2), total])];

  for (const p of pages) {
    const page = await pdfDoc.getPage(p);

    // 1. Check text layer first — zero cost, unicode analysis is accurate here
    const tc = await page.getTextContent();
    const layerText = tc.items.map(i => i.str).join('');
    if (layerText.trim().length >= 50) {
      const result = _detectScriptFromText(layerText, 100);
      _lastDetectionMetrics = {
        source: 'text-layer', initial: result.lang, suspicious: false,
        tried: [], winner: result.lang, winnerConfidence: 100, switched: false,
      };
      return result;
    }

    // 2. Render low-res canvas — keep alive until ALL detection for this page is done
    const vp0  = page.getViewport({ scale: 1 });
    const scale = DETECT_PX / Math.max(vp0.width, vp0.height);
    const vp   = page.getViewport({ scale });
    const cvs  = document.createElement('canvas');
    cvs.width  = Math.round(vp.width);
    cvs.height = Math.round(vp.height);
    await page.render({ canvasContext: cvs.getContext('2d'), viewport: vp }).promise;

    // 3. Quick OCR pass — primary detection
    const res  = await worker.recognize(cvs);
    const txt  = res?.data?.text ?? '';
    const conf = res?.data?.confidence ?? 0;

    if (txt.trim().length >= 20) {
      const primary    = _detectScriptFromText(txt, conf);
      const suspicious = _isDetectionSuspicious(txt, conf);
      const probes     = suspicious ? (FALLBACK_PROBES[_scriptGroupOf(primary.lang)] ?? []) : [];
      const tried      = [];  // track every probe attempted

      // 4. Multi-signal fallback: try probes sequentially, stop on first gain ≥15%
      for (const { group, probe } of probes) {
        tried.push(probe);
        await worker.reinitialize(probe);
        const fbRes  = await worker.recognize(cvs);
        const fbConf = fbRes?.data?.confidence ?? 0;

        if (fbConf > conf + 15) {
          cvs.width = 0; cvs.height = 0;
          _lastDetectionMetrics = {
            source: 'ocr-fallback',
            initial: primary.lang, suspicious,
            tried, winner: probe, winnerConfidence: fbConf,
            switched: true, confidenceInitial: conf,
          };
          return { lang: probe, confident: fbConf >= 65 };
        }
        // Probe didn't win — restore to initial lang before trying next
        await worker.reinitialize(primary.lang);
      }

      cvs.width = 0; cvs.height = 0;
      _lastDetectionMetrics = {
        source: 'ocr-primary',
        initial: primary.lang, suspicious,
        tried, winner: primary.lang, winnerConfidence: conf,
        switched: false,
      };
      return primary;
    }

    cvs.width = 0; cvs.height = 0;
    // Not enough text on this page — try next sample page
  }

  _lastDetectionMetrics = {
    source: 'fallback-default', initial: 'eng', suspicious: false,
    tried: [], winner: 'eng', winnerConfidence: 0, switched: false,
  };
  return { lang: 'eng', confident: false };
}

// ── UI rendering ─────────────────────────────────────────────────────────────
function _langSelectHTML() {
  const autoLabel = _detectedLang
    ? t('ocr_auto_detected', { lang: _getLangName(_detectedLang) })
    : t('ocr_auto_recommended');
  const euOptions = LANGUAGES.european
    .map(l => `<option value="${l.code}"${_selectedLang === l.code ? ' selected' : ''}>${l.name} &middot; ${l.size}</option>`)
    .join('\n        ');
  const cxOptions = LANGUAGES.complex
    .map(l => `<option value="${l.code}"${_selectedLang === l.code ? ' selected' : ''}>${l.name} &middot; ${l.size}</option>`)
    .join('\n        ');

  return `
  <div id="ocrLangBlock" style="margin-top:12px;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
    <label for="ocrLangSelect" style="display:block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:var(--text3);margin-bottom:8px;">
      ${t('ocr_lang_doc')}
    </label>
    <select id="ocrLangSelect" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:15px;font-family:inherit;margin-bottom:0;cursor:pointer;">
      <option value="auto"${_selectedLang === 'auto' ? ' selected' : ''}>${autoLabel}</option>
      <optgroup label="${t('ocr_lang_group_eu')}">
        ${euOptions}
      </optgroup>
      <optgroup label="${t('ocr_lang_group_complex')}">
        ${cxOptions}
      </optgroup>
    </select>
    <div id="langInfoBlock" style="display:none;margin-top:10px;"></div>
  </div>`;
}

function _txtCheckboxHTML() {
  return `
  <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
    <div style="display:flex;align-items:center;gap:8px;">
      <input type="checkbox" id="ocrTxtCheck" style="width:16px;height:16px;cursor:pointer;accent-color:var(--green);">
      <label for="ocrTxtCheck" style="font-size:13px;color:var(--text2);cursor:pointer;">${t('ocr_txt_checkbox')}</label>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin-left:24px;">
      <input type="checkbox" id="ocrHeaderCheck" style="width:14px;height:14px;cursor:pointer;accent-color:var(--green);">
      <label for="ocrHeaderCheck" style="font-size:12px;color:var(--text3);cursor:pointer;">${t('ocr_txt_header_checkbox')}</label>
    </div>
  </div>`;
}

function _renderUI(container) {
  if (_isTextPdf) {
    container.innerHTML = `
      <div style="padding:16px;border:1px solid var(--green);border-radius:10px;background:var(--surface);">
        <p style="margin:0 0 12px;font-size:14px;color:var(--text);">
          &#x2713; ${t('ocr_has_text_layer')}
        </p>
        ${_txtCheckboxHTML()}
      </div>`;
    _bindCheckbox();
    return;
  }

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent.toLowerCase()) && !window.MSStream;

  if (_ocrReady) {
    _ocrReady = true;
    container.innerHTML = `
      <div id="ocrInstallBlock" style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
        <p style="margin:0 0 12px;font-size:14px;color:var(--text);">${t('ocr_scanned_needs_ocr')}</p>
        <div id="ocrReadyMsg" style="padding:10px 14px;border:1px solid var(--green);border-radius:8px;font-size:13px;color:var(--text);background:var(--surface);">
          &#x2713; ${t('ocr_ready_msg')}
        </div>
        ${_langSelectHTML()}
        ${_txtCheckboxHTML()}
      </div>`;
    _bindLangSelect();
    _bindCheckbox();
    return;
  }

  container.innerHTML = `
    <div id="ocrInstallBlock" style="padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
      <p style="margin:0 0 12px;font-size:14px;color:var(--text);">This PDF is scanned &mdash; OCR required to extract text.</p>

      ${isIos ? '' : `
      <button id="btnInstallOcr" type="button" style="
        display:block;width:100%;padding:12px 16px;
        background:var(--green);color:#fff;border:none;border-radius:8px;
        font-size:14px;font-weight:600;cursor:pointer;text-align:center;">
        ${t('ocr_install_btn')}
      </button>`}

      <div id="iosInstallHint" style="display:${isIos ? '' : 'none'};padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);margin-top:8px;">
        <p style="margin:0 0 10px;font-size:13px;color:var(--text);">${t('ocr_ios_hint')}</p>
        <button id="btnDownloadOcrOnly" type="button" style="
          display:block;width:100%;padding:10px 14px;
          background:var(--surface);color:var(--green);border:1.5px solid var(--green);border-radius:8px;
          font-size:13px;font-weight:600;cursor:pointer;text-align:center;">
          ${t('ocr_download_engine_btn')}
        </button>
      </div>

      <div id="ocrReadyMsg" style="display:none;padding:10px 14px;margin-top:12px;border:1px solid var(--green);border-radius:8px;font-size:13px;color:var(--text);background:var(--surface);">
        &#x2713; ${t('ocr_ready_msg')}
      </div>

      ${_langSelectHTML()}
      ${_txtCheckboxHTML()}
    </div>`;

  const btnInstall  = document.getElementById('btnInstallOcr');
  const btnDownload = document.getElementById('btnDownloadOcrOnly');
  if (btnInstall)  btnInstall.addEventListener('click',  _installOcr);
  if (btnDownload) btnDownload.addEventListener('click', _loadTesseract);
  _bindLangSelect();
  _bindCheckbox();
}

function _bindCheckbox() {
  const cb = document.getElementById('ocrTxtCheck');
  if (cb) {
    cb.checked = _downloadAsTxt;
    cb.addEventListener('change', () => { _downloadAsTxt = cb.checked; });
  }
  const cbH = document.getElementById('ocrHeaderCheck');
  if (cbH) {
    cbH.checked = _includeTxtHeader;
    cbH.addEventListener('change', () => { _includeTxtHeader = cbH.checked; });
  }
}

function _bindLangSelect() {
  const sel = document.getElementById('ocrLangSelect');
  if (!sel) return;
  sel.value = _selectedLang;
  // Show info immediately if a complex lang is already the active selection on this render
  // (e.g. set by auto-detection or the "continue anyway" escape hatch before this binds)
  const initComplex = _selectedLang !== 'auto' && LANGUAGES.complex.find(l => l.code === _selectedLang);
  if (initComplex) _showLangInfo(initComplex);
  sel.addEventListener('change', e => {
    const val = e.target.value;
    _selectedLang = val;
    if (val !== 'auto') {
      try { localStorage.setItem('pdfree_ocr_lang', val); } catch { /* private browsing */ }
    }
    const complexLang = val !== 'auto' && LANGUAGES.complex.find(l => l.code === val);
    if (complexLang) {
      _showLangInfo(complexLang);
    } else {
      _hideLangInfo();
    }
  });
}

// Returns true if a successful OCR run with this language was previously completed.
// Approximates Tesseract's browser cache state — if cache is cleared, model re-downloads.
function _isLangInstalled(code) {
  try { return localStorage.getItem(`pdfree_ocr_lang_${code}`) === '1'; } catch { return false; }
}

// Returns the last language the user confirmed/used, or null.
// Used as a weak heuristic when auto-detection falls back to 'eng' (inconclusive).
function _readLastLang() {
  try { return localStorage.getItem('pdfree_ocr_last_lang'); } catch { return null; }
}

function _showLangInfo(lang) {
  const block = document.getElementById('langInfoBlock');
  if (!block) return;
  const installed = _isLangInstalled(lang.code);
  const lines = [];
  if (installed) {
    lines.push(`<p style="margin:0;font-size:12px;color:var(--green);">✓ ${t('ocr_lang_installed', { lang: lang.name })}</p>`);
  } else {
    lines.push(`<p style="margin:0;font-size:12px;color:var(--text3);">ⓘ ${t('ocr_lang_download_note', { size: lang.size })}</p>`);
  }
  if (CJK_LANGS.has(_primaryScript(lang.code))) {
    lines.push(`<p style="margin:6px 0 0;font-size:12px;color:var(--text3);">${t('ocr_cjk_note')}</p>`);
  }
  block.innerHTML = lines.join('');
  block.style.display = '';
}

function _hideLangInfo() {
  const block = document.getElementById('langInfoBlock');
  if (block) { block.style.display = 'none'; block.innerHTML = ''; }
}

// ── OCR engine install ────────────────────────────────────────────────────────
async function _installOcr() {
  if (_deferredInstall) {
    _deferredInstall.prompt();
    await _deferredInstall.userChoice;
    _deferredInstall = null;
  }
  await _loadTesseract();
}

async function _loadTesseract() {
  if (window.Tesseract) { _ocrReady = true; _showOcrReady(); return; }

  const btn = document.getElementById('btnInstallOcr') || document.getElementById('btnDownloadOcrOnly');
  if (btn) { btn.disabled = true; btn.textContent = t('ocr_downloading_engine'); }

  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_CDN;
      s.onload  = resolve;
      s.onerror = () => reject(new Error('Failed to load Tesseract.js'));
      document.head.appendChild(s);
    });

    _ocrReady = true;
    localStorage.setItem('pdfree_ocr_installed', '1');
    _showOcrReady();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = t('ocr_install_btn'); }
    _showToast(t('ocr_download_failed'));
  }
}

function _showOcrReady() {
  const installBtn = document.getElementById('btnInstallOcr');
  if (installBtn) installBtn.style.display = 'none';
  const dlBtn = document.getElementById('btnDownloadOcrOnly');
  if (dlBtn) dlBtn.style.display = 'none';
  const readyMsg = document.getElementById('ocrReadyMsg');
  if (readyMsg) readyMsg.style.display = '';

  const mergeBtn = document.getElementById('mergeBtn');
  if (mergeBtn) mergeBtn.disabled = false;
}

// ── Main button binding ──────────────────────────────────────────────────────
function _syncBtnLabel() {
  const btn = document.getElementById('mergeBtn');
  if (!btn || !btn._ocrBound) return;
  if (_requiresManualLang) {
    btn.disabled = false; // keep clickable — click will open the language picker
    btn.textContent = t('ocr_select_lang_first');
    return;
  }
  btn.disabled = false;
  btn.textContent = _isTextPdf ? '✓ Download PDF' : '🔍 Make PDF Searchable';
}

// Called when auto-detection was inconclusive. The select becomes the dominant
// visual element (yellow validation border + action placeholder). Everything
// else recedes — the button itself explains what to do next via its label.
function _showLangRequired(detectedLang) {
  const langBlock = document.getElementById('ocrLangBlock');
  if (!langBlock) return;

  const sel = document.getElementById('ocrLangSelect');
  if (!sel) return;

  // Pre-select the best candidate so user can confirm with one click instead of
  // hunting through 18 options. Also set _selectedLang so OCR uses it directly —
  // user leaving the pre-selection unchanged counts as implicit confirmation.
  const finalCandidate = detectedLang || 'eng';
  _selectedLang = finalCandidate;
  sel.value     = finalCandidate;

  // Amber border signals "please verify this" (not an error — just needs confirmation)
  sel.style.borderColor = 'rgba(202,138,4,0.85)';
  sel.style.boxShadow   = '0 0 0 3px rgba(202,138,4,0.15)';

  const complexLang = LANGUAGES.complex.find(l => l.code === finalCandidate);
  if (complexLang) _showLangInfo(complexLang);

  // Hint explains the situation without blocking — user sees what was detected and
  // can either confirm by clicking Run OCR or switch to the correct language.
  langBlock.querySelectorAll('.detect-hint').forEach(el => el.remove());
  const hint = document.createElement('p');
  hint.className = 'detect-hint';
  hint.style.cssText = 'margin:8px 0 0;font-size:12px;color:var(--text2);';
  const langName = _getLangName(finalCandidate);
  const note = finalCandidate !== 'eng' ? t('ocr_detection_script_note', { lang: langName }) : '';
  hint.textContent = t('ocr_detection_inconclusive', { note });
  langBlock.appendChild(hint);

  // When user picks a language, clear suggestion state and unblock OCR
  sel.addEventListener('change', function onLangChange() {
    sel.style.borderColor = '';
    sel.style.boxShadow   = '';
    hint.remove();
    _requiresManualLang = false;
    _syncBtnLabel();
    sel.removeEventListener('change', onLangChange);
  });

  // Move focus to the select and scroll it into view — user's attention lands
  // immediately on the pre-selected candidate without any extra click needed.
  sel.focus();
  sel.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Block OCR until user explicitly picks from the dropdown
  _requiresManualLang = true;
  _syncBtnLabel();
}

function _bindMergeBtn() {
  const btn = document.getElementById('mergeBtn');
  if (!btn || btn._ocrBound) return;
  btn._ocrBound = true;

  // Capture phase so this fires before app.js bubble-phase listener,
  // allowing stopImmediatePropagation to prevent doProcess (stub runner).
  btn.addEventListener('click', async e => {
    if (btn.disabled) return; // guard: absorb queued duplicate tap events
    if (!_file) return;
    const mode = btn.dataset.mode || 'process';
    if (mode === 'reset') return;

    // Analysis still running — user clicked too early.
    if (_loading) {
      _showToast(t('val_analysing_pdf'));
      e.stopImmediatePropagation();
      return;
    }

    // Gate: OCR engine not installed.
    if (!_isTextPdf && !_ocrReady) {
      _showToast(t('install_ocr_first'));
      e.stopImmediatePropagation();
      return;
    }

    e.stopImmediatePropagation();

    // If previous detection was inconclusive, open the language picker here —
    // we're still in the synchronous user-gesture stack so showPicker() is allowed.
    if (_requiresManualLang) {
      const selEl = document.getElementById('ocrLangSelect');
      if (selEl) {
        try { selEl.showPicker(); } catch { /* unsupported / sandbox — visual fallback stays */ }
        selEl.focus();
        selEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    // Clear any "suggest language" visual state — user is actually running OCR now
    const _selEl = document.getElementById('ocrLangSelect');
    if (_selEl) { _selEl.style.borderColor = ''; _selEl.style.boxShadow = ''; }
    document.querySelectorAll('.detect-hint').forEach(el => el.remove());

    btn.disabled = true;
    btn.textContent = t('ocr_processing');
    btn.classList.add('ocr-btn--busy');
    const bar = document.getElementById('progressBar');
    if (bar) bar.hidden = false;
    _updateProgress(3, t('ocr_starting'));

    try {
      if (_isTextPdf) {
        _updateProgress(10, t('ocr_preparing'));
        // Already has a text layer on every page — no OCR needed. The PDF
        // itself is already searchable, so it's the primary output (matches
        // what every other OCR tool returns); .txt stays an optional extra
        // via the same checkbox used in the OCR branch below.
        const originalBytes = await _file.arrayBuffer();
        _lastResultBlob = new Blob([originalBytes], { type: 'application/pdf' });
        _lastResultName = _file.name.replace(/\.pdf$/i, '_searchable.pdf');
        if (_downloadAsTxt) {
          const rawText = await _extractTextDirect(_file);
          const pageCount = rawText.split('--- Page ').length - 1;
          const text = _applyHeader(rawText, _file, pageCount);
          _downloadText(text, _file.name);
        }
        // _showSuccess handles the main PDF auto-download via _lastResultBlob
        _showSuccess(t('ocr_already_had_text'));
      } else {
        const myGen = ++_generation;
        // On the SPA home page pdf-lib is already preloaded (no-op below); on
        // standalone tool pages (e.g. /ocr-pdf/) it isn't, so fetch it from CDN
        // now, in parallel with the OCR pass, so it's ready by the time we
        // need it to build the output PDF a few seconds from now.
        const pdfLibPromise = loadPdfLib();
        const { ocrPages, fullText, avgConfidence } = await _runOcr(_file, myGen);
        if (myGen !== _generation) return;
        _updateProgress(95, t('ocr_building_searchable'));
        _setBtnProgress(t('ocr_building_pdf_short'));
        const usedLang = _detectedLang ?? _selectedLang;
        // Mark language model as installed — next visit shows "✓ installed" instead of download notice
        if (usedLang && usedLang !== 'auto') {
          try { localStorage.setItem(`pdfree_ocr_lang_${usedLang}`, '1'); } catch { /* private browsing */ }
          try { localStorage.setItem('pdfree_ocr_last_lang', usedLang); } catch { /* private browsing */ }
        }
        await pdfLibPromise;
        const pdfBytes = await _buildSearchablePdf(_file, ocrPages, usedLang);
        _lastResultBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        _lastResultName = _file.name.replace(/\.pdf$/i, '_searchable.pdf');
        // Secondary .txt alongside the searchable PDF — separate optional file
        if (_downloadAsTxt && fullText) {
          const txtWithHeader = _applyHeader(fullText, _file, ocrPages.length);
          _downloadText(txtWithHeader, _file.name);
        }
        // _showSuccess handles the main PDF auto-download via _lastResultBlob
        const qualityLabel = _ocrQualityLabel(avgConfidence, usedLang);
        _showSuccess(t('ocr_searchable_saved', { quality: qualityLabel }));
      }
    } catch (err) {
      if (err.message === '__LANG_REQUIRED__') {
        // Auto-detection was inconclusive — ask user to select language manually.
        // _showLangRequired() disables the button via _requiresManualLang flag;
        // the finally block calls _syncBtnLabel() which respects that flag.
        _showLangRequired(_detectedLang);
      } else {
        _showToast(t('ocr_error_prefix', { msg: err.message }));
      }
    } finally {
      // _syncBtnLabel() checks _requiresManualLang — if set, keeps button disabled
      btn.classList.remove('ocr-btn--busy');
      if (bar) bar.hidden = true;
      _syncBtnLabel();
    }
  }, true);
}

function _showSuccess(desc) {
  const sc = document.getElementById('successCard');
  if (!sc) return;

  sc.style.display = 'block';
  const title = document.getElementById('successTitle');
  if (title) title.textContent = t('prog_done');
  const descEl = document.getElementById('successDesc');
  if (descEl) descEl.textContent = desc;

  if (!_lastResultBlob || !_lastResultName) {
    sc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  // Auto-download — consistent with all other tools.
  // Blob URL is created fresh each time so re-downloads always work.
  const autoUrl = URL.createObjectURL(_lastResultBlob);
  const autoA   = document.createElement('a');
  autoA.href     = autoUrl;
  autoA.download = _lastResultName;
  document.body.appendChild(autoA);
  autoA.click();
  document.body.removeChild(autoA);
  setTimeout(() => URL.revokeObjectURL(autoUrl), 10000);

  // Show auto-download hint
  const hint = document.getElementById('successAutoHint');
  if (hint) { hint.textContent = t('auto_download_hint', { filename: _lastResultName }); hint.style.display = ''; }

  // Second, more transient confirmation channel — matches app.js's shared
  // _handleSuccess() so OCR's independent success path doesn't diverge.
  setTimeout(() => _showToast(t('download_toast', { filename: _lastResultName })), 400);

  // Wire "Download again" fallback button
  const dlBtn = document.getElementById('downloadBtn');
  if (dlBtn) {
    dlBtn.disabled      = false;
    dlBtn.style.opacity = '';
    dlBtn.textContent   = t('download_again');
    dlBtn.onclick = () => {
      if (!_lastResultBlob) return;
      const url = URL.createObjectURL(_lastResultBlob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = _lastResultName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      // 1.5s grace period matches app.js — gives OS time to initiate the download
      // before disabling the button and showing the privacy-cleared banner.
      setTimeout(() => {
        const banner = document.getElementById('privacyCleared');
        if (banner) banner.classList.add('visible');
        dlBtn.textContent   = t('saved_device');
        dlBtn.disabled      = true;
        dlBtn.style.opacity = '0.5';
      }, 1500);
    };
  }

  // Next steps block — shown after every successful OCR
  let nextSteps = sc.querySelector('.ocr-next-steps');
  if (!nextSteps) {
    nextSteps = document.createElement('div');
    nextSteps.className = 'ocr-next-steps';
    nextSteps.style.cssText = 'margin-top:16px;padding-top:14px;border-top:1px solid var(--border);font-size:13px;';
    nextSteps.innerHTML = `
      <div style="font-weight:600;color:var(--text2);margin-bottom:10px;">${t('ocr_next_steps_title')}</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <a href="${_nextStepHref('pdf2word')}" data-handoff style="display:flex;align-items:center;gap:8px;color:var(--green);text-decoration:none;font-weight:500;">
          <span style="font-size:16px">📝</span> ${t('ocr_next_word')}
        </a>
        <a href="${_nextStepHref('split')}" data-handoff style="display:flex;align-items:center;gap:8px;color:var(--green);text-decoration:none;font-weight:500;">
          <span style="font-size:16px">✂️</span> ${t('ocr_next_split')}
        </a>
        <a href="${_nextStepHref('compress')}" data-handoff style="display:flex;align-items:center;gap:8px;color:var(--green);text-decoration:none;font-weight:500;">
          <span style="font-size:16px">🗜️</span> ${t('ocr_next_compress')}
        </a>
      </div>`;
    // OCR is self-managed and never fires pdfree:success, so the global
    // handoff click interceptor in app.js has no blob to save. We wire it
    // here directly against _lastResultBlob (the searchable PDF only).
    nextSteps.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      const link = e.target.closest('a[data-handoff]');
      if (!link || !_lastResultBlob) return;
      e.preventDefault();
      saveHandoff(_lastResultBlob, _lastResultName, 'ocr', link.href)
        .catch(() => {})
        .then(() => { location.href = link.href; });
    });

    sc.appendChild(nextSteps);
  }

  sc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── TXT header ───────────────────────────────────────────────────────────────
function _buildTxtHeader(file, pageCount) {
  const date = new Date().toISOString().slice(0, 10);
  return t('ocr_txt_header', { name: file.name, pages: pageCount, date });
}

function _applyHeader(text, file, pageCount) {
  if (!_includeTxtHeader) return text;
  return _buildTxtHeader(file, pageCount) + text;
}

// ── OCR pipeline ─────────────────────────────────────────────────────────────
// Target resolution for OCR — Tesseract accuracy peaks at ~300 DPI.
// Resolution is chosen per script family via SCRIPT_PROFILE (see constants):
// CJK needs 3500px for dense ideographs; Arabic/complex 3200px; Latin 3000px.
// All values cap total canvas size to prevent Mobile Safari tab kills.
const MAX_FILE_MB  = 200;
// Mobile Safari aggressively kills tabs under memory pressure.
// Limit page count on iOS/iPadOS to prevent mid-job tab termination.
// Users can still OCR longer documents by splitting the PDF first.
const MAX_PAGES_IOS = 30;

// OCR pipeline:
//   open PDF → text-layer check (skip OCR if found) → resolve language
//   (manual pick, or 'auto': sample pages → script detection → fallback probes
//   if inconclusive, abort and ask user) → createWorker(initial lang)
//   → set CJK params (PSM 11) if applicable → [auto only] reinitialize(detected
//   lang) → re-set CJK params, since reinitialize() resets engine state →
//   per-page: render canvas → counter-rotate if needed → grayscale → binarize
//   (CJK only) → recognize() → confidence-gate (45% complex / 55% latin) →
//   build searchable PDF (+ optional .txt export).
// The "re-set params after reinitialize" step exists because Tesseract.js
// resets engine parameters on reinitialize() — see the PSM-11 re-apply after
// the 'auto' reinitialize() call below; any future reinitialize() call needs
// the same treatment.
async function _runOcr(file, gen) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(
      t('ocr_too_large_for_ocr', { mb: Math.round(file.size / 1024 / 1024), max: MAX_FILE_MB })
    );
  }

  _updateProgress(5, t('p2j_loading_engine'));
  _setBtnProgress(t('ocr_loading_short'));
  await loadPdfJs();

  _updateProgress(8, t('ocr_reading_pdf'));
  const buf    = await file.arrayBuffer();
  let pdfDoc;
  try {
    pdfDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true, ignoreEncryption: true,
    }).promise;
  } catch (err) {
    if (_isPasswordError(err)) {
      throw new Error(t('ocr_password_protected_inline'), { cause: err });
    }
    throw new Error(t('ocr_could_not_open', { msg: err.message }), { cause: err });
  }
  _updateProgress(11, t('ocr_pdf_opened', { n: pdfDoc.numPages }));

  // Guard: warn and cap on Mobile Safari to avoid tab kill under memory pressure
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos && pdfDoc.numPages > MAX_PAGES_IOS) {
    const proceed = window.confirm(
      t('ocr_ios_confirm', { n: pdfDoc.numPages, max: MAX_PAGES_IOS })
    );
    if (!proceed) {
      pdfDoc.destroy();
      throw new Error(t('ocr_cancelled_by_user'));
    }
  }

  // Resolve language: auto-detection or user-chosen
  let resolvedLang = _selectedLang === 'auto' ? 'eng' : _selectedLang;

  let worker;
  try {
  _updateProgress(13, t('ocr_initializing_engine'));
  _setBtnProgress(t('ocr_initializing_short'));
  // Always start with resolved lang (eng for auto); reinitialize after detection if needed
  // Add jpn_vert for Japanese (horizontal + vertical recognition)
  const initTsLang = resolvedLang === 'jpn'     ? 'jpn+jpn_vert'
                   : resolvedLang === 'jpn+eng' ? 'jpn+jpn_vert+eng'
                   : resolvedLang;
  worker = await window.Tesseract.createWorker(initTsLang, 1, {
    logger: m => {
      if (m.status === 'recognizing text') {
        _updateProgress(Math.round(m.progress * 100), t('ocr_recognizing_text', { lang: _getLangName(resolvedLang) }));
      } else if (m.status && m.progress != null) {
        _updateProgress(Math.round(m.progress * 15), t('ocr_loading_lang_short', { lang: _getLangName(resolvedLang) }));
      }
    },
  });

  // PSM 11 (sparse text) works better for CJK invoice/table layouts than PSM 3 (auto).
  // PSM 3 may group kanji blocks suboptimally; PSM 11 finds text anywhere on the page.
  const ps0 = _primaryScript(resolvedLang);
  if (CJK_LANGS.has(ps0)) {
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
  }

  // Auto-detection: sample document, detect dominant script, reinitialize if needed
  if (_selectedLang === 'auto') {
    const cacheKey = _file ? `${_file.name}:${_file.size}` : null;
    let cached = cacheKey ? _langCache.get(cacheKey) : null;
    let detection;
    if (cached) {
      detection = cached;
    } else {
      _updateProgress(14, t('ocr_detecting_lang'));
      const t0 = Date.now();
      detection = await _detectLanguage(pdfDoc, worker);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const switchedNote = _lastDetectionMetrics?.switched
        ? t('ocr_switched_from', { lang: _getLangName(_lastDetectionMetrics.initial) })
        : '';
      _updateProgress(15, t('ocr_detected_in', { lang: _getLangName(detection.lang), elapsed, switched: switchedNote }));
      if (cacheKey) _langCache.set(cacheKey, detection);
    }
    _detectedLang = detection.lang;
    resolvedLang  = detection.lang;
    // Update dropdown label to show detection result
    const sel = document.getElementById('ocrLangSelect');
    if (sel && sel.options[0]) {
      const uncertain = !detection.confident ? t('ocr_uncertain_suffix') : '';
      sel.options[0].textContent = t('ocr_auto_detected', { lang: _getLangName(detection.lang) }) + uncertain;
    }
    // Low confidence → abort OCR and ask user to select language manually.
    // Throwing here exits _runOcr(); the caller's catch block calls
    // _showLangRequired() which disables the button and shows the prompt.
    if (!detection.confident) {
      throw new Error('__LANG_REQUIRED__');
    }
    // Reinitialize with correct model if detection found non-English script
    if (detection.lang !== 'eng') {
      const detTsLang = detection.lang === 'jpn' ? 'jpn+jpn_vert' : detection.lang;
      _updateProgress(15, t('ocr_loading_lang_model', { lang: _getLangName(detection.lang) }));
      await worker.reinitialize(detTsLang);
      // reinitialize() resets engine params — re-apply PSM 11 for CJK (set pre-detection
      // against 'eng' above, so it never took effect for the auto-detect path until now).
      if (CJK_LANGS.has(_primaryScript(detection.lang))) {
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
      }
    }
  }

  const langLabel = _getLangName(resolvedLang);

  const total      = isIos ? Math.min(pdfDoc.numPages, MAX_PAGES_IOS) : pdfDoc.numPages;
  const ocrPages      = [];
  const txtPages      = [];
  const pageErrors    = [];
  let   confSum       = 0;
  let   confCount     = 0;
  const pageDurationsMs = [];

  for (let p = 1; p <= total; p++) {
    const basePct = 15 + Math.round((p - 1) / total * 75);
    let etaSuffix = '';
    if (pageDurationsMs.length > 0) {
      const avgMs = pageDurationsMs.reduce((s, t) => s + t, 0) / pageDurationsMs.length;
      const remainMs = avgMs * (total - p + 1);
      etaSuffix = remainMs >= 60000
        ? t('ocr_eta_min', { n: Math.ceil(remainMs / 60000) })
        : t('ocr_eta_sec', { n: Math.round(remainMs / 1000) });
    }
    _updateProgress(basePct, t('ocr_page_progress', { p, total, lang: langLabel, eta: etaSuffix }));
    _setBtnProgress(t('ocr_page_short', { p, total }));
    const _pageT0 = Date.now();

    let canvas, ocrCanvas;
    try {
      const page = await pdfDoc.getPage(p);

      // Per-page hybrid detection: if this page already has a text layer,
      // extract it directly instead of running Tesseract. This handles hybrid
      // PDFs (e.g. text cover page + scanned appendix) without losing content.
      const tc = await page.getTextContent();
      const pageChars = tc.items.reduce((s, i) => s + i.str.trim().length, 0);
      if (pageChars >= TEXT_CHAR_THRESHOLD) {
        const lines = [];
        for (const item of tc.items) {
          if (!item.str.trim()) continue;
          const iy = Math.round(item.transform[5]);
          const last = lines[lines.length - 1];
          if (last && Math.abs(last.y - iy) <= 4) { last.words.push(item.str); }
          else { lines.push({ y: iy, words: [item.str] }); }
        }
        lines.sort((a, b) => b.y - a.y);
        txtPages.push(`--- Page ${p} ---\n${lines.map(l => l.words.join(' ')).join('\n').trim()}`);
        // Don't add to ocrPages — page already has a text layer, leave it unchanged
        continue;
      }

      // Adaptive scale — aim for MAX_OCR_PX on the longest side, as a hard
      // cap. Old logic (scale=2 default) downsampled high-DPI CamScanner
      // pages from ~2480px to ~1190px before Tesseract, losing fraction bars
      // and small text — fixed by scaling up to the cap. A `Math.max(2, ...)`
      // floor was added at the same time to guarantee that minimum, but it
      // let oversized physical pages (A2/A1 scans, posters — anything wider
      // or taller than ~1500pt) blow past MAX_OCR_PX, risking a Mobile Safari
      // tab kill under memory pressure. Removed: MAX_OCR_PX must stay a true
      // cap, even at the cost of quality on rare oversized pages.
      const vp0 = page.getViewport({ scale: 1 });
      const ps    = _primaryScript(resolvedLang);
      const maxPx = CJK_LANGS.has(ps)     ? SCRIPT_PROFILE.cjk
                  : COMPLEX_LANGS.has(ps) ? SCRIPT_PROFILE.complex
                  : SCRIPT_PROFILE.latin;
      const scale = Math.min(maxPx / vp0.width, maxPx / vp0.height);
      const vp = page.getViewport({ scale });

      canvas        = document.createElement('canvas');
      canvas.width  = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      // Counter-rotate so Tesseract always receives an upright image.
      // PDFs with /Rotate 180 or 270 would otherwise produce garbage confidence.
      // _rotateBackBbox then maps word bboxes back to display-canvas space so
      // _buildSearchablePdf can use vpTransform unchanged.
      const pageRotation = page.rotate || 0;
      ocrCanvas = pageRotation !== 0 ? _counterRotateCanvas(canvas, pageRotation) : canvas;

      const gray = _toGrayscale(ocrCanvas);
      if (CJK_LANGS.has(_primaryScript(resolvedLang))) _binarizeInPlace(gray);
      const result = await worker.recognize(gray);
      // Adaptive confidence threshold — see COMPLEX_LANGS constant.
      // Latin (eng/fra/…): 55% — Tesseract is reliable; below 55% is almost always garbage.
      // Complex (ara/jpn/kor/hin/tha/…): 45% — correct glyphs routinely score 40–50%,
      // so 55% would silently discard real text for these scripts.
      const MIN_CONF = COMPLEX_LANGS.has(_primaryScript(resolvedLang)) ? 45 : 55;
      const words    = result.data.words.flatMap(w => {
        const text = w.text.normalize('NFC').trim();
        if (!text || w.confidence < MIN_CONF) return [];
        confSum += w.confidence;
        confCount++;
        const bbox = pageRotation !== 0
          ? _rotateBackBbox(w.bbox, pageRotation, canvas.width, canvas.height)
          : w.bbox;
        return [{ text, confidence: w.confidence, bbox }];
      });

      // Store viewport transform — used in _buildSearchablePdf to map canvas→PDF coords
      // correctly for any page rotation (0, 90, 180, 270°)
      ocrPages.push({
        pageNum: p, words,
        canvasW: canvas.width, canvasH: canvas.height,
        vpTransform: Array.from(vp.transform),
      });

      // Build plain text from paragraph/line structure
      const paragraphs = result.data.paragraphs
        .map(para => para.lines
          .map(line => line.words.map(w => w.text).join(' ').trim())
          .filter(Boolean)
          .join('\n'))
        .filter(Boolean);
      txtPages.push(`--- Page ${p} ---\n${paragraphs.join('\n\n') || result.data.text.trim()}`);

    } catch (pageErr) {
      // One bad page must not kill the whole job — skip and continue
      pageErrors.push({ page: p, error: pageErr.message });
    } finally {
      // Always release canvas memory regardless of success or error
      if (ocrCanvas && ocrCanvas !== canvas) { ocrCanvas.width = 0; ocrCanvas.height = 0; }
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      pageDurationsMs.push(Date.now() - _pageT0);
    }

    // Bail early if user started a new OCR (new file selected or button re-clicked)
    if (gen !== _generation) break;
  }

  if (gen === _generation) _updateProgress(92, t('ocr_complete'));

  // Surface per-page failures as a non-fatal warning toast
  if (pageErrors.length > 0) {
    const nums = pageErrors.map(e => e.page).join(', ');
    _showToast(t('warn_page_fail', { page: nums, msg: pageErrors[0].error }));
  }

  const avgConfidence = confCount > 0 ? Math.round(confSum / confCount) : null;
  return { ocrPages, fullText: txtPages.join('\n\n'), avgConfidence };
  } finally {
    // Always terminate — prevents thread leak if recognize() or render() throws
    await worker?.terminate();
    pdfDoc.destroy();
  }
}

function _getLangName(code) {
  const all = [...LANGUAGES.european, ...LANGUAGES.complex];
  const found = all.find(l => l.code === code);
  return found ? found.name : code;
}

function _ocrQualityLabel(avgConf, lang) {
  if (avgConf === null) return '';
  if (COMPLEX_LANGS.has(_primaryScript(lang))) {
    // Complex-script confidence is structurally lower even for correct text.
    // Show the raw number with an honest note so users aren't misled.
    return t('ocr_quality_complex', { pct: avgConf, lang: _getLangName(lang) });
  }
  let tier;
  if (avgConf >= 90)      tier = t('ocr_quality_excellent', { pct: avgConf });
  else if (avgConf >= 80) tier = t('ocr_quality_good', { pct: avgConf });
  else if (avgConf >= 60) tier = t('ocr_quality_fair', { pct: avgConf });
  else                    tier = t('ocr_quality_poor', { pct: avgConf });
  return t('ocr_quality_prefix', { tier });
}

// ── Direct text extraction (text-layer PDFs) ─────────────────────────────────
async function _extractTextDirect(file) {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(
      t('ocr_file_too_large_extract', { mb: Math.round(file.size / 1024 / 1024), max: MAX_FILE_MB })
    );
  }
  await loadPdfJs();
  const buf    = await file.arrayBuffer();
  const pdfDoc = await window.pdfjsLib.getDocument({
    data: new Uint8Array(buf), verbosity: 0, disableJavaScript: true, ignoreEncryption: true,
  }).promise;

  const texts = [];
  const total = pdfDoc.numPages;
  for (let p = 1; p <= total; p++) {
    _updateProgress(Math.round(p / total * 90), t('ocr_extracting_page', { p, total }));
    const page = await pdfDoc.getPage(p);
    const tc   = await page.getTextContent();
    // Group items into lines by Y position (items within 4pt of same baseline → same line).
    // 4pt tolerance handles baseline variation in real PDFs without merging adjacent lines.
    const lines = [];
    for (const item of tc.items) {
      if (!item.str.trim()) continue;
      const iy = Math.round(item.transform[5]);
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - iy) <= 4) {
        last.words.push(item.str);
      } else {
        lines.push({ y: iy, words: [item.str] });
      }
    }
    // Sort lines top-to-bottom (higher Y = higher on page in PDF coords)
    lines.sort((a, b) => b.y - a.y);
    const text = lines.map(l => l.words.join(' ')).join('\n');
    texts.push(`--- Page ${p} ---\n${text.trim()}`);
  }
  pdfDoc.destroy();
  _updateProgress(100, t('ocr_done'));
  return texts.join('\n\n');
}

// ── Canvas preprocessing ──────────────────────────────────────────────────────

// Convert rendered page to grayscale before passing to Tesseract.
// Benefits:
//   1. Removes color noise introduced by scanner or CamScanner processing.
//   2. Eliminates colored backgrounds (bar charts, highlighted cells) that
//      can reduce text/background contrast for the OCR engine.
//   3. Slightly reduces memory pressure — grayscale data is the same size
//      as RGBA, but the uniform channels help Tesseract's thresholding.
// The source canvas is NOT modified — a new canvas is returned and released
// by the caller immediately after recognize().
function _toGrayscale(src) {
  const dst = document.createElement('canvas');
  dst.width  = src.width;
  dst.height = src.height;
  const ctx  = dst.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, dst.width, dst.height);
  const d   = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // ITU-R BT.601 luminance weights (same as CSS grayscale filter)
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return dst;
}

// Compute Otsu's optimal binarization threshold from grayscale image data.
// Maximises between-class variance between foreground (dark text) and
// background (light page) — adapts to each page's actual contrast level
// rather than using a fixed cut-off.
function _otsuThreshold(data) {
  const hist  = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
  const total = data.length / 4;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, varMax = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) ** 2;
    if (varBetween > varMax) { varMax = varBetween; threshold = t; }
  }
  return threshold;
}

// Apply Otsu binarization in-place on a grayscale canvas.
// Only called for CJK scripts — kanji strokes are thin (1–3px) and benefit
// from clean black/white separation; intermediate grey values confuse Tesseract
// when a stroke is only slightly darker than the page background.
// Latin/Cyrillic/Arabic glyphs are thicker and already handled well by
// grayscale alone; binarizing them risks destroying anti-aliasing details.
function _binarizeInPlace(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d   = img.data;
  const t   = _otsuThreshold(d);
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] < t ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

// ── Canvas rotation helpers ───────────────────────────────────────────────────

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
// original display canvas space so _buildSearchablePdf can apply vpTransform
// without modification. Derivation: invert the affine applied by
// _counterRotateCanvas for each of the four standard PDF rotation values.
// W, H are the display canvas (pre-rotation) dimensions.
function _rotateBackBbox({ x0, y0, x1, y1 }, R, W, H) {
  if (R === 90)  return { x0: W - y1, y0: x0,     x1: W - y0, y1: x1     };
  if (R === 180) return { x0: W - x1, y0: H - y1, x1: W - x0, y1: H - y0 };
  if (R === 270) return { x0: y0,     y0: H - x1, x1: y1,     y1: H - x0 };
  return { x0, y0, x1, y1 };
}

// ── Searchable PDF builder ────────────────────────────────────────────────────

// Languages whose scripts fall outside Latin-1 (Windows-1252).
// Helvetica only covers codepoints 0-255; everything here starts at U+0400+.
const NON_LATIN_LANGS = new Set(['ara', 'jpn', 'chi_sim', 'chi_tra', 'kor', 'hin', 'tha', 'rus', 'pol']);

// TTF URLs from Google Fonts CDN (variable fonts; verified 2026-05).
// pdf-lib requires TTF or OTF — WOFF/WOFF2 cannot be embedded.
const NOTO_FONT_URLS = {
  ara:     'https://fonts.gstatic.com/s/notosansarabic/v33/nwpPtLGrOAZMl5nJ_wfgRg3DrWFZQML36H986K0.ttf',
  jpn:     'https://fonts.gstatic.com/s/notosansjp/v56/-F62fjtqLzI2JPCgQBnw7HFoxgIO2lZ9hg.ttf',
  chi_sim: 'https://fonts.gstatic.com/s/notosanssc/v40/k3kXo84MPvpLmixcA63oeALhKYiJ-Q7m8w.ttf',
  chi_tra: 'https://fonts.gstatic.com/s/notosanstc/v39/-nF7OG829Oofr2wohFbTp9iFPysLA_ZJ1g.ttf',
  kor:     'https://fonts.gstatic.com/s/notosanskr/v39/PbykFmXiEBPT4ITbgNA5Cgm21nTs4JMMuA.ttf',
  hin:     'https://fonts.gstatic.com/s/notosansdevanagari/v30/TuGOUUFzXI5FBtUq5a8bjKYTZjtRU6Sgv2lRdRhtCC4d.ttf',
  tha:     'https://fonts.gstatic.com/s/notosansthai/v29/iJWdBXeUZi_OHPqn4wq6hQ2_hah-5c-dUX0x.ttf',
  // Cyrillic (Russian, Polish use extended Latin too — Noto Sans covers both)
  rus:     'https://fonts.gstatic.com/s/notosans/v42/o-0IIpQlx3QUlC5A4PNb4j5Ba_2c7A.ttf',
  pol:     'https://fonts.gstatic.com/s/notosans/v42/o-0IIpQlx3QUlC5A4PNb4j5Ba_2c7A.ttf',
};

// In-memory cache of fetched Noto TTF bytes — avoids re-downloading on
// repeated exports within the same session (CJK fonts can be 10–17 MB).
const _notoFontCache = new Map();

// IndexedDB persistence for Noto fonts — survives page reloads.
// CJK users currently re-download 17 MB every session; IDB makes it one-time.
let _idbConn = null;
function _openFontIdb() {
  if (_idbConn) return _idbConn;
  _idbConn = new Promise((resolve, reject) => {
    const req = indexedDB.open('pdfree-ocr-fonts', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('fonts');
    req.onsuccess    = e => resolve(e.target.result);
    req.onerror      = () => { _idbConn = null; reject(req.error); };
  });
  return _idbConn;
}
async function _idbGetFont(lang) {
  try {
    const db = await _openFontIdb();
    return new Promise(resolve => {
      const req = db.transaction('fonts', 'readonly').objectStore('fonts').get(lang);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => resolve(null);
    });
  } catch { return null; }
}
async function _idbSetFont(lang, bytes) {
  try {
    const db = await _openFontIdb();
    return new Promise(resolve => {
      const tx = db.transaction('fonts', 'readwrite');
      tx.objectStore('fonts').put(bytes, lang);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch { /* ignore — IDB write failure is non-fatal */ }
}

// Register fontkit with pdf-lib so that custom TTF fonts can be embedded
// and subset (only used glyphs included — keeps file size small for CJK fonts).
// fontkit.umd.js exposes window.fontkit; must be loaded before this runs.
function _ensureFontkitRegistered(pdfDoc) {
  if (window.fontkit && !pdfDoc._fontkitRegistered) {
    pdfDoc.registerFontkit(window.fontkit);
    pdfDoc._fontkitRegistered = true;
  }
}

// Returns an embedded font suitable for the selected OCR language.
// Latin languages: Helvetica (no network request).
// Non-Latin: fetch the appropriate Noto Sans TTF from Google Fonts CDN,
// register fontkit, and embed with subset:true so only the glyphs that
// actually appear in the document are included — prevents CJK fonts from
// inflating the output PDF by 10–18 MB.
async function _getFontForLang(pdfDoc, lang) {
  const { StandardFonts } = window.PDFLib;

  if (!NON_LATIN_LANGS.has(lang)) {
    return pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  const url = NOTO_FONT_URLS[lang];
  try {
    let bytes = _notoFontCache.get(lang);
    if (!bytes) {
      // Try IndexedDB before hitting the network — one-time download per browser profile
      bytes = await _idbGetFont(lang);
      if (bytes) {
        _notoFontCache.set(lang, bytes);
      }
    }
    if (!bytes) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = await resp.arrayBuffer();
      _notoFontCache.set(lang, bytes);
      _idbSetFont(lang, bytes); // fire-and-forget — failure is non-fatal
    }
    // fontkit must be registered before embedFont can accept raw TTF bytes.
    // subset:true keeps only the glyphs that appear in the document — critical
    // for CJK fonts (Noto Sans SC is 17 MB full; a typical page uses <100 KB).
    _ensureFontkitRegistered(pdfDoc);
    if (!window.fontkit) {
      // fontkit script not yet loaded — Noto cannot be embedded; use Helvetica.
      // Invisible layer will lack non-Latin glyphs but PDF will not be corrupted.
      return pdfDoc.embedFont(StandardFonts.Helvetica);
    }
    return pdfDoc.embedFont(bytes, { subset: true });
  } catch {
    // CDN unreachable or embed failed — fall back to Helvetica.
    // The invisible text layer will not contain non-Latin glyphs,
    // but the PDF itself will not be corrupted.
    return pdfDoc.embedFont(StandardFonts.Helvetica);
  }
}

// Invert a 6-element affine transform [a,b,c,d,e,f].
// Used to map canvas pixel coords back to PDF user-space coords — handles
// any page rotation (0/90/180/270°) without special-casing each angle.
function _invertTransform([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-10) return null;
  return [d/det, -b/det, -c/det, a/det, (c*f - d*e)/det, (b*e - a*f)/det];
}

function _applyTransform([a, b, c, d, e, f], x, y) {
  return { x: a*x + c*y + e, y: b*x + d*y + f };
}

async function _buildSearchablePdf(file, ocrPages, lang) {
  if (!window.PDFLib) {
    throw new Error('pdf-lib not loaded — cannot build searchable PDF');
  }
  const {
    PDFDocument,
    pushGraphicsState, popGraphicsState, setTextRenderingMode,
    TextRenderingMode,
  } = window.PDFLib;

  // Tr=3 (ISO 32000-1 §9.3.6): "neither fill nor stroke" — text goes into content
  // stream for search/copy but is never painted. We write it via pushOperators()
  // because the bundled pdf-lib.min.js ignores the renderingMode option in drawText.
  const TR_INVISIBLE = TextRenderingMode?.Invisible ?? 3;

  const buf    = await file.arrayBuffer();
  const pdfDoc = await PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true });
  const font   = await _getFontForLang(pdfDoc, lang ?? 'eng');
  const pages  = pdfDoc.getPages();

  for (const { pageNum, words, vpTransform } of ocrPages) {
    const page = pages[pageNum - 1];
    if (!page) continue;

    const inv = vpTransform ? _invertTransform(vpTransform) : null;
    if (!inv) continue;

    // Open one graphics state scope per page: save current state, set Tr=3.
    // Every page.drawText() call below inherits Tr=3 through its own inner q/Q.
    page.pushOperators(
      pushGraphicsState(),
      setTextRenderingMode(TR_INVISIBLE),
    );

    for (const w of words) {
      if (!w.text.trim() || w.confidence < 20) continue;
      const { x0, y0, x1, y1 } = w.bbox;

      // Transform all four bbox corners to PDF user-space, then derive the
      // axis-aligned bounding box. This is rotation-agnostic: for 0°/180° pages
      // the canvas x-axis is the PDF x-axis; for 90°/270° they are swapped.
      const corners = [
        _applyTransform(inv, x0, y0),
        _applyTransform(inv, x0, y1),
        _applyTransform(inv, x1, y0),
        _applyTransform(inv, x1, y1),
      ];
      const pdfX0 = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
      const pdfY0 = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
      const pdfX1 = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
      const pdfY1 = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);

      const wordW    = pdfX1 - pdfX0;
      const wordH    = pdfY1 - pdfY0;
      const fontSize = Math.max(4, Math.min(wordH * 0.85, 72));

      try {
        page.drawText(w.text, {
          x:        pdfX0,
          y:        pdfY0,
          size:     fontSize,
          font,
          maxWidth: wordW + 2,
        });
      } catch {
        // Skip words with unsupported glyphs or out-of-bounds coords
      }
    }

    // Restore graphics state — Tr resets to what it was before our q.
    page.pushOperators(popGraphicsState());
  }

  _updateProgress(98, t('ocr_saving_pdf'));
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  _updateProgress(100, t('ocr_done'));
  return bytes;
}

// ── Download helpers ──────────────────────────────────────────────────────────
function _downloadPdf(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename.replace(/\.pdf$/i, '_searchable.pdf');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function _downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename.replace(/\.pdf$/i, '.txt');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function _setBtnProgress(label) {
  const btn = document.getElementById('mergeBtn');
  if (btn && btn._ocrBound && btn.classList.contains('ocr-btn--busy')) {
    btn.textContent = label;
  }
}

function _updateProgress(pct, label) {
  const fill = document.getElementById('progressFill');
  const lbl  = document.getElementById('progressLabel');
  const bar  = document.getElementById('progressBar');
  if (bar)  bar.hidden  = false;
  if (fill) fill.style.width = pct + '%';
  if (lbl)  lbl.textContent  = label;
}

function _showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

function _spinnerHTML(msg) {
  return `<div style="padding:24px 16px;text-align:center;color:var(--text3);font-size:14px;">
    <div style="font-size:24px;margin-bottom:8px;">&#x23F3;</div>${msg}</div>`;
}

function _isPasswordError(err) {
  return err?.name === 'PasswordException' || /password/i.test(err?.message ?? '');
}

function _errorHTML(msg, title = t('ocr_error_title')) {
  return `<div style="padding:16px;border:1px solid #fca5a5;border-radius:10px;background:#fff1f2;color:#dc2626;font-size:13px;">
    <strong>${title}</strong><br>${msg}
  </div>`;
}

