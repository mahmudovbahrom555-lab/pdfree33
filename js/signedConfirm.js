// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  signedConfirm.js — "this PDF is digitally signed" before a tool that
//  writes a new PDF runs (class C28, 2026-11-05; detection: signedPdf.js).
//
//  Not a refusal: someone may want an edited copy on purpose. The copy's
//  signature won't be valid — the original keeps its own. Cancel is the
//  focused default (Esc and the backdrop cancel too); nothing starts until
//  the user presses "Make the copy" (confirmDialog.js).
// ============================================================

import { t } from './i18n.js';
import { confirmDialog } from './confirmDialog.js';

/**
 * @param {{name: string, certified: boolean}[]} files  the signed ones among the selected
 * @returns {Promise<boolean>} true = make the copy
 */
export function confirmSignedCopy(files) {
  return confirmDialog({
    id: 'sigConfirm', icon: '✍', title: t('sig_title'),
    paragraphs: [t('sig_body'), ...(files.some(f => f.certified) ? [t('sig_certified')] : [])],
    items: files.map(f => f.name),
    cancel: t('sig_cancel'), go: t('sig_go'),
  });
}
