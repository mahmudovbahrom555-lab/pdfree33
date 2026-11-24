// SPDX-License-Identifier: AGPL-3.0-only
// "Tool Start" is sent when processing starts (2026-11-17): the tool and a size
// band only — so "pressed the button, then left" can be told from "left at once".
import test from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
globalThis.window = globalThis;
// Node 20 (CI) has no navigator; analytics reads navigator.webdriver like a browser does
globalThis.navigator ??= { userAgent: 'node' };
globalThis.document = { documentElement: { lang: 'en' }, hidden: false, addEventListener() {} };
globalThis.fetch = (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve(); };
const { trackToolStart, trackToolOpen } = await import('../js/analytics.js');

test('one Tool Start event with the tool and a size band', () => {
  sent.length = 0;
  trackToolStart('compress', 3 * 1048576);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/analytics');
  assert.equal(sent[0].body.event, 'Tool Start');
  assert.equal(sent[0].body.props.tool, 'compress');
  assert.match(sent[0].body.props.size, /MB/);
});

test('nothing about the file but its size band', () => {
  sent.length = 0;
  trackToolStart('ocr');
  const keys = Object.keys(sent[0].body.props).sort();
  assert.deepEqual(keys, ['locale', 'session', 'size', 'tool']);
  assert.equal(sent[0].body.props.size, 'unknown');
});

// An automated browser (2026-11-24): only Tool Open and Tool Success go out,
// marked x_webdriver, for the server to keep when a signed agent sent them
// (ChatGPT's cloud browser) and drop otherwise (our own test runs).
test('automated browser: Tool Open goes out marked, other events do not', () => {
  Object.defineProperty(globalThis.navigator, 'webdriver', { value: true, configurable: true });
  try {
    sent.length = 0;
    trackToolStart('compress', 1048576);
    assert.equal(sent.length, 0);
    trackToolOpen('merge');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.event, 'Tool Open');
    assert.equal(sent[0].body.props.x_webdriver, 'yes');
  } finally {
    delete globalThis.navigator.webdriver;
  }
});

test('a person: no x_webdriver', () => {
  sent.length = 0;
  trackToolOpen('merge');
  assert.equal(sent[0].body.props.x_webdriver, undefined);
});
