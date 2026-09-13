// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  dragReorder.js — Shared drag-to-reorder (mouse + touch)
//
//  Extracted from files.js's merge-list reordering so any other tool's
//  UI (e.g. jpg2pdfUI.js's thumbnail grid) can reuse the exact same
//  proven mouse+touch logic instead of a parallel reimplementation.
//
//  Two modes, since list and grid reordering have different touch physics:
//    'list' — vertical list (merge's file rows): touch drag moves only
//             on the Y axis, and horizontal movement cancels the gesture
//             (assumed to be a scroll/swipe, not a reorder intent).
//    'grid' — wrapping thumbnail grid (jpg2pdf's previews): touch drag
//             moves on both axes, no horizontal-cancel heuristic — a
//             grid reorder legitimately needs to move sideways to reach
//             a different column.
//
//  Each item must carry data-i="<index>" matching its position in `array`
//  — the same convention files.js already used for .file-item rows.
// ============================================================

/**
 * Wire drag-to-reorder onto items already in the DOM. Call once per render
 * pass, after the container's innerHTML is set — listeners are attached
 * per-item (not delegated), so a re-render naturally sheds old listeners
 * along with the old nodes.
 * @param {object} opts
 * @param {HTMLElement} opts.container   — element holding the items
 * @param {string} opts.itemSelector     — CSS class of each item, e.g. '.file-item' or '.j2p-thumb'
 * @param {Array[]} opts.arrays          — array(s) to splice in lockstep on reorder, e.g.
 *                                         [selectedFiles] or [selectedFiles, exifAngles] when
 *                                         a caller keeps a second array parallel-indexed to it
 * @param {() => void} opts.onReorder    — called after splicing — re-render
 * @param {() => boolean} [opts.isLocked] — skip reordering while processing
 * @param {'list'|'grid'} [opts.mode]    — touch gesture behavior, default 'list'
 */
export function bindDragReorder({ container, itemSelector, arrays, onReorder, isLocked = () => false, mode = 'list' }) {
  const items = container.querySelectorAll(itemSelector);

  items.forEach(el => {
    el.draggable = !isLocked();
    el.addEventListener('dragstart', () => _onDragStart(el));
    el.addEventListener('dragover',  e => _onDragOver(e, el));
    el.addEventListener('drop',      e => _onDrop(e, el, { arrays, onReorder, isLocked }));
    el.addEventListener('dragend',   () => _onDragEnd(container, itemSelector));
    el.addEventListener('touchstart', e => _onTouchStart(e, el, isLocked), { passive: true });
    el.addEventListener('touchmove',  e => _onTouchMove(e, { itemSelector, mode }), { passive: false });
    el.addEventListener('touchend',   () => _onTouchEnd({ arrays, onReorder }));
    el.addEventListener('touchcancel', _onTouchCancel);
  });
}

// ── Mouse / HTML5 drag-and-drop ─────────────────────────────

let _dragFrom   = null;
let _dragOverEl = null; // currently-highlighted drop target — mirrors the
                         // touch path's own _touchOverEl tracking below, so
                         // only ONE item shows 'drag-target' at a time

function _onDragStart(el) {
  _dragFrom = +el.dataset.i;
  el.classList.add('dragging');
}

function _onDragOver(e, el) {
  e.preventDefault();
  // Real bug found via code review: dragover fires repeatedly on whatever
  // item is currently under the cursor, but nothing ever removed the class
  // from items the drag had ALREADY passed over — dragging a file down
  // through a list left every row it crossed highlighted green
  // simultaneously (visible via .drag-target's border+background) until
  // the whole gesture ended, instead of showing just the current target.
  if (_dragOverEl && _dragOverEl !== el) _dragOverEl.classList.remove('drag-target');
  el.classList.add('drag-target');
  _dragOverEl = el;
}

function _onDrop(e, el, { arrays, onReorder, isLocked }) {
  if (isLocked()) return;
  e.preventDefault();
  el.classList.remove('drag-target');
  _dragOverEl = null;
  const to = +el.dataset.i;
  if (_dragFrom === null || _dragFrom === to) return;

  // Splice every array (e.g. selectedFiles + a parallel-indexed metadata
  // array) in lockstep so index i still refers to the same logical item
  // across all of them after the move.
  for (const arr of arrays) {
    const [moved] = arr.splice(_dragFrom, 1);
    arr.splice(to, 0, moved);
  }
  _dragFrom = null;
  onReorder();
}

function _onDragEnd(container, itemSelector) {
  _dragOverEl = null;
  container.querySelectorAll(itemSelector).forEach(el => {
    el.classList.remove('dragging', 'drag-target');
  });
}

// ── Touch (HTML5 drag-and-drop does not fire on iOS/Android) ───
//
// Gesture detection:
//   'list' mode — horizontal movement dominates (|dx| > |dy| + 4): cancel,
//     let the browser scroll instead. Vertical movement past an 8px
//     threshold enters drag mode.
//   'grid' mode — any movement past an 8px radius enters drag mode,
//     since sideways movement is a normal part of reordering a grid.
//
// Visual: the dragged element follows the finger (translateY for 'list',
// translate(x,y) for 'grid'). elementFromPoint (with pointerEvents:'none'
// on the dragging element) finds the drop target under the finger, since
// touch events always fire on the original touched element regardless of
// where the finger has moved to.
//
// Auto-scroll near screen edges — real bug found via Organize PDF's 60%
// quick-retry rate: `e.preventDefault()` below actively blocks the
// browser's native scroll once a drag is committed, but nothing ever
// scrolled the page on its own, so a list/grid taller than one screen had
// no way to reach an off-screen drop target — confirmed empirically that
// even a 5-card grid already exceeds a 390×844 mobile viewport. Fixed with
// a manual scroll loop (same pattern as sortable.js/react-beautiful-dnd):
// while the finger sits within EDGE_ZONE of the top/bottom edge, a single
// requestAnimationFrame loop scrolls the page and re-derives the dragged
// element's transform + drop target every frame — the finger's own
// clientY doesn't change while it holds still at the edge, only the page
// moves beneath it, so both the visual position and the hit-test MUST be
// recomputed continuously, not just on the next touchmove.
const EDGE_ZONE        = 72; // px from a viewport edge that arms auto-scroll —
                              // a named constant specifically so it's cheap to
                              // recalibrate by feel later, not a magic number
const MAX_SCROLL_SPEED = 18; // px/frame at the very edge (~1080px/s @60fps) —
                              // capped so a long drag pinned to the edge can't
                              // fling the page at an uncontrollable rate

let _touchFrom         = null;
let _touchEl           = null;
let _touchStartY       = 0;
let _touchStartX       = 0;
let _touchStartScrollY = 0; // window.scrollY at drag start — lets the dragged
                             // element's transform stay finger-accurate even
                             // while auto-scroll moves the page under a
                             // stationary finger (see _applyDragTransform)
let _touchOverEl       = null;
let _touchDragging     = false;
let _lastTouchX        = 0; // last known finger position — the auto-scroll
let _lastTouchY        = 0; // RAF loop needs this on frames with no new touchmove

// Exactly one of these may be active at a time (see _updateAutoScroll) —
// running two would double the scroll speed and leak an uncancellable loop.
let _autoScrollDir   = 0;    // -1 (toward top) | 0 (idle) | 1 (toward bottom)
let _autoScrollSpeed = 0;
let _autoScrollRAF   = null; // requestAnimationFrame id, non-null iff running
let _autoScrollCtx   = null; // { itemSelector, mode } — the RAF loop runs
                              // independently of touchmove, so it needs its
                              // own copy of whatever touchmove would've had

function _onTouchStart(e, el, isLocked) {
  if (isLocked()) return;
  const touch = e.touches[0];
  _touchFrom         = +el.dataset.i;
  _touchEl           = el;
  _touchStartY       = touch.clientY;
  _touchStartX       = touch.clientX;
  _touchStartScrollY = window.scrollY;
  _touchOverEl       = null;
  _touchDragging     = false;
  _lastTouchX        = touch.clientX;
  _lastTouchY        = touch.clientY;
}

// Applies the CSS transform that visually follows the finger. dy is
// compensated for any scrolling that's happened since drag start (whether
// from auto-scroll or, in principle, anything else) — without this, once
// the page scrolls, the element would drift away from the finger instead
// of staying pinned under it.
function _applyDragTransform(mode) {
  const scrollDelta = window.scrollY - _touchStartScrollY;
  const dy = _lastTouchY - _touchStartY + scrollDelta;
  const dx = _lastTouchX - _touchStartX;
  _touchEl.style.transform = mode === 'grid'
    ? `translate(${dx}px, ${dy}px)`
    : `translateY(${dy}px)`;
}

// Finds whatever's directly under the finger (skip the dragging element
// itself) and updates the single drag-target highlight. Factored out of
// _onTouchMove so the auto-scroll RAF loop can re-run the same hit-test
// every frame, since elementFromPoint's answer changes as the page scrolls
// beneath an otherwise-stationary finger.
function _updateHitTarget(clientX, clientY, itemSelector) {
  _touchEl.style.pointerEvents = 'none';
  const hit = document.elementFromPoint(clientX, clientY);
  _touchEl.style.pointerEvents = '';

  const target = hit?.closest(itemSelector);

  if (target && target !== _touchEl) {
    if (_touchOverEl && _touchOverEl !== target) {
      _touchOverEl.classList.remove('drag-target');
    }
    target.classList.add('drag-target');
    _touchOverEl = target;
  } else if (!target && _touchOverEl) {
    _touchOverEl.classList.remove('drag-target');
    _touchOverEl = null;
  }
}

// Arms/updates/disarms the auto-scroll loop based on how close the finger
// is to a viewport edge. Speed ramps up linearly the deeper into the edge
// zone the finger sits, capped at MAX_SCROLL_SPEED right at the edge.
function _updateAutoScroll(clientY, ctx) {
  const vh = window.innerHeight;
  let dir = 0, intensity = 0;
  if (clientY < EDGE_ZONE) {
    dir = -1; intensity = (EDGE_ZONE - clientY) / EDGE_ZONE;
  } else if (clientY > vh - EDGE_ZONE) {
    dir = 1; intensity = (clientY - (vh - EDGE_ZONE)) / EDGE_ZONE;
  }

  _autoScrollDir   = dir;
  _autoScrollSpeed = MAX_SCROLL_SPEED * Math.min(1, intensity);
  _autoScrollCtx   = ctx;

  if (dir !== 0 && _autoScrollRAF === null) {
    _autoScrollRAF = requestAnimationFrame(_autoScrollTick);
  } else if (dir === 0) {
    _stopAutoScrollLoop();
  }
}

function _autoScrollTick() {
  // Drag ended/cancelled without going through _stopAutoScrollLoop (should
  // not happen given onTouchEnd/onTouchCancel both call it first, but a
  // stale RAF callback outliving the drag would otherwise scroll the page
  // forever with no way to stop it) — bail out defensively.
  if (_autoScrollDir === 0 || _touchFrom === null || !_touchDragging) {
    _stopAutoScrollLoop();
    return;
  }
  window.scrollBy(0, _autoScrollDir * _autoScrollSpeed);
  _applyDragTransform(_autoScrollCtx.mode);
  _updateHitTarget(_lastTouchX, _lastTouchY, _autoScrollCtx.itemSelector);
  _autoScrollRAF = requestAnimationFrame(_autoScrollTick);
}

function _stopAutoScrollLoop() {
  if (_autoScrollRAF !== null) cancelAnimationFrame(_autoScrollRAF);
  _autoScrollRAF   = null;
  _autoScrollDir   = 0;
  _autoScrollSpeed = 0;
  _autoScrollCtx   = null;
}

function _onTouchMove(e, { itemSelector, mode }) {
  if (_touchFrom === null) return;
  const touch = e.touches[0];
  const dy = touch.clientY - _touchStartY;
  const dx = touch.clientX - _touchStartX;

  if (!_touchDragging) {
    if (mode === 'list') {
      // Horizontal scroll intent — abort drag entirely
      if (Math.abs(dx) > Math.abs(dy) + 4) {
        _touchFrom = null;
        _touchEl   = null;
        return;
      }
      if (Math.abs(dy) < 8) return; // not past threshold yet — could still be a tap
    } else {
      // grid: any direction counts, radius-based threshold
      if (Math.hypot(dx, dy) < 8) return;
    }
    _touchDragging = true;
  }

  // Lock out page scroll now that we're committed to dragging — this is
  // exactly why auto-scroll (above) has to exist: native scroll can never
  // kick in on its own from this point on.
  e.preventDefault();

  _lastTouchX = touch.clientX;
  _lastTouchY = touch.clientY;
  _touchEl.classList.add('touch-dragging');
  _applyDragTransform(mode);
  _updateHitTarget(touch.clientX, touch.clientY, itemSelector);
  _updateAutoScroll(touch.clientY, { itemSelector, mode });
}

function _onTouchEnd({ arrays, onReorder }) {
  // Guaranteed stop regardless of what state the drag was in — a leaked
  // RAF loop would keep scrolling the page indefinitely with no drag active.
  _stopAutoScrollLoop();
  if (_touchFrom === null) return;

  if (_touchEl) {
    _touchEl.style.transform = '';
    _touchEl.classList.remove('touch-dragging');
  }

  if (_touchDragging && _touchOverEl) {
    _touchOverEl.classList.remove('drag-target');
    const to = +_touchOverEl.dataset.i;
    if (to !== _touchFrom) {
      for (const arr of arrays) {
        const [moved] = arr.splice(_touchFrom, 1);
        arr.splice(to, 0, moved);
      }
      onReorder();
    }
  } else if (_touchOverEl) {
    _touchOverEl.classList.remove('drag-target');
  }

  _touchFrom     = null;
  _touchEl       = null;
  _touchOverEl   = null;
  _touchDragging = false;
}

// A cancelled gesture (OS interrupt — incoming call, notification pulldown,
// app switch) must never commit a reorder, but still needs the exact same
// guaranteed cleanup as a normal end — otherwise the next drag inherits a
// stale _touchFrom/_touchEl or (worse) a still-running auto-scroll loop.
function _onTouchCancel() {
  _stopAutoScrollLoop();
  if (_touchEl) {
    _touchEl.style.transform = '';
    _touchEl.classList.remove('touch-dragging');
  }
  if (_touchOverEl) _touchOverEl.classList.remove('drag-target');

  _touchFrom     = null;
  _touchEl       = null;
  _touchOverEl   = null;
  _touchDragging = false;
}
