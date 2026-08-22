// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanCameraUI.js — live in-browser camera viewfinder + document
//  corner-detection/correction modal for jpg2pdf's "Scan with
//  Camera" flow.
//
//  Flow: 'live' (getUserMedia video preview + capture button, with a
//  continuously-updating live corner-tracking overlay — added
//  2026-08-22 after a competitive test against PDF24's camera scanner
//  showed it doing the same; throttled to ~5fps, non-interactive, just
//  a framing guide) → freeze frame → 'review' (frozen frame + 4
//  draggable corner handles, auto-detected via js/scanGeometry.js's
//  detectDocumentQuad, falling back to defaultInsetQuad if nothing
//  confident was found) → confirm → js/scanGeometry.js's warpToRect()
//  → callback with the corrected canvas. The live overlay is purely a
//  visual guide during framing — the actual quad used for the warp is
//  still (re-)detected once on the frozen, full-resolution frame,
//  unchanged from before.
//
//  Modal DOM is created fresh on open and torn down on close (same
//  create/appendChild(document.body)/remove pattern as js/feedback.js's
//  modal) — this flow opens rarely, no reason to keep it in the DOM
//  between uses like jpg2pdfUI.js's persistent options panel.
//
//  openCropReview({sourceCanvas, onConfirm, onSkip}) — added 2026-08-22
//  for js/scanDocumentUI.js's gallery-photo review flow — starts
//  directly at the 'review' stage on an already-decoded image, skipping
//  'live'/capture entirely. Reuses the exact same review-stage code
//  (_startReview/_renderHandles/_bindHandleDrag/_confirm) as the camera
//  flow — only the action buttons differ (gallery mode shows "Skip"
//  instead of "Retake": a real gallery photo might not be a document at
//  all, needs an escape hatch that just uses it unprocessed, whereas
//  "Retake" only makes sense when a live camera is actually available
//  to go back to).
//
//  Pointer handling copies js/drawPointer.js's pattern: native Pointer
//  Events + setPointerCapture (not js/redactUI.js's mousedown/touchstart
//  dual-listener style) — simpler, and each corner here moves
//  independently, unlike redactUI's anchor-opposite-corner box resize.
// ============================================================

import { t } from './i18n.js';
import { loadOpenCv } from './lazyLibs.js';
import { detectDocumentQuad, defaultInsetQuad, warpToRect } from './scanGeometry.js';

let _modal        = null;
let _stream        = null;
let _capturedCanvas = null;
let _quad           = null;   // full-resolution pixel-space {tl,tr,br,bl}
let _displayScale    = 1;      // displayed CSS px per full-res px
let _onConfirm       = null;
let _onFallback       = null;
let _onSkip            = null;
let _reviewMode        = 'camera'; // 'camera' | 'gallery' — controls Retake vs Skip in the review stage's action row
let _resizeHandler    = null;
let _liveTrackInterval = null;

const _LIVE_TRACK_INTERVAL_MS = 200; // ~5fps — a framing guide doesn't need real video framerate

/**
 * Opens the live-camera scan modal.
 * @param {{onConfirm: (canvas: HTMLCanvasElement) => void, onFallback: () => void}} handlers
 *   onConfirm receives the final perspective-corrected canvas.
 *   onFallback is called (and the modal closes itself) if the camera
 *   can't be used at all (no getUserMedia support, permission denied,
 *   no device) — caller should fall back to the native capture input.
 */
export function openScanCamera({ onConfirm, onFallback }) {
  _reviewMode = 'camera';
  _onConfirm  = onConfirm;
  _onFallback = onFallback;
  _onSkip     = null;
  _buildModal();
  _startLiveView();
}

/**
 * Opens the review modal directly on an already-decoded image (no live
 * camera) — for js/scanDocumentUI.js's gallery-photo review flow.
 * @param {{sourceCanvas: HTMLCanvasElement, onConfirm: (canvas: HTMLCanvasElement) => void, onSkip: () => void}} handlers
 *   onConfirm receives the perspective-corrected canvas, same as
 *   openScanCamera. onSkip is called (and the modal closes) if the user
 *   decides this photo doesn't need cropping — resolves with nothing;
 *   caller is responsible for using the original, unprocessed image.
 */
export function openCropReview({ sourceCanvas, onConfirm, onSkip }) {
  _reviewMode      = 'gallery';
  _capturedCanvas  = sourceCanvas;
  _onConfirm       = onConfirm;
  _onSkip          = onSkip;
  _onFallback      = null;
  _buildModal();
  _startReview();
}

function _stopStream() {
  _stream?.getTracks().forEach(tr => tr.stop());
  _stream = null;
}

function _closeModal() {
  _stopStream();
  _stopLiveTracking();
  window.removeEventListener('resize', _resizeHandler);
  document.removeEventListener('keydown', _onKeydown);
  _modal?.remove();
  _modal = null;
  _capturedCanvas = null;
  _quad = null;
}

function _onKeydown(e) {
  if (e.key === 'Escape') _closeModal();
}

// ── Modal shell ────────────────────────────────────────────────

function _buildModal() {
  _modal = document.createElement('div');
  _modal.className = 'scan-cam-modal';
  _modal.innerHTML = `
    <div class="scan-cam-modal__card" role="dialog" aria-modal="true" aria-label="${t('scan_cam_title')}">
      <button type="button" class="scan-cam-close" id="scanCamClose" aria-label="${t('scan_cam_close')}">✕</button>
      <div class="scan-cam-stage" id="scanCamStage"></div>
      <div class="scan-cam-status" id="scanCamStatus" aria-live="polite"></div>
      <div class="scan-cam-actions" id="scanCamActions"></div>
    </div>
  `;
  document.body.appendChild(_modal);
  requestAnimationFrame(() => _modal.classList.add('scan-cam-modal--open'));

  document.getElementById('scanCamClose').addEventListener('click', _closeModal);
  document.addEventListener('keydown', _onKeydown);
  _modal.addEventListener('click', e => { if (e.target === _modal) _closeModal(); });
}

// ── 'live' stage ───────────────────────────────────────────────

async function _startLiveView() {
  const stage  = document.getElementById('scanCamStage');
  const status = document.getElementById('scanCamStatus');
  const actions = document.getElementById('scanCamActions');

  stage.innerHTML = `
    <div class="scan-cam-video-wrap" id="scanCamVideoWrap">
      <video id="scanCamVideo" class="scan-cam-video" autoplay playsinline muted></video>
      <svg class="scan-cam-outline" id="scanCamLiveOutline" preserveAspectRatio="none">
        <polygon id="scanCamLivePolygon"></polygon>
      </svg>
    </div>
  `;
  status.textContent = '';
  actions.innerHTML = `<button type="button" class="split-action-btn" id="scanCamCaptureBtn" disabled>${t('scan_cam_take_photo')}</button>`;

  if (!navigator.mediaDevices?.getUserMedia) {
    _closeModal();
    _onFallback?.();
    return;
  }

  // Starts loading in parallel with the camera permission prompt below —
  // doesn't block the video preview either way. The live tracking overlay
  // just doesn't appear until this resolves (checked each tick via
  // window.cv?.Mat, not a separate readiness flag — avoids the overlay
  // getting stuck "not ready" if the modal is closed and reopened after
  // OpenCV already loaded once).
  loadOpenCv().catch(() => {});

  try {
    _stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    status.textContent = t('scan_cam_permission_denied');
    setTimeout(() => { _closeModal(); _onFallback?.(); }, 1800);
    return;
  }

  const video = document.getElementById('scanCamVideo');
  if (!video) { _stopStream(); return; } // modal closed while awaiting getUserMedia
  video.srcObject = _stream;

  const captureBtn = document.getElementById('scanCamCaptureBtn');
  video.addEventListener('loadedmetadata', () => {
    if (captureBtn) captureBtn.disabled = false;
    _startLiveTracking(video);
  });
  captureBtn.addEventListener('click', () => _capture(video));
}

// Continuously re-detects the document quad on the live video feed as a
// non-interactive framing guide — throttled (not per-frame; video is
// ~30fps, far more than a guide overlay needs) and cleared on capture/
// retake/close so it never keeps running against a stopped/gone video.
function _startLiveTracking(video) {
  _stopLiveTracking();
  const probe = document.createElement('canvas');
  _liveTrackInterval = setInterval(() => {
    if (!window.cv?.Mat || !video.videoWidth) return;
    probe.width  = video.videoWidth;
    probe.height = video.videoHeight;
    probe.getContext('2d').drawImage(video, 0, 0);

    let quad = null;
    try { quad = detectDocumentQuad(probe); } catch { /* skip this tick, try again next */ }
    _renderLiveOverlay(quad, video);
  }, _LIVE_TRACK_INTERVAL_MS);
}

function _stopLiveTracking() {
  if (_liveTrackInterval) { clearInterval(_liveTrackInterval); _liveTrackInterval = null; }
}

function _renderLiveOverlay(quad, video) {
  const svg = document.getElementById('scanCamLiveOutline');
  const polygon = document.getElementById('scanCamLivePolygon');
  if (!svg || !polygon) return;
  if (!quad) { polygon.setAttribute('points', ''); return; } // nothing confident this tick — don't show a stale/wrong guide

  const rect  = video.getBoundingClientRect();
  const scale = rect.width / video.videoWidth;
  svg.setAttribute('width', rect.width);
  svg.setAttribute('height', rect.height);
  svg.style.width  = rect.width + 'px';
  svg.style.height = rect.height + 'px';

  const pts = ['tl', 'tr', 'br', 'bl'].map(k => `${quad[k].x * scale},${quad[k].y * scale}`).join(' ');
  polygon.setAttribute('points', pts);
}

function _capture(video) {
  _stopLiveTracking();
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  _stopStream();
  _capturedCanvas = canvas;
  _startReview();
}

// ── 'review' stage — frozen frame + draggable corner handles ────

async function _startReview() {
  const stage   = document.getElementById('scanCamStage');
  const status  = document.getElementById('scanCamStatus');
  const actions = document.getElementById('scanCamActions');

  const blob = await new Promise(res => _capturedCanvas.toBlob(res, 'image/jpeg', 0.92));
  const url  = URL.createObjectURL(blob);

  stage.innerHTML = `
    <div class="scan-cam-frame-wrap" id="scanCamFrameWrap">
      <img class="scan-cam-frame" id="scanCamFrame" src="${url}" alt="">
      <svg class="scan-cam-outline" id="scanCamOutline" preserveAspectRatio="none">
        <polygon id="scanCamPolygon"></polygon>
      </svg>
      <div class="scan-cam-handle" id="scanCamHandle-tl" data-corner="tl"></div>
      <div class="scan-cam-handle" id="scanCamHandle-tr" data-corner="tr"></div>
      <div class="scan-cam-handle" id="scanCamHandle-br" data-corner="br"></div>
      <div class="scan-cam-handle" id="scanCamHandle-bl" data-corner="bl"></div>
    </div>
  `;
  actions.innerHTML = _reviewMode === 'gallery'
    ? `
      <button type="button" class="split-action-btn" id="scanCamSkipBtn">${t('scan_cam_skip')}</button>
      <button type="button" class="split-action-btn" id="scanCamConfirmBtn" disabled>${t('scan_cam_use_crop')}</button>
    `
    : `
      <button type="button" class="split-action-btn" id="scanCamRetakeBtn">${t('scan_cam_retake')}</button>
      <button type="button" class="split-action-btn" id="scanCamConfirmBtn" disabled>${t('scan_cam_use_crop')}</button>
    `;
  document.getElementById('scanCamRetakeBtn')?.addEventListener('click', () => {
    URL.revokeObjectURL(url);
    _startLiveView();
  });
  document.getElementById('scanCamSkipBtn')?.addEventListener('click', () => _skip(url));
  document.getElementById('scanCamConfirmBtn').addEventListener('click', () => _confirm(url));

  status.textContent = t('scan_cam_detecting');

  const img = document.getElementById('scanCamFrame');
  await new Promise(res => { img.onload = res; img.onerror = res; });

  let detected = null;
  try {
    await loadOpenCv();
    detected = detectDocumentQuad(_capturedCanvas);
  } catch {
    // CDN failure or detection error — defaultInsetQuad below covers it
  }
  _quad = detected || defaultInsetQuad(_capturedCanvas.width, _capturedCanvas.height);
  status.textContent = detected ? '' : t('scan_cam_detect_fallback');

  _resizeHandler = () => _renderHandles();
  window.addEventListener('resize', _resizeHandler);
  _renderHandles();
  _bindHandleDrag();
  document.getElementById('scanCamConfirmBtn').disabled = false;
}

function _renderHandles() {
  const img = document.getElementById('scanCamFrame');
  if (!img || !_quad) return;
  const rect = img.getBoundingClientRect();
  _displayScale = rect.width / _capturedCanvas.width;

  const svg = document.getElementById('scanCamOutline');
  svg.setAttribute('width', rect.width);
  svg.setAttribute('height', rect.height);
  svg.style.width  = rect.width + 'px';
  svg.style.height = rect.height + 'px';

  const pts = ['tl', 'tr', 'br', 'bl'].map(k => {
    const p = _quad[k];
    const dx = p.x * _displayScale, dy = p.y * _displayScale;
    const handle = document.getElementById(`scanCamHandle-${k}`);
    handle.style.left = dx + 'px';
    handle.style.top  = dy + 'px';
    return `${dx},${dy}`;
  }).join(' ');
  document.getElementById('scanCamPolygon').setAttribute('points', pts);
}

function _bindHandleDrag() {
  ['tl', 'tr', 'br', 'bl'].forEach(corner => {
    const handle = document.getElementById(`scanCamHandle-${corner}`);
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const img = document.getElementById('scanCamFrame');

      const onMove = ev => {
        const rect = img.getBoundingClientRect();
        const x = Math.min(Math.max(0, ev.clientX - rect.left), rect.width);
        const y = Math.min(Math.max(0, ev.clientY - rect.top),  rect.height);
        _quad[corner] = { x: x / _displayScale, y: y / _displayScale };
        _renderHandles();
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  });
}

async function _confirm(reviewUrl) {
  const status = document.getElementById('scanCamStatus');
  status.textContent = t('scan_cam_processing');
  try {
    const warped = warpToRect(_capturedCanvas, _quad);
    URL.revokeObjectURL(reviewUrl);
    const cb = _onConfirm;
    _closeModal();
    cb?.(warped);
  } catch {
    status.textContent = t('scan_cam_processing_failed');
  }
}

function _skip(reviewUrl) {
  URL.revokeObjectURL(reviewUrl);
  const cb = _onSkip;
  _closeModal();
  cb?.();
}
