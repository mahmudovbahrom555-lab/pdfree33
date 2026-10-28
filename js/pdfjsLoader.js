// SPDX-License-Identifier: AGPL-3.0-only
// pdf.js for the whole site: one pinned version from cdnjs with Subresource
// Integrity, its worker through pdfWorkerShim.js, Adobe's CMaps from
// js/vendor/. Moved out of pdf2jpgUI.js (2026-10-28) so a page can load pdf.js
// without that tool's own modules (the PDF safety check page loads nothing
// it doesn't need); pdf2jpgUI.js still exports it as loadPdfJs.

const PDFJS_VERSION     = '3.11.174';
const PDFJS_CDN         = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
// Subresource Integrity — pdf.js is loaded from a third-party CDN (cdnjs) on
// nearly every tool page; CSP's script-src allowlists the domain, but that
// only pins WHERE the script may come from, not WHAT it may contain — a
// compromised CDN could still serve arbitrary JS with full access to
// whatever PDF a user is processing at that moment. SRI pins the exact
// bytes. Hash computed directly against the pinned PDFJS_VERSION above
// (sha384, matches the actual file served at this exact URL — verified via
// curl before adding, not copied from an unverified source).
const PDFJS_SRI         = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
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
    await _loadScript(`${PDFJS_CDN}/pdf.min.js`, PDFJS_SRI);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      new URL('./pdfWorkerShim.js', import.meta.url).toString();
    // Adobe's predefined CMaps, for every getDocument() on the site: without
    // them pdf.js reads no text from a CJK font a PDF names without embedding
    // it (UniGB-UCS2-H, 90ms-RKSJ-H, …) or from one in an Adobe character
    // collection without ToUnicode — 8 of 128 Chinese corpus documents came
    // out with their Chinese missing or an empty .docx (2026-10-23).
    // pdf.js has no global option for this, and its exports are getters that
    // can't be reassigned: window.pdfjsLib becomes the library itself (its
    // prototype) with a getDocument that adds the default.
    const lib = window.pdfjsLib;
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

function _loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    document.querySelector(`script[src="${src}"]`)?.remove();
    const s = document.createElement('script');
    s.src     = src;
    if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
    s.onload  = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export { _ensurePdfJs as loadPdfJs };
