// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  analytics.js — Privacy-first analytics via Plausible
//
//  🎯 Сверх ТЗ:
//  1. File size buckets ("< 1 MB", "1–10 MB", "10–50 MB", "> 50 MB")
//     вместо точных цифр — никаких fingerprinting-рисков.
//  2. Все события через один helper _track() — легко отключить
//     в dev-сборке (просто убери скрипт Plausible из HTML).
//  3. Tool timings — замеряем сколько секунд заняла обработка
//     (rounded to nearest 5s) — помогает понять performance.
//  4. Graceful: если window.plausible не загружен (adblock,
//     нет интернета) — молча ничего не делает.
// ============================================================

/** Rounded size bucket for privacy-safe reporting */
function _sizeBucket(bytes) {
  if (!bytes || bytes <= 0)        return 'unknown';
  const mb = bytes / 1048576;
  if (mb < 1)   return '< 1 MB';
  if (mb < 10)  return '1–10 MB';
  if (mb < 50)  return '10–50 MB';
  return '> 50 MB';
}

/** Round duration to nearest 5 seconds for privacy */
function _roundDuration(ms) {
  const s = Math.round(ms / 1000);
  return Math.round(s / 5) * 5;
}

// Plausible v2: set up event queue so events fired before the async
// script loads are buffered and replayed once the script initialises.
if (typeof window !== 'undefined') {
  window.plausible = window.plausible || function() {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };
}

/** Plausible custom event wrapper — no-op if not loaded */
function _track(eventName, props = {}) {
  try {
    if (typeof window === 'undefined') return;
    if (typeof window.plausible === 'function') {
      window.plausible(eventName, { props });
    }
    // In development, log to console instead
    if (window._pdfreeDevMode) {
      console.info(`[Analytics] ${eventName}`, props);
    }
  } catch { /* Never let analytics break the app */ }
}

// ── Per-tool timing ───────────────────────────────────────────
const _timers = {};

/**
 * Call when a tool becomes visible to the user (step 1 of the funnel).
 * Plausible funnel: Tool Open → File Added → Tool Start → Tool Success/Cancel/Error
 */
export function trackToolOpen(tool) {
  _track('Tool Open', { tool });
}

/** Call when a tool starts processing */
export function trackToolStart(tool) {
  _timers[tool] = performance.now();
}

/**
 * Call when a tool completes successfully.
 * @param {string} tool
 * @param {{ inputSize?: number, outputSize?: number }} opts
 */
export function trackToolSuccess(tool, { inputSize = 0, outputSize = 0 } = {}) {
  const durationMs = _timers[tool] ? performance.now() - _timers[tool] : null;
  delete _timers[tool];

  const props = {
    tool,
    input_size:  _sizeBucket(inputSize),
    output_size: _sizeBucket(outputSize),
  };
  if (durationMs !== null) {
    props.duration_s = _roundDuration(durationMs);
  }

  _track('Tool Success', props);
}

/** Track tool cancellations — useful for UX insight */
export function trackToolCancel(tool) {
  delete _timers[tool];
  _track('Tool Cancel', { tool });
}

/** Track first file added — measures "activation rate" */
export function trackFileAdded(tool, fileSize = 0) {
  _track('File Added', { tool, size: _sizeBucket(fileSize) });
}

/**
 * Track tool errors — the single most useful signal for knowing what to fix.
 *
 * error_type taxonomy (based on actual runtime error sources):
 *   enc_lib_failed      — encryption library failed to load from CDN
 *   enc_failed          — encryption failed (unsupported PDF format)
 *   pdf_restricted      — PDF has AES owner-password restrictions
 *   renderer_not_loaded — pdf.js renderer was not initialized
 *   render_all_failed   — pdf2jpg: every page failed to render
 *   pdf_engine_failed   — pdf.js failed to load from CDN
 *   pdf_read_failed     — could not read PDF page metadata
 *   worker_crash        — unhandled worker error
 *   no_pages            — user submitted with no pages selected (UX gap)
 *   unknown             — unclassified
 */
export function trackToolError(tool, errorType = 'unknown') {
  delete _timers[tool];
  _track('Tool Error', { tool, error_type: errorType });
}

/** Track install prompt shown / accepted / dismissed */
export function trackInstallPrompt(action) {
  // action: 'shown' | 'accepted' | 'dismissed'
  _track('PWA Install', { action });
}

/** Track file download — measures real conversion (processed → saved) */
export function trackDownload(tool, outputSize = 0) {
  _track('Download', { tool, output_size: _sizeBucket(outputSize) });
}
