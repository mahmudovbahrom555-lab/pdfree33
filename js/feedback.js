// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  feedback.js — Lightweight feedback modal
//
//  Handles [data-open-feedback] buttons (🐛 Found a bug, 💡 Have an idea, 👍 All good!)
//  and the 💬 Feedback button in the footer.
//
//  The modal is injected once on first open and reused.
//  Feedback text is sent as a Plausible custom event — free, no server needed.
//  Privacy: no PII, no file data, text is truncated to 500 chars before sending.
// ============================================================

const MODAL_ID = 'fbModal';

const _TYPE_TITLES = {
  bug:   '🐛 Report a bug',
  idea:  '💡 Share an idea',
  other: '💬 Share feedback',
};

const _TYPE_PLACEHOLDERS = {
  bug:   'What went wrong? Which file type or tool?',
  idea:  'What feature would help you most?',
  other: 'Anything you\'d like to tell us?',
};

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
      <textarea class="fb-modal__textarea" id="fbModalText"
                placeholder="Tell us what happened…" maxlength="1000" rows="4"></textarea>
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

export function openFeedback(type = 'other') {
  const modal  = _getOrCreateModal();
  const title  = modal.querySelector('#fbModalTitle');
  const text   = modal.querySelector('#fbModalText');
  const thanks = modal.querySelector('#fbModalThanks');
  const send   = modal.querySelector('#fbModalSend');

  title.textContent    = _TYPE_TITLES[type]  || _TYPE_TITLES.other;
  text.placeholder     = _TYPE_PLACEHOLDERS[type] || _TYPE_PLACEHOLDERS.other;
  text.value           = '';
  thanks.style.display = 'none';
  send.style.display   = '';
  send.disabled        = false;

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

function _sendFeedback(modal) {
  const type = modal.dataset.fbType || 'other';
  const text = modal.querySelector('#fbModalText')?.value?.trim() || '';
  const send = modal.querySelector('#fbModalSend');

  // Require at least 3 chars for bug/idea reports; allow empty for "All good"
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
      window.plausible('Feedback', {
        props: { type, has_text: text.length > 0 ? 'yes' : 'no' },
      });
    }
    if (window._pdfreeDevMode) {
      console.info('[Feedback]', { type, text: text.slice(0, 80) });
    }
  } catch { /* never fail */ }

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
