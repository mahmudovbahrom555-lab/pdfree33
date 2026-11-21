// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  confirmDialog.js — one question before something the user may not want:
//  "this PDF is digitally signed" (signedConfirm.js), "the text will be hard
//  to read" (Compress to a size). Cancel is the focused default (Esc and the
//  backdrop cancel too); focus stays inside until a button is pressed. The
//  look is the signed-PDF dialog's (.sig-confirm in css/components.css).
// ============================================================

import { esc } from './utils.js';

/**
 * @param {{ id: string, icon: string, title: string, paragraphs: string[],
 *           items?: string[], cancel: string, go: string, safeIsPrimary?: boolean }} o
 *   id: prefix of the element ids (`${id}Title`, `${id}Cancel`, `${id}Go`…)
 *   safeIsPrimary: Cancel gets the strong look (when going on loses something)
 * @returns {Promise<boolean>} true = go
 */
export function confirmDialog({ id, icon, title, paragraphs, items = [], cancel, go, safeIsPrimary = false }) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'sig-confirm';
    wrap.innerHTML = `
      <div class="sig-confirm__backdrop" data-sig="cancel"></div>
      <div class="sig-confirm__card" role="alertdialog" aria-modal="true" aria-labelledby="${id}Title" aria-describedby="${id}Body">
        <div class="sig-confirm__icon" aria-hidden="true">${esc(icon)}</div>
        <h2 id="${id}Title" class="sig-confirm__title">${esc(title)}</h2>
        <div id="${id}Body">
          ${paragraphs.map(p => `<p class="sig-confirm__text">${esc(p)}</p>`).join('')}
          ${items.length ? `<ul class="sig-confirm__files">${items.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="sig-confirm__actions">
          <button type="button" class="sig-confirm__btn${safeIsPrimary ? ' sig-confirm__btn--go' : ''}" id="${id}Cancel" data-sig="cancel">${esc(cancel)}</button>
          <button type="button" class="sig-confirm__btn${safeIsPrimary ? '' : ' sig-confirm__btn--go'}" id="${id}Go" data-sig="go">${esc(go)}</button>
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
    wrap.querySelector(`#${id}Cancel`).focus();
  });
}
