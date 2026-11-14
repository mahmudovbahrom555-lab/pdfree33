// SPDX-License-Identifier: AGPL-3.0-only
// "File Rejected" carries a file's extension, never its name (2026-11-14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectedExt } from '../js/analytics.js';

test('the extension, lower case', () => {
  assert.equal(rejectedExt('Report.DOC'), '.doc');
  assert.equal(rejectedExt('scan.heic'), '.heic');
  assert.equal(rejectedExt('archive.tar.gz'), '.gz');
});

test('nothing of the name gets through', () => {
  assert.equal(rejectedExt('Иванов паспорт'), 'none');
  assert.equal(rejectedExt('contract.final-version-Ivanov'), 'other');
  assert.equal(rejectedExt('a.toolongextension'), 'other');
  assert.equal(rejectedExt('notes.пдф'), 'other');
  assert.equal(rejectedExt(''), 'none');
});
