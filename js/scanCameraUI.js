// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  scanCameraUI.js — live in-browser camera viewfinder + document
//  corner-detection/correction modal for jpg2pdf's "Scan with
//  Camera" flow.
//
//  Flow: 'live' (getUserMedia video preview + capture button) →
//  freeze frame → 'review' (frozen frame + 4 draggable corner
//  handles, auto-detected via js/scanGeometry.js's detectDocumentQuad,
//  falling back to defaultInsetQuad if nothing confident was found) →
//  confirm → js/scanGeometry.js's warpToRect() → callback with the
//  corrected canvas.
//
//  Modal DOM is created fresh on open and torn down on close (same
//  create/appendChild(document.body)/remove pattern as js/feedback.js's
//  modal) — this flow opens rarely, no reason to keep it in the DOM
//  between uses like jpg2pdfUI.js's persistent options panel.
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
let _resizeHandler    = null;

/**
 * Opens the live-camera scan modal.
 * @param {{onConfirm: (canvas: HTMLCanvasElement) => void, onFallback: () => void}} handlers
 *   onConfirm receives the final perspective-corrected canvas.
 *   onFallback is called (and the modal closes itself) if the camera
 *   can't be used at all (no getUserMedia support, permission denied,
 *   no device) — caller should fall back to the native capture input.
 */
export function openScanCamera({ onConfirm, onFallback }) {
  _onConfirm  = onConfirm;
  _onFallback = onFallback;
  _buildModal();
  _startLiveView();
}

function _stopStream() {
  _stream?.getTracks().forEach(tr => tr.stop());
  _stream = null;
}

function _closeModal() {
  _stopStream();
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

  stage.innerHTML = `<video id="scanCamVideo" class="scan-cam-video" autoplay playsinline muted></video>`;
  status.textContent = '';
  actions.innerHTML = `<button type="button" class="split-action-btn" id="scanCamCaptureBtn" disabled>${t('scan_cam_take_photo')}</button>`;

  if (!navigator.mediaDevices?.getUserMedia) {
    _closeModal();
    _onFallback?.();
    return;
  }

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
  video.addEventListener('loadedmetadata', () => { if (captureBtn) captureBtn.disabled = false; });
  captureBtn.addEventListener('click', () => _capture(video));
}

function _capture(video) {
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
  actions.innerHTML = `
    <button type="button" class="split-action-btn" id="scanCamRetakeBtn">${t('scan_cam_retake')}</button>
    <button type="button" class="split-action-btn" id="scanCamConfirmBtn" disabled>${t('scan_cam_use_crop')}</button>
  `;
  document.getElementById('scanCamRetakeBtn').addEventListener('click', () => {
    URL.revokeObjectURL(url);
    _startLiveView();
  });
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
