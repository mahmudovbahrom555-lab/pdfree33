// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  behavioralSignals.js — Silent quality signals from behavior
//
//  Signals that reveal result quality without asking the user:
//
//  RETRY        — same file converted 2+ times on this page
//                 → result was probably wrong
//  QUICK_RETRY  — new conversion started <90s after previous download
//                 → user opened the file, didn't like it, came back fast
//
//  Privacy: everything is kept in this page's memory only and is gone with
//  it — nothing in localStorage or sessionStorage (2026-10-25: a download's
//  time and tool were kept in localStorage for a "Return Visit" signal, the
//  files' hashes in sessionStorage; the privacy policy promises only UI
//  preferences on the device). Sent: the attempt number or the gap in
//  seconds, and the tool — never a hash, a name or any file data.
// ============================================================

import {
  trackBehaviorRetry,
  trackBehaviorQuickRetry,
  trackBehaviorAutoDownloadRecovery,
} from './analytics.js';

const _conversions = new Map();   // hash → conversions on this page
let _lastDownloadAt = 0;

// What the old signals left on returning users' devices goes (2026-10-25).
export function forgetStoredSignals() {
  try { localStorage.removeItem('pdfree_last_dl'); localStorage.removeItem('pdfree_search_misses'); } catch { /* storage blocked */ }
  try { sessionStorage.removeItem('pdfree_hashes'); } catch { /* storage blocked */ }
}

// ── Record download ───────────────────────────────────────────
// Called when the user clicks the Download button.

export function recordDownload() {
  _lastDownloadAt = Date.now();
}

// ── Retry + quick-retry detection ────────────────────────────
// Called at conversion start (before doProcess).
// Fire-and-forget: never throws, never delays processing.

export async function checkAndRecordConversion(tool, file) {
  if (!file) return;
  const hash = await _sha256First64k(file);
  if (!hash) return;

  // ── Same-file retry ──
  const prev = _conversions.get(hash) || 0;
  _conversions.set(hash, prev + 1);
  if (prev >= 1) {
    trackBehaviorRetry(tool, prev + 1);  // attempt number (2nd, 3rd, …)
  }

  // ── Quick retry after a download on this page ──
  if (_lastDownloadAt) {
    const gapS = (Date.now() - _lastDownloadAt) / 1000;
    if (gapS >= 0 && gapS < 90) {
      trackBehaviorQuickRetry(tool, gapS);
    }
  }
}

// ── Auto-download recovery detection ────────────────────────────
// Called when the user manually clicks "Download again". If that lands
// within a few seconds of the automatic download firing, the automatic
// one almost certainly failed silently — there's no reliable browser API
// to detect a blocked/dismissed download directly, so a fast manual
// re-click is the best available proxy.

const _AUTO_DOWNLOAD_RECOVERY_WINDOW_MS = 8000;

export function checkAutoDownloadRecovery(tool, autoDownloadAtMs) {
  if (Date.now() - autoDownloadAtMs > _AUTO_DOWNLOAD_RECOVERY_WINDOW_MS) return;
  trackBehaviorAutoDownloadRecovery(tool);
}

// SHA-256 of first 64 KB — fast enough to run just before processing.
// 64 KB is sufficient to distinguish different PDFs; doesn't reveal content.
async function _sha256First64k(file) {
  try {
    const buf    = await file.slice(0, 65536).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
