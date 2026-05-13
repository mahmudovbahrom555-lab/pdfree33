// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

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

/** Track install prompt shown / accepted / dismissed */
export function trackInstallPrompt(action) {
  // action: 'shown' | 'accepted' | 'dismissed'
  _track('PWA Install', { action });
}
