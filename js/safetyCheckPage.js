// SPDX-License-Identifier: AGPL-3.0-only
// The PDF safety check page (pdf-safety-check/index.html): choose a PDF, see
// what it can do (pdfSafetyScan + the pages read by pdf.js: links' shown text,
// QR codes), see its pages drawn with scripts off, and download a copy with
// the acting parts taken out (pdfSafetyDisarm), checked again before it is
// offered. Nothing in the file is run; nothing is uploaded.
import { showToast, setProgress, hideProgress } from './ui.js';
import { loadPdfLib } from './lazyLibs.js';
import { loadPdfJs } from './pdfjsLoader.js';
import { scanPdf } from './pdfSafetyScan.js';
import { buildReport } from './pdfSafetyReport.js';
import { disarmPdf } from './pdfSafetyDisarm.js';
import { linkMismatchesOnPages, qrCodesOnPages } from './pdfSafetyPages.js';
import { picturesPdf } from './pdfSafetyPictures.js';

const $ = id => document.getElementById(id);
const PREVIEW_PAGES = 6;
let current = null;   // { file, bytes, scan, pdf } of the file on screen
let run = 0;          // a newer file drops an older one's late results

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LEVEL_WORD = { high: 'Acts', medium: 'Worth a look', low: 'Link', none: 'Nothing found' };

function renderReport(rep, qr) {
  const el = $('safetyReport');
  const groups = rep.groups.map(g => `
    <div class="safety-group">
      <h3>${esc(g.title)}</h3>
      ${g.items.map(i => `
        <div class="safety-item">
          <span class="safety-badge safety-level-${i.level}">${esc(LEVEL_WORD[i.level] ?? i.level)}</span>
          <div class="safety-item-title">${esc(i.title)}${i.count > 1 ? ` <span class="safety-item-where">×${i.count}</span>` : ''}</div>
          <div class="safety-item-where">${esc(i.where ?? '')}</div>
          <div class="safety-item-why">${esc(i.why ?? '')}</div>
          ${i.detail ? `<div class="safety-item-detail">${esc(i.detail)}</div>` : ''}
        </div>`).join('')}
    </div>`).join('');
  const qrHtml = qr.length ? `
    <div class="safety-group">
      <h3>QR codes</h3>
      ${qr.map(c => `
        <div class="safety-item">
          <span class="safety-badge safety-level-${c.flags?.length ? 'medium' : 'low'}">QR</span>
          <div class="safety-item-title">${esc(c.host ?? 'Text in a QR code')}</div>
          <div class="safety-item-where">page ${c.page + 1}</div>
          <div class="safety-item-why">A phone that scans it opens this${c.flags?.length ? ` — it ${esc(c.flags.join(', '))}` : ''}.</div>
          <div class="safety-item-detail">${esc(c.data)}</div>
        </div>`).join('')}
    </div>` : '';
  el.innerHTML = `
    <div class="safety-headline"><span class="safety-badge safety-level-${rep.level}">${esc(LEVEL_WORD[rep.level])}</span>${esc(rep.headline)}</div>
    ${groups}${qrHtml}
    ${rep.notes.length ? `<ul class="safety-notes">${rep.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <p class="safety-limits">${esc(rep.limits)}</p>`;
  el.hidden = false;
}

async function preview(pdf, mine) {
  const box = $('safetyPages');
  box.innerHTML = '';
  $('safetyPreview').hidden = false;
  for (let i = 1; i <= Math.min(pdf.numPages, PREVIEW_PAGES) && mine === run; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 280 / page.getViewport({ scale: 1 }).width });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    c.setAttribute('aria-label', `Page ${i}`);
    box.append(c);
    // annotationMode 0: the pages' own drawing only — no form widgets, no links
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: 0 }).promise;
    page.cleanup();
  }
}

async function check(file) {
  const mine = ++run;
  current = null;
  $('mergeBtn').disabled = true;
  $('successCard').style.display = 'none';
  $('safetyReport').hidden = true;
  $('safetyOptionsPanel').hidden = true;
  $('safetyStatus').textContent = `Checking ${file.name}…`;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await Promise.all([loadPdfLib(), loadPdfJs()]);
    const scan = await scanPdf(bytes, window.PDFLib);
    if (mine !== run) return;
    let pdf = null, mismatches = [], qr = [];
    try {
      pdf = await window.pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, enableScripting: false }).promise;
      $('safetyStatus').textContent = 'Reading the pages: links and QR codes…';
      [mismatches, qr] = await Promise.all([linkMismatchesOnPages(pdf, scan.uris ?? []), qrCodesOnPages(pdf)]);
    } catch (e) {
      // pdf.js couldn't open it (a password, a broken file): the object scan stands alone
      scan.error ??= String(e?.message ?? e).slice(0, 120);
    }
    if (mine !== run) return;
    renderReport(buildReport(scan, { linkMismatches: mismatches }), qr);
    // the report starts at the top of the screen, clear of the sticky button
    // (CLAUDE.md UX rule 8: new content near the bottom of a short phone)
    $('safetyReport').scrollIntoView({ block: 'start', behavior: 'instant' });
    current = { file, bytes, scan, pdf };
    $('safetyStatus').textContent = '';
    if (scan.encrypted && !pdf) {
      showToast('This PDF is encrypted, so it can\'t be cleaned here. Remove the protection first (Unlock PDF), then check it again.', 9000);
    } else {
      // an encrypted file pdf.js can still draw is offered as pictures only
      $('safetyOptionsPanel').hidden = false;
      $('mergeBtn').disabled = !!scan.encrypted;
      $('safetyPicturesBtn').disabled = !pdf;
    }
    if (pdf) await preview(pdf, mine);
  } catch (e) {
    if (mine !== run) return;
    $('safetyStatus').textContent = '';
    showToast(`This file couldn't be read as a PDF (${String(e?.message ?? e).slice(0, 80)}).`, 8000);
  }
}

async function clean() {
  if (!current) { $('fileInput').click(); return; }
  const { file, bytes } = current;
  $('mergeBtn').disabled = true;
  setProgress(30, 'Taking out what acts…');
  try {
    const d = await disarmPdf(bytes, window.PDFLib, { keepLinks: !$('safetyRemoveLinks').checked });
    if (d.status === 'encrypted') { showToast('This PDF is encrypted, so it can\'t be cleaned here.', 8000); return; }
    if (d.status === 'unreadable') {
      showToast(current.pdf
        ? 'This PDF\'s structure couldn\'t be taken apart. "Download as pictures" can still give you a clean copy.'
        : 'This PDF\'s structure couldn\'t be taken apart, so it can\'t be cleaned here. Open it only with care.', 10000);
      return;
    }
    setProgress(80, 'Checking the cleaned copy…');
    const after = await scanPdf(d.bytes, window.PDFLib);
    const left = after.findings.filter(f => f.risk === 'high' || f.risk === 'medium');
    if (left.length) {
      // never hand out a copy the check itself doesn't pass
      showToast(`The cleaned copy still had ${left.length} acting part(s); it was not saved.`, 10000);
      return;
    }
    offer(d.bytes, file.name.replace(/\.pdf$/i, '') + '-cleaned.pdf',
      d.removed.length ? `Cleaned: ${d.removed.length} part(s) taken out` : 'Nothing to take out',
      d.removed.length
        ? `${[...new Set(d.removed.map(r => r.what))].slice(0, 6).join(', ')}. Checked again: nothing acting is left.`
        : 'The copy is the same document, rewritten; checked again: nothing acting.');
  } catch (e) {
    showToast(`Cleaning failed: ${String(e?.message ?? e).slice(0, 100)}`, 8000);
  } finally {
    hideProgress();
    $('mergeBtn').disabled = false;
  }
}

function offer(bytes, name, title, desc) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  $('successTitle').textContent = title;
  $('successDesc').textContent = desc;
  const dl = $('downloadBtn');
  dl.style.display = '';
  dl.onclick = () => { const a = Object.assign(document.createElement('a'), { href: url, download: name }); a.click(); };
  $('successCard').style.display = '';
  dl.click();
}

async function pictures() {
  if (!current?.pdf) return;
  const { file, pdf } = current;
  const mine = run;
  $('safetyPicturesBtn').disabled = $('mergeBtn').disabled = true;
  try {
    setProgress(2, 'Redrawing the pages…');
    const bytes = await picturesPdf(pdf, window.PDFLib, {
      onPage: (i, n) => setProgress(Math.round(95 * i / n), `Page ${i} of ${n}…`),
      isCancelled: () => mine !== run,
    });
    if (!bytes) return;   // another file was chosen meanwhile
    const after = await scanPdf(bytes, window.PDFLib);
    if (after.findings.some(f => f.risk === 'high' || f.risk === 'medium')) {
      showToast('The picture copy didn\'t pass the check; it was not saved.', 10000);
      return;
    }
    offer(bytes, file.name.replace(/\.pdf$/i, '') + '-pictures.pdf', `${pdf.numPages} page(s) redrawn as pictures`,
      'Nothing of the original file is kept. Checked again: nothing acting. The text is now part of the pictures.');
  } catch (e) {
    showToast(`Redrawing failed: ${String(e?.message ?? e).slice(0, 100)}`, 8000);
  } finally {
    hideProgress();
    $('safetyPicturesBtn').disabled = false;
    $('mergeBtn').disabled = !!current?.scan?.encrypted;
  }
}

function pick(files) {
  const f = [...files].find(x => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
  if (!f) { showToast('Choose a PDF file.'); return; }
  check(f);
}

const zone = $('dropZone');
$('fileInput').addEventListener('change', e => { if (e.target.files.length) pick(e.target.files); e.target.value = ''; });
zone.addEventListener('click', e => { if (e.target === zone) $('fileInput').click(); });
zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer?.files?.length) pick(e.dataTransfer.files); });
// the button before a file: open the picker (UX rule 5 — never a dead click)
$('mergeBtn').disabled = false;
$('mergeBtn').addEventListener('click', clean);
$('safetyPicturesBtn').addEventListener('click', pictures);
