// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  tests/drawUI.logic.test.js
//
//  Pure-logic tests for js/drawUI.js + js/drawPointer.js. All
//  tested functions are copied verbatim from the source so the
//  suite runs in Node.js without a DOM/canvas — matches the
//  project's established pattern (see fillUI.logic.test.js,
//  splitUI.logic.test.js).
//
//  Covers the exact risk this suite exists to reduce: the draw
//  tool's undo/redo + per-page command-history state machine and
//  its move/style/delete overlay resolution had zero coverage
//  despite being the most stateful, longest-lived code in the
//  tool — and this exact tool already shipped two real production
//  bugs this session (missing editor markup, missing CSS) that
//  only surfaced via manual browser testing.
//
//    • _resolveScene    — applies move/style/delete overlay
//                          commands onto the base command list,
//                          including 'batch' (lasso multi-select
//                          move/delete — one command, N nested ops)
//                          (drawUI.js:339)
//    • _isMeaningful     — degenerate-stroke/shape filter that
//                          gates what actually gets committed
//                          (drawPointer.js:708)
//    • computeMovePatch  — per-type delta-shift used to build a
//                          lasso group-move's batch ops (drawUI.js)
//    • _pointInPolygon   — PNPOLY ray-casting test backing the
//                          lasso tool's selection (drawPointer.js)
//    • command-stack     — push / undo / redo / clear semantics
//                          on the real Map<pageNum, Command[]>
//                          shape (drawUI.js:683-709,
//                          drawPointer.js:702-706), including
//                          per-page isolation and the
//                          "new stroke clears redo history"
//                          invariant enforced by
//                          clearRedoForCurrentPage()
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`); passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`); failed++;
  }
}

function expect(actual) {
  return {
    toBe:         (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:      (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy:   ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy:    ()  => { if (actual)  throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toHaveLength: (n) => { if (actual.length !== n) throw new Error(`Expected length ${n}, got ${actual.length}`); },
  };
}

// ── Pure copy from js/drawUI.js:339 ─────────────────────────────

function _applyOp(op, deleted, pos, style) {
  if (op.type === 'delete') { deleted.add(op.targetId); return; }
  if (op.type === 'move')   { const { type: _t, targetId, ...coords } = op; pos.set(targetId, coords); return; }
  if (op.type === 'style')  { style.set(op.targetId, { ...style.get(op.targetId), ...op.patch }); }
}

function _resolveScene(cmds) {
  const hasOverrides = cmds.some(
    c => c.type === 'move' || c.type === 'style' || c.type === 'delete' || c.type === 'batch'
  );
  if (!hasOverrides) return cmds;
  const deleted = new Set();
  const pos     = new Map();
  const style   = new Map();
  cmds.forEach(c => {
    if (c.type === 'batch') { c.ops.forEach(op => _applyOp(op, deleted, pos, style)); return; }
    _applyOp(c, deleted, pos, style);
  });
  return cmds
    .filter(c => c.type !== 'move' && c.type !== 'style' && c.type !== 'delete' && c.type !== 'batch' && !deleted.has(c.id))
    .map(c => {
      const p = pos.get(c.id)   ?? null;
      const s = style.get(c.id) ?? null;
      return (p || s) ? { ...c, ...p, ...s } : c;
    });
}

// ── Pure copy from js/drawUI.js's computeMovePatch ──────────────

function computeMovePatch(cmd, dx, dy) {
  switch (cmd.type) {
    case 'text':
    case 'rect':
    case 'oval':
      return { x: cmd.x + dx, y: cmd.y + dy };
    case 'line':
    case 'arrow':
      return { x1: cmd.x1 + dx, y1: cmd.y1 + dy, x2: cmd.x2 + dx, y2: cmd.y2 + dy };
    case 'pen':
    case 'erase':
    case 'marker':
      return { points: cmd.points.map(([x, y]) => [x + dx, y + dy]) };
    case 'highlight':
      return { rects: (cmd.rects ?? [{ x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h }]).map(r => ({ ...r, x: r.x + dx, y: r.y + dy })) };
    default:
      return {};
  }
}

// ── Pure copy from js/drawPointer.js's _pointInPolygon ──────────

function _pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Pure copy from js/drawPointer.js:708 ────────────────────────

function _isMeaningful(cmd) {
  switch (cmd.type) {
    case 'pen':
    case 'erase':
    case 'marker': return cmd.points.length >= 2;
    case 'arrow':
    case 'line':   return Math.hypot(cmd.x2 - cmd.x1, cmd.y2 - cmd.y1) >= 3;
    case 'rect':
    case 'highlight': return cmd.w >= 3 && cmd.h >= 3;
    case 'oval':   return cmd.rx >= 3 && cmd.ry >= 3;
    default:       return true;
  }
}

// ── Command-stack harness — mirrors the real Map<pageNum, Command[]>
// state machine (drawUI.js _pageCommands/_redoStack + _undo/_redo/
// _clearPage + drawPointer.js's _pushCommand/clearRedoForCurrentPage),
// with _redrawPage()'s canvas rendering stripped out (state only).

function makeDrawState() {
  const pageCommands = new Map();
  const redoStack    = new Map();
  let currentPage     = 1;

  return {
    setPage(p) { currentPage = p; },
    // drawPointer.js:702 — immutable push
    pushCommand(cmd) {
      const cmds = pageCommands.get(currentPage) ?? [];
      pageCommands.set(currentPage, [...cmds, cmd]);
    },
    // drawUI.js:184-187 — called before every real push (new stroke invalidates redo)
    clearRedoForCurrentPage() {
      redoStack.set(currentPage, []);
    },
    // drawUI.js:683-692
    undo() {
      const cmds = pageCommands.get(currentPage) ?? [];
      if (!cmds.length) return;
      const undone = cmds.pop();
      pageCommands.set(currentPage, cmds);
      const stack = redoStack.get(currentPage) ?? [];
      stack.push(undone);
      redoStack.set(currentPage, stack);
    },
    // drawUI.js:694-703
    redo() {
      const stack = redoStack.get(currentPage) ?? [];
      if (!stack.length) return;
      const cmd = stack.pop();
      redoStack.set(currentPage, stack);
      const cmds = pageCommands.get(currentPage) ?? [];
      cmds.push(cmd);
      pageCommands.set(currentPage, cmds);
    },
    // drawUI.js:705-709
    clearPage() {
      pageCommands.set(currentPage, []);
      redoStack.set(currentPage, []);
    },
    commands(p = currentPage) { return pageCommands.get(p) ?? []; },
    redoLength(p = currentPage) { return (redoStack.get(p) ?? []).length; },
  };
}

console.log('drawUI.logic.test.js\n');

// ── _resolveScene ────────────────────────────────────────────────

test('_resolveScene: no overrides returns commands unchanged', () => {
  const cmds = [{ type: 'pen', id: 1, points: [[0, 0], [1, 1]] }];
  expect(_resolveScene(cmds)).toEqual(cmds);
});

test('_resolveScene: delete removes the target command', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0 },
    { type: 'delete', targetId: 1 },
  ];
  expect(_resolveScene(cmds)).toEqual([]);
});

test('_resolveScene: delete only affects the matching id', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0 },
    { type: 'text', id: 2, x: 5, y: 5 },
    { type: 'delete', targetId: 1 },
  ];
  const result = _resolveScene(cmds);
  expect(result).toHaveLength(1);
  expect(result[0].id).toBe(2);
});

test('_resolveScene: move overlay updates text x/y', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0, text: 'hi' },
    { type: 'move', targetId: 1, x: 40, y: 60 },
  ];
  const result = _resolveScene(cmds);
  expect(result).toHaveLength(1);
  expect(result[0].x).toBe(40);
  expect(result[0].y).toBe(60);
  expect(result[0].text).toBe('hi'); // untouched fields survive the merge
});

test('_resolveScene: move overlay updates shape x1/y1/x2/y2', () => {
  const cmds = [
    { type: 'arrow', id: 1, x1: 0, y1: 0, x2: 10, y2: 10 },
    { type: 'move', targetId: 1, x1: 5, y1: 5, x2: 15, y2: 15 },
  ];
  const result = _resolveScene(cmds);
  expect(result[0]).toEqual({ type: 'arrow', id: 1, x1: 5, y1: 5, x2: 15, y2: 15 });
});

test('_resolveScene: style overlay merges a partial patch', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0, size: 16, color: '#000' },
    { type: 'style', targetId: 1, patch: { size: 24 } },
  ];
  const result = _resolveScene(cmds);
  expect(result[0].size).toBe(24);
  expect(result[0].color).toBe('#000'); // unpatched field preserved
});

test('_resolveScene: later style command for the same id wins over an earlier one', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0, size: 16 },
    { type: 'style', targetId: 1, patch: { size: 20 } },
    { type: 'style', targetId: 1, patch: { size: 30 } },
  ];
  expect(_resolveScene(cmds)[0].size).toBe(30);
});

test('_resolveScene: two style patches on the same id merge instead of replacing', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0, size: 16, color: '#000' },
    { type: 'style', targetId: 1, patch: { size: 20 } },
    { type: 'style', targetId: 1, patch: { color: '#f00' } },
  ];
  const result = _resolveScene(cmds)[0];
  expect(result.size).toBe(20);
  expect(result.color).toBe('#f00');
});

test('_resolveScene: move + style overlays combine on the same target', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0, size: 16 },
    { type: 'move', targetId: 1, x: 40, y: 60 },
    { type: 'style', targetId: 1, patch: { size: 24 } },
  ];
  const result = _resolveScene(cmds)[0];
  expect(result.x).toBe(40);
  expect(result.y).toBe(60);
  expect(result.size).toBe(24);
});

test('_resolveScene: overlay commands themselves never appear in the resolved output', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0 },
    { type: 'move', targetId: 1, x: 1, y: 1 },
    { type: 'style', targetId: 1, patch: {} },
  ];
  const types = _resolveScene(cmds).map(c => c.type);
  expect(types).toEqual(['text']);
});

test('_resolveScene: move/style/delete targeting a non-existent id is a harmless no-op', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0 },
    { type: 'move', targetId: 999, x: 40, y: 60 },
    { type: 'delete', targetId: 888 },
  ];
  const result = _resolveScene(cmds);
  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({ type: 'text', id: 1, x: 0, y: 0 });
});

// ── _isMeaningful ────────────────────────────────────────────────

test('_isMeaningful: pen stroke with 2+ points is meaningful', () => {
  expect(_isMeaningful({ type: 'pen', points: [[0, 0], [1, 1]] })).toBeTruthy();
});

test('_isMeaningful: pen stroke with a single point (a tap) is rejected', () => {
  expect(_isMeaningful({ type: 'pen', points: [[0, 0]] })).toBeFalsy();
});

test('_isMeaningful: marker/erase follow the same points>=2 rule as pen', () => {
  expect(_isMeaningful({ type: 'marker', points: [[0, 0]] })).toBeFalsy();
  expect(_isMeaningful({ type: 'erase',  points: [[0, 0], [1, 1]] })).toBeTruthy();
});

test('_isMeaningful: arrow/line need at least 3px of length', () => {
  expect(_isMeaningful({ type: 'arrow', x1: 0, y1: 0, x2: 2, y2: 0 })).toBeFalsy();
  expect(_isMeaningful({ type: 'line',  x1: 0, y1: 0, x2: 3, y2: 0 })).toBeTruthy();
});

test('_isMeaningful: rect/highlight need both w and h >= 3px', () => {
  expect(_isMeaningful({ type: 'rect', w: 2, h: 10 })).toBeFalsy();
  expect(_isMeaningful({ type: 'highlight', w: 3, h: 3 })).toBeTruthy();
});

test('_isMeaningful: oval needs both radii >= 3px', () => {
  expect(_isMeaningful({ type: 'oval', rx: 3, ry: 1 })).toBeFalsy();
  expect(_isMeaningful({ type: 'oval', rx: 3, ry: 3 })).toBeTruthy();
});

test('_isMeaningful: unrecognized types (e.g. text) default to always meaningful', () => {
  expect(_isMeaningful({ type: 'text' })).toBeTruthy();
});

// ── computeMovePatch (lasso group-move per-type deltas) ─────────

test('computeMovePatch: text/rect/oval shift x/y by the delta', () => {
  expect(computeMovePatch({ type: 'text', x: 10, y: 20 }, 5, -3)).toEqual({ x: 15, y: 17 });
  expect(computeMovePatch({ type: 'rect', x: 10, y: 20, w: 40, h: 30 }, 5, -3)).toEqual({ x: 15, y: 17 });
});

test('computeMovePatch: line/arrow shift both endpoints', () => {
  const patch = computeMovePatch({ type: 'arrow', x1: 0, y1: 0, x2: 10, y2: 10 }, 5, 5);
  expect(patch).toEqual({ x1: 5, y1: 5, x2: 15, y2: 15 });
});

test('computeMovePatch: pen/erase/marker shift every point in the stroke', () => {
  const patch = computeMovePatch({ type: 'pen', points: [[0, 0], [10, 10]] }, 2, 3);
  expect(patch).toEqual({ points: [[2, 3], [12, 13]] });
});

test('computeMovePatch: highlight shifts every rect, keeping w/h unchanged', () => {
  const patch = computeMovePatch({ type: 'highlight', rects: [{ x: 0, y: 0, w: 10, h: 5 }] }, 4, 4);
  expect(patch).toEqual({ rects: [{ x: 4, y: 4, w: 10, h: 5 }] });
});

// ── _pointInPolygon (PNPOLY — backs lasso selection) ─────────────

test('_pointInPolygon: point clearly inside a square is inside', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  expect(_pointInPolygon(5, 5, square)).toBeTruthy();
});

test('_pointInPolygon: point clearly outside a square is outside', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  expect(_pointInPolygon(50, 50, square)).toBeFalsy();
});

test('_pointInPolygon: works for a non-convex (concave) loop, not just rectangles', () => {
  // "L" shape (concave) — a point inside the notch must NOT be reported as inside
  const lShape = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
  expect(_pointInPolygon(2, 2, lShape)).toBeTruthy();   // inside the L's filled area
  expect(_pointInPolygon(8, 8, lShape)).toBeFalsy();    // inside the notch — not filled
});

// ── _resolveScene: 'batch' (lasso multi-select move/delete/style) ──

test('_resolveScene: a batch move relocates every targeted command in one command', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0 },
    { type: 'rect', id: 2, x: 0, y: 0, w: 10, h: 10 },
    { type: 'batch', ops: [
      { type: 'move', targetId: 1, x: 5, y: 5 },
      { type: 'move', targetId: 2, x: 3, y: 3 },
    ] },
  ];
  const result = _resolveScene(cmds);
  expect(result).toHaveLength(2);
  expect(result.find(c => c.id === 1)).toEqual({ type: 'text', id: 1, x: 5, y: 5 });
  expect(result.find(c => c.id === 2)).toEqual({ type: 'rect', id: 2, x: 3, y: 3, w: 10, h: 10 });
});

test('_resolveScene: a batch delete removes every targeted command in one command', () => {
  const cmds = [
    { type: 'pen', id: 1, points: [[0, 0]] },
    { type: 'pen', id: 2, points: [[1, 1]] },
    { type: 'pen', id: 3, points: [[2, 2]] },
    { type: 'batch', ops: [{ type: 'delete', targetId: 1 }, { type: 'delete', targetId: 3 }] },
  ];
  const result = _resolveScene(cmds);
  expect(result).toHaveLength(1);
  expect(result[0].id).toBe(2);
});

test('_resolveScene: the batch command itself never appears in the resolved output', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0 },
    { type: 'batch', ops: [{ type: 'move', targetId: 1, x: 1, y: 1 }] },
  ];
  const types = _resolveScene(cmds).map(c => c.type);
  expect(types).toEqual(['text']);
});

test('_resolveScene: a batch can mix move, style and delete ops targeting different ids', () => {
  const cmds = [
    { type: 'text', id: 1, x: 0, y: 0, size: 16 },
    { type: 'rect', id: 2, x: 0, y: 0, w: 10, h: 10 },
    { type: 'pen',  id: 3, points: [[0, 0]] },
    { type: 'batch', ops: [
      { type: 'move',   targetId: 1, x: 9, y: 9 },
      { type: 'style',  targetId: 2, patch: { color: '#f00' } },
      { type: 'delete', targetId: 3 },
    ] },
  ];
  const result = _resolveScene(cmds);
  expect(result).toHaveLength(2);
  expect(result.find(c => c.id === 1)).toEqual({ type: 'text', id: 1, x: 9, y: 9, size: 16 });
  expect(result.find(c => c.id === 2).color).toBe('#f00');
});

// ── Command-stack: push / undo / redo / clear ───────────────────

test('push then undo removes the last command and it is gone from the page', () => {
  const s = makeDrawState();
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 1 });
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 2 });
  s.undo();
  expect(s.commands()).toEqual([{ type: 'pen', id: 1 }]);
});

test('undo moves the popped command onto the redo stack', () => {
  const s = makeDrawState();
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 1 });
  s.undo();
  expect(s.redoLength()).toBe(1);
});

test('redo restores the most recently undone command', () => {
  const s = makeDrawState();
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 1 });
  s.undo();
  s.redo();
  expect(s.commands()).toEqual([{ type: 'pen', id: 1 }]);
  expect(s.redoLength()).toBe(0);
});

test('undo on an empty page is a no-op, not a crash', () => {
  const s = makeDrawState();
  s.undo();
  expect(s.commands()).toEqual([]);
  expect(s.redoLength()).toBe(0);
});

test('redo with nothing on the redo stack is a no-op', () => {
  const s = makeDrawState();
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 1 });
  s.redo(); // nothing was undone — should not duplicate the command
  expect(s.commands()).toEqual([{ type: 'pen', id: 1 }]);
});

test('a new stroke after undo clears the redo stack (redo history invalidated)', () => {
  const s = makeDrawState();
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 1 });
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 2 });
  s.undo(); // id:2 now sits on the redo stack
  expect(s.redoLength()).toBe(1);
  s.clearRedoForCurrentPage(); // real code always calls this before pushCommand
  s.pushCommand({ type: 'pen', id: 3 });
  expect(s.redoLength()).toBe(0);
  expect(s.commands()).toEqual([{ type: 'pen', id: 1 }, { type: 'pen', id: 3 }]);
});

test('clearPage wipes both the command list and the redo stack', () => {
  const s = makeDrawState();
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 1 });
  s.undo(); // id:1 now on redo stack
  s.clearPage();
  expect(s.commands()).toEqual([]);
  expect(s.redoLength()).toBe(0);
});

test('clearPage is not itself undoable — undo after clear finds nothing to restore', () => {
  const s = makeDrawState();
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 1 });
  s.clearPage();
  s.undo(); // must not resurrect the cleared command
  expect(s.commands()).toEqual([]);
});

test('per-page isolation: undo on page 2 does not touch page 1 history', () => {
  const s = makeDrawState();
  s.setPage(1);
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 'p1-a' });
  s.setPage(2);
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 'p2-a' });
  s.undo(); // undoes page 2's stroke only
  expect(s.commands(2)).toEqual([]);
  expect(s.commands(1)).toEqual([{ type: 'pen', id: 'p1-a' }]);
});

test('per-page isolation: each page keeps its own independent redo stack', () => {
  const s = makeDrawState();
  s.setPage(1);
  s.clearRedoForCurrentPage(); s.pushCommand({ type: 'pen', id: 'p1-a' });
  s.undo();
  s.setPage(2);
  expect(s.redoLength(2)).toBe(0); // page 2 was never touched
  expect(s.redoLength(1)).toBe(1);
});

console.log(`\n${'─'.repeat(50)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
