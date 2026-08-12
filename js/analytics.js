// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  analytics.js — Privacy-first analytics via Workers Analytics Engine
//
//  🎯 Сверх ТЗ:
//  1. File size buckets ("< 1 MB", "1–10 MB", "10–50 MB", "> 50 MB")
//     вместо точных цифр — никаких fingerprinting-рисков.
//  2. Все события через один helper _track() — единая точка,
//     если транспорт снова сменится, менять только его.
//  3. Tool timings — замеряем сколько секунд заняла обработка
//     (rounded to nearest 5s) — помогает понять performance.
//  4. Graceful: сетевая ошибка / отсутствие бэкенда — молча
//     ничего не делает, никогда не ломает приложение.
//
//  Transport: fire-and-forget POST to /api/analytics (same-origin
//  Cloudflare Worker route), which relays to Workers Analytics Engine
//  via env.ANALYTICS.writeDataPoint() — see src/index.js. Replaced the
//  previous Plausible integration (paid service); Analytics Engine has
//  no client-side JS API, so every event now needs this server round-
//  trip instead of a direct window.plausible() call.
// ============================================================

import { getLang } from './config.js';

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

/** Custom event wrapper — fire-and-forget, never throws into the caller */
function _track(eventName, props = {}) {
  try {
    if (typeof window === 'undefined') return;
    // locale first — no caller ever passes it explicitly, but this keeps
    // the merge order intentional rather than accidental.
    const fullProps = { locale: getLang(), ...props };
    if (typeof fetch === 'function') {
      fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventName, props: fullProps }),
      }).catch(() => { /* offline/adblock/etc — never let this break the app */ });
    }
    // In development, log to console instead
    if (window._pdfreeDevMode) {
      console.info(`[Analytics] ${eventName}`, fullProps);
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

/**
 * Track the "Share this tool" flow — separate from Download/Send (file sharing).
 * action: 'open' (button clicked) | 'success' (native share completed) |
 *         'cancel' (native share dismissed) | 'fallback_open' (no navigator.share —
 *         custom menu shown) | 'copy_link' | 'whatsapp' | 'telegram' | 'email'
 * (the last four are fallback-menu channel clicks)
 */
export function trackShareTool(action, tool) {
  _track('Share Tool', { action, tool });
}

// ── Behavioral quality signals ────────────────────────────────
// These fire without asking the user — behavior reveals satisfaction.

/** Same file converted 2+ times this session → result was likely wrong */
export function trackBehaviorRetry(tool, attempt) {
  _track('Retry Conversion', { tool, attempt: String(attempt) });
}

/** New conversion <90s after previous download → user checked result and came back fast */
export function trackBehaviorQuickRetry(tool, gapS) {
  _track('Quick Retry', { tool, gap_s: String(_roundDuration(gapS * 1000)) });
}

/** Page opened within 5 min of last download → user checked result and returned */
export function trackBehaviorReturnVisit(gapMin, tool) {
  _track('Return Visit', { gap_min: String(gapMin), tool });
}

/**
 * User clicked "Download again" within seconds of the automatic download
 * firing → the automatic one very likely failed silently (blocked by the
 * browser, a save dialog was dismissed, iOS Safari opened the PDF instead
 * of saving it). Strongest available signal for "the file was ready but
 * the user never actually got it" — see behavioralSignals.js.
 */
export function trackBehaviorAutoDownloadRecovery(tool) {
  _track('Auto Download Recovery', { tool });
}

// ── Batch processing funnel ─────────────────────────────────────
// Layered on top of the generic Tool Open → File Added → Tool Start →
// Tool Success funnel above (app.js's shared pdfree:success handler calls
// trackToolSuccess for batch runs too, via the same _timers[tool] set by
// the trackToolStart call before doProcess() — that's left untouched here).
// These batch-specific events add file-count and per-batch success-rate
// visibility that the generic funnel can't express.
const _batchTimers = {};

/** Call when a batch run begins (2+ files selected on a batch-eligible tool). */
export function trackBatchStart(tool, fileCount) {
  _batchTimers[tool] = performance.now();
  _track('Batch Start', { tool, files: String(fileCount) });
}

/**
 * Call when a batch run finishes and a ZIP was produced (even if some
 * individual files failed — see trackToolError('batch_item_failed') for
 * per-file failures and trackToolError('batch_all_failed') when none succeed).
 */
export function trackBatchSuccess(tool, fileCount, succeeded) {
  const durationMs = _batchTimers[tool] ? performance.now() - _batchTimers[tool] : null;
  delete _batchTimers[tool];
  const props = { tool, files: String(fileCount), succeeded: String(succeeded) };
  if (durationMs !== null) props.duration_s = _roundDuration(durationMs);
  _track('Batch Success', props);
}

// ── Search funnel ─────────────────────────────────────────────

/** User typed a query and got results */
export function trackSearchQuery(query, hits) {
  _track('Search Query', { query: query.slice(0, 50), hits: String(hits) });
}

/** User typed a query and got zero results */
export function trackSearchMiss(query) {
  _track('Search Miss', { query: query.slice(0, 50) });
}

/** User clicked a search result and launched that tool */
export function trackSearchSelect(query, tool) {
  _track('Search Select', { query: query.slice(0, 50), tool });
}

// ── Hero drop zone funnel ──────────────────────────────────────

/**
 * User selected file(s) in the hero drop zone.
 * @param {number} fileCount
 * @param {'drop'|'button'} source
 */
export function trackHeroFileSelect(fileCount, source) {
  _track('Hero File Select', { count: String(fileCount), source });
}

/**
 * User clicked a popular chip.
 * @param {string} key   — tool key (e.g. 'merge', 'compress')
 * @param {'file-first'|'search-first'|'image-hint'|'search-candidate'|'search-fallback'} flow
 *   file-first  = had a pending file → chip launches tool immediately
 *   search-first = no file → chip opens result card for file selection
 *   image-hint  = clicked the hero-zone "have an image?" escape hatch
 *   search-candidate = picked one of several tools a query narrowed down to
 *   search-fallback  = query matched nothing → picked one of the popular
 *                      tools shown as a fallback instead
 */
export function trackChipClick(key, flow) {
  _track('Chip Click', { tool: key, flow });
}

// ── Homepage engagement signals ─────────────────────────────────
// Homepage-only — tool pages already get an equivalent "did nothing" rate
// for free from the gap between Tool Open and File Added counts above.
// Kept independent of each other by design: each event's meaning stays
// literal (e.g. "No Interaction" means zero clicks/input, full stop), and
// any cross-referencing (e.g. "left without scrolling past 25%") is left
// to Plausible's own segmentation UI rather than baked into the code.
// See js/homepageEngagement.js for the signal-detection wiring.

/**
 * User's first click/input anywhere on the homepage after load. Fired at
 * most once per pageview. Answers "how long before someone engages" —
 * informs whether the hero/above-the-fold content prompts immediate action.
 * @param {number} elapsedMs — ms from navigation/bootstrap to first interaction
 */
export function trackHomepageTimeToInteract(elapsedMs) {
  _track('Homepage Time To Interact', { seconds: String(_roundDuration(elapsedMs)) });
}

/**
 * Homepage tab hidden (backgrounded/closed/navigated away) with zero
 * clicks or input events recorded during this pageview. Fired at most
 * once per pageview.
 * @param {number} elapsedMs — ms from navigation/bootstrap to hidden
 */
export function trackHomepageNoInteraction(elapsedMs) {
  _track('Homepage No Interaction', { seconds: String(_roundDuration(elapsedMs)) });
}

/**
 * User's vertical scroll passed a milestone percentage of the page. Fired
 * at most once per milestone per pageview. Directly answers whether
 * content below the hero (tool cards, FAQ) gets seen at all.
 * @param {25|50|75|100} depth
 */
export function trackHomepageScrollDepth(depth) {
  _track('Homepage Scroll Depth', { depth: String(depth) });
}
