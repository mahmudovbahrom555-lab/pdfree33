// SPDX-License-Identifier: AGPL-3.0-only
// How many pages the OCR tool reads at once (2026-11-17): one on a phone or a
// weak machine and for PP-OCR's scripts on a desktop, 2–3 otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
const { ocrLanes } = await import('../js/ocrEngine.js');

const desk = (cores, mem) => ({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/157', hardwareConcurrency: cores, deviceMemory: mem, userAgentData: { mobile: false } });
const firefox = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0', hardwareConcurrency: 8 };
const phone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile Safari', hardwareConcurrency: 6, deviceMemory: 8 };

test('one page at a time on a phone and on a weak machine', () => {
  assert.equal(ocrLanes('eng', phone), 1);
  assert.equal(ocrLanes('eng', desk(2, 8)), 1);
  assert.equal(ocrLanes('eng', desk(8, 2)), 1);
});

test('two on a 4-core desktop, three on 8 cores with 8 GB', () => {
  assert.equal(ocrLanes('eng', desk(4, 4)), 2);
  assert.equal(ocrLanes('ara', desk(6, 8)), 2);
  assert.equal(ocrLanes('rus', desk(8, 8)), 3);
});

test('Chinese and Japanese in desktop Chrome: PP-OCR reads them, one lane', () => {
  assert.equal(ocrLanes('chi_sim', desk(8, 8)), 1);
  assert.equal(ocrLanes('jpn', desk(8, 8)), 1);
});

test('Firefox says no memory and no userAgentData: Tesseract, two lanes even for Japanese', () => {
  assert.equal(ocrLanes('jpn', firefox), 2);
  assert.equal(ocrLanes('eng', firefox), 2);
});
