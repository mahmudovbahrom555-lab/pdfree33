// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  mergeOrderUI.js — Merge's "Page order": one file after another, or
//  alternate pages (Search Miss "interleave", 2026-10-14).
//
//  Fronts and backs scanned as two stacks — or one after the other in a
//  single scan — are put back together; see mergeWorker.js's
//  handleAlternate. Its own module, like watermarkRemoveUI.js, because
//  files.js reads it too: one file is enough to alternate (its halves),
//  so Merge's button must not wait for a second file in this mode.
// ============================================================

import { chipGroup, checkbox, infoBanner } from './uiComponents.js';
import { t } from './i18n.js';

const ORDER_GROUP_ID = 'mergePageOrder';
const REVERSE_ID     = 'mergeReverseOthers';

let _order   = 'append';   // 'append' | 'alternate'
let _reverse = true;       // a turned-over stack of backs comes out last page first

export function getMergeOrder()   { return { order: _order, reverseOthers: _reverse }; }
export function resetMergeOrder() { _order = 'append'; _reverse = true; }

export function mergeOrderHtml() {
  return `
    <div style="margin-top:14px;">
      <label style="display:block;font-size:12px;font-weight:600;color:var(--text2);
        margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;">
        ${t('merge_order_title')}
      </label>
      ${chipGroup(ORDER_GROUP_ID, [
        { value: 'append',    label: t('merge_order_append') },
        { value: 'alternate', label: t('merge_order_alternate') },
      ], _order, t('merge_order_title'))}
    </div>
    <div id="mergeAlternateExtras" style="display:${_order === 'alternate' ? 'block' : 'none'};">
      ${infoBanner(t('merge_alternate_hint'))}
      ${checkbox({ id: REVERSE_ID, checked: _reverse, title: t('merge_reverse_title'), subtitle: t('merge_reverse_sub') })}
    </div>`;
}

// appendOnlyId — the block shown only for one file after another
// (bookmarks, blank pages: neither applies to alternated pages).
export function bindMergeOrder(appendOnlyId) {
  document.querySelectorAll(`input[name="${ORDER_GROUP_ID}"]`).forEach(input => {
    input.addEventListener('change', e => {
      if (!e.target.checked) return;
      _order = e.target.value;
      document.querySelectorAll(`[data-name="${ORDER_GROUP_ID}"]`).forEach(el =>
        el.classList.toggle('j2p-chip--active', el.dataset.value === _order));
      const alternate = _order === 'alternate';
      document.getElementById('mergeAlternateExtras').style.display = alternate ? 'block' : 'none';
      document.getElementById(appendOnlyId).style.display           = alternate ? 'none' : 'block';
      // one file is enough to alternate — files.js's _updateMeta re-checks the button
      document.dispatchEvent(new CustomEvent('pdfree:merge-order-changed'));
    });
  });
  document.getElementById(REVERSE_ID)?.addEventListener('change', e => {
    _reverse = e.target.checked;
  });
}
