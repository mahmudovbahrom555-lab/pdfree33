// SPDX-License-Identifier: AGPL-3.0-only
// The "Compress Target" event's numbers (js/analytics.js compressTargetProps):
// the size asked for as typed, the result as fits/over-by-a-range — never more.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compressTargetProps } from '../js/analytics.js';

const MB = 1048576;

test('a typed MB size is kept as typed, a fit says "fits"', () => {
  const p = compressTargetProps({ targetBytes: 4 * MB, inputSize: 14 * MB, outputSize: 3.9 * MB, met: true, step: 5, runs: 4 });
  assert.deepEqual(p, { tool: 'compress', target: '4 MB', input_size: '10–50 MB', result: 'fits', step: 5, runs: 4 });
});

test('a KB size reads in KB; a miss says by how much, as a range', () => {
  const p = compressTargetProps({ targetBytes: 500 * 1024, inputSize: 2 * MB, outputSize: 600 * 1024, met: false, step: 9, runs: 4 });
  assert.equal(p.target, '500 KB');
  assert.equal(p.result, 'over 10–50%');
  assert.equal(compressTargetProps({ targetBytes: MB, inputSize: 5 * MB, outputSize: 4 * MB, met: false, step: 9, runs: 4 }).result, 'over >2×');
  assert.equal(compressTargetProps({ targetBytes: MB, inputSize: 5 * MB, outputSize: 1.05 * MB, met: false, step: 9, runs: 4 }).result, 'over ≤10%');
});

test('no field beyond the ones the privacy page names', () => {
  const p = compressTargetProps({ targetBytes: 2.5 * MB, inputSize: 3 * MB, outputSize: 2 * MB, met: true, step: 1, runs: 4 });
  assert.deepEqual(Object.keys(p).sort(), ['input_size', 'result', 'runs', 'step', 'target', 'tool']);
  assert.equal(p.target, '2.5 MB');
});
