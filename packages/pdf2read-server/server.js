// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  server.js — self-hosted REST wrapper for @pdfree/pdf2read-core.
//
//  POST /reflow   — body: raw PDF bytes (Content-Type: application/pdf).
//                   response: JSON { pages, pageCount } (Content-Type: application/json).
//  GET  /health   — { status: "ok" }, for container orchestration.
//
//  No built-in auth, by design — matches @pdfree/pdf2md-server's own
//  self-hosted posture. Put this behind your own reverse proxy/firewall if
//  exposed beyond localhost or a trusted network. See README.md.
//
//  Conversion runs in a worker thread (convertWorker.js), NOT the same
//  thread — required for the timeout below to be real cancellation rather
//  than a same-thread race that returns an HTTP response on schedule but
//  leaves the underlying conversion running unbounded in the background.
//  See convertWorker.js's header comment for the real, verified reason
//  (same one @pdfree/pdf2md-server's own server.js documents).
// ============================================================

import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'convertWorker.js');

const PORT             = Number(process.env.PORT) || 8080;
const MAX_BODY_BYTES   = Number(process.env.MAX_BODY_BYTES) || 50 * 1024 * 1024; // 50 MB
const TIMEOUT_MS       = Number(process.env.TIMEOUT_MS) || 60_000; // 60 s
// Each in-flight conversion is a real worker_threads Worker — its own V8
// isolate, real memory/CPU overhead beyond just the PDF bytes. With no cap,
// N simultaneous large-PDF requests spawn N simultaneous workers with no
// bound at all — a real OOM path, not hypothetical. Requests beyond
// MAX_CONCURRENT queue (FIFO) rather than being rejected outright, but
// don't wait forever — QUEUE_TIMEOUT_MS bounds how long a queued request
// waits for a slot before giving up with a clear 503.
const MAX_CONCURRENT   = Number(process.env.MAX_CONCURRENT) || 4;
const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS) || 30_000; // 30 s

const server = createServer((req, res) => {
  _route(req, res).catch(err => {
    // Safety net — a request handler must never crash the process.
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Internal error: ${err.message}`);
  });
});

async function _route(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/reflow') {
    await _handleReflow(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found. POST /reflow with a PDF body (Content-Type: application/pdf), or GET /health.');
}

async function _handleReflow(req, res) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/pdf') && !contentType.includes('application/octet-stream')) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request: Content-Type must be application/pdf (or application/octet-stream).');
    return;
  }

  let bytes;
  try {
    bytes = await _readBodyWithLimit(req, MAX_BODY_BYTES);
  } catch (err) {
    // Connection: close + destroy-after-finish, not an immediate
    // req.destroy() — destroying the request stream synchronously tears
    // down the whole underlying socket before the error response can
    // flush (req/res share one Socket), so the client sees a bare
    // connection reset instead of a real 413/400. Same real finding
    // @pdfree/pdf2md-server's own server.js already documents.
    res.setHeader('Connection', 'close');
    if (err.code === 'BODY_TOO_LARGE') {
      res.writeHead(413, { 'Content-Type': 'text/plain' });
      res.end(`Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`);
    } else {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Bad request: ${err.message}`);
    }
    res.once('finish', () => req.destroy());
    return;
  }

  if (bytes.length === 0) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request: empty body.');
    return;
  }

  // Real PDF signature check ("%PDF-", the required magic bytes at the
  // start of every valid PDF per the spec), not just a client-supplied,
  // trivially-spoofable Content-Type header — same defense-in-depth check
  // @pdfree/pdf2md-server's own server.js already uses.
  if (bytes.length < 5 || bytes.toString('latin1', 0, 5) !== '%PDF-') {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end("Bad request: not a PDF (missing the required '%PDF-' signature at the start of the file).");
    return;
  }

  let slotAcquired = false;
  try {
    await _acquireSlot(QUEUE_TIMEOUT_MS);
    slotAcquired = true;
    const result = await _convertWithTimeout(bytes, TIMEOUT_MS);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    if (err.code === 'QUEUE_TIMEOUT') {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end(`Server is at its concurrency limit (${MAX_CONCURRENT}) and no slot freed up within ${QUEUE_TIMEOUT_MS}ms — try again shortly.`);
    } else if (err.code === 'TIMEOUT') {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end(`Conversion exceeded the ${TIMEOUT_MS}ms timeout.`);
    } else {
      res.writeHead(422, { 'Content-Type': 'text/plain' });
      res.end(`Conversion failed: ${err.message}`);
    }
  } finally {
    if (slotAcquired) _releaseSlot();
  }
}

// ── Concurrency limiter ──────────────────────────────────────────────
// A plain in-process counting semaphore + FIFO queue — no external
// dependency needed for this. `activeCount` tracks in-flight conversions;
// a request beyond MAX_CONCURRENT waits in `queue` for a slot to free up,
// bounded by queueTimeoutMs so a queued request can't wait forever behind
// a backlog of slow/adversarial conversions.
let _activeCount = 0;
const _queue = [];

function _acquireSlot(queueTimeoutMs) {
  if (_activeCount < MAX_CONCURRENT) {
    _activeCount++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const entry = { settled: false };
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      entry.settled = true;
      const idx = _queue.indexOf(entry);
      if (idx !== -1) _queue.splice(idx, 1);
      const err = new Error('queue wait timed out');
      err.code = 'QUEUE_TIMEOUT';
      reject(err);
    }, queueTimeoutMs);
    entry.grant = () => {
      if (entry.settled) return;
      entry.settled = true;
      clearTimeout(entry.timer);
      _activeCount++;
      resolve();
    };
    _queue.push(entry);
  });
}

function _releaseSlot() {
  _activeCount--;
  const next = _queue.shift();
  if (next) next.grant();
}

// Streams the request body, rejecting as soon as MAX_BODY_BYTES is exceeded
// — checked incrementally, not after fully buffering an oversized upload
// in memory.
function _readBodyWithLimit(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let over = false;
    req.on('data', chunk => {
      if (over) return;
      total += chunk.length;
      if (total > maxBytes) {
        over = true;
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Runs the conversion in a worker thread with a real, enforced timeout —
// worker.terminate() forcibly kills the thread if it hasn't responded by
// timeoutMs, regardless of what it's doing internally.
function _convertWithTimeout(pdfBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { pdfBytes: new Uint8Array(pdfBytes) },
    });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error('conversion timed out');
      err.code = 'TIMEOUT';
      worker.terminate();
      reject(err);
    }, timeoutMs);

    worker.once('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error));
    });

    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    // A worker can exit (e.g. crash, OOM-killed) without ever emitting
    // 'message' or 'error' — without this, that case would hang the
    // request forever instead of failing it.
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`conversion worker exited unexpectedly (code ${code})`));
    });
  });
}

server.listen(PORT, () => {
  // server.address().port, not PORT itself — PORT=0 (used by tests to get
  // an OS-assigned ephemeral port) would otherwise log the literal "0".
  const actualPort = server.address().port;
  console.log(`pdf2read-server listening on :${actualPort} (max body ${MAX_BODY_BYTES} bytes, timeout ${TIMEOUT_MS}ms, max concurrent ${MAX_CONCURRENT})`);
});
