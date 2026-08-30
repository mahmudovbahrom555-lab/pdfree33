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
import { detectDocumentQuad, defaultInsetQuad, warpToRectAsync, detectSpineX, DETECT_LONG_EDGE,
         chooseCropViewLayout, unrotatedImagePoint } from './scanGeometry.js';
import { SCAN_MAX_LONG_EDGE } from './scanConstants.js';

let _modal        = null;
let _stream        = null;
let _capturedCanvas = null;
let _quad           = null;   // full-resolution pixel-space {tl,tr,br,bl}
let _displayScale    = 1;      // displayed CSS px per full-res px
let _viewRotated     = false;  // mobile-only: #scanCamFrameInner is CSS-rotated -90°
                                // to use the available box's larger dimension — see
                                // _computeFrameLayout()'s own comment for the full
                                // rationale (real user report, Redmi 8: top/bottom
                                // corner handles unreachable on a portrait photo
                                // squeezed into a short viewport).
let _onConfirm       = null;
let _onFallback       = null;
let _onSkip            = null;
// Phase 3 of the competitor catch-up (see scandoc_competitor_catchup_plan_2026_08
// memory for the full TZ) — a blemish-eraser: paint white over a smudge/
// shadow/stray mark before confirming, instead of retaking the photo.
// Operates on _capturedCanvas directly (same pre-warp source the corner
// crop/rotate buttons already mutate) via a transparent overlay canvas
// that lives inside #scanCamFrameInner — same rigid-group rotation
// treatment as the SVG outline/handles, so it needs zero extra rotation
// math of its own; only the pointer-drag coordinate conversion (screen to
// local) is shared with _bindHandleDrag's own _viewRotated-aware logic.
let _eraseMode       = false;
let _eraseBrushSize  = 'medium'; // 'small' | 'medium' | 'large' — see _ERASE_BRUSH_RADII
let _reviewMode        = 'camera'; // 'camera' | 'gallery' — controls Retake vs Skip in the review stage's action row
let _scanSubMode       = 'single'; // 'single' | 'book' — set per-review, not sticky across captures (see _startReview)
let _resizeHandler    = null;
let _liveTrackInterval = null;
let _reviewGen          = 0;   // bumped on every close — lets in-flight _startReview() awaits bail out
let _frameUrl           = null; // current #scanCamFrame object URL — module-level so rotation can swap it mid-review
let _spineUrl           = null; // book-mode spine-adjust stage's own object URL — separate from _frameUrl, own stage
let _spineResizeHandler = null; // book-mode spine-adjust stage's own resize listener — separate from _resizeHandler

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

// suppressOnSkip: true when the caller (_confirm/_skip) already resolved the
// review itself — otherwise (✕ button, Escape, backdrop click) an explicit
// close in gallery mode is treated the same as clicking Skip: without this,
// dismissing the modal any way other than its own buttons left the calling
// tool's review queue permanently stuck (onSkip/onConfirm never fired), with
// the process button staying enabled but unable to ever complete.
function _closeModal({ suppressOnSkip = false } = {}) {
  _reviewGen++;  // invalidate any _startReview() awaits still in flight
  _stopStream();
  _stopLiveTracking();
  window.removeEventListener('resize', _resizeHandler);
  document.removeEventListener('keydown', _onKeydown);
  // Real leaks found via code review, all from the same root cause: closing
  // the modal any way OTHER than a stage's own confirm button (X/Escape/
  // backdrop) used to skip that stage's own cleanup entirely, since each
  // stage only released its own resources inside its own confirm handler.
  // Book-spread's spine-adjust stage has its own separate object URL and
  // resize listener from the crop-review stage above it (_frameUrl/
  // _resizeHandler) — both need the same treatment here.
  //
  // _frameUrl itself was missed in that same pass (only _resizeHandler got
  // removed above) — confirmed via a real revokeObjectURL call log: closing
  // via the ✕ button left the review-stage frame's blob URL alive for the
  // rest of the page's lifetime, every single time, since _confirm/_skip/
  // Retake are the only paths that ever revoked it.
  if (_frameUrl) { URL.revokeObjectURL(_frameUrl); _frameUrl = null; }
  if (_spineUrl) { URL.revokeObjectURL(_spineUrl); _spineUrl = null; }
  if (_spineResizeHandler) { window.removeEventListener('resize', _spineResizeHandler); _spineResizeHandler = null; }
  // A handle drag in progress (pointerdown fired, pointerup never did)
  // left _magnifierEl pointing at a canvas in the now-removed modal — null
  // it out explicitly rather than relying on pointerup, which never comes.
  _magnifierEl = null;
  _modal?.remove();
  _modal = null;
  _capturedCanvas = null;
  _quad = null;
  _viewRotated = false;
  _eraseMode = false;
  _consensusQueue = [];
  _autoCaptureArmed = true;
  if (!suppressOnSkip && _reviewMode === 'gallery') {
    const cb = _onSkip;
    _onSkip = null;  // guard against any possible double-invocation
    cb?.();
  }
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
  // doesn't block the video preview either way. Pre-warms the MAIN-thread
  // OpenCV load (loadOpenCv() caches its promise) for _startReview()'s
  // later one-shot post-capture detection, which still runs main-thread
  // (a single call per photo, not the ongoing per-tick cost the live
  // overlay itself used to be) — the live overlay now runs in its own
  // js/scanDetectWorker.js with its own independent OpenCV load, so this
  // call no longer gates it the way it used to.
  loadOpenCv().catch(() => {});
  _ensureDetectWorker(); // pre-create so its own OpenCV load can start now too, not on the live overlay's first tick

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
    _consensusQueue = [];
    _autoCaptureArmed = true;
    _startLiveTracking(video);
  });
  captureBtn.addEventListener('click', () => _capture(video));
}

// Continuously re-detects the document quad on the live video feed as a
// non-interactive framing guide — throttled (not per-frame; video is
// ~30fps, far more than a guide overlay needs) and cleared on capture/
// retake/close so it never keeps running against a stopped/gone video.
//
// Runs in js/scanDetectWorker.js, not the main thread — found via code
// review to be a real, ongoing (not one-shot) main-thread cost for the
// entire time the live preview stays open (same risk class the filter
// pipeline was already moved off-thread for, see js/scanFilterWorker.js).
// This function still does the downscale-for-detection step itself
// (cheap canvas draw, using the SAME DETECT_LONG_EDGE the main-thread
// detectDocumentQuad() uses for its own one-shot post-capture detection)
// and un-scales the returned quad back to full-frame coordinates — the
// worker only runs the actual Canny/contour pipeline on whatever size
// ImageData it's handed.
let _detectWorker = null;
let _detectBusy   = false;
let _liveTrackGen = 0; // bumped on stop — discards a stale in-flight worker response from a previous session

function _ensureDetectWorker() {
  if (!_detectWorker) {
    _detectWorker = new Worker(new URL('./scanDetectWorker.js', import.meta.url));
  }
  return _detectWorker;
}

function _startLiveTracking(video) {
  _stopLiveTracking();
  const myGen = ++_liveTrackGen;
  const probe = document.createElement('canvas');
  const small = document.createElement('canvas');
  _liveTrackInterval = setInterval(() => {
    // Busy guard — skip this tick rather than queueing a second request;
    // a slightly stale overlay is fine for a non-interactive framing
    // guide, a growing backlog of unprocessed frames is not.
    if (!video.videoWidth || _detectBusy) return;
    probe.width  = video.videoWidth;
    probe.height = video.videoHeight;
    probe.getContext('2d').drawImage(video, 0, 0);

    const scale = Math.min(1, DETECT_LONG_EDGE / Math.max(probe.width, probe.height));
    const dw = Math.max(1, Math.round(probe.width  * scale));
    const dh = Math.max(1, Math.round(probe.height * scale));
    small.width = dw; small.height = dh;
    const sctx = small.getContext('2d');
    sctx.drawImage(probe, 0, 0, dw, dh);
    const imageData = sctx.getImageData(0, 0, dw, dh);

    _detectBusy = true;
    const worker = _ensureDetectWorker();
    worker.onmessage = (e) => {
      _detectBusy = false;
      if (myGen !== _liveTrackGen) return; // a newer (or no) session has started since this request went out
      if (e.data.type !== 'quadResult') return; // error this tick — try again next
      let quad = e.data.quad;
      if (quad) {
        const inv = 1 / scale;
        quad = {
          tl: { x: quad.tl.x * inv, y: quad.tl.y * inv },
          tr: { x: quad.tr.x * inv, y: quad.tr.y * inv },
          br: { x: quad.br.x * inv, y: quad.br.y * inv },
          bl: { x: quad.bl.x * inv, y: quad.bl.y * inv },
        };
      }
      const clipped = quad ? isClippedQuad(quad, video.videoWidth, video.videoHeight) : false;
      _renderLiveOverlay(quad, video, clipped);
      _updateAutoCapture(quad, clipped, video);
    };
    // imageData.data.buffer transferred (zero-copy) — imageData itself is
    // not touched again on this side after posting.
    worker.postMessage({ type: 'detectQuad', data: imageData.data, w: dw, h: dh }, [imageData.data.buffer]);
  }, _LIVE_TRACK_INTERVAL_MS);
}

function _stopLiveTracking() {
  if (_liveTrackInterval) { clearInterval(_liveTrackInterval); _liveTrackInterval = null; }
  _liveTrackGen++;
  _detectBusy = false;
}

// A corner within this fraction of the frame's own width/height from any
// edge counts as "touching" it — matches the class of check documented in
// ClearScan's docs/DETECTION_CASES.md ("Partially clipped single page"):
// 2+ corners near the frame edge means the shot is very likely missing part
// of the document, so warn (don't block — the user may want it anyway).
const _CLIP_EDGE_MARGIN_FRAC = 0.02;
const _CLIP_MIN_CORNERS = 2;

export function isClippedQuad(quad, videoWidth, videoHeight) {
  const mx = videoWidth * _CLIP_EDGE_MARGIN_FRAC;
  const my = videoHeight * _CLIP_EDGE_MARGIN_FRAC;
  let nearEdge = 0;
  for (const k of ['tl', 'tr', 'br', 'bl']) {
    const p = quad[k];
    if (p.x <= mx || p.x >= videoWidth - mx || p.y <= my || p.y >= videoHeight - my) nearEdge++;
  }
  return nearEdge >= _CLIP_MIN_CORNERS;
}

function _renderLiveOverlay(quad, video, clipped) {
  const svg     = document.getElementById('scanCamLiveOutline');
  const polygon = document.getElementById('scanCamLivePolygon');
  if (!svg || !polygon) return;
  if (!quad) {
    polygon.setAttribute('points', ''); // nothing confident this tick — don't show a stale/wrong guide
    polygon.classList.remove('scan-cam-outline--clipped');
    return;
  }

  const rect  = video.getBoundingClientRect();
  const scale = rect.width / video.videoWidth;
  svg.setAttribute('width', rect.width);
  svg.setAttribute('height', rect.height);
  svg.style.width  = rect.width + 'px';
  svg.style.height = rect.height + 'px';

  const pts = ['tl', 'tr', 'br', 'bl'].map(k => `${quad[k].x * scale},${quad[k].y * scale}`).join(' ');
  polygon.setAttribute('points', pts);
  polygon.classList.toggle('scan-cam-outline--clipped', clipped);
}

// ── Auto-capture: temporal consensus ────────────────────────────
//
// Inspired by WeScan's RectangleFeaturesFunnel (see docs referenced in this
// feature's commit) — compared against ClearScan's own comparison of
// open-source scanners, which specifically warns against a naive
// "only compare to the last frame" approach (one missed detection resets
// everything). Instead: keep a bounded queue of recent quad "signatures"
// (normalized center + area) and check how many of the RECENT ones agree
// with the latest — tolerant of a single noisy/missed frame without losing
// all progress, same rationale as ClearScan's documented design.
//
// Safety gate (also from ClearScan's docs/DETECTION_CASES.md): a clipped
// (cut-off) frame clears the queue outright — "every agreeing sample must
// be safe before automatic capture can resume", so one clean frame can't
// reuse an older clipped-frame's consensus progress.
//
// Tolerances/window size are reasoned defaults (not yet validated against
// a real physical camera in this environment — see this feature's memory
// note), verified instead via direct logic tests with synthetic quad
// sequences (tests/scanCameraConsensus.test.js-style coverage in this
// commit's Playwright verification).
const _CONSENSUS_QUEUE_SIZE  = 8;
const _CONSENSUS_MIN_AGREE   = 5;
const _CONSENSUS_CENTER_TOL  = 0.03; // fraction of frame width/height
const _CONSENSUS_AREA_TOL    = 0.08; // fraction of frame area

let _consensusQueue   = [];
let _autoCaptureArmed = true;

function _quadSignature(quad, w, h) {
  const cx = (quad.tl.x + quad.tr.x + quad.br.x + quad.bl.x) / 4 / w;
  const cy = (quad.tl.y + quad.tr.y + quad.br.y + quad.bl.y) / 4 / h;
  // Shoelace formula, normalized to frame area — order-independent measure
  // of "how big is this quad", used alongside center position to detect a
  // stable, unmoving framing (not just a stationary centroid).
  const pts = [quad.tl, quad.tr, quad.br, quad.bl];
  let area2 = 0;
  for (let i = 0; i < 4; i++) {
    const p = pts[i], q = pts[(i + 1) % 4];
    area2 += p.x * q.y - q.x * p.y;
  }
  const area = Math.abs(area2) / 2 / (w * h);
  return { cx, cy, area };
}

function _signaturesAgree(a, b) {
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) < _CONSENSUS_CENTER_TOL
      && Math.abs(a.area - b.area) < _CONSENSUS_AREA_TOL;
}

// Exported for direct logic testing (like isClippedQuad above) — feeds a
// sequence of quads/clipped-flags through the same state this module uses
// internally, so the consensus behavior is verifiable without a real
// camera. Resets the module's queue as a side effect, matching how a real
// capture session starts fresh — tests should account for that.
export function __resetConsensusForTest() { _consensusQueue = []; }
export function __stepConsensusForTest(quad, clipped, w, h) {
  return _stepConsensus(quad, clipped, w, h);
}

function _stepConsensus(quad, clipped, w, h) {
  if (!quad || clipped) { _consensusQueue = []; return 0; }
  const sig = _quadSignature(quad, w, h);
  _consensusQueue.push(sig);
  if (_consensusQueue.length > _CONSENSUS_QUEUE_SIZE) _consensusQueue.shift();
  let agreeCount = 0;
  for (const s of _consensusQueue) if (_signaturesAgree(s, sig)) agreeCount++;
  return agreeCount;
}

function _updateAutoCapture(quad, clipped, video) {
  if (!_autoCaptureArmed) return;
  const agreeCount = _stepConsensus(quad, clipped, video.videoWidth, video.videoHeight);
  const status = document.getElementById('scanCamStatus');

  if (agreeCount >= _CONSENSUS_MIN_AGREE) {
    _autoCaptureArmed = false; // capture() tears down the interval — prevent a double-trigger race
    if (status) status.textContent = '';
    _capture(video);
    return;
  }

  if (!status) return;
  // Priority: clipped warning > hold-steady progress > nothing. Clipped
  // always wins since it's the more actionable message (repositioning
  // fixes both problems at once anyway).
  if (clipped) {
    status.textContent = t('scan_cam_clipped_hint');
  } else if (agreeCount >= 2) {
    status.textContent = t('scan_cam_hold_steady');
  } else {
    status.textContent = '';
  }
}

// Variance of the Laplacian — a standard, well-known blur metric (low
// variance = few sharp edges = likely out of focus/motion-blurred; high
// variance = lots of sharp edges = likely in focus). Runs on a downscaled
// copy — blur is a low-frequency judgment, full resolution isn't needed and
// would be far slower for no real accuracy gain.
// Threshold calibrated empirically against real sharp vs. blurred test
// images (see the memory note referenced in this feature's commit) — not
// copied from an OpenCV tutorial's default, which assumes a different
// kernel/resolution than this one.
const _BLUR_WORK_DIM = 400;
// Calibrated against real synthetic sharp/blurred text renders (not a
// borrowed tutorial default): Gaussian-blur radius 2 (still legible, real
// text like "84213" readable) scored ~2183; radius 3 (genuinely hard to
// read) scored ~556. 1000 sits between the two, biased toward the
// "genuinely blurry" side to avoid false-positiving on borderline-OK
// photos. Real phone photos have more natural texture/grain than a clean
// synthetic render, so this may need revisiting against real camera
// captures — not yet tested against those.
const _BLUR_VARIANCE_THRESHOLD = 1000;
// Exported (like scanFilter.js's medianFilterGray/clahePlane) so the
// calibration itself is verifiable against real sharp/blurred images
// instead of trusting a borrowed tutorial default.
export function computeBlurVariance(canvas) {
  const scale = Math.min(1, _BLUR_WORK_DIM / Math.max(canvas.width, canvas.height));
  const w = Math.max(3, Math.round(canvas.width * scale));
  const h = Math.max(3, Math.round(canvas.height * scale));
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  const ctx = small.getContext('2d');
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  }

  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      const lap = gray[idx - 1] + gray[idx + 1] + gray[idx - w] + gray[idx + w] - 4 * gray[idx];
      sum += lap; sumSq += lap * lap; count++;
    }
  }
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

// Same long-edge cap and same real reason as js/scanConstants.js's
// SCAN_MAX_LONG_EDGE — applied here too since this live-camera path's
// captured frame skips js/scanDocumentUI.js's decode step entirely and
// would otherwise reach js/scanGeometry.js's warpToRect() (an OpenCV
// perspective warp, its own real full-resolution Mat allocation)
// completely uncapped. getUserMedia is opened here with no explicit
// width/height constraint, so the frame size is whatever the browser/
// driver negotiates — not guaranteed to already be small.
function _capture(video) {
  _stopLiveTracking();
  const rawW = video.videoWidth, rawH = video.videoHeight;
  const scale = Math.min(1, SCAN_MAX_LONG_EDGE / Math.max(rawW, rawH));
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(rawW * scale));
  canvas.height = Math.max(1, Math.round(rawH * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  _stopStream();
  _capturedCanvas = canvas;
  _startReview();
}

// ── 'review' stage — frozen frame + draggable corner handles ────

async function _startReview() {
  const myGen   = ++_reviewGen;  // see _closeModal — bailed out if the modal closes mid-await below
  const stage   = document.getElementById('scanCamStage');
  const status  = document.getElementById('scanCamStatus');
  const actions = document.getElementById('scanCamActions');

  const blob = await new Promise(res => _capturedCanvas.toBlob(res, 'image/jpeg', 0.92));
  if (myGen !== _reviewGen) { return; }  // modal closed while encoding the frame
  _frameUrl = URL.createObjectURL(blob);

  _scanSubMode = 'single';
  stage.innerHTML = `
    <div class="scan-cam-stage-col">
      <div class="scan-cam-mode-row" id="scanCamModeRow">
        <button type="button" class="scan-cam-mode-chip scan-cam-mode-chip--active" id="scanCamModeSingle">${t('scan_cam_mode_single')}</button>
        <button type="button" class="scan-cam-mode-chip" id="scanCamModeBook">${t('scan_cam_mode_book')}</button>
      </div>
      <div class="scan-cam-frame-wrap" id="scanCamFrameWrap">
        <div class="scan-cam-frame-inner" id="scanCamFrameInner">
          <img class="scan-cam-frame" id="scanCamFrame" src="${_frameUrl}" alt="">
          <svg class="scan-cam-outline" id="scanCamOutline" preserveAspectRatio="none">
            <polygon id="scanCamPolygon"></polygon>
          </svg>
          <div class="scan-cam-handle" id="scanCamHandle-tl" data-corner="tl"></div>
          <div class="scan-cam-handle" id="scanCamHandle-tr" data-corner="tr"></div>
          <div class="scan-cam-handle" id="scanCamHandle-br" data-corner="br"></div>
          <div class="scan-cam-handle" id="scanCamHandle-bl" data-corner="bl"></div>
          <canvas class="scan-cam-erase-overlay" id="scanCamEraseOverlay"></canvas>
        </div>
      </div>
      <div class="scan-cam-tool-row" id="scanCamToolRow">
        ${_eraseToolRowHtml()}
      </div>
    </div>
  `;
  document.getElementById('scanCamModeSingle').addEventListener('click', () => _setScanSubMode('single'));
  document.getElementById('scanCamModeBook').addEventListener('click', () => _setScanSubMode('book'));
  _bindEraseToolRow();
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
    URL.revokeObjectURL(_frameUrl);
    _frameUrl = null;
    _startLiveView();
  });
  document.getElementById('scanCamSkipBtn')?.addEventListener('click', () => _skip());
  document.getElementById('scanCamConfirmBtn').addEventListener('click', () => _confirm());

  status.textContent = t('scan_cam_detecting');

  const img = document.getElementById('scanCamFrame');
  await new Promise(res => { img.onload = res; img.onerror = res; });
  if (myGen !== _reviewGen) { return; }  // modal closed while the frame image loaded

  await _detectAndSetQuad();
  if (myGen !== _reviewGen) { return; }  // modal closed while detecting the quad

  _computeFrameLayout();
  _resizeHandler = () => { _computeFrameLayout(); _renderHandles(); };
  window.addEventListener('resize', _resizeHandler);
  _renderHandles();
  _bindHandleDrag();
  document.getElementById('scanCamConfirmBtn').disabled = false;
}

// Shared by _startReview (initial detection) and _rotateCapturedImage/
// _resetCrop (re-detection after the working image changes, or on a
// plain "start over" request) — same detect-or-fallback logic, same
// status-line reporting, one place to keep them consistent.
async function _detectAndSetQuad() {
  const status = document.getElementById('scanCamStatus');
  let detected = null;
  try {
    await loadOpenCv();
    detected = detectDocumentQuad(_capturedCanvas);
  } catch {
    // CDN failure or detection error — defaultInsetQuad below covers it
  }
  _quad = detected || defaultInsetQuad(_capturedCanvas.width, _capturedCanvas.height);

  // Detection fallback is the more actionable message (affects the crop
  // itself) — only show the blur warning when detection succeeded, so the
  // status line never has to choose between two unrelated warnings at once.
  if (status) {
    if (!detected) {
      status.textContent = t('scan_cam_detect_fallback');
    } else {
      let blurry = false;
      try { blurry = computeBlurVariance(_capturedCanvas) < _BLUR_VARIANCE_THRESHOLD; } catch { /* skip on any canvas error */ }
      status.textContent = blurry ? t('scan_cam_blurry_hint') : '';
    }
  }
  return detected;
}

// Rotates the WORKING image itself (not just the crop quad) 90° in the
// given direction — a real user request comparing against a competing
// scanner app's rotate-left/rotate-right toolbar buttons: EXIF-based
// auto-orientation only covers a photo that was actually taken sideways
// per the camera's own sensor; a document photographed upright but
// deliberately rotated (or a source image with no/wrong EXIF at all)
// has no other recovery path today short of retaking the photo.
// Re-detects the quad on the newly-rotated image afterward (same
// reasoning as the initial detection: an old quad's coordinates don't
// meaningfully transfer across a dimension-swapping 90° rotation).
async function _rotateCapturedImage(direction) {
  const myGen = _reviewGen; // not bumped by rotation itself, only by _closeModal
  const src = _capturedCanvas;
  const rotated = document.createElement('canvas');
  rotated.width  = src.height;
  rotated.height = src.width;
  const ctx = rotated.getContext('2d');
  ctx.translate(rotated.width / 2, rotated.height / 2);
  ctx.rotate(direction * Math.PI / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  _capturedCanvas = rotated;
  _computeFrameLayout(); // dimensions swapped — the rotate-to-fit decision can flip too

  const img = document.getElementById('scanCamFrame');
  const oldUrl = _frameUrl;
  const blob = await new Promise(res => _capturedCanvas.toBlob(res, 'image/jpeg', 0.92));
  if (myGen !== _reviewGen || !img) { return; } // modal closed mid-rotation
  _frameUrl = URL.createObjectURL(blob);
  img.src = _frameUrl;
  await new Promise(res => { img.onload = res; img.onerror = res; });
  URL.revokeObjectURL(oldUrl);
  if (myGen !== _reviewGen) { return; }

  await _detectAndSetQuad();
  if (myGen !== _reviewGen) { return; }
  _renderHandles();
}

// Re-runs detection on the CURRENT working image without touching it —
// "start the crop over" for when manual corner-dragging has gone wrong,
// same real user request/comparison as rotation above.
async function _resetCrop() {
  const myGen = _reviewGen;
  await _detectAndSetQuad();
  if (myGen !== _reviewGen) { return; }
  _renderHandles();
}

// ── Blemish eraser ───────────────────────────────────────────
// Local (pre-scale, display-space) brush radii — same units _renderHandles
// already draws in (image px × _displayScale), so these look consistent
// regardless of how zoomed in/out the current photo happens to be.
const _ERASE_BRUSH_RADII = { small: 16, medium: 32, large: 56 };

function _eraseToolRowHtml() {
  if (_eraseMode) {
    return `
      <span class="scan-cam-erase-label">${t('scan_cam_erase_brush')}</span>
      ${['small', 'medium', 'large'].map(size => `
        <button type="button" class="scan-cam-tool-btn scan-cam-brush-btn${_eraseBrushSize === size ? ' scan-cam-tool-btn--active' : ''}" data-brush="${size}" aria-label="${t(`scan_cam_brush_${size}`)}">
          <span class="scan-cam-brush-dot scan-cam-brush-dot--${size}"></span>
        </button>
      `).join('')}
      <button type="button" class="scan-cam-tool-btn" id="scanCamEraseDone">${t('scan_cam_erase_done')}</button>
    `;
  }
  return `
    <button type="button" class="scan-cam-tool-btn" id="scanCamRotateLeft" aria-label="${t('scan_cam_rotate_left')}">↺</button>
    <button type="button" class="scan-cam-tool-btn" id="scanCamResetCrop" aria-label="${t('scan_cam_reset_crop')}">${t('scan_cam_reset_crop')}</button>
    <button type="button" class="scan-cam-tool-btn" id="scanCamErase" aria-label="${t('scan_cam_erase')}">🧹</button>
    <button type="button" class="scan-cam-tool-btn" id="scanCamRotateRight" aria-label="${t('scan_cam_rotate_right')}">↻</button>
  `;
}

function _bindEraseToolRow() {
  document.getElementById('scanCamRotateLeft')?.addEventListener('click', () => _rotateCapturedImage(-1));
  document.getElementById('scanCamRotateRight')?.addEventListener('click', () => _rotateCapturedImage(1));
  document.getElementById('scanCamResetCrop')?.addEventListener('click', () => _resetCrop());
  document.getElementById('scanCamErase')?.addEventListener('click', () => _setEraseMode(true));
  document.getElementById('scanCamEraseDone')?.addEventListener('click', () => _setEraseMode(false));
  document.querySelectorAll('.scan-cam-brush-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _eraseBrushSize = btn.dataset.brush;
      document.querySelectorAll('.scan-cam-brush-btn').forEach(b =>
        b.classList.toggle('scan-cam-tool-btn--active', b.dataset.brush === _eraseBrushSize));
    });
  });
}

function _setEraseMode(on) {
  _eraseMode = on;
  const toolRow = document.getElementById('scanCamToolRow');
  if (toolRow) { toolRow.innerHTML = _eraseToolRowHtml(); _bindEraseToolRow(); }

  const overlay = document.getElementById('scanCamEraseOverlay');
  const confirmBtn = document.getElementById('scanCamConfirmBtn');
  const skipOrRetakeBtn = document.getElementById('scanCamSkipBtn') || document.getElementById('scanCamRetakeBtn');
  if (on) {
    _showEraseOverlay(overlay);
    _bindEraseDrag(overlay);
    // Corner handles + confirm/skip stay in the DOM (so layout doesn't
    // jump) but shouldn't be interactive while painting — same
    // "disable, don't hide" reasoning as the slider reset buttons.
    document.querySelectorAll('.scan-cam-handle').forEach(h => h.style.pointerEvents = 'none');
    if (confirmBtn) confirmBtn.disabled = true;
    if (skipOrRetakeBtn) skipOrRetakeBtn.disabled = true;
  } else {
    _commitErase(overlay);
    document.querySelectorAll('.scan-cam-handle').forEach(h => h.style.pointerEvents = '');
    if (confirmBtn) confirmBtn.disabled = false;
    if (skipOrRetakeBtn) skipOrRetakeBtn.disabled = false;
  }
}

// Overlay is sized to the SAME local box _renderHandles/_computeFrameLayout
// already establish (image px × _displayScale) and lives inside the same
// rotating #scanCamFrameInner — it's carried along by that element's own
// CSS transform exactly like the SVG outline, no separate rotation math.
function _showEraseOverlay(overlay) {
  if (!overlay || !_capturedCanvas) return;
  const localW = Math.round(_capturedCanvas.width  * _displayScale);
  const localH = Math.round(_capturedCanvas.height * _displayScale);
  overlay.width  = localW;
  overlay.height = localH;
  overlay.style.width  = localW + 'px';
  overlay.style.height = localH + 'px';
  overlay.style.display = 'block';
  overlay.getContext('2d').clearRect(0, 0, localW, localH);
}

function _bindEraseDrag(overlay) {
  if (!overlay) return;
  const ctx = overlay.getContext('2d');
  ctx.fillStyle = '#fff';

  const paintAt = (clientX, clientY) => {
    const rect = overlay.getBoundingClientRect();
    const sx = Math.min(Math.max(0, clientX - rect.left), rect.width);
    const sy = Math.min(Math.max(0, clientY - rect.top),  rect.height);
    let lx, ly;
    if (_viewRotated) {
      ({ x: lx, y: ly } = unrotatedImagePoint(sx, sy, _capturedCanvas.width, _displayScale));
      lx *= _displayScale; ly *= _displayScale; // back to LOCAL (display) px — unrotatedImagePoint returns full-res image px
    } else {
      lx = sx; ly = sy;
    }
    // Radii are already in local/display px (see _ERASE_BRUSH_RADII's own
    // comment) — stays visually the same on-screen brush size regardless
    // of the photo's real resolution, no further scaling needed here.
    const radius = _ERASE_BRUSH_RADII[_eraseBrushSize] ?? _ERASE_BRUSH_RADII.medium;
    ctx.beginPath();
    ctx.arc(lx, ly, radius, 0, Math.PI * 2);
    ctx.fill();
  };

  let drawing = false;
  const onDown = e => {
    if (!_eraseMode) return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    drawing = true;
    paintAt(e.clientX, e.clientY);
  };
  const onMove = e => {
    if (!drawing) return;
    e.preventDefault();
    paintAt(e.clientX, e.clientY);
  };
  const onUp = () => { drawing = false; };
  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointermove', onMove);
  overlay.addEventListener('pointerup', onUp);
  overlay.addEventListener('pointercancel', onUp);
}

// Composites the overlay's white strokes onto _capturedCanvas at full
// resolution (drawImage's own dest-size scaling handles the
// local-px-to-real-px upscale) and regenerates _frameUrl from the result
// — same "mutate _capturedCanvas, re-encode, swap the <img> src" pattern
// _rotateCapturedImage already established, just without re-detecting the
// quad afterward (erasing a blemish shouldn't move the document's edges).
async function _commitErase(overlay) {
  if (!overlay || !_capturedCanvas) return;
  const ctx = _capturedCanvas.getContext('2d');
  ctx.drawImage(overlay, 0, 0, _capturedCanvas.width, _capturedCanvas.height);
  overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  overlay.style.display = 'none';

  const img = document.getElementById('scanCamFrame');
  const oldUrl = _frameUrl;
  const blob = await new Promise(res => _capturedCanvas.toBlob(res, 'image/jpeg', 0.92));
  if (!img) return; // modal closed mid-commit
  _frameUrl = URL.createObjectURL(blob);
  img.src = _frameUrl;
  await new Promise(res => { img.onload = res; img.onerror = res; });
  URL.revokeObjectURL(oldUrl);
}

// Mobile-only: decides whether displaying the working image CSS-rotated
// -90° would use the available box better than its natural orientation
// (see js/scanGeometry.js's chooseCropViewLayout for the full geometry
// rationale — same "rotate the interaction surface" trick js/fillUI.js's
// signature pad already uses for its own drawing canvas), and if so,
// explicitly sizes+rotates #scanCamFrameInner to match.
//
// Deliberately scoped to the mobile breakpoint (window.innerWidth<=700,
// matching css/components.css's own @media boundary for this modal's
// full-height layout): on desktop, .scan-cam-frame-wrap stays a plain
// content-sized (inline-block) box with plenty of headroom under its
// existing 60vh cap, and #scanCamFrameInner is left unstyled so the
// ORIGINAL, unrelated content-based sizing chain (.scan-cam-frame's own
// width:auto/height:auto/max-width/max-height) keeps working exactly as
// before this feature existed — _renderHandles() falls back to measuring
// the live rect there, same as it always did.
//
// #scanCamFrameInner (not #scanCamFrameWrap itself) gets the explicit
// size+rotation specifically so the flex-managed outer wrap (already
// fixed to correctly shrink to available space) keeps doing that job
// unmodified — the inner div's img/svg/handles are positioned using
// perfectly ordinary, UNROTATED local coordinates (see _renderHandles
// below, unchanged either way) and the CSS transform on this one element
// carries all of them along together as a rigid group. Only
// _bindHandleDrag's screen-to-local inverse (real touch/mouse
// coordinates, which reflect the POST-rotation visual bounds) needs
// rotation-aware math.
function _computeFrameLayout() {
  const wrap  = document.getElementById('scanCamFrameWrap');
  const inner = document.getElementById('scanCamFrameInner');
  const img   = document.getElementById('scanCamFrame');
  if (!wrap || !inner || !_capturedCanvas) return;

  if (window.innerWidth > 700) {
    _viewRotated = false;
    inner.style.cssText = '';
    if (img) img.style.cssText = '';
    return;
  }

  const boxW = wrap.clientWidth, boxH = wrap.clientHeight;
  if (boxW <= 0 || boxH <= 0) return; // not laid out yet — next resize/render will retry

  const { rotated, scale } = chooseCropViewLayout(_capturedCanvas.width, _capturedCanvas.height, boxW, boxH);
  _viewRotated  = rotated;
  _displayScale = scale;

  inner.style.width     = `${_capturedCanvas.width  * scale}px`;
  inner.style.height    = `${_capturedCanvas.height * scale}px`;
  inner.style.transform = rotated ? 'rotate(-90deg)' : '';
  if (img) img.style.cssText = 'display:block;width:100%;height:100%;max-width:none;max-height:none;';
}

function _renderHandles() {
  const inner = document.getElementById('scanCamFrameInner');
  if (!inner || !_quad) return;

  // Desktop leaves #scanCamFrameInner unsized (see _computeFrameLayout's
  // own comment) — it just hugs the img's own content-based size, so the
  // scale must still be measured live here, exactly as before this
  // feature existed. Mobile already precomputed an exact _displayScale
  // (and sized the inner to match) in _computeFrameLayout().
  if (window.innerWidth > 700) {
    const rect = inner.getBoundingClientRect();
    _displayScale = rect.width / _capturedCanvas.width;
  }

  const localW = _capturedCanvas.width  * _displayScale;
  const localH = _capturedCanvas.height * _displayScale;

  const svg = document.getElementById('scanCamOutline');
  svg.setAttribute('width', localW);
  svg.setAttribute('height', localH);
  svg.style.width  = localW + 'px';
  svg.style.height = localH + 'px';

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

// Magnifier loupe, shown while dragging a corner handle — a real user
// request comparing this to a competing scanner app's implementation:
// on a touchscreen, a finger dragging a small handle covers the exact
// point being placed, making precise corner placement genuinely hard to
// judge. The loupe shows a zoomed crop of the SOURCE image (not the
// on-screen scaled <img>, so it stays sharp at zoom) centered on the
// live corner position, offset above the actual touch point so the
// finger never covers it — flips below if the point is too close to the
// frame's top edge to fit above.
const _MAGNIFIER_SIZE       = 100; // CSS px, both the canvas and its visual diameter
const _MAGNIFIER_ZOOM       = 2.5;
const _MAGNIFIER_OFFSET_Y   = 90;  // px above the touch point, center to center

let _magnifierEl = null;

function _showMagnifier(displayX, displayY, fullResX, fullResY) {
  const wrap = document.getElementById('scanCamFrameWrap');
  if (!wrap) return;
  if (!_magnifierEl) {
    _magnifierEl = document.createElement('canvas');
    _magnifierEl.className = 'scan-cam-magnifier';
    _magnifierEl.width  = _MAGNIFIER_SIZE;
    _magnifierEl.height = _MAGNIFIER_SIZE;
    wrap.appendChild(_magnifierEl);
  }

  const cropSize = _MAGNIFIER_SIZE / _MAGNIFIER_ZOOM;
  const ctx = _magnifierEl.getContext('2d');
  ctx.clearRect(0, 0, _MAGNIFIER_SIZE, _MAGNIFIER_SIZE);
  ctx.save();
  ctx.beginPath();
  ctx.arc(_MAGNIFIER_SIZE / 2, _MAGNIFIER_SIZE / 2, _MAGNIFIER_SIZE / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(
    _capturedCanvas,
    fullResX - cropSize / 2, fullResY - cropSize / 2, cropSize, cropSize,
    0, 0, _MAGNIFIER_SIZE, _MAGNIFIER_SIZE
  );
  ctx.restore();

  // Crosshair at dead center — marks the exact point being placed,
  // independent of whatever's in the underlying image at that spot.
  // Same green as the corner handles/crop outline (--green, #2D7A4F —
  // canvas 2D can't read a CSS custom property, hardcoded to match) and
  // a bigger arm length — a real user comparison found the original
  // small white crosshair harder to align by than the reference app's
  // bigger, brand-colored one.
  const armLen = 16;
  ctx.strokeStyle = '#2D7A4F';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(_MAGNIFIER_SIZE / 2 - armLen, _MAGNIFIER_SIZE / 2);
  ctx.lineTo(_MAGNIFIER_SIZE / 2 + armLen, _MAGNIFIER_SIZE / 2);
  ctx.moveTo(_MAGNIFIER_SIZE / 2, _MAGNIFIER_SIZE / 2 - armLen);
  ctx.lineTo(_MAGNIFIER_SIZE / 2, _MAGNIFIER_SIZE / 2 + armLen);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Clamped on BOTH axes to the wrap's own bounds — a real gap found via
  // a real user comparison (dragging a bottom-row handle, or one near the
  // left/right edge, could otherwise push the loupe partway off the
  // visible frame). Half the loupe's own size, since it's centered on
  // (left, top) via CSS transform:translate(-50%,-50%).
  const half = _MAGNIFIER_SIZE / 2;
  const wrapW = wrap.clientWidth, wrapH = wrap.clientHeight;

  const fitsAbove = displayY - _MAGNIFIER_OFFSET_Y - half >= 0;
  const rawY = fitsAbove ? displayY - _MAGNIFIER_OFFSET_Y : displayY + _MAGNIFIER_OFFSET_Y;
  const magY = Math.min(Math.max(rawY, half), Math.max(half, wrapH - half));
  const magX = Math.min(Math.max(displayX, half), Math.max(half, wrapW - half));

  _magnifierEl.style.left = magX + 'px';
  _magnifierEl.style.top  = magY + 'px';
}

function _hideMagnifier() {
  _magnifierEl?.remove();
  _magnifierEl = null;
}

function _bindHandleDrag() {
  ['tl', 'tr', 'br', 'bl'].forEach(corner => {
    const handle = document.getElementById(`scanCamHandle-${corner}`);
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const inner = document.getElementById('scanCamFrameInner');
      const wrap  = document.getElementById('scanCamFrameWrap');

      const onMove = ev => {
        // inner's own rect reflects whatever's actually on screen right now
        // (its natural content-sized box on desktop, or its explicitly
        // sized + possibly CSS-rotated box on mobile — either way this is
        // the real, current POST-transform bounding box).
        const innerRect = inner.getBoundingClientRect();
        const x = Math.min(Math.max(0, ev.clientX - innerRect.left), innerRect.width);
        const y = Math.min(Math.max(0, ev.clientY - innerRect.top),  innerRect.height);

        let fullX, fullY;
        if (_viewRotated) {
          ({ x: fullX, y: fullY } = unrotatedImagePoint(x, y, _capturedCanvas.width, _displayScale));
        } else {
          fullX = x / _displayScale;
          fullY = y / _displayScale;
        }
        _quad[corner] = { x: fullX, y: fullY };
        _renderHandles();

        // The magnifier is appended to #scanCamFrameWrap, not the
        // (possibly smaller/rotated) inner — convert this touch's
        // inner-relative position to wrap-relative by adding the inner's
        // own offset within the wrap (0,0 on desktop, where inner fills
        // the wrap exactly; a real offset on mobile, where inner is
        // centered within a wrap that may not match its own aspect ratio).
        const wrapRect = wrap.getBoundingClientRect();
        const offsetX = innerRect.left - wrapRect.left;
        const offsetY = innerRect.top  - wrapRect.top;
        _showMagnifier(x + offsetX, y + offsetY, fullX, fullY);
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        _hideMagnifier();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  });
}

function _setScanSubMode(mode) {
  _scanSubMode = mode;
  document.getElementById('scanCamModeSingle')?.classList.toggle('scan-cam-mode-chip--active', mode === 'single');
  document.getElementById('scanCamModeBook')?.classList.toggle('scan-cam-mode-chip--active', mode === 'book');
}

async function _confirm() {
  const myGen = _reviewGen;
  const status = document.getElementById('scanCamStatus');
  const confirmBtn = document.getElementById('scanCamConfirmBtn');
  // warpToRectAsync now has a real await point before the heavy work starts
  // (unlike the old synchronous warpToRect, which blocked the event loop
  // immediately) — a second click could otherwise interleave and call
  // _confirm() again mid-flight. Disabling here is new specifically
  // because of that, not a pre-existing gap the sync version already had.
  if (confirmBtn) confirmBtn.disabled = true;
  status.textContent = t('scan_cam_processing');
  try {
    const warped = await warpToRectAsync(_capturedCanvas, _quad);
    if (myGen !== _reviewGen) return; // modal closed while warping
    URL.revokeObjectURL(_frameUrl);
    _frameUrl = null;
    if (_scanSubMode === 'book') {
      _startSpineAdjust(warped);
      return;
    }
    const cb = _onConfirm;
    _closeModal({ suppressOnSkip: true });  // resolved via Confirm, not Skip
    cb?.([warped]);
  } catch {
    if (myGen !== _reviewGen) return;
    status.textContent = t('scan_cam_processing_failed');
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

// ── Book-spread mode: spine adjustment + split ──────────────────
//
// Runs AFTER the normal 4-corner crop is confirmed — the whole visible
// spread has already been perspective-corrected into `warped` by this
// point, same as single-page mode. This stage only asks "where's the
// gutter", then splits the already-rectified image in two at that x.
// Scoped-down vs. ClearScan's own book-mode design (see this feature's
// memory note): no gutter-darkness/texture confidence scoring beyond
// detectSpineX's own simple check, no live recovery for asymmetric/
// border-filling spreads — the user's own draggable adjustment is the
// safety net here instead.
async function _startSpineAdjust(warped) {
  const myGen   = _reviewGen; // still valid — _confirm didn't bump it (only _closeModal/openX do)
  const stage   = document.getElementById('scanCamStage');
  const status  = document.getElementById('scanCamStatus');
  const actions = document.getElementById('scanCamActions');
  if (!stage || myGen !== _reviewGen) return;

  const blob = await new Promise(res => warped.toBlob(res, 'image/jpeg', 0.92));
  if (myGen !== _reviewGen) return; // modal closed while encoding
  _spineUrl = URL.createObjectURL(blob);

  let xFrac = 0.5, confident = false;
  try {
    const ctx = warped.getContext('2d');
    const data = ctx.getImageData(0, 0, warped.width, warped.height).data;
    ({ xFrac, confident } = detectSpineX(data, warped.width, warped.height));
  } catch { /* keep the 0.5 fallback */ }

  stage.innerHTML = `
    <div class="scan-cam-frame-wrap" id="scanCamSpineWrap">
      <img class="scan-cam-frame" id="scanCamSpineFrame" src="${_spineUrl}" alt="">
      <div class="scan-cam-spine-line" id="scanCamSpineLine"></div>
    </div>
  `;
  actions.innerHTML = `
    <button type="button" class="split-action-btn" id="scanCamSpineConfirmBtn">${t('scan_cam_split_use')}</button>
  `;
  status.textContent = confident ? '' : t('scan_cam_spine_fallback_hint');

  const img = document.getElementById('scanCamSpineFrame');
  await new Promise(res => { img.onload = res; img.onerror = res; });
  if (myGen !== _reviewGen) return;

  const renderSpine = () => {
    const rect = img.getBoundingClientRect();
    const line = document.getElementById('scanCamSpineLine');
    if (!line) return;
    line.style.left = (xFrac * rect.width) + 'px';
    line.style.height = rect.height + 'px';
  };
  renderSpine();
  _spineResizeHandler = () => renderSpine();
  window.addEventListener('resize', _spineResizeHandler);

  const line = document.getElementById('scanCamSpineLine');
  line.addEventListener('pointerdown', e => {
    e.preventDefault();
    line.setPointerCapture(e.pointerId);
    const onMove = ev => {
      const rect = img.getBoundingClientRect();
      const x = Math.min(Math.max(0, ev.clientX - rect.left), rect.width);
      xFrac = x / rect.width;
      renderSpine();
    };
    const onUp = () => {
      line.removeEventListener('pointermove', onMove);
      line.removeEventListener('pointerup', onUp);
      line.removeEventListener('pointercancel', onUp);
    };
    line.addEventListener('pointermove', onMove);
    line.addEventListener('pointerup', onUp);
    line.addEventListener('pointercancel', onUp);
  });

  document.getElementById('scanCamSpineConfirmBtn').addEventListener('click', () => {
    window.removeEventListener('resize', _spineResizeHandler);
    _spineResizeHandler = null;
    URL.revokeObjectURL(_spineUrl);
    _spineUrl = null;
    const splitX = Math.round(warped.width * xFrac);
    const left  = document.createElement('canvas');
    left.width  = Math.max(1, splitX);
    left.height = warped.height;
    left.getContext('2d').drawImage(warped, 0, 0);

    const right = document.createElement('canvas');
    right.width  = Math.max(1, warped.width - splitX);
    right.height = warped.height;
    right.getContext('2d').drawImage(warped, -splitX, 0);

    const cb = _onConfirm;
    _closeModal({ suppressOnSkip: true });
    cb?.([left, right]);
  });
}

function _skip() {
  URL.revokeObjectURL(_frameUrl);
  _frameUrl = null;
  _closeModal();  // gallery-mode close already fires onSkip — see _closeModal
}
