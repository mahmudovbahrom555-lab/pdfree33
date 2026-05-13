// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  tests/splitUI.logic.test.js
//  Tests for pure logic extracted from splitUI.js, pageNumUI.js,
//  extractUI.js, and EXIF parsing from jpg2pdfUI.js.
//
//  Zero dependencies — runs with: node tests/splitUI.logic.test.js
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => { console.log(`  ✓ ${name}`); passed++; })
            .catch(e => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
    } else {
      console.log(`  ✓ ${name}`); passed++;
    }
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`); failed++;
  }
}

function expect(actual) {
  return {
    toBe:          (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:       (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy:    ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy:     ()  => { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toHaveLength:  (n) => { if (actual.length !== n) throw new Error(`Expected length ${n}, got ${actual.length}`); },
    toContain:     (v) => { if (!actual.includes(v)) throw new Error(`Expected array to contain ${JSON.stringify(v)}`); },
    toBeGreaterThan: (n) => { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
  };
}

// ══════════════════════════════════════════════════════════════
// Range parsing (copy of _parseRange from splitUI.js)
// ══════════════════════════════════════════════════════════════

function parseRange(str, maxPage) {
  const pages = new Set();
  str.split(',').forEach(part => {
    part = part.trim();
    if (!part) return;
    const dash = part.indexOf('-');
    if (dash > 0) {
      const from = parseInt(part.slice(0, dash));
      const to   = parseInt(part.slice(dash + 1));
      if (!isNaN(from) && !isNaN(to)) {
        for (let p = Math.max(1, from); p <= Math.min(maxPage, to); p++) pages.add(p);
      }
    } else {
      const p = parseInt(part);
      if (!isNaN(p) && p >= 1 && p <= maxPage) pages.add(p);
    }
  });
  return [...pages].sort((a, b) => a - b);
}

function pagesToRangeString(pages) {
  if (!pages.length) return '';
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) { end = sorted[i]; }
    else { ranges.push(start === end ? `${start}` : `${start}-${end}`); start = end = sorted[i]; }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

console.log('\n📄 Range parsing:');

test('single page', () => { expect(parseRange('5', 20)).toEqual([5]); });
test('simple range', () => { expect(parseRange('1-3', 10)).toEqual([1,2,3]); });
test('comma-separated pages', () => { expect(parseRange('1, 3, 5', 10)).toEqual([1,3,5]); });
test('mixed ranges and singles', () => { expect(parseRange('1-3, 5, 7-9', 10)).toEqual([1,2,3,5,7,8,9]); });
test('clamps to maxPage', () => { expect(parseRange('8-15', 10)).toEqual([8,9,10]); });
test('ignores page 0 and negatives', () => { expect(parseRange('0, -1, 1', 5)).toEqual([1]); });
test('ignores pages beyond max', () => { expect(parseRange('100', 10)).toEqual([]); });
test('empty string returns empty array', () => { expect(parseRange('', 10)).toEqual([]); });
test('whitespace-only returns empty', () => { expect(parseRange('   ', 10)).toEqual([]); });
test('deduplicates overlapping ranges', () => { expect(parseRange('1-5, 3-7', 10)).toEqual([1,2,3,4,5,6,7]); });
test('sorts output', () => { expect(parseRange('5, 1, 3', 10)).toEqual([1,3,5]); });
test('handles non-numeric gracefully', () => { expect(parseRange('abc, 2', 10)).toEqual([2]); });
test('single page equals itself', () => { expect(parseRange('7', 10)).toEqual([7]); });

console.log('\n🔁 Range string serialization (round-trip):');

test('consecutive pages collapse to range', () => {
  expect(pagesToRangeString([1,2,3])).toBe('1-3');
});
test('non-consecutive stay separate', () => {
  expect(pagesToRangeString([1,3,5])).toBe('1, 3, 5');
});
test('mixed consecutive and single', () => {
  expect(pagesToRangeString([1,2,3,5,7,8,9])).toBe('1-3, 5, 7-9');
});
test('empty array returns empty string', () => {
  expect(pagesToRangeString([])).toBe('');
});
test('single page returns just the number', () => {
  expect(pagesToRangeString([7])).toBe('7');
});
test('round-trip: parse then serialize', () => {
  const pages = parseRange('1-3, 5, 7-9', 20);
  expect(pagesToRangeString(pages)).toBe('1-3, 5, 7-9');
});
test('round-trip: serialize then parse', () => {
  const str = pagesToRangeString([1,2,3,5,7,8,9]);
  expect(parseRange(str, 20)).toEqual([1,2,3,5,7,8,9]);
});

// ══════════════════════════════════════════════════════════════
// Page number formatters (copy from pageNumUI.js / worker.js)
// ══════════════════════════════════════════════════════════════

function toRoman(n) {
  if (n <= 0 || n > 3999) return String(n);
  const v = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const s = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let r = '';
  for (let i = 0; i < v.length; i++) while (n >= v[i]) { r += s[i]; n -= v[i]; }
  return r;
}

function toAlpha(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}

function formatNum(n, fmt) {
  if (fmt === 'roman') return toRoman(n);
  if (fmt === 'alpha') return toAlpha(n);
  return String(n);
}

console.log('\n🔢 Page number formatters:');

test('arabic: 1 → "1"', () => { expect(formatNum(1, 'arabic')).toBe('1'); });
test('arabic: 42 → "42"', () => { expect(formatNum(42, 'arabic')).toBe('42'); });
test('roman: 1 → "I"', () => { expect(formatNum(1, 'roman')).toBe('I'); });
test('roman: 4 → "IV"', () => { expect(formatNum(4, 'roman')).toBe('IV'); });
test('roman: 9 → "IX"', () => { expect(formatNum(9, 'roman')).toBe('IX'); });
test('roman: 14 → "XIV"', () => { expect(formatNum(14, 'roman')).toBe('XIV'); });
test('roman: 40 → "XL"', () => { expect(formatNum(40, 'roman')).toBe('XL'); });
test('roman: 90 → "XC"', () => { expect(formatNum(90, 'roman')).toBe('XC'); });
test('roman: 400 → "CD"', () => { expect(formatNum(400, 'roman')).toBe('CD'); });
test('roman: 900 → "CM"', () => { expect(formatNum(900, 'roman')).toBe('CM'); });
test('roman: 1994 → "MCMXCIV"', () => { expect(formatNum(1994, 'roman')).toBe('MCMXCIV'); });
test('roman: 2024 → "MMXXIV"', () => { expect(formatNum(2024, 'roman')).toBe('MMXXIV'); });
test('roman: 0 falls back to "0"', () => { expect(formatNum(0, 'roman')).toBe('0'); });
test('alpha: 1 → "A"', () => { expect(formatNum(1, 'alpha')).toBe('A'); });
test('alpha: 26 → "Z"', () => { expect(formatNum(26, 'alpha')).toBe('Z'); });
test('alpha: 27 → "AA"', () => { expect(formatNum(27, 'alpha')).toBe('AA'); });
test('alpha: 52 → "AZ"', () => { expect(formatNum(52, 'alpha')).toBe('AZ'); });
test('alpha: 53 → "BA"', () => { expect(formatNum(53, 'alpha')).toBe('BA'); });

// ══════════════════════════════════════════════════════════════
// Analytics: file size buckets (from analytics.js)
// ══════════════════════════════════════════════════════════════

function sizeBucket(bytes) {
  if (!bytes || bytes <= 0) return 'unknown';
  const mb = bytes / 1048576;
  if (mb < 1)  return '< 1 MB';
  if (mb < 10) return '1–10 MB';
  if (mb < 50) return '10–50 MB';
  return '> 50 MB';
}

function roundDuration(ms) {
  const s = Math.round(ms / 1000);
  return Math.round(s / 5) * 5;
}

console.log('\n📊 Analytics helpers:');

test('< 1 MB bucket', () => { expect(sizeBucket(500000)).toBe('< 1 MB'); });
test('1–10 MB bucket', () => { expect(sizeBucket(5 * 1048576)).toBe('1–10 MB'); });
test('10–50 MB bucket', () => { expect(sizeBucket(20 * 1048576)).toBe('10–50 MB'); });
test('> 50 MB bucket', () => { expect(sizeBucket(100 * 1048576)).toBe('> 50 MB'); });
test('zero bytes → unknown', () => { expect(sizeBucket(0)).toBe('unknown'); });
test('negative → unknown', () => { expect(sizeBucket(-1)).toBe('unknown'); });
test('boundary 1MB exactly → 1–10 MB', () => { expect(sizeBucket(1048576)).toBe('1–10 MB'); });
test('duration rounds to 5s', () => { expect(roundDuration(7000)).toBe(5); });
test('duration 12s rounds to 10', () => { expect(roundDuration(12000)).toBe(10); });
test('duration 13s rounds to 15', () => { expect(roundDuration(13000)).toBe(15); });

// ══════════════════════════════════════════════════════════════
// Worker pdfPipeline opts defaults (unit-level)
// ══════════════════════════════════════════════════════════════

console.log('\n⚙️  pdfPipeline option defaults:');

function applyDefaults(opts) {
  return {
    loadLabel:        opts.loadLabel        ?? 'Loading PDF…',
    saveLabel:        opts.saveLabel        ?? 'Saving…',
    saveValue:        opts.saveValue        ?? 90,
    objectStreams:    opts.objectStreams     ?? true,
    ignoreEncryption: opts.ignoreEncryption ?? true,
  };
}

test('empty opts → all defaults', () => {
  const d = applyDefaults({});
  expect(d.loadLabel).toBe('Loading PDF…');
  expect(d.saveValue).toBe(90);
  expect(d.objectStreams).toBeTruthy();
  expect(d.ignoreEncryption).toBeTruthy();
});
test('saveValue override respected', () => {
  const d = applyDefaults({ saveValue: 95 });
  expect(d.saveValue).toBe(95);
  expect(d.saveLabel).toBe('Saving…'); // untouched
});
test('objectStreams:false respected', () => {
  const d = applyDefaults({ objectStreams: false });
  expect(d.objectStreams).toBeFalsy();
});

// ══════════════════════════════════════════════════════════════
// Tool registry descriptor logic
// ══════════════════════════════════════════════════════════════

console.log('\n🗂️  Tool registry logic:');

function makeRegistry() {
  const _reg = new Map();
  return {
    register: (key, desc) => _reg.set(key, desc),
    get: (key) => _reg.get(key),
    hideAll: () => { for (const d of _reg.values()) d.hide?.(); },
    collect: (key) => {
      const desc = _reg.get(key);
      if (!desc?.getParams) return { params: {}, error: null };
      const params = desc.getParams();
      const error  = desc.validate ? desc.validate(params) : null;
      return { params, error };
    },
  };
}

test('registry stores and retrieves descriptor', () => {
  const reg = makeRegistry();
  reg.register('merge', { runner: 'merge' });
  expect(reg.get('merge').runner).toBe('merge');
});
test('hideAll calls hide on all registered tools', () => {
  const reg = makeRegistry();
  let hiddenA = false, hiddenB = false;
  reg.register('a', { hide: () => { hiddenA = true; } });
  reg.register('b', { hide: () => { hiddenB = true; } });
  reg.hideAll();
  expect(hiddenA).toBeTruthy();
  expect(hiddenB).toBeTruthy();
});
test('tool with no hide skipped gracefully', () => {
  const reg = makeRegistry();
  reg.register('nohide', { runner: 'stub' });
  // Should not throw
  reg.hideAll();
  expect(true).toBeTruthy();
});
test('validate returns error message for invalid params', () => {
  const reg = makeRegistry();
  reg.register('split', {
    getParams: () => ({ pages: [] }),
    validate:  (p) => p.pages.length === 0 ? 'Select at least one page' : null,
  });
  const { error } = reg.collect('split');
  expect(error).toBe('Select at least one page');
});
test('validate returns null for valid params', () => {
  const reg = makeRegistry();
  reg.register('split', {
    getParams: () => ({ pages: [1, 2, 3] }),
    validate:  (p) => p.pages.length === 0 ? 'Select at least one page' : null,
  });
  const { error } = reg.collect('split');
  expect(error).toBeFalsy();
});
test('tool without getParams returns empty params', () => {
  const reg = makeRegistry();
  reg.register('merge', { runner: 'merge' });
  const { params, error } = reg.collect('merge');
  expect(JSON.stringify(params)).toBe('{}');
  expect(error).toBeFalsy();
});

// ══════════════════════════════════════════════════════════════
// Extract pages: preset logic
// ══════════════════════════════════════════════════════════════

console.log('\n📑 Extract presets:');

function applyPreset(preset, total) {
  if (preset === 'odd')         return Array.from({length: total}, (_,i) => i+1).filter(p => p%2===1);
  if (preset === 'even')        return Array.from({length: total}, (_,i) => i+1).filter(p => p%2===0);
  if (preset === 'first-half')  return Array.from({length: Math.ceil(total/2)}, (_,i) => i+1);
  if (preset === 'second-half') return Array.from({length: Math.floor(total/2)}, (_,i) => Math.ceil(total/2)+i+1);
  return [];
}

test('odd preset: 10 pages → [1,3,5,7,9]', () => {
  expect(applyPreset('odd', 10)).toEqual([1,3,5,7,9]);
});
test('even preset: 10 pages → [2,4,6,8,10]', () => {
  expect(applyPreset('even', 10)).toEqual([2,4,6,8,10]);
});
test('first-half: 10 pages → [1-5]', () => {
  expect(applyPreset('first-half', 10)).toEqual([1,2,3,4,5]);
});
test('second-half: 10 pages → [6-10]', () => {
  expect(applyPreset('second-half', 10)).toEqual([6,7,8,9,10]);
});
test('first-half odd total: 11 pages → [1-6]', () => {
  expect(applyPreset('first-half', 11)).toEqual([1,2,3,4,5,6]);
});
test('odd preset on 1 page → [1]', () => {
  expect(applyPreset('odd', 1)).toEqual([1]);
});
test('even preset on 1 page → []', () => {
  expect(applyPreset('even', 1)).toEqual([]);
});
test('reverse pages: booklet order', () => {
  const pages = [1,2,3,4,5];
  expect([...pages].reverse()).toEqual([5,4,3,2,1]);
});

// ══════════════════════════════════════════════════════════════
// PWA: install prompt state logic
// ══════════════════════════════════════════════════════════════

console.log('\n📲 PWA install prompt:');

function makeInstallState() {
  let _event = null, _shown = false;
  return {
    capture:   (e) => { _event = e; },
    canShow:   () => !_shown && _event !== null,
    show:      () => { _shown = true; },
    dismiss:   () => { _event = null; },
    hasEvent:  () => _event !== null,
    wasShown:  () => _shown,
  };
}

test('cannot show without captured event', () => {
  const s = makeInstallState();
  expect(s.canShow()).toBeFalsy();
});
test('can show after event captured', () => {
  const s = makeInstallState();
  s.capture({ prompt: () => {} });
  expect(s.canShow()).toBeTruthy();
});
test('cannot show twice', () => {
  const s = makeInstallState();
  s.capture({ prompt: () => {} });
  s.show();
  expect(s.canShow()).toBeFalsy();
});
test('dismiss clears event', () => {
  const s = makeInstallState();
  s.capture({ prompt: () => {} });
  s.dismiss();
  expect(s.hasEvent()).toBeFalsy();
});

// ══════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════

setTimeout(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
  if (failed > 0) process.exit(1);
}, 50);

// ══════════════════════════════════════════════════════════════
// _classifyError (pure copy from worker.js for testability)
// ══════════════════════════════════════════════════════════════

function classifyError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  if (msg.includes('encrypt') || msg.includes('password')) return 'ENCRYPTED';
  if (msg.includes('corrupt') || msg.includes('invalid')  ||
      msg.includes('bad')     || msg.includes('malformed') ||
      msg.includes('header')  || msg.includes('parse'))     return 'CORRUPT';
  return 'UNKNOWN';
}

console.log('\n🔍 Error classification:');

test('encrypt keyword → ENCRYPTED', () => { expect(classifyError(new Error('Encrypted PDF'))).toBe('ENCRYPTED'); });
test('password keyword → ENCRYPTED', () => { expect(classifyError(new Error('Incorrect password'))).toBe('ENCRYPTED'); });
test('ENCRYPT uppercase → ENCRYPTED', () => { expect(classifyError(new Error('ENCRYPT failed'))).toBe('ENCRYPTED'); });
test('corrupt keyword → CORRUPT', () => { expect(classifyError(new Error('Corrupt data stream'))).toBe('CORRUPT'); });
test('invalid keyword → CORRUPT', () => { expect(classifyError(new Error('Invalid PDF structure'))).toBe('CORRUPT'); });
test('bad keyword → CORRUPT', () => { expect(classifyError(new Error('Bad XRef table'))).toBe('CORRUPT'); });
test('malformed keyword → CORRUPT', () => { expect(classifyError(new Error('Malformed stream'))).toBe('CORRUPT'); });
test('unknown error → UNKNOWN', () => { expect(classifyError(new Error('Out of memory'))).toBe('UNKNOWN'); });
test('null message → UNKNOWN', () => { expect(classifyError({})).toBe('UNKNOWN'); });
test('string error → classified', () => { expect(classifyError('invalid pdf')).toBe('CORRUPT'); });
test('header keyword → CORRUPT', () => { expect(classifyError(new Error('No PDF header found'))).toBe('CORRUPT'); });
test('parse keyword → CORRUPT', () => { expect(classifyError(new Error('Failed to parse PDF document'))).toBe('CORRUPT'); });
