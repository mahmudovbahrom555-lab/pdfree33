// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  server.js — self-hosted REST wrapper for @pdfree/pdf2md-core.
//
//  POST /convert  — body: raw PDF bytes (Content-Type: application/pdf).
//                   response: Markdown text (Content-Type: text/markdown).
//  GET  /health   — { status: "ok" }, for container orchestration.
//
//  No built-in auth, by design — matches HURIDOCS' own self-hosted posture.
//  Put this behind your own reverse proxy/firewall if exposed beyond
//  localhost or a trusted network. See README.md.
//
//  Conversion runs in a worker thread (convertWorker.js), NOT the same
//  thread — required for the timeout below to be real cancellation rather
//  than a same-thread race that returns an HTTP response on schedule but
//  leaves the underlying conversion running unbounded in the background.
//  See convertWorker.js's header comment for the real, verified reason.
// ============================================================

import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'convertWorker.js');

const PORT            = Number(process.env.PORT) || 8080;
const MAX_BODY_BYTES  = Number(process.env.MAX_BODY_BYTES) || 50 * 1024 * 1024; // 50 MB
const TIMEOUT_MS      = Number(process.env.TIMEOUT_MS) || 60_000; // 60 s

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

  if (req.method === 'POST' && req.url === '/convert') {
    await _handleConvert(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found. POST /convert with a PDF body (Content-Type: application/pdf), or GET /health.');
}

async function _handleConvert(req, res) {
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
    // connection reset instead of a real 413/400. Found via a real curl
    // test against this exact path (got "HTTP 000", no response at all)
    // before this fix.
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

  try {
    const markdown = await _convertWithTimeout(bytes, TIMEOUT_MS);
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end(markdown);
  } catch (err) {
    if (err.code === 'TIMEOUT') {
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end(`Conversion exceeded the ${TIMEOUT_MS}ms timeout.`);
    } else {
      res.writeHead(422, { 'Content-Type': 'text/plain' });
      res.end(`Conversion failed: ${err.message}`);
    }
  }
}

// Streams the request body, rejecting as soon as MAX_BODY_BYTES is exceeded
// — checked incrementally, not after fully buffering an oversized upload
// in memory. Stops ACCUMULATING chunks once over the limit (the actual
// memory-safety property this exists for) but does not tear down the
// socket itself — that's the caller's job, AFTER its error response has
// been flushed (see _handleConvert's BODY_TOO_LARGE branch and its
// comment for why: destroying the request stream here killed the shared
// socket before the 413 response could ever reach the client).
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
// timeoutMs, regardless of what it's doing internally. See this file's
// header comment and convertWorker.js's for why a same-thread
// Promise.race()/AbortSignal timeout does NOT work for this workload.
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
      if (msg.ok) resolve(msg.markdown);
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
  console.log(`pdf2md-server listening on :${actualPort} (max body ${MAX_BODY_BYTES} bytes, timeout ${TIMEOUT_MS}ms)`);
});
