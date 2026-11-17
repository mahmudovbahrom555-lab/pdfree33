// SPDX-License-Identifier: AGPL-3.0-only
// Rage Click leaves out controls pressed repeatedly on purpose (2026-11-14):
// they were half of all Rage Clicks and hid the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRepeatControl, isTextField } from '../js/rageClicks.js';

const el = (id, tagName = 'BUTTON') => ({ id, tagName });

test('steppers, undo, next/prev, zoom and canvases are left out', () => {
  for (const id of ['btnUndo', 'btnRedo', 'btnNext', 'btnPrev', 'extNextThumb', 'extPrevThumb', 'selSizeUp',
    'textSizeDown', 'ffZoomInBtn', 'ffZoomOutBtn', 'ffPrevBtn', 'rdctNextPage']) {
    assert.equal(isRepeatControl(el(id)), true, id);
  }
  assert.equal(isRepeatControl(el('drawCanvas', 'CANVAS')), true);
  assert.equal(isRepeatControl(el('', 'CANVAS')), true);
});

test('the controls whose repeats mean trouble still count', () => {
  for (const id of ['mergeFilenameInput', 'mergeBtn', 'dropZone', 'extRangeApply', 'extRangeInput',
    'compressTargetValue', 'markup', 'signup', 'heroFileName', '']) {
    assert.equal(isRepeatControl(el(id)), false, id);
  }
});

test('text fields are told apart — their clicks say whether the value changed', () => {
  for (const [tagName, type] of [['INPUT', 'text'], ['INPUT', 'number'], ['INPUT', ''], ['TEXTAREA', ''], ['SELECT', '']]) {
    assert.equal(isTextField({ tagName, type }), true, `${tagName} ${type}`);
  }
  for (const [tagName, type] of [['INPUT', 'checkbox'], ['INPUT', 'file'], ['INPUT', 'submit'], ['BUTTON', ''], ['DIV', '']]) {
    assert.equal(isTextField({ tagName, type }), false, `${tagName} ${type}`);
  }
});
