// SPDX-License-Identifier: AGPL-3.0-only
// pdf.js for the whole site: one pinned version, served from this site
// (js/vendor/pdfjs-4.10.38/ — pdf.js 4.10.38's legacy build, verified against
// the npm registry, see js/vendor/SOURCE.txt), its worker through
// pdfWorkerModule.js, Adobe's CMaps from js/vendor/pdfjs-cmaps/.
// A versioned folder, not the old file names: js/vendor/ is cached for an
// hour (browser and edge), and a returning visitor could otherwise pair this
// loader with a cached 3.11 worker, or the reverse — pdf.js then refuses to
// start. pdfWorkerShim.js + vendor/pdf.worker.min.js (3.11) stay until every
// cache holding the previous loader has expired, then go in a cleanup change.
// 3.11.174 from cdnjs before (2026-10-28): CVE-2024-4367 / GHSA-wgrm-67xf-hhpq
// (script run from a crafted font) is fixed in 4.2.67; it was held off until
// then by isEvalSupported: false on every rendering call. pdf.js 4 ships ES
// modules only — imported here, no <script>, so no SRI is needed for a file
// this site serves itself. The last 4.x, not 5.x: a smaller step for the code
// that reads getOperatorList's drawing (pdf2wordBorders.js, pdf2mdCore.js…).
// pdf2jpgUI.js still exports it as loadPdfJs.
import './atPolyfill.js';

let   _pdfJsLoading     = null;
const PDFJS_MAX_RETRIES = 2;

async function _ensurePdfJs() {
  if (window.pdfjsLib) return;
  if (_pdfJsLoading) { await _pdfJsLoading; return; }
  _pdfJsLoading = _loadWithRetry(PDFJS_MAX_RETRIES);
  try { await _pdfJsLoading; } finally { _pdfJsLoading = null; }
}

async function _loadWithRetry(retriesLeft) {
  try {
    const lib = await import('./vendor/pdfjs-4.10.38/pdf.min.js');
    // a module worker (pdf.js 4 starts it with { type: 'module' })
    lib.GlobalWorkerOptions.workerSrc = new URL('./pdfWorkerModule.js', import.meta.url).toString();
    // Adobe's predefined CMaps, for every getDocument() on the site: without
    // them pdf.js reads no text from a CJK font a PDF names without embedding
    // it (UniGB-UCS2-H, 90ms-RKSJ-H, …) or from one in an Adobe character
    // collection without ToUnicode — 8 of 128 Chinese corpus documents came
    // out with their Chinese missing or an empty .docx (2026-10-23).
    // pdf.js has no global option for this, and a module's exports can't be
    // reassigned: window.pdfjsLib is the library (its prototype) with a
    // getDocument that adds the default.
    const cMapUrl = new URL('./vendor/pdfjs-cmaps/', import.meta.url).toString();
    window.pdfjsLib = Object.create(lib, {
      getDocument: { value: src => lib.getDocument({ cMapUrl, cMapPacked: true, ...src }) },
    });
  } catch (err) {
    if (retriesLeft > 0) {
      await new Promise(r => setTimeout(r, 1000 * (PDFJS_MAX_RETRIES - retriesLeft + 1)));
      return _loadWithRetry(retriesLeft - 1);
    }
    throw err;
  }
}

export { _ensurePdfJs as loadPdfJs };
