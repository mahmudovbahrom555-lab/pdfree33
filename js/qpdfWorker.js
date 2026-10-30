// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  qpdfWorker.js — qpdf (WebAssembly) in a classic worker
//
//  The vendored build before (qpdf-run 0.2.1, qpdf 11.7) had a fixed heap:
//  an encrypted PDF holding one stream over ~4.5 MB — a big scan — made it
//  abort, so a restricted file (no open password, editing locked) couldn't
//  be decrypted: "too large" in most tools, and EXTRACT-85E1 for a parent's
//  60 MB homeschool math worksheet (2026-10-30). js/vendor/qpdf/lib is now
//  @neslinesli93/qpdf-wasm 0.3.0 (qpdf 12.2, ALLOW_MEMORY_GROWTH): a 60 MB
//  linearized AES-256 restricted file decrypts in 0.7 s. Its factory API
//  (MODULARIZE) needs this worker instead of qpdf-run's; the messages are
//  the same, so js/decryptPdf.js speaks to it unchanged:
//
//    { id, type: 'init', qpdfJsUrl, wasmUrl }            → { id, ok, type: 'ready' }
//    { id, type: 'run', inputs: { name: bytes }, args, outputs: [name] }
//                                                       → { id, ok, outputs, exitCode }
//    failure → { id, ok: false, code, message, exitCode }
//
//  Exit code 3 is qpdf's "succeeded with warnings": the output is there.
//  After an abort the instance is dropped and a new one made — an aborted
//  Emscripten runtime can't be called again; a plain non-zero exit (wrong
//  password) keeps it.
// ============================================================

let factory = null;
let instance = null;

async function load(qpdfJsUrl, wasmUrl) {
  if (!factory) {
    importScripts(qpdfJsUrl);              // defines the global factory `Module`
    factory = self.Module;
  }
  if (!instance) instance = await factory({ noInitialRun: true, locateFile: p => (p.endsWith('.wasm') ? wasmUrl : p) });
  return instance;
}

function failure(code, message, exitCode = null) {
  return Object.assign(new Error(message), { code, exitCode });
}

function run(q, args) {
  try {
    const r = q.callMain(args);
    return Number.isFinite(r) ? r : 0;
  } catch (e) {
    if (Number.isFinite(e?.status)) return e.status;       // Emscripten's ExitStatus
    if (Number.isFinite(e)) return e;
    throw e;                                               // an abort: "Aborted(OOM)" and the like
  }
}

self.onmessage = async (event) => {
  const m = event.data || {};
  if (m.type === 'destroy') { self.close(); return; }
  try {
    const q = await load(m.qpdfJsUrl, m.wasmUrl);
    if (m.type === 'init') { self.postMessage({ id: m.id, ok: true, type: 'ready' }); return; }
    const names = Object.keys(m.inputs || {}), outs = m.outputs || [];
    if (!names.length || !Array.isArray(m.args) || !m.args.length || !outs.length) throw failure('QPDF_INVALID_INPUT', 'qpdf run needs inputs, args and outputs');
    const unlink = n => { try { q.FS.unlink('/' + n); } catch { /* not there */ } };
    [...names, ...outs].forEach(unlink);
    for (const n of names) q.FS.writeFile('/' + n, m.inputs[n] instanceof Uint8Array ? m.inputs[n] : new Uint8Array(m.inputs[n]));
    const exitCode = run(q, m.args.map(a => (names.includes(a) || outs.includes(a) ? '/' + a : a)));
    if (exitCode !== 0 && exitCode !== 3) throw failure('QPDF_EXEC_FAILED', 'qpdf exited with status ' + exitCode, exitCode);
    const outputs = {};
    for (const n of outs) {
      try { outputs[n] = q.FS.readFile('/' + n); } catch { throw failure('QPDF_OUTPUT_MISSING', 'qpdf did not produce ' + n, exitCode); }
    }
    [...names, ...outs].forEach(unlink);
    self.postMessage({ id: m.id, ok: true, outputs, exitCode }, Object.values(outputs).map(b => b.buffer));
  } catch (e) {
    // qpdf exiting non-zero (a wrong password) leaves the instance usable — and
    // a new one from the same factory read every later password as wrong, so
    // only an abort (no exit code: out of memory and the like) starts clean
    if (m.type === 'run' && e?.code === undefined) instance = null;
    self.postMessage({ id: m.id, ok: false, code: e?.code || 'QPDF_EXEC_FAILED', message: String(e?.message || e), exitCode: e?.exitCode ?? null });
  }
};
