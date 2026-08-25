// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  formulaOcrToggle.js — pdf2md-only "Recognize formulas as
//  LaTeX (beta)" opt-in toggle. Not shared (unlike
//  js/watermarkRemoveUI.js, used across merge/compress/split/
//  rotate) — this is specific to pdf2md's display-formula crop
//  feature, following that module's own getX()/resetX()/xHtml()/
//  bindX() shape.
//
//  Off by default: real, measured trade-offs (~76MB one-time
//  download, ~620ms/formula, ~71% real accuracy across a diverse
//  17-formula sample tested this session — see
//  pdf2md_formula_ocr_feasibility_2026_08 memory) mean this should
//  be an informed choice, not a silent default. Copy is honest
//  about all of this up front, matching this project's established
//  disclosure-first pattern elsewhere (e.g. the compress tool's own
//  "where we lose" framing).
// ============================================================

import { checkbox } from './uiComponents.js';
import { t } from './i18n.js';

let _active = false;

export const FORMULA_OCR_TOGGLE_ID = 'formulaOcrToggle';

export function getFormulaOcr()   { return _active; }
export function resetFormulaOcr() { _active = false; }

export function formulaOcrToggleHtml() {
  return checkbox({
    id:       FORMULA_OCR_TOGGLE_ID,
    checked:  _active,
    title:    t('p2m_formula_ocr_title'),
    subtitle: t('p2m_formula_ocr_subtitle'),
  });
}

export function bindFormulaOcr() {
  document.getElementById(FORMULA_OCR_TOGGLE_ID)?.addEventListener('change', e => {
    _active = e.target.checked;
  });
}
