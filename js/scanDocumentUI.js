// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanDocumentUI.js — "Document Scanner" tool: camera + gallery
//  photos, EVERY image goes through the corner-detect/crop-review
//  modal (js/scanCameraUI.js) before being accepted — unlike jpg2pdf,
//  where that review is opt-in per-photo (Scan with Camera button
//  only) so gallery-picking stays fast/frictionless for its "quickly
//  combine existing images" use case. Split into two separate tools
//  2026-08-22 specifically to keep that distinction real, not force
//  review friction onto jpg2pdf's users.
//
//  Assembly reuses jpg2pdf's PDF-building path unmodified — registered
//  with runner:'jpg2pdf' in js/toolRegistrations.js, so getParams()
//  here returns the exact same shape getJpg2PdfParams() does and
//  handleJpg2Pdf (js/worker.js) runs with zero changes. Zero new
//  worker code for this whole tool.
//
//  Review-gating: every File that lands in selectedFiles gets tagged
//  file._scanReviewed = true once it's been through SOME form of
//  review (camera output arrives already tagged; gallery-picked files
//  start untagged). initScanDocumentOptions() diffs incoming files
//  against that tag, queues untagged ones, and processes the queue
//  SEQUENTIALLY (one review modal at a time, not all at once) via
//  js/scanCameraUI.js's openCropReview() — confirm crops+filters+
//  replaces the entry in selectedFiles; skip tags the original
//  unprocessed file reviewed and leaves it alone (a real photo might
//  not be a document at all — must have an escape hatch).
// ============================================================

import { id, esc as _esc } from './utils.js';
import { OCR_LANGUAGES } from './ocrUI.js';
import { ocrLangForLocale } from './ocrEngine.js';
import { getLang } from './config.js';
import { t } from './i18n.js';
import { showToast } from './ui.js';
import { selectedFiles, isFilesLocked, addFiles, removeFile } from './files.js';
import { bindDragReorder } from './dragReorder.js';
import { presetRememberCard } from './uiComponents.js';
import { loadPreset, clearPreset } from './presets.js';
import { isHeicFile, decodeHeicToJpegBlob } from './heicDecode.js';
import { filterScanPhoto } from './scanFilter.js';
import { openScanCamera, openCropReview } from './scanCameraUI.js';
import { detectDocumentQuad, fullFrameQuad, warpToRectAsync } from './scanGeometry.js';
import { loadOpenCv } from './lazyLibs.js';
import { SCAN_MAX_LONG_EDGE } from './scanConstants.js';

const _MANY_IMAGES_WARN_THRESHOLD = 80; // same soft heads-up as jpg2pdfUI.js
let _warnedManyImages = false;

// Draws `img` into a NEW canvas capped to SCAN_MAX_LONG_EDGE (see
// js/scanConstants.js for why), scaled uniformly so it never upscales a
// source that's already smaller. Shared by every decode path below so
// the cap can't be missed on one of them.
//
// No manual EXIF-rotation step here. This function used to also take an
// `angle` param and manually re-rotate via ctx.rotate() for a nonzero
// EXIF orientation, on the (wrong) assumption that `img` was still in
// its raw, un-rotated sensor orientation. Real, shipped bug — found via
// a real user report ("vertical photo becomes horizontal"), root-caused
// by verifying directly (real JPEG, EXIF orientation=6, real Chromium):
// the browser's own <img> decode ALREADY auto-applies EXIF orientation
// — naturalWidth/naturalHeight and everything drawImage() draws are
// already correctly, permanently rotated by the time onload fires. The
// old manual rotation was a real double-rotation on top of that — same
// class of bug already fixed once in this project for a DIFFERENT tool
// (jpg2pdf's handleJpg2Pdf; see the feedback_image_orientation_single_source
// lesson: never layer manual EXIF rotation on top of the browser's own —
// trust exactly one source).
function _capLongEdge(img) {
  const rawW = img.naturalWidth, rawH = img.naturalHeight;
  const scale = Math.min(1, SCAN_MAX_LONG_EDGE / Math.max(rawW, rawH));
  const outW  = Math.max(1, Math.round(rawW * scale));
  const outH  = Math.max(1, Math.round(rawH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  canvas.getContext('2d').drawImage(img, 0, 0, outW, outH);
  return canvas;
}

// ── State ──────────────────────────────────────────────────────
let _pageSize    = 'auto';
let _orientation = 'auto';
let _scanFilterMode = 'grayscale';
// Phase 2 of the competitor catch-up (see [[scandoc_competitor_catchup_plan_2026_08]]
// memory) — manual brightness/contrast, previously baked into
// js/scanFilterWorker.js's fixed _STRENGTH=0.5 with "no exposed UI
// control in v1". -50..50, 0 = the same baseline look that constant
// already produced (an ADJUSTMENT on top of it, not a from-scratch
// value — 0 must reproduce exactly what shipped before this existed).
let _scanBrightness = 0;
let _scanContrast   = 0;
let _compress    = true;
let _quality     = 0.82;
let _exifAngles  = [];
let _rememberLoaded   = false;
let _settingsRendered = false;
let _reviewQueue  = [];   // File[] waiting to go through openCropReview
let _reviewingNow = false; // guards against starting a 2nd review modal while one is open

let _cropProcessing = null;
let _optionsGeneration = 0;
const _originalPhotos = new WeakMap();
const _pageFilters = new WeakMap();
const _pageCrops = new WeakMap();
const SCAN_FILTERS = ['original', 'grayscale', 'faded', 'color', 'bw'];

async function _makeScanPage(canvas, name, original, settings = { mode: _scanFilterMode, ..._scanAdjust() }) {
  const { mode, brightness, contrast } = settings;
  const adjust = { brightness, contrast };
  // Keep a compact unfiltered crop so repeated edits never compound a filter.
  const source = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.96));
  const blob = await filterScanPhoto(canvas, mode, adjust);
  const file = new File([blob], name, { type: blob.type });
  file._scanReviewed = true;
  if (source) _pageFilters.set(file, { source, mode, ...adjust });
  if (original) _originalPhotos.set(file, original);
  return file;
}

function _scanAdjust() {
  return { brightness: _scanBrightness, contrast: _scanContrast };
}

export function getScanDocumentParams() {
  return { ocrLanguage: id('sdRecognizeText')?.checked ? id('sdOcrLanguage').value : null,
           pageSize: _pageSize, orientation: _orientation,
           compress: _compress, quality: _quality, exifAngles: _exifAngles,
           // Not a real assembly param — read by toolRegistrations.js's
           // validate() to block submitting while a review modal is
           // still queued/open, so a page can't slip through unreviewed.
           cropProcessing: _cropProcessing,
           reviewPending: _reviewingNow || _reviewQueue.length > 0,
           hasFiles: selectedFiles.length > 0 };
}

// ── Public API ─────────────────────────────────────────────────

export async function initScanDocumentOptions(files) {
  const container = id('scanDocumentOptions');
  if (!container) return;

  if (files.length === 0) { hideScanDocumentOptions(); return; }
  const generation = ++_optionsGeneration;

  if (!_rememberLoaded) {
    _rememberLoaded = true;
    const saved = loadPreset('scanDocument');
    if (saved) {
      _pageSize    = saved.pageSize    ?? _pageSize;
      _orientation = saved.orientation ?? _orientation;
      _compress    = saved.compress    ?? _compress;
      _quality     = saved.quality     ?? _quality;
    }
  }

  if (!_settingsRendered) {
    container.innerHTML = `
      <div class="j2p-loading">
        <span class="compress-loading__spinner" aria-hidden="true"></span>
        ${t('sd_loading')}
      </div>
    `;
  }
  container.style.display = 'block';

  const angles = await Promise.all(files.map(_readExifAngle));
  if (generation !== _optionsGeneration) return;
  _exifAngles = angles;

  if (files.length > _MANY_IMAGES_WARN_THRESHOLD && !_warnedManyImages) {
    _warnedManyImages = true;
    showToast(t('warn_many_images', { n: files.length }), 7000);
  }
  if (files.length <= _MANY_IMAGES_WARN_THRESHOLD) _warnedManyImages = false;

  _render(files);
  _queueUnreviewedFiles(files);
}

export function hideScanDocumentOptions() {
  ++_optionsGeneration;
  const container = id('scanDocumentOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _pageSize = 'auto'; _orientation = 'auto'; _scanFilterMode = 'grayscale';
  _scanBrightness = 0; _scanContrast = 0;
  _compress = true; _quality = 0.82; _exifAngles = [];
  _warnedManyImages = false; _rememberLoaded = false; _settingsRendered = false;
  _reviewQueue = []; _reviewingNow = false; _cropProcessing = null;
}

// ── Review-gating queue ───────────────────────────────────────
// Every new, untagged file gets queued and reviewed ONE AT A TIME —
// confirmed via AskUserQuestion during planning: showing N review
// modals back-to-back is real friction, but it's expected friction
// here (this tool's whole point), unlike showing them simultaneously
// which would just be confusing.

function _queueUnreviewedFiles(files) {
  const unreviewed = files.filter(f => !f._scanReviewed && !_reviewQueue.includes(f));
  if (unreviewed.length === 0) return;

  // Real user request: reviewing many photos one modal at a time is real
  // friction for a big batch (e.g. a folder of diplomas/ID pages/medical
  // records). Only offered on a genuinely fresh batch (idle queue, 2+
  // photos) — a single photo, or more arriving mid-review, just joins the
  // queue as before; the choice would be noise there.
  if (unreviewed.length > 1 && !_reviewingNow && !_cropProcessing && _reviewQueue.length === 0) {
    _promptBatchMode(unreviewed);
    return;
  }

  _reviewQueue.push(...unreviewed);
  _drainReviewQueue();
}

// Auto-crop path deliberately reuses the exact same real functions the
// interactive review modal calls (detectDocumentQuad/fullFrameQuad/
// warpToRect/filterScanPhoto) — same detection, same fallback, same
// filter pipeline, just without stopping for a human to look at each
// one. Single-page only (book-spread's gutter split needs the user's own
// adjustment — no reasonable default exists there, so that mode is
// simply not offered for batch auto-apply).
async function _promptBatchMode(files) {
  await loadOpenCv().catch(() => {}); // best-effort warmup; a failure just means fullFrameQuad is used for every photo below
  const modal = document.createElement('div');
  modal.className = 'scan-cam-modal scan-cam-modal--open';
  modal.innerHTML = `
    <div class="scan-cam-modal__card" role="dialog" aria-modal="true" aria-label="${t('sd_batch_title')}">
      <p style="margin:0 0 16px;text-align:center;">${t('sd_batch_prompt', { n: files.length })}</p>
      <div class="scan-cam-actions">
        <button type="button" class="split-action-btn" id="sdBatchReviewEach">${t('sd_batch_review_each')}</button>
        <button type="button" class="split-action-btn" id="sdBatchAutoAll">${t('sd_batch_auto_all')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  id('sdBatchReviewEach').addEventListener('click', () => {
    modal.remove();
    _reviewQueue.push(...files);
    _drainReviewQueue();
  });
  id('sdBatchAutoAll').addEventListener('click', () => {
    modal.remove();
    const status = id('sdCropStatus');
    if (status) status.textContent = t('scan_cam_processing');
    const processing = _autoProcessAll(files).finally(() => {
      if (_cropProcessing !== processing) return;
      _cropProcessing = null;
      if (status) status.textContent = '';
      _drainReviewQueue();
    });
    _cropProcessing = processing;
  });
}

async function _autoProcessAll(files) {
  let applied = true;
  for (const file of files) {
    // Same "removed while queued" escape hatch _drainReviewQueue already has.
    if (!selectedFiles.includes(file)) continue;
    try {
      const sourceCanvas = await _decodeSourcePhoto(file);
      let quad = null;
      try { quad = detectDocumentQuad(sourceCanvas); } catch { /* falls through to fullFrameQuad below */ }
      quad = quad || fullFrameQuad(sourceCanvas.width, sourceCanvas.height);
      const warped = await warpToRectAsync(sourceCanvas, quad);
      const baseName = file.name.replace(/\.\w+$/, '');
      const reviewedFile = await _makeScanPage(warped, baseName + '-scan.jpg', file);
      _pageCrops.set(reviewedFile, { frame: file, quad });
      const idx = selectedFiles.indexOf(file);
      if (idx !== -1) {
        selectedFiles.splice(idx, 1, reviewedFile);
        _exifAngles.splice(idx, 1, 0); // baked into the warp already, same as the reviewed-confirm path
      }
    } catch {
      // Same recovery as _drainReviewQueue's catch: tag reviewed so it's
      // never retried in a loop, leave the file as-is, surface a toast.
      applied = false;
      file._scanReviewed = true;
      showToast(t('sd_review_decode_failed', { name: file.name }));
    }
    _render(selectedFiles); // per-photo, not just at the end — batch progress stays visible
  }
  return applied;
}

async function _drainReviewQueue() {
  if (_reviewingNow || _cropProcessing || _reviewQueue.length === 0) return;
  _reviewingNow = true;
  const file = _reviewQueue.shift();

  // The file may have been removed from selectedFiles while queued
  // (user deleted it before its review turn came up) — skip silently.
  if (!selectedFiles.includes(file)) { _reviewingNow = false; _drainReviewQueue(); return; }

  try {
    const sourceCanvas = await _decodeSourcePhoto(file);
    openCropReview({
      sourceCanvas,
      // warpedCanvases: 1 entry for single-page mode, 2 for book-spread
      // mode (left/right page, already split — see scanCameraUI.js's
      // _startSpineAdjust). Either way, replace the one queued `file`
      // with however many reviewed pages came out of it.
      onConfirm: (warpedCanvases, crop) => _applyReviewedCrop(file, warpedCanvases, {
        ...crop, originalFrame: crop.frame === sourceCanvas ? file : null,
      }, _drainReviewQueue),
      onSkip: () => {
        file._scanReviewed = true; // leave the original file + its real EXIF angle untouched
        _reviewingNow = false;
        _render(selectedFiles);
        _drainReviewQueue();
      },
    });
  } catch {
    // Decode failure (corrupt image, unsupported format) — tag reviewed
    // so it doesn't loop forever, leave it in the list as-is, let the
    // final assembly step surface any real problem with it.
    file._scanReviewed = true;
    showToast(t('sd_review_decode_failed', { name: file.name }));
    _reviewingNow = false;
    _drainReviewQueue();
  }
}

// Real, observed failure mode on memory-constrained devices: decoding a
// very large source image can leave the browser's own internal decoder
// stuck — neither onload nor onerror ever fires (a known Chromium
// behavior under memory pressure, separate from — and upstream of —
// SCAN_MAX_LONG_EDGE's cap, which only shrinks the canvas AFTER this
// decode already succeeded). An un-timed-out await here hangs the whole
// review queue FOREVER: no toast, no visible change, and retrying does
// nothing since _reviewingNow never resets — reported for real as
// "ничего не меняется" (nothing visibly happens), sometimes, on
// "Choose File". Wrapping with a timeout converts that into the SAME
// recoverable decode-failure path _drainReviewQueue's catch already
// handles (tags the file reviewed, shows a toast, unblocks the queue).
const _DECODE_TIMEOUT_MS = 20000;

function _loadImageWithTimeout(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    const timer = setTimeout(() => rej(new Error('image decode timed out')), _DECODE_TIMEOUT_MS);
    img.onload  = () => { clearTimeout(timer); res(img); };
    img.onerror = () => { clearTimeout(timer); rej(new Error('image decode failed')); };
    img.src = url;
  });
}

// The crop review needs a correctly-oriented image up front — corner
// detection on a sideways photo would be meaningless. No manual EXIF
// rotation needed here (see _capLongEdge's own comment for the real bug
// that used to live here): the browser's own <img> decode already
// applies it.
async function _decodeSourcePhoto(file) {
  const source = isHeicFile(file) ? (await decodeHeicToJpegBlob(file)) ?? file : file;
  const url = URL.createObjectURL(source);
  let img;
  try {
    img = await _loadImageWithTimeout(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  return _capLongEdge(img);
}

// ── "Take Photo" — always goes through the live camera + review
//    modal (this tool's whole point). Falls back to a plain native
//    capture input (no review — same graceful-degradation reasoning
//    as jpg2pdf's fallback) only when getUserMedia isn't supported.
//
//    Lives in scan-document/index.html's STATIC HTML (like the
//    drop-zone itself), not inside #scanDocumentOptions — real bug
//    found+fixed during the 2026-08-22 QA pass: the panel (and
//    anything inside it) only ever renders once files.length > 0, so a
//    "Take Photo" button INSIDE it could never be clicked for the
//    FIRST photo — a chicken-and-egg dead end. Bound once here, at
//    module load, not inside _render().
//
//    Adds the resulting file via the real addFiles() (js/files.js) —
//    same choke point every other file-add path in this codebase goes
//    through — rather than manually pushing to selectedFiles/_exifAngles
//    and calling _render() directly, so initScanDocumentOptions() runs
//    for real (sets container display:block, computes EXIF, etc.) even
//    on the very first photo, when the panel has never rendered before. ──

function _bindTakePhotoButton() {
  const btn   = id('sdTakePhotoBtn');
  const input = id('sdTakePhotoInput');
  if (!btn || !input) return;

  btn.addEventListener('click', () => {
    if (navigator.mediaDevices?.getUserMedia) {
      openScanCamera({
        // canvases: 1 for single-page, 2 for book-spread mode (already
        // split left/right — see scanCameraUI.js's _startSpineAdjust).
        onConfirm: async (canvases, isCurrent, crop) => {
          const frame = await _encodeCropFrame(crop.frame);
          const stamp = Date.now();
          const files = [];
          for (let i = 0; i < canvases.length; i++) {
            const suffix = canvases.length > 1 ? `-${i + 1}` : '';
            const file = await _makeScanPage(canvases[i], `scan-${stamp}${suffix}.jpg`);
            if (frame && crop.quad) _pageCrops.set(file, { frame, quad: crop.quad });
            files.push(file);
          }
          if (isCurrent()) addFiles(files);
        },
        onFallback: () => input.click(),
      });
    } else {
      input.click();
    }
  });

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const source = isHeicFile(file) ? (await decodeHeicToJpegBlob(file)) ?? file : file;
      const url = URL.createObjectURL(source);
      let img;
      try {
        img = await _loadImageWithTimeout(url); // see its own comment — same silent-hang risk as the review path
      } finally {
        URL.revokeObjectURL(url);
      }
      // No crop-review step in this fallback path (native camera app, used
      // when getUserMedia isn't available) — cap resolution here directly,
      // same as _decodeSourcePhoto does for the gallery/review path.
      const capped = _capLongEdge(img);
      const scanFile = await _makeScanPage(capped, `scan-${Date.now()}.jpg`, file);
      _pageCrops.set(scanFile, { frame: file });
      addFiles([scanFile]);
    } catch {
      showToast(t('sd_capture_failed'));
    }
  });
}

_bindTakePhotoButton(); // module-load time — see comment block above

// ── Render — split static/dynamic, same pattern as jpg2pdfUI.js's
//    _settingsRendered guard (real bug found+fixed there earlier this
//    session: a full rebuild on every file-list change silently
//    interrupts an in-progress settings interaction, e.g. a slider
//    drag). Settings panel built once; only the thumbnail grid wrapper
//    is replaced on later calls. ──

function _settingsHtml() {
  const languages = [...OCR_LANGUAGES.european, ...OCR_LANGUAGES.complex];
  const preferred = ocrLangForLocale(getLang());
  const defaultLanguage = languages.some(lang => lang.code === preferred) ? preferred : 'eng';
  return `
    <div class="j2p-row">
      <div class="j2p-group">
        <span class="j2p-group__label">${t('j2p_scan_filter')}</span>
        <div class="j2p-chips" role="group" aria-label="${t('j2p_scan_filter')}">
          ${[
            { value: 'original',  label: t('j2p_scan_filter_original') },
            { value: 'grayscale', label: t('j2p_scan_filter_grayscale') },
            { value: 'faded', label: t('j2p_scan_filter_faded') },
            { value: 'color',     label: t('j2p_scan_filter_color') },
            { value: 'bw',        label: t('j2p_scan_filter_bw') },
          ].map(o => `
            <label class="j2p-chip${_scanFilterMode === o.value ? ' j2p-chip--active' : ''}" data-value="${o.value}" data-name="sdScanFilter">
              <input type="radio" name="sdScanFilter" value="${o.value}"${_scanFilterMode === o.value ? ' checked' : ''}>
              ${o.label}
            </label>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="j2p-row">
      <div class="j2p-group" style="flex:1;">
        <div class="j2p-quality-row" id="sdBrightnessRow">
          <div class="j2p-quality-header">
            <span>${t('j2p_scan_brightness')}</span>
            <span style="display:flex;align-items:center;gap:8px;">
              <span class="j2p-quality-val" id="sdBrightnessVal">${_scanBrightness}</span>
              <button type="button" class="j2p-slider-reset" id="sdBrightnessReset" aria-label="${t('j2p_scan_reset')}"${_scanBrightness === 0 ? ' disabled' : ''}>↺</button>
            </span>
          </div>
          <input type="range" id="sdBrightness" class="j2p-quality-slider"
                 min="-50" max="50" step="1" value="${_scanBrightness}"
                 aria-label="${t('j2p_scan_brightness')}">
        </div>
        <div class="j2p-quality-row" id="sdContrastRow" style="margin-top:12px;">
          <div class="j2p-quality-header">
            <span>${t('j2p_scan_contrast')}</span>
            <span style="display:flex;align-items:center;gap:8px;">
              <span class="j2p-quality-val" id="sdContrastVal">${_scanContrast}</span>
              <button type="button" class="j2p-slider-reset" id="sdContrastReset" aria-label="${t('j2p_scan_reset')}"${_scanContrast === 0 ? ' disabled' : ''}>↺</button>
            </span>
          </div>
          <input type="range" id="sdContrast" class="j2p-quality-slider"
                 min="-50" max="50" step="1" value="${_scanContrast}"
                 aria-label="${t('j2p_scan_contrast')}">
        </div>
      </div>
    </div>

    <div class="j2p-row">
      <div class="j2p-group">
        <span class="j2p-group__label">${t('j2p_page_size')}</span>
        <div class="j2p-chips" role="group" aria-label="${t('j2p_page_size')}">
          ${[
            { value: 'auto',   label: t('j2p_size_auto') },
            { value: 'a4',     label: 'A4'       },
            { value: 'letter', label: 'Letter'   },
            { value: 'fit',    label: t('j2p_fit') },
          ].map(o => `
            <label class="j2p-chip${_pageSize === o.value ? ' j2p-chip--active' : ''}" data-value="${o.value}" data-name="sdSize">
              <input type="radio" name="sdSize" value="${o.value}"${_pageSize === o.value ? ' checked' : ''}>
              ${o.label}
            </label>
          `).join('')}
        </div>
      </div>

      <div class="j2p-group">
        <span class="j2p-group__label">${t('j2p_orientation')}</span>
        <div class="j2p-chips" role="group" aria-label="${t('j2p_orientation')}">
          ${[
            { value: 'auto',      label: t('j2p_orient_auto')      },
            { value: 'portrait',  label: t('j2p_orient_portrait')  },
            { value: 'landscape', label: t('j2p_orient_landscape') },
          ].map(o => `
            <label class="j2p-chip${_orientation === o.value ? ' j2p-chip--active' : ''}" data-value="${o.value}" data-name="sdOrient">
              <input type="radio" name="sdOrient" value="${o.value}"${_orientation === o.value ? ' checked' : ''}>
              ${o.label}
            </label>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="j2p-compress-block">
      <div class="j2p-compress-row">
        <div class="j2p-compress-label">
          <strong>${t('j2p_compress_images')}</strong>
          <small>${t('j2p_compress_desc')}</small>
        </div>
        <label class="j2p-toggle" aria-label="${t('j2p_compress_images')}">
          <input type="checkbox" id="sdCompressCheck"${_compress ? ' checked' : ''}>
          <span class="j2p-toggle__track"></span>
          <span class="j2p-toggle__thumb"></span>
        </label>
      </div>
      <div class="j2p-quality-row${_compress ? '' : ' j2p-quality-row--disabled'}" id="sdQualityRow">
        <div class="j2p-quality-header">
          <span>${t('j2p_quality')}</span>
          <span class="j2p-quality-val" id="sdQualityVal">${Math.round(_quality * 100)}%</span>
        </div>
        <input type="range" id="sdQuality" class="j2p-quality-slider"
               min="40" max="100" step="1" value="${Math.round(_quality * 100)}"
               aria-label="${t('j2p_aria_quality', { pct: Math.round(_quality * 100) })}">
      </div>
    </div>

    ${presetRememberCard({
      id:       'scanDocumentRememberCheck',
      checked:  loadPreset('scanDocument') !== null,
      title:    '💾 ' + t('preset_remember_title'),
      subtitle: t('preset_remember_sub'),
      ariaLabel: t('preset_remember_title'),
    })}
    <div class="j2p-compress-block">
      <label class="sd-ocr-toggle">
        <input type="checkbox" id="sdRecognizeText" aria-controls="sdOcrLanguageRow">
        ${t('sd_ocr_enable')}
      </label>
      <div id="sdOcrLanguageRow" hidden>
        <label for="sdOcrLanguage">${t('ocr_lang_doc')}</label>
        <select id="sdOcrLanguage">
          ${languages.map(lang => `<option value="${lang.code}"${lang.code === defaultLanguage ? ' selected' : ''}>${_esc(lang.name)}</option>`).join('')}
        </select>
      </div>
    </div>
  `;
}

// CSS renders .j2p-thumb__canvas at 56x56 (css/components.css) — the
// canvas's own raster width/height must match that, scaled by
// devicePixelRatio, or the browser upscales a lower-res bitmap into the
// CSS box and every thumbnail comes out visibly soft (worse on a real
// phone's retina display, which is most of this tool's actual traffic).
// Found via code review: this canvas used a flat 48x48 raster with no
// DPR scaling at all — same bug, same shared CSS class/markup pattern,
// also present in js/jpg2pdfUI.js (fixed there too, see that file).
const _THUMB_CSS_SIZE = 56;
const _THUMB_RASTER_SIZE = Math.round(_THUMB_CSS_SIZE * (window.devicePixelRatio || 1));

function _previewsHtml(files) {
  return `
    <div class="j2p-previews" aria-label="${t('j2p_image_preview')}" role="list">
      ${files.map((f, i) => `
        <div class="j2p-thumb" role="listitem" data-index="${i}" data-i="${i}" title="${_esc(f.name).replaceAll('"', '&quot;')}">
          <canvas class="j2p-thumb__canvas" data-index="${i}" width="${_THUMB_RASTER_SIZE}" height="${_THUMB_RASTER_SIZE}" aria-hidden="true"></canvas>
          <span class="j2p-thumb__name">${_esc(_truncName(f.name, 12))}</span>
          ${_pageFilters.has(f) ? `<button type="button" class="split-action-btn sd-compare-button" data-sd-edit-filter>${t('j2p_scan_filter')}</button>` : ''}
          ${_originalPhotos.has(f) ? `<button type="button" class="split-action-btn sd-compare-button" data-sd-compare>${t('cs_before')} / ${t('cs_after')}</button>` : ''}
          ${f._scanReviewed ? '<button type="button" class="j2p-thumb__remove" data-sd-remove>×</button>' : ''}
          ${!f._scanReviewed ? `<span class="j2p-thumb__badge" aria-label="${t('sd_pending_review')}">⏳</span>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function _render(files) {
  const container = id('scanDocumentOptions');
  if (!container) return;

  if (!_settingsRendered) {
    _settingsRendered = true;
    container.innerHTML = `<div id="sdPreviewsWrap">${_previewsHtml(files)}</div><div id="sdCropStatus" role="status"></div>${_settingsHtml()}`;
    _bindSettingsEvents();
  } else {
    const wrap = id('sdPreviewsWrap');
    if (wrap) wrap.innerHTML = _previewsHtml(files);
  }
  _bindThumbGridEvents(files);
  _renderThumbnails(files);
}

const _imgCache = new WeakMap();
async function _loadThumbImage(file) {
  const cached = _imgCache.get(file);
  if (cached) return cached;
  const source = isHeicFile(file) ? (await decodeHeicToJpegBlob(file)) ?? file : file;
  const url = URL.createObjectURL(source);
  const img = new Image();
  await new Promise(res => { img.onload = res; img.onerror = res; img.src = url; });
  URL.revokeObjectURL(url);
  _imgCache.set(file, img);
  return img;
}

async function _renderThumbnails(files) {
  for (let i = 0; i < files.length; i++) {
    const canvas = document.querySelector(`.j2p-thumb__canvas[data-index="${i}"]`);
    if (!canvas) continue;
    try {
      const img = await _loadThumbImage(files[i]);
      if (!img.naturalWidth) continue;
      const ctx = canvas.getContext('2d');
      const scale = Math.min(_THUMB_RASTER_SIZE / img.naturalWidth, _THUMB_RASTER_SIZE / img.naturalHeight);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      ctx.clearRect(0, 0, _THUMB_RASTER_SIZE, _THUMB_RASTER_SIZE);
      ctx.drawImage(img, (_THUMB_RASTER_SIZE - w) / 2, (_THUMB_RASTER_SIZE - h) / 2, w, h);
    } catch { /* thumbnail is cosmetic only */ }
  }
}

function _bindSettingsEvents() {
  const container = id('scanDocumentOptions');

  container.addEventListener('change', e => {
    if (e.target.id === 'sdRecognizeText') id('sdOcrLanguageRow').hidden = !e.target.checked;
    if (e.target.name === 'sdSize') {
      _pageSize = e.target.value;
      container.querySelectorAll('[data-name="sdSize"]').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.value === _pageSize);
      });
    }
    if (e.target.name === 'sdOrient') {
      _orientation = e.target.value;
      container.querySelectorAll('[data-name="sdOrient"]').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.value === _orientation);
      });
    }
    if (e.target.name === 'sdScanFilter') {
      _scanFilterMode = e.target.value;
      container.querySelectorAll('[data-name="sdScanFilter"]').forEach(el => {
        el.classList.toggle('j2p-chip--active', el.dataset.value === _scanFilterMode);
      });
    }
    if (e.target.id === 'sdCompressCheck') {
      _compress = e.target.checked;
      const row = id('sdQualityRow');
      if (row) row.classList.toggle('j2p-quality-row--disabled', !_compress);
    }
    if (e.target.id === 'scanDocumentRememberCheck' && !e.target.checked) {
      clearPreset('scanDocument');
    }
  });

  const slider = id('sdQuality');
  if (slider) {
    slider.addEventListener('input', () => {
      _quality = slider.value / 100;
      const val = id('sdQualityVal');
      if (val) val.textContent = slider.value + '%';
    });
  }

  _bindAdjustSlider('sdBrightness', v => { _scanBrightness = v; });
  _bindAdjustSlider('sdContrast',   v => { _scanContrast   = v; });
}

// Shared by the brightness/contrast sliders — each pairs a <input type=range>
// with a live value label and a reset (↺) button that snaps back to 0 (the
// baseline js/scanFilterWorker.js already produced before these existed —
// see _scanBrightness/_scanContrast's own comment). Reset button is
// disabled at 0 rather than just inert-looking, so there's no dead click.
function _bindAdjustSlider(idPrefix, setValue) {
  const slider = id(idPrefix);
  const val    = id(`${idPrefix}Val`);
  const reset  = id(`${idPrefix}Reset`);
  if (!slider) return;

  slider.addEventListener('input', () => {
    setValue(+slider.value);
    if (val) val.textContent = slider.value;
    if (reset) reset.disabled = +slider.value === 0;
  });

  reset?.addEventListener('click', () => {
    setValue(0);
    slider.value = 0;
    if (val) val.textContent = '0';
    reset.disabled = true;
  });
}

function _bindThumbGridEvents(files) {
  const container = id('scanDocumentOptions');
  if (!container) return;
  const previews = container.querySelector('.j2p-previews');
  if (previews) {
    previews.querySelectorAll('[data-sd-remove]').forEach(button => {
      const file = files[Number(button.closest('.j2p-thumb').dataset.index)];
      button.setAttribute('aria-label', t('j2p_remove_image', { name: file.name }));
      button.addEventListener('touchstart', event => event.stopPropagation());
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (isFilesLocked() || _reviewingNow || _cropProcessing) return;
        const index = selectedFiles.indexOf(file);
        if (index < 0) return;
        _exifAngles.splice(index, 1);
        removeFile(index);
        if (!selectedFiles.length) hideScanDocumentOptions();
      });
    });
    previews.querySelectorAll('[data-sd-compare], [data-sd-edit-filter]').forEach(button => {
      button.addEventListener('touchstart', event => event.stopPropagation());
    });
    bindDragReorder({
      container:    previews,
      itemSelector: '.j2p-thumb',
      arrays:       [selectedFiles, _exifAngles],
      onReorder:    () => _render(selectedFiles),
      isLocked:     isFilesLocked,
      mode:         'grid',
    });
    // Real user request: let a reviewed photo be re-opened for a second look —
    // e.g. to confirm the crop actually landed correctly before assembling the
    // PDF. Only for already-reviewed files (the ⏳ badge ones get their own
    // review automatically via _queueUnreviewedFiles — clicking one of THOSE
    // here would race the queue, so this deliberately no-ops for them).
    previews.addEventListener('click', e => {
      const thumb = e.target.closest('.j2p-thumb');
      if (!thumb) return;
      if (e.target.closest('[data-sd-edit-filter]')) {
        _openPageFilter(files[Number(thumb.dataset.index)]);
        return;
      }
      if (e.target.closest('[data-sd-compare]')) {
        _openScanComparison(files[Number(thumb.dataset.index)]);
        return;
      }
      _openThumbPreview(+thumb.dataset.index);
    });
  }
}

function _openPageFilter(file) {
  const settings = _pageFilters.get(file);
  if (!settings || isFilesLocked() || _reviewingNow || _cropProcessing ||
      !selectedFiles.includes(file) || id('sdPageFilter')) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'sdPageFilter';
  dialog.className = 'sd-comparison sd-page-filter';
  dialog.setAttribute('aria-label', t('j2p_scan_filter'));
  dialog.innerHTML = `
    <img alt="${t('cs_preview_page')}">
    <form>
      <fieldset>
        <label>${t('j2p_scan_filter')}
          <select name="mode">${SCAN_FILTERS.map(mode =>
            `<option value="${mode}"${mode === settings.mode ? ' selected' : ''}>${t('j2p_scan_filter_' + mode)}</option>`).join('')}</select>
        </label>
        <label>${t('j2p_scan_brightness')} <input name="brightness" type="range" min="-50" max="50" value="${settings.brightness}"></label>
        <label>${t('j2p_scan_contrast')} <input name="contrast" type="range" min="-50" max="50" value="${settings.contrast}"></label>
      </fieldset>
      <p role="status"></p>
      <button type="button" class="split-action-btn">${t('scan_cam_close')}</button>
      <button type="submit" class="split-action-btn">${t('ext_apply')}</button>
    </form>`;
  const form = dialog.querySelector('form');
  const status = dialog.querySelector('[role="status"]');
  const apply = form.querySelector('[type="submit"]');
  const img = dialog.querySelector('img');
  const controls = form.elements;
  let url = URL.createObjectURL(file);
  img.src = url;
  let blob = file;
  let chosen = settings;
  let updating = false;
  const setAdjustable = () => {
    controls.brightness.disabled = controls.contrast.disabled = controls.mode.value === 'original';
  };
  setAdjustable();

  form.addEventListener('change', async () => {
    if (updating) return;
    updating = true;
    dialog.querySelector('fieldset').disabled = true;
    apply.disabled = true;
    status.textContent = t('scan_cam_processing');
    const next = {
      source: settings.source,
      mode: controls.mode.value,
      brightness: Number(controls.brightness.value),
      contrast: Number(controls.contrast.value),
    };
    let bitmap;
    try {
      bitmap = await createImageBitmap(settings.source);
      const processed = await filterScanPhoto(bitmap, next.mode, next);
      if (!dialog.open) return;
      blob = processed;
      chosen = next;
      URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      img.src = url;
      status.textContent = '';
      apply.disabled = false;
    } catch {
      status.textContent = t('scan_cam_processing_failed');
    } finally {
      bitmap?.close();
      updating = false;
      dialog.querySelector('fieldset').disabled = false;
      setAdjustable();
    }
  });
  dialog.addEventListener('cancel', event => { if (updating) event.preventDefault(); });
  form.querySelector('[type="button"]').addEventListener('click', () => { if (!updating) dialog.close(); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const index = selectedFiles.indexOf(file);
    if (updating || index < 0 || isFilesLocked()) return;
    if (blob !== file) {
      const updated = new File([blob], file.name, { type: blob.type });
      updated._scanReviewed = true;
      _pageFilters.set(updated, chosen);
      if (_pageCrops.has(file)) _pageCrops.set(updated, _pageCrops.get(file));
      if (_originalPhotos.has(file)) _originalPhotos.set(updated, _originalPhotos.get(file));
      selectedFiles.splice(index, 1, updated);
      _render(selectedFiles);
    }
    dialog.close();
  });
  dialog.addEventListener('close', () => {
    URL.revokeObjectURL(url);
    dialog.remove();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

async function _openScanComparison(file) {
  const original = _originalPhotos.get(file);
  if (!original || !selectedFiles.includes(file) || id('sdComparison')) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'sdComparison';
  dialog.className = 'sd-comparison';
  dialog.setAttribute('aria-label', `${t('cs_before')} / ${t('cs_after')}`);
  const urls = [];
  dialog.addEventListener('close', () => {
    urls.forEach(url => URL.revokeObjectURL(url));
    dialog.remove();
  }, { once: true });
  dialog.innerHTML = `
    <form method="dialog"><button class="split-action-btn">${t('scan_cam_close')}</button></form>
    <div class="sd-comparison__pages"></div>`;
  document.body.append(dialog);
  dialog.showModal();
  const before = isHeicFile(original) ? await decodeHeicToJpegBlob(original).catch(() => null) : original;
  if (!dialog.open) return;
  for (const [label, photo] of [[t('cs_before'), before], [t('cs_after'), file]]) {
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    figure.append(caption);
    if (photo) {
      const img = new Image();
      const url = URL.createObjectURL(photo);
      urls.push(url);
      img.src = url;
      img.alt = label;
      figure.append(img);
    } else {
      figure.append(t('rdct_no_preview'));
    }
    dialog.querySelector('.sd-comparison__pages').append(figure);
  }
}

// Reuses the exact same review UI (js/scanCameraUI.js's openCropReview) and
// confirm/skip splice logic as the initial automatic review — the only
// difference is there's no queue to drain afterward, just a single file
// re-opened on demand. Shares _reviewingNow with _drainReviewQueue so the
// two can never both have a modal open at once.
async function _openThumbPreview(idx) {
  if (isFilesLocked() || _reviewingNow || _cropProcessing) return;
  const file = selectedFiles[idx];
  if (!file || !file._scanReviewed) return;

  _reviewingNow = true;
  try {
    const crop = _pageCrops.get(file);
    const frame = crop?.frame ?? file;
    const sourceCanvas = await _decodeSourcePhoto(frame);
    if (!selectedFiles.includes(file)) { _reviewingNow = false; return; }
    openCropReview({
      sourceCanvas,
      initialQuad: crop?.quad,
      onConfirm: (warpedCanvases, updatedCrop) => _applyReviewedCrop(file, warpedCanvases, {
        ...updatedCrop, originalFrame: updatedCrop.frame === sourceCanvas ? frame : null,
      }),
      onSkip: () => { _reviewingNow = false; }, // no changes — file stays exactly as it was
    });
  } catch {
    _reviewingNow = false;
    showToast(t('sd_review_decode_failed', { name: file.name }));
  }
}

// Keep the user's export request waiting for the actual cropped bytes.
function _encodeCropFrame(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.96));
}

function _applyReviewedCrop(file, canvases, crop, next) {
  const status = id('sdCropStatus');
  if (status) status.textContent = t('scan_cam_processing');
  const processing = (async () => {
    try {
      const baseName = file.name.replace(/(?:-scan(?:-\d+)?)?\.\w+$/, '');
      const frame = crop.quad ? crop.originalFrame ?? await _encodeCropFrame(crop.frame) : null;
      const reviewed = [];
      for (const [i, canvas] of canvases.entries()) {
        const suffix = canvases.length > 1 ? `-scan-${i + 1}` : '-scan';
        const original = _originalPhotos.get(file) ?? (_pageCrops.has(file) ? null : file);
        const page = await _makeScanPage(canvas, baseName + suffix + '.jpg', original, _pageFilters.get(file));
        if (frame) _pageCrops.set(page, { frame, quad: crop.quad });
        reviewed.push(page);
      }
      const index = selectedFiles.indexOf(file);
      if (_cropProcessing !== processing || index < 0) return false;
      selectedFiles.splice(index, 1, ...reviewed);
      _exifAngles.splice(index, 1, ...reviewed.map(() => 0));
      return true;
    } catch {
      if (_cropProcessing === processing) showToast(t('sd_capture_failed'));
      return false;
    } finally {
      if (_cropProcessing === processing) {
        _cropProcessing = null;
        _reviewingNow = false;
        if (status) status.textContent = '';
        _render(selectedFiles);
        next?.();
      }
    }
  })();
  _cropProcessing = processing;
}

function _truncName(name, max) {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

// ── EXIF angle extraction — identical to jpg2pdfUI.js's own (kept as
//    a real, accepted small duplication rather than a cross-tool
//    import, consistent with this codebase's established per-tool-
//    owns-its-UI-code pattern) ──

async function _readExifAngle(file) {
  if (!file.type.includes('jpeg') && !file.name.toLowerCase().endsWith('.jpg')) return 0;
  try {
    const slice = file.slice(0, 65536);
    const buf   = await slice.arrayBuffer();
    const view  = new DataView(buf);
    if (view.getUint16(0) !== 0xFFD8) return 0;
    let offset = 2;
    while (offset < buf.byteLength - 1) {
      const marker = view.getUint16(offset);
      if (marker === 0xFFE1) {
        const segLen = view.getUint16(offset + 2);
        const exifHeader = String.fromCharCode(
          view.getUint8(offset + 4), view.getUint8(offset + 5),
          view.getUint8(offset + 6), view.getUint8(offset + 7)
        );
        if (exifHeader === 'Exif') {
          const tiffOffset = offset + 10;
          const little = view.getUint16(tiffOffset) === 0x4949;
          const ifdOffset = tiffOffset + view.getUint32(tiffOffset + 4, little);
          const numEntries = view.getUint16(ifdOffset, little);
          for (let i = 0; i < numEntries; i++) {
            const entryOffset = ifdOffset + 2 + i * 12;
            if (view.getUint16(entryOffset, little) === 0x0112) {
              const orientation = view.getUint16(entryOffset + 8, little);
              if (orientation === 3) return 180;
              if (orientation === 6) return 90;
              if (orientation === 8) return 270;
              return 0;
            }
          }
        }
        offset += 2 + segLen;
      } else if ((marker & 0xFF00) !== 0xFF00) {
        break;
      } else {
        offset += 2 + view.getUint16(offset + 2);
      }
    }
  } catch { /* not a real JPEG or truncated — no rotation */ }
  return 0;
}
