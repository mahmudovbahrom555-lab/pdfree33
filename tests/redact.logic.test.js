// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  tests/redact.logic.test.js
//
//  Pure-logic tests for the True PDF Redaction feature.
//  All tested functions are copied verbatim from their source
//  so the suite runs in Node.js without a DOM or Worker.
//
//  Covers:
//    • _luhnCheck          — Luhn credit card checksum
//    • PII_PATTERNS        — regex correctness per pattern type
//    • validateFn filter   — CC regex + Luhn integration
//    • _simRedact          — rect coord logic (PDF→canvas mapping)
//    • sourceCounts        — report aggregation logic
//    • _dataUrlToBytes     — base64 decoder from redact-worker.js
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`Expected ${b}, got ${a}`);
    },
    toBeTrue()  { if (actual !== true)  throw new Error(`Expected true, got ${actual}`); },
    toBeFalse() { if (actual !== false) throw new Error(`Expected false, got ${actual}`); },
    toBeGreaterThan(n) { if (actual <= n) throw new Error(`Expected > ${n}, got ${actual}`); },
    toBeLessThan(n)    { if (actual >= n) throw new Error(`Expected < ${n}, got ${actual}`); },
    toBe0()     { if (actual !== 0) throw new Error(`Expected 0, got ${actual}`); },
    toContain(sub) {
      if (typeof actual === 'string') {
        if (!actual.includes(sub)) throw new Error(`Expected "${actual}" to contain "${sub}"`);
      } else if (Array.isArray(actual)) {
        if (!actual.includes(sub)) throw new Error(`Expected array to contain ${sub}`);
      }
    },
    toHaveLength(n) {
      if (actual.length !== n) throw new Error(`Expected length ${n}, got ${actual.length}`);
    },
  };
}

// ── Copy of _luhnCheck from redactUI.js ───────────────────────
function _luhnCheck(str) {
  const digits = str.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ── Copy of PII_PATTERNS from redactUI.js ─────────────────────
const PII_PATTERNS = [
  { id: 'email', label: '📧 Email',
    regex: /[a-zA-Z0-9._%+\w]{1,64}@[a-zA-Z0-9.]{1,253}\.[a-zA-Z]{2,24}/gi },
  { id: 'phone', label: '📞 Phone',
    regex: /(?:\+\d{1,3}[\s]?)?\(?\d{2,4}\)?[\s.]\d{2,4}[\s.]\d{2,9}/g },
  { id: 'cc', label: '💳 Credit Card',
    regex: /\b\d{4}[\s]?\d{4}[\s]?\d{4}[\s]?\d{4}\b/g,
    validate: _luhnCheck },
  { id: 'iban', label: '🏦 IBAN',
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{1,30}\b/g },
  { id: 'url', label: '🌐 URL',
    regex: /https?:\/\/[^\s]+/gi },
];

// ── Copy of _dataUrlToBytes from redact-worker.js ─────────────
function _dataUrlToBytes(dataUrl) {
  // Node.js version using Buffer instead of atob
  const base64 = dataUrl.split(',')[1];
  return Buffer.from(base64, 'base64');
}

// Helper: apply a PII pattern to a string, return all valid matches
function findMatches(patternId, str) {
  const pii = PII_PATTERNS.find(p => p.id === patternId);
  const rx = new RegExp(pii.regex.source, pii.regex.flags);
  const results = [];
  let m;
  while ((m = rx.exec(str)) !== null) {
    if (pii.validate && !pii.validate(m[0])) continue;
    results.push(m[0]);
  }
  return results;
}

// ── sourceCounts aggregation (copied from processor.js) ───────
function buildSourceCounts(rectsByPage, applyAll, sharedRects, redactedPageSet) {
  const sourceCounts = {};
  for (const pageIdx of redactedPageSet) {
    const pageNum = pageIdx + 1;
    const rects = applyAll ? sharedRects : (rectsByPage[pageNum] || []);
    for (const r of rects) {
      const src = r.source || 'area';
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    }
  }
  return sourceCounts;
}

// ═══════════════════════════════════════════════════════════════
//  1. Luhn Algorithm
// ═══════════════════════════════════════════════════════════════
console.log('\n── Luhn Check ──────────────────────────────────────────');

test('valid Visa card passes', () => {
  expect(_luhnCheck('4532015112830366')).toBeTrue();
});

test('valid Visa with spaces passes', () => {
  expect(_luhnCheck('4532 0151 1283 0366')).toBeTrue();
});

test('valid MasterCard passes', () => {
  expect(_luhnCheck('5425233430109903')).toBeTrue();
});

test('valid Amex (15 digits) passes', () => {
  expect(_luhnCheck('371449635398431')).toBeTrue();
});

test('valid Discover passes', () => {
  expect(_luhnCheck('6011111111111117')).toBeTrue();
});

test('sequential 1234567890123456 fails Luhn', () => {
  expect(_luhnCheck('1234567890123456')).toBeFalse();
});

test('all-zeros 0000000000000000 passes Luhn (known edge case — sum=0)', () => {
  // Luhn sum of all zeros = 0; 0 % 10 === 0 → valid by definition.
  // This is a known limitation of the checksum — extremely rare in real docs.
  expect(_luhnCheck('0000000000000000')).toBeTrue();
});

test('random 16-digit 1234567812345678 fails Luhn', () => {
  expect(_luhnCheck('1234567812345678')).toBeFalse();
});

test('too-short number (12 digits) returns false', () => {
  expect(_luhnCheck('123456789012')).toBeFalse();
});

test('too-long number (20 digits) returns false', () => {
  expect(_luhnCheck('12345678901234567890')).toBeFalse();
});

test('empty string returns false', () => {
  expect(_luhnCheck('')).toBeFalse();
});

test('non-digit string returns false', () => {
  expect(_luhnCheck('not-a-card-number')).toBeFalse();
});

// ═══════════════════════════════════════════════════════════════
//  2. Email Pattern
// ═══════════════════════════════════════════════════════════════
console.log('\n── Email Pattern ────────────────────────────────────────');

test('basic email matches', () => {
  const m = findMatches('email', 'Contact: user@example.com for info');
  expect(m.length).toBeGreaterThan(0);
  expect(m[0]).toContain('@example.com');
});

test('email with subdomain matches', () => {
  const m = findMatches('email', 'Send to admin@mail.company.co.uk');
  expect(m.length).toBeGreaterThan(0);
});

test('email with plus tag matches', () => {
  const m = findMatches('email', 'user+tag@domain.org');
  expect(m.length).toBeGreaterThan(0);
});

test('multiple emails in one string', () => {
  const m = findMatches('email', 'From: alice@a.com To: bob@b.com');
  expect(m.length).toBe(2);
});

// Real ReDoS found via a live pentest pass: the original unbounded email
// regex (`[...]+@[...]+\.[a-zA-Z]{2,}`) took 28+ SECONDS against a
// 200k-char adversarial string with no `@`/no valid TLD — the /gi global
// flag retries at every failed starting position, and each retry re-does
// an O(n) greedy-then-backtrack scan, compounding to real O(n²). This
// pattern runs directly against item.str from a PDF's own extracted text
// (_runPatternSearch in redactUI.js) — a single crafted long text-showing
// operation in a malicious PDF reaches it with no length limit. Fixed by
// bounding every quantifier to a real-world max (RFC 5321 local part ≤64,
// RFC 1035 domain ≤253). These 3 cases pin the fix at a smaller, CI-fast
// size (20k, not 200k) — even at 1/10th the size that took 28s unfixed,
// this must stay well under a second, or the bound regressed.
test('ReDoS: long run with no @ does not hang (local-part blowup)', () => {
  const start = Date.now();
  findMatches('email', 'a'.repeat(20000) + '!');
  expect(Date.now() - start).toBeLessThan(500);
});

test('ReDoS: long run with no valid TLD does not hang (domain-part blowup)', () => {
  const start = Date.now();
  findMatches('email', 'a@' + 'b'.repeat(20000) + '9');
  expect(Date.now() - start).toBeLessThan(500);
});

test('ReDoS: long run after the dot does not hang (TLD blowup)', () => {
  const start = Date.now();
  findMatches('email', 'a@b.' + 'c'.repeat(20000));
  expect(Date.now() - start).toBeLessThan(500);
});

test('no email in plain text — no match', () => {
  const m = findMatches('email', 'No email here at all');
  expect(m.length).toBe(0);
});

test('@-only string does not match', () => {
  const m = findMatches('email', '@nodomain');
  expect(m.length).toBe(0);
});

// ═══════════════════════════════════════════════════════════════
//  3. Phone Pattern (structured, requires separators)
// ═══════════════════════════════════════════════════════════════
console.log('\n── Phone Pattern ────────────────────────────────────────');

test('international format +1 555 123 4567 matches', () => {
  const m = findMatches('phone', 'Call +1 555 123 4567');
  expect(m.length).toBeGreaterThan(0);
});

test('dot-separated 555.123.4567 matches', () => {
  const m = findMatches('phone', 'Tel: 555.123.4567');
  expect(m.length).toBeGreaterThan(0);
});

test('bare digits 1234567890 (no separators) do NOT match', () => {
  const m = findMatches('phone', 'ID number: 1234567890');
  expect(m.length).toBe(0);
});

test('short number 123-45 (too short) does not match', () => {
  const m = findMatches('phone', 'Code: 123-45');
  expect(m.length).toBe(0);
});

// ═══════════════════════════════════════════════════════════════
//  4. Credit Card — regex + Luhn integration
// ═══════════════════════════════════════════════════════════════
console.log('\n── Credit Card (regex + Luhn) ───────────────────────────');

test('valid Visa 4532 0151 1283 0366 is detected', () => {
  const m = findMatches('cc', 'Card: 4532 0151 1283 0366');
  expect(m.length).toBe(1);
});

test('valid MasterCard 5425 2334 3010 9903 is detected', () => {
  const m = findMatches('cc', '5425 2334 3010 9903');
  expect(m.length).toBe(1);
});

test('invalid 16 digits 1234 5678 9012 3456 is filtered by Luhn', () => {
  const m = findMatches('cc', '1234 5678 9012 3456');
  expect(m.length).toBe(0);
});

test('near-sequential 0000 0000 0000 0001 is filtered by Luhn', () => {
  // Sum = 1; 1 % 10 !== 0 → invalid
  const m = findMatches('cc', '0000 0000 0000 0001');
  expect(m.length).toBe(0);
});

test('mixed text with valid CC extracts only the card', () => {
  const m = findMatches('cc', 'Invoice #00005432 Amount: 4532 0151 1283 0366 EUR');
  expect(m.length).toBe(1);
  expect(m[0]).toContain('4532');
});

test('text with only random 16-digit number — no false positive', () => {
  const m = findMatches('cc', 'Order ref: 1234 5678 9012 3456 processed');
  expect(m.length).toBe(0);
});

// ═══════════════════════════════════════════════════════════════
//  5. IBAN Pattern
// ═══════════════════════════════════════════════════════════════
console.log('\n── IBAN Pattern ─────────────────────────────────────────');

test('German IBAN matches', () => {
  const m = findMatches('iban', 'IBAN: DE89370400440532013000');
  expect(m.length).toBeGreaterThan(0);
});

test('UK IBAN matches', () => {
  const m = findMatches('iban', 'Bank: GB29NWBK60161331926819');
  expect(m.length).toBeGreaterThan(0);
});

test('lowercase text does not match IBAN (uppercase required)', () => {
  const m = findMatches('iban', 'de89370400440532013000');
  expect(m.length).toBe(0);
});

// ═══════════════════════════════════════════════════════════════
//  6. URL Pattern
// ═══════════════════════════════════════════════════════════════
console.log('\n── URL Pattern ──────────────────────────────────────────');

test('https URL matches', () => {
  const m = findMatches('url', 'See https://pdfree.io for details');
  expect(m.length).toBeGreaterThan(0);
});

test('http URL matches', () => {
  const m = findMatches('url', 'http://example.com/path?q=1&r=2');
  expect(m.length).toBeGreaterThan(0);
});

test('ftp:// URL does NOT match (http/https only)', () => {
  const m = findMatches('url', 'ftp://files.example.com');
  expect(m.length).toBe(0);
});

test('bare domain without scheme does not match', () => {
  const m = findMatches('url', 'Visit www.example.com today');
  expect(m.length).toBe(0);
});

// ═══════════════════════════════════════════════════════════════
//  7. Redaction Report — sourceCounts aggregation
// ═══════════════════════════════════════════════════════════════
console.log('\n── Redaction Report (sourceCounts) ─────────────────────');

test('counts email and phone sources correctly', () => {
  const rectsByPage = {
    1: [{ type: 'rect', x:0, y:0, w:10, h:10, source: 'email' },
        { type: 'rect', x:0, y:20, w:10, h:10, source: 'email' }],
    3: [{ type: 'rect', x:0, y:0, w:10, h:10, source: 'phone' }],
  };
  const counts = buildSourceCounts(rectsByPage, false, [], new Set([0, 2]));
  expect(counts['email']).toBe(2);
  expect(counts['phone']).toBe(1);
});

test('manual areas tagged as "area"', () => {
  const rectsByPage = {
    2: [{ type: 'rect', x:0, y:0, w:50, h:50 }], // no source field
  };
  const counts = buildSourceCounts(rectsByPage, false, [], new Set([1]));
  expect(counts['area']).toBe(1);
});

test('applyAll mode uses shared rects on each redacted page', () => {
  const sharedRects = [
    { type: 'rect', x:0, y:0, w:10, h:10, source: 'cc' },
    { type: 'rect', x:0, y:20, w:10, h:10, source: 'cc' },
  ];
  // 3 pages all redacted
  const counts = buildSourceCounts({}, true, sharedRects, new Set([0, 1, 2]));
  // 2 rects × 3 pages = 6
  expect(counts['cc']).toBe(6);
});

test('empty redactedPageSet returns empty counts', () => {
  const counts = buildSourceCounts({}, false, [], new Set());
  expect(Object.keys(counts).length).toBe(0);
});

// ═══════════════════════════════════════════════════════════════
//  8. _dataUrlToBytes (redact-worker helper)
// ═══════════════════════════════════════════════════════════════
console.log('\n── dataUrl → bytes decoder ──────────────────────────────');

test('round-trip base64 encode/decode', () => {
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
  const dataUrl = 'data:image/png;base64,' + original.toString('base64');
  const decoded = _dataUrlToBytes(dataUrl);
  expect(decoded[0]).toBe(0x89);
  expect(decoded[1]).toBe(0x50);
  expect(decoded[2]).toBe(0x4e);
  expect(decoded[3]).toBe(0x47);
});

test('non-empty result for non-trivial input', () => {
  const dataUrl = 'data:image/png;base64,' + Buffer.from('hello world').toString('base64');
  const bytes = _dataUrlToBytes(dataUrl);
  expect(bytes.length).toBeGreaterThan(0);
});

// ═══════════════════════════════════════════════════════════════
//  9. Coordinate mapping: PDF → canvas rect
// ═══════════════════════════════════════════════════════════════
console.log('\n── PDF → canvas coordinate mapping ─────────────────────');

// In _runRedactTrue: PDF coords (origin bottom-left) are mapped to
// canvas coords (origin top-left) at RENDER_SCALE.
// cx = r.x * scale; cy = (pageHeight - r.y - r.h) * scale
function pdfRectToCanvas(r, pageHeight, scale) {
  return {
    cx: r.x * scale,
    cy: (pageHeight - r.y - r.h) * scale,
    cw: r.w * scale,
    ch: r.h * scale,
  };
}

test('top-left PDF rect maps to top-left canvas rect', () => {
  // A4: 595×842pt, rect at top-left corner (PDF y near pageHeight)
  const r = { x: 0, y: 792, w: 100, h: 50 }; // near top in PDF coords
  const c = pdfRectToCanvas(r, 842, 1);
  expect(c.cx).toBe(0);
  expect(c.cy).toBe(0);  // 842 - 792 - 50 = 0
});

test('scale factor doubles all dimensions', () => {
  const r = { x: 10, y: 20, w: 100, h: 50 };
  const c1 = pdfRectToCanvas(r, 842, 1);
  const c2 = pdfRectToCanvas(r, 842, 2);
  expect(c2.cx).toBe(c1.cx * 2);
  expect(c2.cw).toBe(c1.cw * 2);
  expect(c2.ch).toBe(c1.ch * 2);
});

test('rect width/height are always positive', () => {
  const r = { x: 50, y: 100, w: 200, h: 80 };
  const c = pdfRectToCanvas(r, 842, 2);
  expect(c.cw > 0).toBe(true);
  expect(c.ch > 0).toBe(true);
});

// ═══════════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════════
console.log('');
if (failed === 0) {
  console.log(`  All ${passed} redact tests passed ✓`);
} else {
  console.log(`  ${passed} passed, ${failed} FAILED`);
  process.exit(1);
}
