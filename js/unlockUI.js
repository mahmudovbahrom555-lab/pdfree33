// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  unlockUI.js — Unlock PDF (remove password) options panel
//
//  file._pdfMeta.isEncrypted (set by files.js's silent owner-only
//  preflight) decides which state renders first, but it's only a hint —
//  _runUnlock() in processor.js always makes the real QPDF call and
//  reacts to its actual result, so a stale flag can't produce a wrong
//  outcome.
//
//  Unlike protectUI.js, the password field is NOT wiped after a failed
//  attempt (only on success or file change) — a wrong-password retry is
//  the expected common case here, and this password is being *recalled*,
//  not created, so re-typing it every time is pure friction.
// ============================================================

import { id }        from './utils.js';
import { group, infoBanner } from './uiComponents.js';

let _file = null;

// ── Public API ────────────────────────────────────────────────

export function initUnlockOptions(file) {
  const container = id('unlockOptions');
  if (!container) return;

  _file = file;
  container.style.display = 'block';
  _render(container);
}

export function hideUnlockOptions() {
  const container = id('unlockOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _file = null;
}

export function getUnlockParams() {
  const needsPassword = !!_file?._pdfMeta?.isEncrypted;
  const input = id('unlockPwd');
  const password = (input?.value || '').normalize('NFC');
  return { password, needsPassword };
}

// Clears the password field after a successful unlock — the operation is
// done, so there's no reason to keep the (now-used) password sitting in
// the DOM. Called by app.js's pdfree:success handling; safe to call even
// if this tool isn't the one that just ran.
document.addEventListener('pdfree:success', e => {
  if (e.detail?.tool !== 'unlock') return;
  const input = id('unlockPwd');
  if (input) input.value = '';
});

// ── Render ────────────────────────────────────────────────────

function _render(container) {
  const needsPassword = !!_file?._pdfMeta?.isEncrypted;

  if (!needsPassword) {
    container.innerHTML = infoBanner(
      '✓ This PDF doesn\'t require a password — click <strong>Remove Password Protection</strong> to continue.',
      'clean'
    );
    return;
  }

  container.innerHTML = `
    ${group('Password', `
      <div class="prot-pwd-row">
        <input type="password" id="unlockPwd" class="prot-input"
               placeholder="Enter the PDF's password" maxlength="128"
               autocomplete="current-password" aria-label="PDF password"
               spellcheck="false">
        <button type="button" class="prot-eye" id="unlockPwdEye"
                aria-label="Show password" title="Show/hide">👁</button>
      </div>
      <div class="prot-hint">
        You need the correct password to remove protection — PDFree cannot bypass or guess it.
      </div>
    `)}
  `;

  id('unlockPwdEye')?.addEventListener('click', () => _toggleVisibility('unlockPwd', 'unlockPwdEye'));
}

function _toggleVisibility(inputId, btnId) {
  const input = id(inputId);
  const btn   = id(btnId);
  if (!input) return;
  const isText = input.type === 'text';
  input.type   = isText ? 'password' : 'text';
  if (btn) btn.textContent = isText ? '👁' : '🙈';
}
