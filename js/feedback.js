// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  feedback.js — Lightweight feedback modal
//
//  Handles [data-open-feedback] buttons (🐛 Found a bug, 💡 Have an idea,
//  👍 All good!) on the success card, the 💬 Feedback button in the footer,
//  and the "Report this" prompt openErrorFeedback() wires up from a failed
//  tool run (see processor.js _handleError).
//
//  The modal is injected once on first open and reused.
//  Submissions POST to /api/feedback (same-origin Cloudflare Worker route),
//  which relays them to Telegram — no database, nothing stored on our side.
//  A lightweight aggregate event also goes to Plausible for trend counts
//  (type only, never the message text).
//  Email is optional and only used if the user wants a reply.
// ============================================================

const MODAL_ID = 'fbModal';

const _TYPE_TITLES = {
  bug:   '🐛 Report a bug',
  idea:  '💡 Share an idea',
  other: '💬 Share feedback',
  error: '⚠️ What went wrong?',
};

const _TYPE_PLACEHOLDERS = {
  bug:   'What went wrong? Which file type or tool?',
  idea:  'What feature would help you most?',
  other: 'Anything you\'d like to tell us?',
  error: 'A few details help us fix it faster (optional)',
};

let _context = { tool: 'unknown', message: '' };

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
      <p class="fb-modal__context" id="fbModalContext" style="display:none"></p>
      <textarea class="fb-modal__textarea" id="fbModalText"
                placeholder="Tell us what happened…" maxlength="1000" rows="4"></textarea>
      <input class="fb-modal__email" id="fbModalEmail" type="email"
             placeholder="Email (optional — only if you'd like a reply)" maxlength="200" autocomplete="email">
      <!-- Honeypot — hidden from real users via CSS, bots that fill every field trip it -->
      <input class="fb-modal__hp" id="fbModalHp" type="text" name="website" tabindex="-1"
             autocomplete="off" aria-hidden="true">
      <div class="fb-modal__actions">
        <button type="button" class="fb-modal__send" id="fbModalSend">Send feedback</button>
      </div>
      <p class="fb-modal__thanks" id="fbModalThanks" style="display:none">
        Thank you! Your feedback helps us improve.
      </p>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

/**
 * @param {string} type 'bug' | 'idea' | 'other' | 'error'
 * @param {{tool?: string, message?: string}} [context] — tool key + (for
 *   type='error') the error message shown as read-only context, not
 *   something the user has to retype.
 */
export function openFeedback(type = 'other', context = {}) {
  const modal   = _getOrCreateModal();
  const title   = modal.querySelector('#fbModalTitle');
  const ctxEl   = modal.querySelector('#fbModalContext');
  const text    = modal.querySelector('#fbModalText');
  const email   = modal.querySelector('#fbModalEmail');
  const hp      = modal.querySelector('#fbModalHp');
  const thanks  = modal.querySelector('#fbModalThanks');
  const send    = modal.querySelector('#fbModalSend');

  _context = { tool: context.tool || document.body.dataset.tool || 'unknown', message: context.message || '' };

  title.textContent = _TYPE_TITLES[type] || _TYPE_TITLES.other;
  text.placeholder  = _TYPE_PLACEHOLDERS[type] || _TYPE_PLACEHOLDERS.other;
  text.value        = '';
  email.value       = '';
  hp.value          = '';

  if (type === 'error' && _context.message) {
    ctxEl.textContent   = `"${_context.message}"`;
    ctxEl.style.display = '';
  } else {
    ctxEl.style.display = 'none';
  }

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
        type, text, email, hp,
        tool: _context.tool,
        url:  location.href,
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
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') _closeFeedback();
});
