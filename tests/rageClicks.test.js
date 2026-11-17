// SPDX-License-Identifier: AGPL-3.0-only
// Rage Click leaves out controls pressed repeatedly on purpose (2026-11-14):
// they were half of all Rage Clicks and hid the real ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRepeatControl } from '../js/rageClicks.js';

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
  for (const id of ['mergeBtn', 'dropZone', 'extRangeApply', 'markup', 'signup', 'heroFileName', '']) {
    assert.equal(isRepeatControl(el(id)), false, id);
  }
});

test('text fields are left out: clicked three times to select their text, a number field\'s arrows again and again', () => {
  for (const [id, tagName, type] of [['compressTargetValue', 'INPUT', 'number'], ['extRangeInput', 'INPUT', 'text'],
    ['mergeFilenameInput', 'INPUT', 'text'], ['', 'INPUT', ''], ['', 'TEXTAREA', ''], ['', 'SELECT', '']]) {
    assert.equal(isRepeatControl({ id, tagName, type }), true, `${id} ${tagName} ${type}`);
  }
  for (const type of ['checkbox', 'file', 'submit', 'button']) {
    assert.equal(isRepeatControl({ id: '', tagName: 'INPUT', type }), false, type);
  }
});
