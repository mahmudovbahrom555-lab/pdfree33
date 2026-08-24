// SPDX-License-Identifier: AGPL-3.0-only
//
// Real end-to-end tests: spawns the actual server.js as a subprocess (not
// an in-process import — this exercises the real startup path, the real
// worker_threads spawn/terminate machinery, and real env-var configuration
// exactly as a deployer would run it), makes real HTTP requests with
// real PDF bytes, and asserts on real responses. Each test that needs a
// non-default MAX_BODY_BYTES/TIMEOUT_MS spawns its own server instance —
// these are module-level constants read from process.env at import time,
// so they can't be varied within one running process.
//
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here       = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'server.js');
const fixture    = name => join(here, '..', '..', '..', 'tests', 'fixtures', 'columns', name);

// Starts server.js as a real subprocess with the given env, waits for its
// "listening on :PORT" line, resolves { proc, baseUrl }. Caller must kill
// `proc` when done.
function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: '0', ...env },
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

test('GET /health returns { status: "ok" }', async () => {
  const { proc, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    await stopServer(proc);
  }
});

test('POST /convert with a real PDF returns real Markdown, matching the library directly', async () => {
  const { proc, baseUrl } = await startServer();
  try {
    const pdfBytes = await readFile(fixture('2608.11433.pdf'));
    const res = await fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBytes,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/markdown/);
    const md = await res.text();
    assert.ok(md.length > 1000);
    assert.match(md, /^#{1,6} .*Stigma and Support/m);

    const { pdfToMarkdown } = await import('@pdfree/pdf2md-core');
    const direct = await pdfToMarkdown(pdfBytes);
    assert.equal(md, direct, 'server output must be byte-identical to calling the library directly');
  } finally {
    await stopServer(proc);
  }
});

test('POST /convert with wrong Content-Type returns 400', async () => {
  const { proc, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not a pdf',
    });
    assert.equal(res.status, 400);
  } finally {
    await stopServer(proc);
  }
});

test('POST /convert with an empty body returns 400', async () => {
  const { proc, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: '',
    });
    assert.equal(res.status, 400);
  } finally {
    await stopServer(proc);
  }
});

test('POST /convert with a non-PDF body (wrong content, right Content-Type) is rejected by the %PDF- signature check, before ever spawning a worker', async () => {
  const { proc, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: 'this is not really a pdf file',
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /not a PDF.*signature/);
  } finally {
    await stopServer(proc);
  }
});

test('a body that passes the %PDF- signature check but is structurally broken still reaches the worker and gets a proper 422, not a crash', async () => {
  const { proc, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: '%PDF-1.4\nthis has the right magic bytes but nothing else valid',
    });
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Invalid PDF/);
  } finally {
    await stopServer(proc);
  }
});

test('SECURITY: a body over MAX_BODY_BYTES is rejected with 413, and the connection still responds cleanly (not a bare reset)', async () => {
  const { proc, baseUrl } = await startServer({ MAX_BODY_BYTES: '1000' });
  try {
    const pdfBytes = await readFile(fixture('2608.11433.pdf')); // real file, far over 1000 bytes
    const res = await fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBytes,
    });
    assert.equal(res.status, 413);
    assert.match(await res.text(), /exceeds the 1000-byte limit/);

    // The server must still be alive and correctly serving other requests
    // after rejecting an oversized one — not left in a broken state.
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
  } finally {
    await stopServer(proc);
  }
});

test('SECURITY: a slow conversion is really cut off by TIMEOUT_MS, not just client-facing (worker.terminate() enforcement, not a same-thread race)', async () => {
  const { proc, baseUrl } = await startServer({ TIMEOUT_MS: '200' });
  try {
    // A real, large, multi-page PDF that takes several real seconds to
    // convert (built from a real fixture repeated) — 200ms is nowhere
    // close to enough time for a genuine conversion to finish, so a 504
    // here proves the timeout is real, not a fluke of a fast machine.
    const src = await readFile(fixture('2608.11694.pdf'));
    // Reuse the same bytes multiple times isn't valid PDF concatenation,
    // so instead just rely on the single real 13-page/2MB fixture with an
    // aggressively short timeout — still real, still provably too fast
    // for a genuine multi-page extraction to complete.
    const start = Date.now();
    const res = await fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: src,
    });
    const elapsed = Date.now() - start;
    assert.equal(res.status, 504);
    assert.match(await res.text(), /exceeded the 200ms timeout/);
    // The whole point of worker.terminate() over a same-thread race: the
    // response must come back close to TIMEOUT_MS, not after however long
    // the real conversion would have taken.
    assert.ok(elapsed < 3000, `expected a fast timeout response, took ${elapsed}ms`);
  } finally {
    await stopServer(proc);
  }
});

test('SECURITY: with MAX_CONCURRENT=1, a second simultaneous request queues and still succeeds once the first finishes', async () => {
  const { proc, baseUrl } = await startServer({ MAX_CONCURRENT: '1', QUEUE_TIMEOUT_MS: '10000' });
  try {
    const pdfBytes = await readFile(fixture('2608.11433.pdf'));
    const post = () => fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBytes,
    });
    // Real concurrency, not sequential awaits — both requests are in
    // flight at once; with MAX_CONCURRENT=1 the second one must queue
    // behind the first rather than spawning a second worker immediately.
    const [a, b] = await Promise.all([post(), post()]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const [mdA, mdB] = await Promise.all([a.text(), b.text()]);
    assert.equal(mdA, mdB, 'both requests convert the same file — output must match');
  } finally {
    await stopServer(proc);
  }
});

test('SECURITY: with MAX_CONCURRENT=1 and a short QUEUE_TIMEOUT_MS, a request that cannot get a slot in time gets a clear 503, not a hang', async () => {
  const { proc, baseUrl } = await startServer({ MAX_CONCURRENT: '1', QUEUE_TIMEOUT_MS: '50' });
  try {
    const pdfBytes = await readFile(fixture('2608.11433.pdf')); // real conversion takes well over 50ms
    const post = () => fetch(`${baseUrl}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBytes,
    });
    const [a, b] = await Promise.all([post(), post()]);
    const statuses = [a.status, b.status].sort();
    // One request occupies the only slot (200); the other can't get a
    // slot within the 50ms queue timeout (503) — order between the two
    // parallel fetches isn't guaranteed, so check the pair, not which one.
    assert.deepEqual(statuses, [200, 503]);
    const rejected = a.status === 503 ? a : b;
    assert.match(await rejected.text(), /concurrency limit/);
  } finally {
    await stopServer(proc);
  }
});

test('GET /unknown-route returns 404', async () => {
  const { proc, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/unknown-route`);
    assert.equal(res.status, 404);
  } finally {
    await stopServer(proc);
  }
});
