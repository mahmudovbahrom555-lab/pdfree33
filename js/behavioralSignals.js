// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  behavioralSignals.js — Silent quality signals from behavior
//
//  Three signals that reveal result quality without asking the user:
//
//  RETRY        — same file converted 2+ times this session
//                 → result was probably wrong
//  QUICK_RETRY  — new conversion started <90s after previous download
//                 → user opened the file, didn't like it, came back fast
//  RETURN_VISIT — page opened within 5 minutes of the last download
//                 → user checked the result and returned unhappy
//
//  Privacy guarantees:
//  • File hash = SHA-256 of first 64 KB only — fast, non-identifying
//  • sessionStorage: cleared when tab closes — no cross-session tracking
//  • localStorage: timestamps + tool name only — no filenames, no file data
//  • Zero third-party calls beyond the existing Plausible script
// ============================================================

import {
  trackBehaviorRetry,
  trackBehaviorQuickRetry,
  trackBehaviorReturnVisit,
} from './analytics.js';

const _SS_KEY = 'pdfree_hashes';   // sessionStorage: { [hash]: conversionCount }
const _LS_KEY = 'pdfree_last_dl';  // localStorage:   { ts: ms, tool: string }

// ── Return-visit detection ────────────────────────────────────
// Called once on DOMContentLoaded. If the user downloaded a file in the
// last 5 minutes and then re-opened the site, that's a quality signal.

export function checkReturnVisit() {
  try {
    const raw = localStorage.getItem(_LS_KEY);
    if (!raw) return;
    const { ts, tool } = JSON.parse(raw);
    const gapMs = Date.now() - ts;
    if (gapMs <= 0 || gapMs > 5 * 60_000) return;
    const gapMin = gapMs < 60_000 ? '<1' : String(Math.floor(gapMs / 60_000));
    trackBehaviorReturnVisit(gapMin, tool ?? 'unknown');
  } catch { /* never break the app */ }
}

// ── Record download ───────────────────────────────────────────
// Called when the user clicks the Download button.
// Stores only a timestamp + tool name — no file data.

export function recordDownload(tool) {
  try {
    localStorage.setItem(_LS_KEY, JSON.stringify({ ts: Date.now(), tool }));
  } catch { /* storage quota or private browsing mode */ }
}

// ── Retry + quick-retry detection ────────────────────────────
// Called at conversion start (before doProcess).
// Fire-and-forget: never throws, never delays processing.

export async function checkAndRecordConversion(tool, file) {
  if (!file) return;
  const hash = await _sha256First64k(file);
  if (!hash) return;

  try {
    // ── Same-file retry (sessionStorage, cleared on tab close) ──
    const raw    = sessionStorage.getItem(_SS_KEY);
    const counts = raw ? JSON.parse(raw) : {};
    const prev   = counts[hash] || 0;
    counts[hash] = prev + 1;
    sessionStorage.setItem(_SS_KEY, JSON.stringify(counts));

    if (prev >= 1) {
      trackBehaviorRetry(tool, prev + 1);  // attempt number (2nd, 3rd, …)
    }

    // ── Quick retry after recent download (localStorage timestamp) ──
    const dlRaw = localStorage.getItem(_LS_KEY);
    if (dlRaw) {
      const { ts } = JSON.parse(dlRaw);
      const gapS  = (Date.now() - ts) / 1000;
      if (gapS >= 0 && gapS < 90) {
        trackBehaviorQuickRetry(tool, gapS);
      }
    }
  } catch { /* never block processing */ }
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
