// SPDX-License-Identifier: AGPL-3.0-only
// PDF to Word's "Tool Success" extras (js/analytics.js workProps): the page
// count as a range and whether text recognition ran — never more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workProps } from '../js/analytics.js';

test('page counts fall into the four ranges the privacy page names', () => {
  assert.equal(workProps({ pages: 1 }).pages, '1–5');
  assert.equal(workProps({ pages: 5 }).pages, '1–5');
  assert.equal(workProps({ pages: 6 }).pages, '6–20');
  assert.equal(workProps({ pages: 20 }).pages, '6–20');
  assert.equal(workProps({ pages: 21 }).pages, '21–100');
  assert.equal(workProps({ pages: 100 }).pages, '21–100');
  assert.equal(workProps({ pages: 101 }).pages, '> 100');
});

test('recognition is yes/no, not a page count', () => {
  assert.equal(workProps({ pages: 40, ocrPages: 0 }).ocr, 'no');
  assert.equal(workProps({ pages: 40 }).ocr, 'no');
  assert.equal(workProps({ pages: 40, ocrPages: 37 }).ocr, 'yes');
});

test('no field beyond the ones the privacy page names', () => {
  assert.deepEqual(Object.keys(workProps({ pages: 3, ocrPages: 1 })).sort(), ['ocr', 'pages']);
});
