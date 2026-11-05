// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  signedConfirm.js — "this PDF is digitally signed" before a tool that
//  writes a new PDF runs (class C28, 2026-11-05; detection: signedPdf.js).
//
//  Not a refusal: someone may want an edited copy on purpose. The copy's
//  signature won't be valid — the original keeps its own. Cancel is the
//  focused default (Esc and the backdrop cancel too); nothing starts until
//  the user presses "Make the copy".
// ============================================================

import { t } from './i18n.js';
import { esc } from './utils.js';

/**
 * @param {{name: string, certified: boolean}[]} files  the signed ones among the selected
 * @returns {Promise<boolean>} true = make the copy
 */
export function confirmSignedCopy(files) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const certified = files.some(f => f.certified);
    const wrap = document.createElement('div');
    wrap.className = 'sig-confirm';
    wrap.innerHTML = `
      <div class="sig-confirm__backdrop" data-sig="cancel"></div>
      <div class="sig-confirm__card" role="alertdialog" aria-modal="true" aria-labelledby="sigConfirmTitle" aria-describedby="sigConfirmBody">
        <div class="sig-confirm__icon" aria-hidden="true">✍</div>
        <h2 id="sigConfirmTitle" class="sig-confirm__title">${esc(t('sig_title'))}</h2>
        <div id="sigConfirmBody">
          <p class="sig-confirm__text">${esc(t('sig_body'))}</p>
          ${certified ? `<p class="sig-confirm__text">${esc(t('sig_certified'))}</p>` : ''}
          <ul class="sig-confirm__files">${files.map(f => `<li>${esc(f.name)}</li>`).join('')}</ul>
        </div>
        <div class="sig-confirm__actions">
          <button type="button" class="sig-confirm__btn" id="sigConfirmCancel" data-sig="cancel">${esc(t('sig_cancel'))}</button>
          <button type="button" class="sig-confirm__btn sig-confirm__btn--go" id="sigConfirmGo" data-sig="go">${esc(t('sig_go'))}</button>
        </div>
      </div>`;
    const done = ok => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      prev?.focus?.();
      resolve(ok);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); return; }
      if (e.key !== 'Tab') return;
      // focus stays inside the dialog
      const btns = [...wrap.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      e.preventDefault();
      btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
    };
    wrap.addEventListener('click', e => {
      const what = e.target.closest('[data-sig]')?.dataset.sig;
      if (what) done(what === 'go');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('#sigConfirmCancel').focus();
  });
}
