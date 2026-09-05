// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  convertWorker.js — runs pdfToReadingBlocks() on a separate worker thread
//  so server.js's real per-request timeout can actually enforce a hard
//  deadline via worker.terminate(). Same reasoning, same reused finding, as
//  @pdfree/pdf2md-server's own convertWorker.js (see that file's header):
//  an AbortSignal/setTimeout-based timeout racing the conversion in the SAME
//  thread does not work for this workload — pdf.js's per-page await chain
//  resolves fast enough to stay entirely in the microtask queue under
//  Node's "fake worker" mode, starving the timer/macrotask phase for the
//  full duration a same-thread timer would need to fire. worker_threads
//  gives real, verifiable enforcement instead.
// ============================================================

import { parentPort, workerData } from 'node:worker_threads';
import { pdfToReadingBlocks } from '@pdfree/pdf2read-core';

try {
  const result = await pdfToReadingBlocks(Buffer.from(workerData.pdfBytes));
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
