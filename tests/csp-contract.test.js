// tests/csp-contract.test.js
// Guards against a real bug found+fixed 2026-08-25 (commit 51971e1): pdf2md's
// opt-in Formula OCR (js/formulaOcr.js) fetches the Texo/FormulaNet model from
// huggingface.co, which 302-redirects to a *.hf.co CDN subdomain (confirmed
// via `curl -IL`, not assumed — real target seen: us.aws.cdn.hf.co). CSP
// connect-src is enforced per redirect hop, so BOTH origins must be allowed
// or the download silently fails in production with no error UI — exactly
// what shipped, undetected by build/lint/test, until real Playwright testing
// caught it. This test catches the same regression without needing a browser:
// any future edit to the CSP meta tag (in the tool-page template or any of
// the 14 homepages) that drops either origin fails CI immediately.
//
// Run: node tests/csp-contract.test.js

import { readFileSync } from 'fs';
import { strict as assert } from 'assert';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function readFile(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

// Every source file that carries its own literal CSP <meta> tag and can
// actually reach pdf2md's Formula OCR toggle: the tool-page template (one
// source generates every /pdf-to-markdown/ locale variant via build.py) plus
// all 14 hand-maintained real homepages (pdf2md's toolArea is embedded
// inline on each — see CLAUDE.md's "Adding a new tool" checklist).
const CSP_FILES = {
  'scripts/templates/tool-page.html': readFile('scripts/templates/tool-page.html'),
  'index.html':    readFile('index.html'),
  'de/index.html': readFile('de/index.html'),
  'es/index.html': readFile('es/index.html'),
  'fr/index.html': readFile('fr/index.html'),
  'pt/index.html': readFile('pt/index.html'),
  'id/index.html': readFile('id/index.html'),
  'tr/index.html': readFile('tr/index.html'),
  'vi/index.html': readFile('vi/index.html'),
  'ru/index.html': readFile('ru/index.html'),
  'ja/index.html': readFile('ja/index.html'),
  'it/index.html': readFile('it/index.html'),
  'ko/index.html': readFile('ko/index.html'),
  'nl/index.html': readFile('nl/index.html'),
  'pl/index.html': readFile('pl/index.html'),
};

function connectSrcOf(html) {
  // Anchored on "connect-src 'self'" specifically — some files also document
  // individual connect-src entries in a plain-text comment above the real
  // <meta> tag ("connect-src: *.doubleclick.net REQUIRED for..."), and a
  // looser match would capture that comment instead of the real directive.
  const m = html.match(/connect-src 'self'([\s\S]*?);/);
  return m ? m[1] : null;
}

console.log('\nCSP connect-src allows the Formula OCR model CDN (all 15 sources):');
for (const [name, html] of Object.entries(CSP_FILES)) {
  const connectSrc = connectSrcOf(html);
  test(`${name}: has a connect-src directive`, () =>
    assert.ok(connectSrc, 'No connect-src found in CSP meta tag')
  );
  test(`${name}: connect-src allows huggingface.co`, () =>
    assert.ok(connectSrc && connectSrc.includes('https://huggingface.co'),
      'huggingface.co missing — model config/tokenizer fetch would be silently blocked')
  );
  test(`${name}: connect-src allows *.hf.co (the real LFS redirect target)`, () =>
    assert.ok(connectSrc && connectSrc.includes('https://*.hf.co'),
      '*.hf.co missing — huggingface.co redirects large model weights here; CSP is enforced per redirect hop')
  );
}

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`Tests: ${total} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
