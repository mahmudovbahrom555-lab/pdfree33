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
  });
}

// ── Mouse / HTML5 drag-and-drop ─────────────────────────────

let _dragFrom = null;

function _onDragStart(el) {
  _dragFrom = +el.dataset.i;
  el.classList.add('dragging');
}

function _onDragOver(e, el) {
  e.preventDefault();
  el.classList.add('drag-target');
}

function _onDrop(e, el, { arrays, onReorder, isLocked }) {
  if (isLocked()) return;
  e.preventDefault();
  el.classList.remove('drag-target');
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

let _touchFrom     = null;
let _touchEl       = null;
let _touchStartY   = 0;
let _touchStartX   = 0;
let _touchOverEl   = null;
let _touchDragging = false;

function _onTouchStart(e, el, isLocked) {
  if (isLocked()) return;
  const touch = e.touches[0];
  _touchFrom     = +el.dataset.i;
  _touchEl       = el;
  _touchStartY   = touch.clientY;
  _touchStartX   = touch.clientX;
  _touchOverEl   = null;
  _touchDragging = false;
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

  // Lock out page scroll now that we're committed to dragging
  e.preventDefault();

  _touchEl.style.transform = mode === 'grid'
    ? `translate(${dx}px, ${dy}px)`
    : `translateY(${dy}px)`;
  _touchEl.classList.add('touch-dragging');

  // Find what's directly under the finger (skip the dragging element itself)
  _touchEl.style.pointerEvents = 'none';
  const hit = document.elementFromPoint(touch.clientX, touch.clientY);
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

function _onTouchEnd({ arrays, onReorder }) {
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
