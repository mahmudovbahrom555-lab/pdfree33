// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  rageClicks.js — Site-wide rage-click detection
//
//  Unlike homepageEngagement.js, this runs on every page (tool pages
//  included) — a disabled "Process" button before a file's selected, an
//  unresponsive redact-canvas, or any confusing control is just as
//  relevant on a tool page as on the homepage.
//
//  3+ clicks on the SAME element within ~1s fires one Rage Click event,
//  then a 5s cooldown per element suppresses re-firing during a sustained
//  burst — same "fire once, not per event" discipline as scroll-depth
//  milestones in homepageEngagement.js.
// ============================================================

import { trackRageClick } from './analytics.js';

const RAGE_WINDOW_MS   = 1000; // clicks must land within this window to count as a burst
const RAGE_THRESHOLD   = 3;    // clicks within the window that trigger a fire
const RAGE_COOLDOWN_MS = 5000; // suppress re-firing on the same element for this long after firing

// Best-effort element descriptor — good enough to identify *which* element
// without needing a full CSS-selector library.
function _describeElement(el) {
  if (!el || el === document.body) return 'body';
  if (el.id) return `#${el.id}`;
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
  return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
}

export function initRageClickDetection() {
  const _clickLog        = new WeakMap(); // element -> recent click timestamps
  const _rageFiredRecently = new WeakMap(); // element -> last-fired timestamp

  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, a, [role="button"], input[type="submit"]') || e.target;

    const now = Date.now();
    const timestamps = (_clickLog.get(el) || []).filter(t => now - t < RAGE_WINDOW_MS);
    timestamps.push(now);
    _clickLog.set(el, timestamps);

    if (timestamps.length >= RAGE_THRESHOLD) {
      const lastFired = _rageFiredRecently.get(el) || 0;
      if (now - lastFired > RAGE_COOLDOWN_MS) {
        _rageFiredRecently.set(el, now);
        trackRageClick(_describeElement(el));
      }
    }
  }, { passive: true });
}
