// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  watermarkRemoveUI.js — Shared "Try to remove watermarks"
//  toggle used by merge, compress, split, and rotate.
//
//  One module = one state variable. Each tool:
//    1. Renders wmRemoveHtml() into its options container
//    2. Calls bindWmRemove() in its _bindEvents()
//    3. Calls resetWmRemove() in its hide() function
//    4. Reads getWmRemove() via toolRegistrations.js getParams
//
//  Phase 1 (annotation removal) is handled in worker.js by
//  _stripAnnotations(pdf) which deletes /Annots from each page.
//  This covers ~30-40% of real-world watermark cases.
// ============================================================

import { checkbox } from './uiComponents.js';
import { t } from './i18n.js';

let _active = false;

export const WM_TOGGLE_ID = 'wmRemoveToggle';

export function getWmRemove()   { return _active; }
export function resetWmRemove() { _active = false; }

export function wmRemoveHtml() {
  return checkbox({
    id:       WM_TOGGLE_ID,
    checked:  _active,
    title:    t('wmrm_title'),
    subtitle: t('wmrm_subtitle'),
  });
}

export function bindWmRemove() {
  document.getElementById(WM_TOGGLE_ID)?.addEventListener('change', e => {
    _active = e.target.checked;
  });
}
