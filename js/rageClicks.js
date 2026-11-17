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

// Controls people press again and again on purpose: undo/redo, next/prev,
// size and zoom steppers, and drawing canvases. In the 2026-11-14 review they
// were half of all Rage Clicks (#drawCanvas 32 people, #btnUndo 22, #btnNext,
// #selSizeUp …) and buried the real ones (the Merge file name, #mergeBtn).
// Matched by the camelCase ending of the id, so a new stepper is covered too.
const _REPEAT_ID = /(?:^|[a-z])(?:Undo|Redo|Next|Prev|Up|Down|ZoomIn|ZoomOut)(?:Btn|Thumb|Page)?$/;
// Text fields too: three clicks select a field's text to type over it, and a
// number field's arrows are clicked again and again. The 2026-11-17 day's top
// three Rage Clicks were fields (#compressTargetValue 14 people,
// #extRangeInput 7, #mergeFilenameInput 5); Compress's size field, tried by
// hand on a desktop and a phone in five browser languages, takes clicks,
// focus and typing ("2,5" too) as it should.
const _FIELD_TYPES = /^(?:text|number|search|email|tel|url|password|)$/i;
export function isRepeatControl(el) {
  return el?.tagName === 'CANVAS' || _REPEAT_ID.test(el?.id || '') ||
    el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' ||
    (el?.tagName === 'INPUT' && _FIELD_TYPES.test(el.type || ''));
}

export function initRageClickDetection() {
  const _clickLog        = new WeakMap(); // element -> recent click timestamps
  const _rageFiredRecently = new WeakMap(); // element -> last-fired timestamp

  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, a, [role="button"], input[type="submit"]') || e.target;
    if (isRepeatControl(el)) return;

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
