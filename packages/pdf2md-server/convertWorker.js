// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  convertWorker.js — runs pdfToMarkdown() on a separate worker thread so
//  server.js's real per-request timeout can actually enforce a hard
//  deadline via worker.terminate().
//
//  Found the hard way, not assumed: an AbortSignal/setTimeout-based
//  timeout racing pdfToMarkdown() in the SAME thread does not work for
//  this workload — verified directly that a timer scheduled mid-extraction
//  never fires until the whole conversion finishes (pdf.js's per-page
//  await chain resolves fast enough to stay entirely in the microtask
//  queue under Node's "fake worker" mode, starving the timer/macrotask
//  phase for the full duration — reproduced on a real 130-page/20MB PDF,
//  5+ seconds of a scheduled 50ms timer never firing). A same-thread
//  timeout would still return an HTTP response on schedule, but the
//  underlying conversion keeps burning CPU in the background unbounded —
//  a real DoS vector for a server handling untrusted uploads, not just a
//  cosmetic issue. worker_threads gives real, verifiable enforcement: the
//  main thread's own event loop is never blocked by this worker's CPU-bound
//  work, so its timeout timer fires reliably and worker.terminate() kills
//  the worker's thread outright, regardless of what it's doing.
// ============================================================

import { parentPort, workerData } from 'node:worker_threads';
import { pdfToMarkdown } from '@pdfree/pdf2md-core';

try {
  const markdown = await pdfToMarkdown(Buffer.from(workerData.pdfBytes));
  parentPort.postMessage({ ok: true, markdown });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
