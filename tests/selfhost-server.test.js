// ============================================================
//  tests/selfhost-server.test.js — real end-to-end tests for
//  selfhost/server.js (the self-hosted Docker package's entry point).
//
//  Spawns the actual server.js as a subprocess against a real built
//  dist/ (not an in-process import) — exercises the real startup path
//  and real HTTP behavior exactly as a self-hoster would run it, then
//  makes real HTTP requests and asserts on real responses. This is the
//  "does the self-hosted container match production behavior" check —
//  same spirit as packages/pdf2md-server/test/server.test.js's own
//  subprocess-based approach.
//
//  Run: node tests/selfhost-server.test.js
// ============================================================

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const SERVER_PATH = join(ROOT, 'selfhost', 'server.js');
const DIST        = join(ROOT, 'dist');

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toContain(sub) {
      if (!String(actual).includes(sub)) throw new Error(`expected "${actual}" to contain "${sub}"`);
    },
  };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (buf) => {
      out += buf.toString();
      const m = out.match(/listening on :(\d+)/);
      if (m) {
        proc.stdout.off('data', onData);
        resolve({ proc, baseUrl: `http://localhost:${m[1]}` });
      }
    };
    proc.stdout.on('data', onData);
    proc.once('error', reject);
    proc.once('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`server exited early with code ${code}, output: ${out}`));
    });
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill();
  });
}

const inCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
if (!existsSync(DIST) && !inCI) {
  console.log('  – skipped: selfhost-server check (dist/ not built — run scripts/build.py first; mandatory in CI)');
} else {
  const { proc, baseUrl } = await startServer();

  try {
    await test('dist/ exists', () => {
      if (!existsSync(DIST)) throw new Error('dist/ does not exist — build step must have failed or been skipped');
    });

    await test('GET /health returns { status: "ok" }', async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });

    await test('GET / (homepage) returns 200', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    });

    await test('a known redirect (/compress/) returns a real 301 to /compress-pdf/', async () => {
      const res = await fetch(`${baseUrl}/compress/`, { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toContain('/compress-pdf/');
    });

    await test('a real tool page (/merge-pdf/) returns 200', async () => {
      const res = await fetch(`${baseUrl}/merge-pdf/`);
      expect(res.status).toBe(200);
    });

    await test('an unmatched path returns a genuine 404 status, not a soft-404 200', async () => {
      const res = await fetch(`${baseUrl}/this-path-does-not-exist/`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/html');
    });

    await test('a static asset (js/app.js) is served with the right content-type', async () => {
      const res = await fetch(`${baseUrl}/js/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');
    });

    await test('the qpdf WASM binary is served with a real application/wasm content-type', async () => {
      const res = await fetch(`${baseUrl}/js/vendor/qpdf/lib/qpdf.wasm`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/wasm');
    });

    await test('a versioned asset (?v=) gets a long immutable Cache-Control', async () => {
      const res = await fetch(`${baseUrl}/js/app.js?v=abc123`);
      expect(res.headers.get('cache-control')).toContain('immutable');
    });

    await test('a bare asset (no ?v=) gets a short Cache-Control, not immutable', async () => {
      const res = await fetch(`${baseUrl}/js/app.js`);
      const cc = res.headers.get('cache-control') || '';
      if (cc.includes('immutable')) throw new Error(`expected a short cache for a bare URL, got "${cc}"`);
    });

    await test('HTML responses get Cache-Control: no-cache', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    });

    await test('a malformed percent-encoded path returns 400, not an unhandled 500', async () => {
      const res = await fetch(`${baseUrl}/%E0%A4%A`);
      expect(res.status).toBe(400);
    });

    await test('a path-traversal attempt cannot escape dist/', async () => {
      const res = await fetch(`${baseUrl}/../../../../etc/passwd`);
      if (res.status === 200) throw new Error('path traversal attempt returned 200 — dist/ escape possible');
    });

    await test('/embed/ strips X-Frame-Options and sets a permissive frame-ancestors CSP', async () => {
      const res = await fetch(`${baseUrl}/embed/`);
      if (res.headers.get('x-frame-options')) throw new Error('X-Frame-Options should be stripped on /embed/ paths');
      expect(res.headers.get('content-security-policy')).toContain('frame-ancestors *');
    });

    await test('POST /api/feedback with a valid Origin and no Telegram/GSheet secrets set is a clean no-op (200)', async () => {
      const res = await fetch(`${baseUrl}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify({ type: 'other', text: '' }),
      });
      expect(res.status).toBe(200);
    });
  } finally {
    await stopServer(proc);
  }
}

console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed > 0) process.exit(1);
