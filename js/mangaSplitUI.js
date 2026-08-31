// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ============================================================
//  mangaSplitUI.js — Split Manga Pages tool UI
//
//  Thin, intentionally simple UI: a thumbnail grid (reusing rotateUI.js's
//  lazy-render pattern — IntersectionObserver, MAX_RENDERS queue, shared
//  pdf.js loader) where clicking a page marks it "don't split" (covers,
//  single pages mixed into an otherwise all-spreads scan), plus one RTL
//  toggle (manga/manhwa reads right-to-left, default on).
//
//  No undo/quick-select/per-page rotation like rotateUI/organizeUI —
//  deliberately out of scope for this thin MVP (see the plan: "maximally
//  simple", real usage is the signal being measured, not feature breadth).
//
//  Also owns the short post-use Mom-Test-style survey (renderMangaSurvey,
//  wired via toolRegistrations.js's onSuccess), since it only makes sense
//  in the context of this one tool — not a generalized survey system.
// ============================================================

import { id, esc } from './utils.js';
import { showToast } from './ui.js';
import { loadingRow, infoBanner, checkbox } from './uiComponents.js';
import { loadPdfJs } from './pdf2jpgUI.js';  // reuse CDN loader with retry logic
import { loadPdfLib } from './lazyLibs.js';
import { t, tp } from './i18n.js';
import { trackMangaSurveyAnswer } from './analytics.js';

// ── Constants ─────────────────────────────────────────────────

const _LARGE_DOC_WARN_THRESHOLD = 150; // soft heads-up only, same threshold as rotateUI
const MAX_RENDERS = 3; // concurrent lazy thumb renders, mirrors rotateUI/pdf2jpgUI

// ── State ──────────────────────────────────────────────────────

let _pageCount    = 0;
let _skipped      = new Set(); // Set<index> — pages marked "don't split"
let _rtl          = true;      // manga/manhwa default: right page first
let _thumbnailURLs = [];       // [string | null] — objectURLs, null = not rendered yet
let _useThumbs    = false;
let _pdfJsDoc     = null;
let _observer     = null;
let _renderQueue  = [];
let _activeRenders = 0;

// ── Public API ─────────────────────────────────────────────────

export function getMangaSplitParams() {
  return { rtl: _rtl, skipPages: [..._skipped] };
}

export async function initMangaSplitOptions(file) {
  const container = id('mangaSplitOptions');
  if (!container) return;

  container.innerHTML = loadingRow(t('ms_loading'));
  container.style.display = 'block';

  try {
    await loadPdfLib();
    const { PDFDocument } = window.PDFLib;
    const buf = await file.arrayBuffer();
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });

    _pageCount = doc.getPageCount();
    if (_pageCount === 0) { showToast(t('no_pages_pdf')); _hide(container); return; }

    _skipped = new Set();
    _rtl = true;
    _thumbnailURLs = new Array(_pageCount).fill(null);

    _useThumbs = true;
    try {
      await _initPdfJsDoc(buf);
    } catch (thumbErr) {
      _useThumbs = false;
      _pdfJsDoc  = null;
      console.warn('[mangaSplitUI] pdf.js unavailable, using numbered cards:', thumbErr.message);
    }

    if (_pageCount > _LARGE_DOC_WARN_THRESHOLD) {
      showToast(t('warn_many_pages', { n: _pageCount }), 7000);
    }

    _render(file);

  } catch (err) {
    showToast(t('ms_err_load', { msg: err.message }), 5000);
    _hide(container);
  }
}

export function hideMangaSplitOptions() {
  _cleanup();
  const container = id('mangaSplitOptions');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
  _pageCount = 0;
  _skipped   = new Set();
  _rtl       = true;
  _useThumbs = false;
  clearMangaSurvey();
}

// ── Thumbnail rendering (lazy — mirrors rotateUI.js's pattern) ─────────

async function _initPdfJsDoc(buf) {
  await loadPdfJs();
  _pdfJsDoc = await window.pdfjsLib.getDocument({
    data:          new Uint8Array(buf.slice(0)),
    disableWorker: true,
  }).promise;
}

function _setupLazyThumbs() {
  _observer?.disconnect();
  if (!_useThumbs || !_pdfJsDoc) return;

  _observer = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) {
        _observer.unobserve(e.target);
        _enqueueThumb(parseInt(e.target.dataset.idx, 10));
      }
    }
  }, { rootMargin: '300px' });

  id('msGrid')?.querySelectorAll('[data-idx]').forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    if (!_thumbnailURLs[idx]) _observer.observe(el);
  });
}

function _enqueueThumb(idx) {
  if (_thumbnailURLs[idx] || _renderQueue.includes(idx)) return;
  _renderQueue.push(idx);
  _drainThumbs();
}

function _drainThumbs() {
  while (_activeRenders < MAX_RENDERS && _renderQueue.length > 0) {
    const idx = _renderQueue.shift();
    if (_thumbnailURLs[idx]) continue;
    _activeRenders++;
    _renderThumb(idx).finally(() => { _activeRenders--; _drainThumbs(); });
  }
}

async function _renderThumb(idx) {
  if (!_pdfJsDoc || _thumbnailURLs[idx]) return;
  try {
    const page     = await _pdfJsDoc.getPage(idx + 1);
    const viewport = page.getViewport({ scale: 0.4 });

    const canvas  = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.72));
    _thumbnailURLs[idx] = URL.createObjectURL(blob);
    page.cleanup?.();
    _updateCard(idx);
  } catch { /* leave placeholder — cosmetic only, split still works */ }
}

// ── Main render ────────────────────────────────────────────────

function _render(file) {
  const container = id('mangaSplitOptions');
  if (!container) return;

  container.innerHTML = `
    <div class="compress-info">
      <span class="compress-info__name" title="${esc(file.name)}">${esc(_truncName(file.name))}</span>
      <span class="compress-info__dot">·</span>
      <span class="compress-info__meta">${tp(_pageCount, 'split_info_page', 'split_info_pages', { n: _pageCount })}</span>
    </div>

    <div class="ms-rtl-row">
      ${checkbox({ id: 'msRtlToggle', checked: _rtl, title: t('ms_rtl_title'), subtitle: t('ms_rtl_subtitle') })}
    </div>

    <div class="rot-hint" id="msHint" aria-live="polite">${t('ms_hint')}</div>

    <div class="rot-grid ${_useThumbs ? 'rot-grid--thumbs' : 'rot-grid--numbers'}"
         id="msGrid" role="list" aria-label="${t('ms_grid_aria')}">
      ${_renderGrid()}
    </div>

    ${infoBanner(t('ms_banner'), 'info')}
  `;

  _bindEvents();
  _setupLazyThumbs();
}

function _renderGrid() {
  const cards = [];
  for (let i = 0; i < _pageCount; i++) cards.push(_cardHTML(i));
  return cards.join('');
}

function _cardHTML(i) {
  const skipped  = _skipped.has(i);
  const skClass  = skipped ? ' ms-card--skipped' : '';
  const ariaLabel = t('ms_page_aria', { n: i + 1 }) + (skipped ? t('ms_skipped_suffix') : '');
  const badgeHTML = skipped
    ? `<span class="rot-badge ms-badge" aria-hidden="true" title="${esc(t('ms_restore_title'))}">⊘</span>`
    : '';

  if (_useThumbs) {
    const url = _thumbnailURLs[i];
    const thumbInner = url
      ? `<img src="${esc(url)}" alt="${t('ms_page_alt', { n: i + 1 })}" loading="lazy">`
      : '';
    return `
      <div class="rot-card${skClass}" data-idx="${i}"
           role="listitem button" tabindex="0"
           aria-label="${esc(ariaLabel)}" title="${esc(skipped ? t('ms_restore_title') : t('ms_skip_title'))}">
        <div class="rot-thumb">
          ${thumbInner}
          ${badgeHTML}
        </div>
        <span class="rot-card__num">${i + 1}</span>
      </div>`;
  } else {
    return `
      <div class="rot-card rot-card--num${skClass}" data-idx="${i}"
           role="listitem button" tabindex="0"
           aria-label="${esc(ariaLabel)}" title="${esc(skipped ? t('ms_restore_title') : t('ms_skip_title'))}">
        <div class="rot-numbox">
          <span class="rot-numbox__n">${i + 1}</span>
          ${badgeHTML}
        </div>
        <span class="rot-card__num">${i + 1}</span>
      </div>`;
  }
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
  id('msRtlToggle')?.addEventListener('change', e => { _rtl = e.target.checked; });

  id('msGrid')?.addEventListener('click', e => {
    const card = e.target.closest('[data-idx]');
    if (!card) return;
    const idx = parseInt(card.dataset.idx, 10);
    if (_skipped.has(idx)) _skipped.delete(idx);
    else                    _skipped.add(idx);
    _updateCard(idx);
  });

  id('msGrid')?.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') {
      const card = e.target.closest('[data-idx]');
      if (!card) return;
      e.preventDefault();
      card.click();
    }
  });
}

function _updateCard(idx) {
  const grid = id('msGrid');
  if (!grid) return;
  const card = grid.querySelector(`[data-idx="${idx}"]`);
  if (!card) return;
  card.outerHTML = _cardHTML(idx);
  if (_useThumbs && !_thumbnailURLs[idx] && _observer) {
    const freshCard = grid.querySelector(`[data-idx="${idx}"]`);
    if (freshCard) _observer.observe(freshCard);
  }
}

// ── Cleanup ────────────────────────────────────────────────────

function _cleanup() {
  _observer?.disconnect();
  _observer      = null;
  _renderQueue   = [];
  _activeRenders = 0;
  _pdfJsDoc      = null;

  for (const url of _thumbnailURLs) {
    if (url) URL.revokeObjectURL(url);
  }
  _thumbnailURLs = [];
}

function _hide(container) {
  container.style.display = 'none';
  container.innerHTML = '';
}

function _truncName(name) {
  return name.length > 35 ? name.slice(0, 32) + '…' : name;
}

// ── Post-use survey ──────────────────────────────────────────────
// Mom-Test-style, not "would you want more features" — what the user
// actually did. Skippable at every step. Reuses the existing generic
// analytics pipeline (trackMangaSurveyAnswer → _track → /api/analytics),
// no new endpoint or backend change needed.

export function renderMangaSurvey() {
  const el = id('mangaSurvey');
  if (!el) return;
  el.style.display = '';
  el.innerHTML = _surveyStep1Html();
  _bindSurveyStep1();
}

export function clearMangaSurvey() {
  const el = id('mangaSurvey');
  if (!el) return;
  el.innerHTML    = '';
  el.style.display = 'none';
}

function _surveyStep1Html() {
  return `
    <div class="ms-survey">
      <div class="ms-survey__title">${t('ms_survey_title')}</div>

      <div class="ms-survey__q">
        <span class="ms-survey__label">${t('ms_survey_why')}</span>
        <div class="j2p-chips" role="radiogroup" aria-label="${esc(t('ms_survey_why'))}">
          <label class="j2p-chip"><input type="radio" name="msWhy" value="print"> ${t('ms_survey_why_print')}</label>
          <label class="j2p-chip"><input type="radio" name="msWhy" value="device"> ${t('ms_survey_why_device')}</label>
          <label class="j2p-chip"><input type="radio" name="msWhy" value="other"> ${t('ms_survey_why_other')}</label>
        </div>
      </div>

      <div class="ms-survey__q">
        <label class="ms-survey__label" for="msAnnoying">${t('ms_survey_annoying')}</label>
        <input type="text" id="msAnnoying" class="ms-survey__input" maxlength="200">
      </div>

      <div class="ms-survey__q">
        <label class="ms-survey__label" for="msBefore">${t('ms_survey_before')}</label>
        <input type="text" id="msBefore" class="ms-survey__input" maxlength="200">
      </div>

      <div class="ms-survey__actions">
        <button type="button" class="split-action-btn" id="msSurveySkip">${t('ms_survey_skip')}</button>
        <button type="button" class="split-action-btn ms-survey__submit" id="msSurveySubmit">${t('ms_survey_submit')}</button>
      </div>
    </div>`;
}

function _bindSurveyStep1() {
  id('msSurveySkip')?.addEventListener('click', () => clearMangaSurvey());
  id('msSurveySubmit')?.addEventListener('click', () => {
    const why      = document.querySelector('input[name="msWhy"]:checked')?.value || '';
    const annoying = id('msAnnoying')?.value.trim() || '';
    const before   = id('msBefore')?.value.trim() || '';
    if (why)      trackMangaSurveyAnswer('why', why);
    if (annoying) trackMangaSurveyAnswer('annoying', annoying.slice(0, 200));
    if (before)   trackMangaSurveyAnswer('before', before.slice(0, 200));
    _renderSurveyStep2();
  });
}

function _renderSurveyStep2() {
  const el = id('mangaSurvey');
  if (!el) return;
  el.innerHTML = `
    <div class="ms-survey">
      <div class="ms-survey__q">
        <span class="ms-survey__label">${t('ms_survey_pay_q')}</span>
        <div class="ms-survey__actions">
          <button type="button" class="split-action-btn" data-pay="yes">${t('ms_survey_pay_yes')}</button>
          <button type="button" class="split-action-btn" data-pay="no">${t('ms_survey_pay_no')}</button>
          <button type="button" class="split-action-btn" data-pay="maybe">${t('ms_survey_pay_maybe')}</button>
        </div>
      </div>
    </div>`;
  el.querySelectorAll('[data-pay]').forEach(btn => {
    btn.addEventListener('click', () => {
      trackMangaSurveyAnswer('pay', btn.dataset.pay);
      _renderSurveyThanks();
    });
  });
}

function _renderSurveyThanks() {
  const el = id('mangaSurvey');
  if (!el) return;
  el.innerHTML = `<div class="ms-survey ms-survey--thanks">${t('ms_survey_thanks')}</div>`;
  setTimeout(() => clearMangaSurvey(), 2500);
}
