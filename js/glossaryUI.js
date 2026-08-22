// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  glossaryUI.js — Document Glossary tool UI
//
//  Single PDF in, single PDF out. User pastes a term/definition
//  dictionary (one entry per line: "term - definition"); the actual
//  term matching runs on the main thread inside processor.js's
//  _runGlossary() when the user submits (needs pdf.js, which this
//  module deliberately does NOT load itself — no reason to duplicate
//  that work before the user has even entered a dictionary). This file
//  only owns the dictionary textarea + file-info display + parsing.
//
//  Dictionary format is deliberately the simplest possible to parse and
//  to type by hand: one entry per line, "term - definition". Split on
//  the FIRST " - " only, so a definition containing its own dashes
//  (very likely in real prose) isn't cut short.
// ============================================================

import { id, esc } from './utils.js';
import { t } from './i18n.js';

let _file = null;

export function initGlossaryOptions(file) {
  const container = id('glossaryOptions');
  if (!container) return;

  // Preserve any already-typed dictionary text across a re-init for the
  // SAME file. js/app.js's global 'pdfree:file-decrypted' listener calls
  // initToolOptions() — and therefore this function — again whenever any
  // encrypted PDF's async owner-only-decrypt check settles, REGARDLESS of
  // whether it actually succeeded. Confirmed via a real Playwright test:
  // without this, a user who starts typing their dictionary before that
  // async check resolves has their input silently wiped by the
  // unconditional innerHTML rebuild below. A genuinely different file
  // (the common, non-racy case) still starts blank, as before.
  const existingTextarea = id('glsDictionary');
  const preservedDictionary = (existingTextarea && _file === file) ? existingTextarea.value : '';

  _file = file;
  container.style.display = 'block';
  container.innerHTML = `
    <div style="padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:12px;font-size:13px;color:var(--text2);">
      ${esc(t('gls_intro'))}
    </div>
    <label for="glsFileInfo" style="display:block;font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;">${esc(t('gls_file_label'))}</label>
    <div id="glsFileInfo" style="font-size:13px;color:var(--text2);margin-bottom:16px;">${esc(file.name)}</div>

    <label for="glsDictionary" style="display:block;font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;">${esc(t('gls_dictionary_label'))}</label>
    <div style="font-size:12px;color:var(--text2);margin-bottom:6px;">${esc(t('gls_dictionary_hint'))}</div>
    <textarea id="glsDictionary" rows="8" spellcheck="false"
      placeholder="${esc(t('gls_dictionary_placeholder'))}"
      style="width:100%;box-sizing:border-box;padding:10px;font-family:ui-monospace,monospace;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);resize:vertical;"></textarea>
    <div id="glsParsedCount" style="font-size:12px;color:var(--text2);margin-top:6px;"></div>
  `;

  const textarea = id('glsDictionary');
  if (textarea) {
    textarea.value = preservedDictionary;
    textarea.addEventListener('input', _updateParsedCount);
    _updateParsedCount();
  }
}

export function hideGlossaryOptions() {
  const container = id('glossaryOptions');
  if (container) {
    container.style.display = 'none';
    container.innerHTML = '';
  }
  _file = null;
}

// "term - definition" per line, first " - " only (a definition may
// legitimately contain its own dashes — "term - a period of time —
// pre-Vedic" should still parse as one entry, not split again there).
export function _parseDictionary(text) {
  const entries = [];
  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const sepIdx = line.indexOf(' - ');
    if (sepIdx === -1) continue;
    const term = line.slice(0, sepIdx).trim();
    const definition = line.slice(sepIdx + 3).trim();
    if (term && definition) entries.push({ term, definition });
  }
  return entries;
}

function _updateParsedCount() {
  const textarea = id('glsDictionary');
  const label = id('glsParsedCount');
  if (!textarea || !label) return;
  const entries = _parseDictionary(textarea.value);
  label.textContent = entries.length
    ? t('gls_parsed_count', { n: entries.length })
    : '';
}

export function getGlossaryParams() {
  const textarea = id('glsDictionary');
  const dictionary = _parseDictionary(textarea ? textarea.value : '');
  return { dictionary, hasFile: !!_file };
}
