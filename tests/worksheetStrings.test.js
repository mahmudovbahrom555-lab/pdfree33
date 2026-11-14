// SPDX-License-Identifier: AGPL-3.0-only
// "One question per slide" speaks the page's language (2026-11-14): every
// tr('…') sentence in the editor and every text, label and tooltip in its
// index.html has a translation in each language of worksheet-slides/strings.js,
// with the same {placeholders}. A new English sentence without them fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STRINGS } from '../worksheet-slides/strings.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worksheet-slides');
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function sourceKeys() {
  const keys = new Set();
  const add = s => { s = decode(s).trim(); if (/[A-Za-z]{2}/.test(s) && s !== 'PDF' && s !== 'ree') keys.add(s); };
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  for (const m of html.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) add(m[1]);
  for (const m of html.matchAll(/>([^<]+)</g)) add(m[1]);
  for (const f of ['editor.js', 'quiz-pptx.js', 'suggest-frames.js']) {
    for (const m of read(f).matchAll(/tr\('((?:[^'\\]|\\.)*)'/g)) add(m[1].replace(/\\'/g, "'"));
  }
  return [...keys];
}

const keys = sourceKeys();
const placeholders = s => (s.match(/\{\w+\}/g) || []).sort().join();

test('the editor has words to translate', () => {
  assert.ok(keys.length > 100, `only ${keys.length} found — the extraction broke`);
});

for (const lang of ['ar', 'de', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'tr', 'vi', 'zh-CN']) {
  test(`${lang}: every sentence translated, placeholders kept`, () => {
    const table = STRINGS[lang];
    assert.ok(table, `no ${lang} table`);
    const missing = keys.filter(k => !table[k]);
    assert.deepEqual(missing, [], `missing in ${lang}`);
    for (const k of keys) assert.equal(placeholders(table[k]), placeholders(k), `${lang}: ${k}`);
  });
}

// Two ways a sentence escapes the check above: written without tr(), or passed
// to tr() as an expression (tr(a ? 'X' : 'Y')) the extraction can't read.
test('every English sentence in the editor goes through tr() with a literal', () => {
  for (const f of ['editor.js', 'quiz-pptx.js', 'suggest-frames.js']) {
    const src = read(f);
    assert.deepEqual([...src.matchAll(/\btr\((?!')/g)].map(m => src.slice(m.index, m.index + 40)), [], `${f}: tr() without a literal`);
    const code = src.replace(/tr\('(?:[^'\\]|\\.)*'/g, 'tr(X');
    const loose = [...code.matchAll(/'((?:[^'\\]|\\.)*)'|`([^`]*)`/g)].map(m => m[1] ?? m[2])
      .filter(t => /[A-Z][a-z]+ [a-z]+/.test(t) && !/ppt\/|xml|application\/|http/.test(t));
    assert.deepEqual(loose, [], `${f}: English outside tr()`);
  }
});

