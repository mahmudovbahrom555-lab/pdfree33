// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  homepageEngagement.js — Passive homepage engagement signals
//
//  Three signals, homepage-only (tool pages already get an equivalent
//  "did nothing" rate for free from the Tool Open → File Added gap in
//  the existing funnel — see analytics.js):
//
//  TIME_TO_INTERACT — ms from load to first click/input
//  NO_INTERACTION   — page hidden/closed with zero clicks/input this
//                      pageview (fires at most once)
//  SCROLL_DEPTH     — 25/50/75/100% milestones (fires at most once each)
//
//  Kept independent of each other by design — each event's meaning stays
//  crisp; cross-referencing (e.g. "left without scrolling past 25%") is
//  left to Plausible's own segmentation UI.
// ============================================================

import {
  trackHomepageTimeToInteract,
  trackHomepageNoInteraction,
  trackHomepageScrollDepth,
} from './analytics.js';

export function initHomepageEngagement() {
  const _startMs = performance.now();
  let _hasInteracted = false;
  let _noInteractionFired = false;

  // ── Time-to-first-interaction / no-interaction ──────────────
  function _onFirstInteraction() {
    if (_hasInteracted) return;
    _hasInteracted = true;
    trackHomepageTimeToInteract(performance.now() - _startMs);
    document.removeEventListener('click', _onFirstInteraction);
    document.removeEventListener('input', _onFirstInteraction);
  }
  document.addEventListener('click', _onFirstInteraction);
  document.addEventListener('input', _onFirstInteraction);

  // visibilitychange over pagehide/beforeunload — fires reliably on mobile
  // backgrounding, avoids deprecated-unload pitfalls. Doesn't conflict with
  // app.js's own visibilitychange listener (service-worker update check) —
  // addEventListener supports multiple independent listeners.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (_hasInteracted || _noInteractionFired) return;
    _noInteractionFired = true;
    trackHomepageNoInteraction(performance.now() - _startMs);
  });

  // ── Scroll depth ─────────────────────────────────────────────
  const _milestones = [25, 50, 75, 100];
  const _fired = new Set();
  let _scrollTicking = false;

  function _checkScrollDepth() {
    const scrollTop    = window.scrollY;
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (scrollHeight <= 0) return; // page shorter than viewport — no scroll possible
    const pct = (scrollTop / scrollHeight) * 100;
    for (const milestone of _milestones) {
      if (pct >= milestone && !_fired.has(milestone)) {
        _fired.add(milestone);
        trackHomepageScrollDepth(milestone);
      }
    }
  }

  window.addEventListener('scroll', () => {
    if (_scrollTicking) return;
    _scrollTicking = true;
    requestAnimationFrame(() => {
      _checkScrollDepth();
      _scrollTicking = false;
    });
  }, { passive: true });
}
