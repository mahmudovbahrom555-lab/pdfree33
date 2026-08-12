// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  feedback.js — Lightweight, personal feedback modal
//
//  Handles [data-open-feedback] buttons (🐛 Found a bug, 💡 Have an idea,
//  👍 All good!) on the success card, the 💬 Feedback button in the footer,
//  and the "tap to report" prompt processor.js's _handleError() wires up
//  on a failed tool run.
//
//  The modal is injected once on first open and reused.
//  Submissions POST to /api/feedback (same-origin Cloudflare Worker route),
//  which relays them to Telegram — no database, nothing stored on our side.
//  A lightweight aggregate event also goes to Plausible for trend counts
//  (type only, never the message text).
//  Email is optional and only used if the user wants a reply.
//
//  Copy is intentionally personal (real name, "I read this myself") rather
//  than corporate "Feedback" language — the goal is to lower the barrier
//  to writing, not just collect submissions. See the fb_* keys in i18n.js.
// ============================================================

import { t } from './i18n.js';

const MODAL_ID = 'fbModal';

const _TYPE_TITLE_KEYS       = { bug: 'fb_title_bug',       idea: 'fb_title_idea',       other: 'fb_title_other',       error: 'fb_title_error' };
const _TYPE_PLACEHOLDER_KEYS = { bug: 'fb_placeholder_bug', idea: 'fb_placeholder_idea', other: 'fb_placeholder_other', error: 'fb_placeholder_error' };

let _context          = { tool: 'unknown', message: '' };
let _screenshotDataUrl = '';

// ── Device / browser detection (bug reports only, opt-out via checkbox) ─
// A short "OS · Browser" string, not the raw User-Agent — enough to
// reproduce a bug, without the extra fingerprinting surface of a full UA.
function _detectDevice() {
  const ua = navigator.userAgent || '';

  let os = 'Unknown OS';
  if      (/Windows NT/.test(ua))        os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(ua))  os = 'iOS';
  else if (/Mac OS X/.test(ua))          os = 'macOS';
  else if (/Android/.test(ua))           os = 'Android';
  else if (/Linux/.test(ua))             os = 'Linux';

  let browser = 'Unknown browser', m;
  if      ((m = ua.match(/Edg\/([\d.]+)/)))              browser = `Edge ${m[1].split('.')[0]}`;
  else if ((m = ua.match(/OPR\/([\d.]+)/)))               browser = `Opera ${m[1].split('.')[0]}`;
  else if ((m = ua.match(/Chrome\/([\d.]+)/)))            browser = `Chrome ${m[1].split('.')[0]}`;
  else if ((m = ua.match(/Firefox\/([\d.]+)/)))           browser = `Firefox ${m[1].split('.')[0]}`;
  else if ((m = ua.match(/Version\/([\d.]+).*Safari/)))  browser = `Safari ${m[1].split('.')[0]}`;

  return `${os} · ${browser}`;
}

// ── Screenshot attach: read → downscale → JPEG data URL ─────────────────
// Capped at 1280px / quality 0.75 so a phone photo-sized screenshot stays
// well under Telegram's sendPhoto limit and doesn't bloat the request.
const _SCREENSHOT_MAX_SRC_BYTES = 15 * 1024 * 1024;
const _SCREENSHOT_MAX_DIM       = 1280;

function _readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader   = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function _loadImage(src) {
  return new Promise((resolve, reject) => {
    const img    = new Image();
    img.onload   = () => resolve(img);
    img.onerror  = () => reject(new Error('image decode failed'));
    img.src      = src;
  });
}

async function _processScreenshotFile(file) {
  if (!file.type.startsWith('image/')) return { error: 'invalid' };
  if (file.size > _SCREENSHOT_MAX_SRC_BYTES) return { error: 'too_large' };

  const rawDataUrl = await _readFileAsDataUrl(file);
  const img        = await _loadImage(rawDataUrl);

  const scale = Math.min(1, _SCREENSHOT_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth  * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);

  return { dataUrl: canvas.toDataURL('image/jpeg', 0.75) };
}

function _resetScreenshot(modal) {
  _screenshotDataUrl = '';
  const input   = modal.querySelector('#fbModalScreenshotInput');
  const preview = modal.querySelector('#fbModalScreenshotPreview');
  const errorEl = modal.querySelector('#fbModalScreenshotError');
  const attach  = modal.querySelector('#fbModalAttachBtn');
  if (input)   input.value          = '';
  if (preview) preview.style.display = 'none';
  if (errorEl) errorEl.style.display = 'none';
  if (attach)  attach.style.display  = '';
}

// ── Modal lifecycle ───────────────────────────────────────────

function _getOrCreateModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id        = MODAL_ID;
  modal.className = 'fb-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Send feedback');
  modal.innerHTML = `
    <div class="fb-modal__card">
      <button type="button" class="fb-modal__close" aria-label="Close">✕</button>
      <p class="fb-modal__title" id="fbModalTitle">Feedback</p>
      <p class="fb-modal__intro" id="fbModalIntro">${t('fb_intro')}</p>
      <p class="fb-modal__context" id="fbModalContext" style="display:none"></p>
      <textarea class="fb-modal__textarea" id="fbModalText"
                placeholder="" maxlength="1000" rows="4"></textarea>
      <input class="fb-modal__email" id="fbModalEmail" type="email"
             placeholder="${t('fb_email_placeholder')}" maxlength="200" autocomplete="email">
      <!-- Honeypot — hidden from real users via CSS, bots that fill every field trip it -->
      <input class="fb-modal__hp" id="fbModalHp" type="text" name="website" tabindex="-1"
             autocomplete="off" aria-hidden="true">
      <label class="fb-modal__checkbox" id="fbModalDeviceRow" style="display:none">
        <input type="checkbox" id="fbModalDeviceInfo" checked>
        <span>${t('fb_device_info')}</span>
      </label>
      <div class="fb-modal__screenshot" id="fbModalScreenshotRow" style="display:none">
        <input class="fb-modal__file-input" id="fbModalScreenshotInput" type="file" accept="image/*" tabindex="-1">
        <button type="button" class="fb-modal__attach" id="fbModalAttachBtn">${t('fb_attach_screenshot')}</button>
        <div class="fb-modal__screenshot-preview" id="fbModalScreenshotPreview" style="display:none">
          <img id="fbModalScreenshotImg" alt="">
          <button type="button" class="fb-modal__screenshot-remove" id="fbModalScreenshotRemove"
                  aria-label="${t('fb_screenshot_remove')}" title="${t('fb_screenshot_remove')}">✕</button>
        </div>
        <p class="fb-modal__screenshot-hint">${t('fb_screenshot_hint')}</p>
        <p class="fb-modal__screenshot-error" id="fbModalScreenshotError" style="display:none">${t('fb_screenshot_too_large')}</p>
      </div>
      <div class="fb-modal__actions">
        <button type="button" class="fb-modal__send" id="fbModalSend">${t('fb_send')}</button>
      </div>
      <p class="fb-modal__thanks" id="fbModalThanks" style="display:none">
        ${t('fb_thanks')}
      </p>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

/**
 * @param {string} type 'bug' | 'idea' | 'other' | 'error'
 * @param {{tool?: string, message?: string, errorId?: string}} [context] —
 *   tool key + (for type='error') the error message and a stable error
 *   code, both shown as read-only context, not something the user has to
 *   retype.
 */
export function openFeedback(type = 'other', context = {}) {
  const modal           = _getOrCreateModal();
  const title           = modal.querySelector('#fbModalTitle');
  const ctxEl           = modal.querySelector('#fbModalContext');
  const text            = modal.querySelector('#fbModalText');
  const email           = modal.querySelector('#fbModalEmail');
  const hp              = modal.querySelector('#fbModalHp');
  const thanks          = modal.querySelector('#fbModalThanks');
  const send            = modal.querySelector('#fbModalSend');
  const deviceRow       = modal.querySelector('#fbModalDeviceRow');
  const deviceCheckbox  = modal.querySelector('#fbModalDeviceInfo');
  const screenshotRow   = modal.querySelector('#fbModalScreenshotRow');

  _context = {
    tool:    context.tool || document.body.dataset.tool || 'unknown',
    message: context.message || '',
    errorId: context.errorId || '',
  };

  title.textContent = t(_TYPE_TITLE_KEYS[type] || _TYPE_TITLE_KEYS.other);
  text.placeholder  = t(_TYPE_PLACEHOLDER_KEYS[type] || _TYPE_PLACEHOLDER_KEYS.other);
  text.value        = '';
  email.value       = '';
  hp.value          = '';

  if (type === 'error' && _context.message) {
    ctxEl.textContent   = _context.errorId
      ? `"${_context.message}" · ${t('error_id_label', { id: _context.errorId })}`
      : `"${_context.message}"`;
    ctxEl.style.display = '';
  } else {
    ctxEl.style.display = 'none';
  }

  // Device/browser auto-detect: bug reports only — that's where "what
  // browser/OS is this" actually helps reproduce something. Off by
  // default visibility, on by default when shown (user can uncheck).
  deviceRow.style.display = (type === 'bug') ? '' : 'none';
  if (deviceCheckbox) deviceCheckbox.checked = true;

  // Screenshot attach: bug + error reports, where a picture of what went
  // wrong is the fastest way to explain it.
  screenshotRow.style.display = (type === 'bug' || type === 'error') ? '' : 'none';
  _resetScreenshot(modal);

  thanks.style.display = 'none';
  send.style.display   = '';
  send.disabled         = false;

  modal.dataset.fbType = type;
  modal.style.display  = 'flex';
  requestAnimationFrame(() => modal.classList.add('fb-modal--open'));
  setTimeout(() => text.focus(), 80);
}

function _closeFeedback() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.remove('fb-modal--open');
  // Hide after CSS transition finishes
  modal.addEventListener('transitionend', () => {
    if (!modal.classList.contains('fb-modal--open')) modal.style.display = 'none';
  }, { once: true });
}

async function _sendFeedback(modal) {
  const type  = modal.dataset.fbType || 'other';
  const text  = modal.querySelector('#fbModalText')?.value?.trim()  || '';
  const email = modal.querySelector('#fbModalEmail')?.value?.trim() || '';
  const hp    = modal.querySelector('#fbModalHp')?.value            || '';
  const send  = modal.querySelector('#fbModalSend');

  const deviceRow      = modal.querySelector('#fbModalDeviceRow');
  const deviceCheckbox = modal.querySelector('#fbModalDeviceInfo');
  const includeDevice  = deviceRow?.style.display !== 'none' && !!deviceCheckbox?.checked;
  const device         = includeDevice ? _detectDevice() : '';

  // Require at least 3 chars for bug/idea/error reports; allow empty for "All good"
  if (type !== 'other' && text.length < 3) {
    const ta = modal.querySelector('#fbModalText');
    ta?.focus();
    ta?.classList.add('fb-modal__textarea--error');
    setTimeout(() => ta?.classList.remove('fb-modal__textarea--error'), 600);
    return;
  }

  if (send) send.disabled = true;

  try {
    if (typeof window.plausible === 'function') {
      window.plausible('Feedback', { props: { type, tool: _context.tool } });
    }
  } catch { /* never fail */ }

  try {
    await fetch('/api/feedback', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type, text, email, hp, device,
        tool:       _context.tool,
        message:    _context.message,
        errorId:    _context.errorId,
        screenshot: _screenshotDataUrl,
        url:        location.href,
      }),
    });
  } catch {
    // Network/offline failure — still thank the user, don't punish them
    // for something out of their control. window._pdfreeDevMode logs below
    // help catch this during development.
  }
  if (window._pdfreeDevMode) {
    console.info('[Feedback]', { type, text: text.slice(0, 80), tool: _context.tool });
  }

  const thanks = modal.querySelector('#fbModalThanks');
  if (send)   send.style.display   = 'none';
  if (thanks) thanks.style.display = '';
  setTimeout(_closeFeedback, 1800);
}

// ── Event delegation ──────────────────────────────────────────

document.addEventListener('click', e => {
  // Open modal from any [data-open-feedback] element
  const opener = e.target.closest('[data-open-feedback]');
  if (opener) {
    openFeedback(opener.dataset.fbType || 'other');
    return;
  }

  // Close on backdrop click
  if (e.target.id === MODAL_ID) { _closeFeedback(); return; }

  // Close button inside modal
  if (e.target.closest('.fb-modal__close')) { _closeFeedback(); return; }

  // Send button
  if (e.target.closest('#fbModalSend')) {
    const modal = document.getElementById(MODAL_ID);
    if (modal) _sendFeedback(modal);
    return;
  }

  // Attach-screenshot button — proxies the click to the hidden file input
  if (e.target.closest('#fbModalAttachBtn')) {
    document.getElementById('fbModalScreenshotInput')?.click();
    return;
  }

  // Remove attached screenshot
  if (e.target.closest('#fbModalScreenshotRemove')) {
    const modal = document.getElementById(MODAL_ID);
    if (modal) _resetScreenshot(modal);
    return;
  }
});

document.addEventListener('change', async e => {
  if (e.target.id !== 'fbModalScreenshotInput') return;
  const modal = document.getElementById(MODAL_ID);
  const file  = e.target.files?.[0];
  if (!modal || !file) return;

  const errorEl = modal.querySelector('#fbModalScreenshotError');
  const result   = await _processScreenshotFile(file).catch(() => ({ error: 'invalid' }));

  if (result.error) {
    _resetScreenshot(modal);
    if (errorEl && result.error === 'too_large') errorEl.style.display = '';
    return;
  }

  _screenshotDataUrl = result.dataUrl;
  const preview = modal.querySelector('#fbModalScreenshotPreview');
  const img     = modal.querySelector('#fbModalScreenshotImg');
  const attach  = modal.querySelector('#fbModalAttachBtn');
  if (errorEl) errorEl.style.display = 'none';
  if (img)     img.src               = result.dataUrl;
  if (preview) preview.style.display = '';
  if (attach)  attach.style.display  = 'none';
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') _closeFeedback();
});
