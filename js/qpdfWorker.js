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
//  A failure says which kind it is (C33, 2026-11-06):
//    QPDF_WRONG_PASSWORD — qpdf exited 2 and said "invalid password";
//    QPDF_EXEC_FAILED    — any other non-zero exit (a damaged file…);
//    QPDF_ABORTED        — the runtime aborted (out of memory, a broken state)
//                          on a clean instance too: the message keeps qpdf's.
//  An aborted Emscripten runtime can't be called again, so after an abort a
//  new instance is made from the URLs 'init' gave (the 'run' messages carry
//  none — the instance used to be rebuilt from undefined URLs and every later
//  run in the tab failed) and the run is tried once more on it.
//  Each run leaves the virtual file system as it found it: its files removed
//  and the files qpdf left open closed — a wrong-password exit leaves its
//  input open, and ~320 of them made the runtime abort (run 477 of 800 with
//  2 in 3 passwords wrong, Chromium, 2026-11-06).
// ============================================================

let factory = null;
let instance = null;
let urls = null;        // { qpdfJsUrl, wasmUrl } from 'init' — kept to rebuild the instance
let stderr = [];        // qpdf's messages during the current run

async function load() {
  if (!urls) throw failure('QPDF_NOT_INITIALISED', 'qpdf worker got a run before init');
  if (!factory) {
    importScripts(urls.qpdfJsUrl);         // defines the global factory `Module`
    factory = self.Module;
  }
  if (!instance) {
    // This build ignores the print/printErr options: each instance binds
    // console.error when it is made, so qpdf's messages are caught by
    // swapping console.error for that moment (still shown in the console).
    // qpdf 12.2's --requires-password answers 2 for a wrong password here,
    // like a damaged file — the message is the one signal that tells them apart.
    const consoleError = console.error;
    console.error = (...a) => { stderr.push(a.map(String).join(' ')); consoleError.apply(console, a); };
    try {
      instance = await factory({ noInitialRun: true, locateFile: p => (p.endsWith('.wasm') ? urls.wasmUrl : p) });
    } finally {
      console.error = consoleError;
    }
  }
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

// Remove this run's files and close what qpdf left open (fd 0–2 are the
// standard streams).
function cleanUp(q, names) {
  for (const n of names) { try { q.FS.unlink('/' + n); } catch { /* not there */ } }
  try {
    for (const st of q.FS.streams) if (st && st.fd > 2) { try { q.FS.close(st); } catch { /* already closed */ } }
  } catch { /* an aborted runtime: dropped anyway */ }
}

// One qpdf run on instance `q` → { outputs, exitCode }, or throws a failure.
function runOnce(q, m) {
  const names = Object.keys(m.inputs), outs = m.outputs;
  cleanUp(q, [...names, ...outs]);
  stderr = [];
  try {
    for (const n of names) q.FS.writeFile('/' + n, m.inputs[n] instanceof Uint8Array ? m.inputs[n] : new Uint8Array(m.inputs[n]));
    const exitCode = run(q, m.args.map(a => (names.includes(a) || outs.includes(a) ? '/' + a : a)));
    if (exitCode === 2 && stderr.some(l => /: invalid password$/.test(l))) throw failure('QPDF_WRONG_PASSWORD', 'invalid password', exitCode);
    if (exitCode !== 0 && exitCode !== 3) throw failure('QPDF_EXEC_FAILED', `qpdf exited with status ${exitCode}: ${stderr.slice(-1).join('')}`.trim(), exitCode);
    const outputs = {};
    for (const n of outs) {
      try { outputs[n] = q.FS.readFile('/' + n); } catch { throw failure('QPDF_OUTPUT_MISSING', 'qpdf did not produce ' + n, exitCode); }
    }
    return { outputs, exitCode };
  } finally {
    cleanUp(q, [...names, ...outs]);
  }
}

self.onmessage = async (event) => {
  const m = event.data || {};
  if (m.type === 'destroy') { self.close(); return; }
  try {
    if (m.qpdfJsUrl && m.wasmUrl) urls = { qpdfJsUrl: m.qpdfJsUrl, wasmUrl: m.wasmUrl };
    if (m.type === 'init') { await load(); self.postMessage({ id: m.id, ok: true, type: 'ready' }); return; }
    if (!m.inputs || !Object.keys(m.inputs).length || !Array.isArray(m.args) || !m.args.length || !m.outputs?.length) {
      throw failure('QPDF_INVALID_INPUT', 'qpdf run needs inputs, args and outputs');
    }
    let result;
    try {
      result = runOnce(await load(), m);
    } catch (e) {
      if (e?.code !== undefined) throw e;                  // qpdf's own verdict on this file
      instance = null;                                     // aborted: once more on a clean instance
      try {
        result = runOnce(await load(), m);
      } catch (e2) {
        if (e2?.code !== undefined) throw e2;
        instance = null;
        throw failure('QPDF_ABORTED', String(e2?.message || e2));
      }
    }
    const { outputs, exitCode } = result;
    self.postMessage({ id: m.id, ok: true, outputs, exitCode }, Object.values(outputs).map(b => b.buffer));
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, code: e?.code || 'QPDF_ABORTED', message: String(e?.message || e), exitCode: e?.exitCode ?? null });
  }
};
