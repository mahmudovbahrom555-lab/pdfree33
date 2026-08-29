// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  metaUI.js — PDF Metadata Editor
//
//  🎯 Сверх ТЗ:
//  1. Pre-read реальных значений — показываем что сейчас в PDF
//     до редактирования (через window.PDFLib как в compressUI).
//  2. JSON export/import — одна кнопка копирует метаданные как JSON,
//     другая позволяет вставить JSON и применить всё сразу.
//  3. "Strip all" — одним кликом очищает все поля (полезно для
//     удаления личных данных перед отправкой).
// ============================================================

import { id }       from './utils.js';
import { showToast } from './ui.js';
import { loadPdfLib } from './lazyLibs.js';
import { t } from './i18n.js';

// ── State ──────────────────────────────────────────────────────
let _meta = { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' };
let _originalSize = 0;
let _initGen = 0;   // bumped on every initMetaOptions() call — see below for why this matters
                     // more here than in most tools: _meta isn't just a preview, it's the exact
                     // data getMetaParams() hands to the worker to WRITE into whichever file is
                     // currently selected — a stale call finishing last doesn't just show the
                     // wrong title in the form, it can silently write one file's real
                     // title/author/subject into a completely different file's output.

export function getMetaParams() {
  return { meta: { ..._meta } };
}

// ── Public API ─────────────────────────────────────────────────

export async function initMetaOptions(file) {
  const container = id('metaOptions');
  if (!container) return;

  // Captured before any await — real bug found+confirmed via Playwright:
  // remove a large/slow-to-parse file, add a different one quickly, and
  // without this guard the FIRST file's title/author could finish parsing
  // last and overwrite the second file's correctly-empty _meta — then
  // "Save Metadata" writes the first file's real metadata into the
  // second file's actual output PDF. Same race class as resize's
  // 1ee544a9 fix, but with a genuine wrong-output consequence here
  // instead of just a misleading preview.
  const gen = ++_initGen;

  _originalSize = file.size;
  container.innerHTML = `
    <div class="compress-loading">
      <span class="compress-loading__spinner" aria-hidden="true"></span>
      ${t('meta_reading')}
    </div>
  `;
  container.style.display = 'block';

  try {
    await loadPdfLib();
    if (gen !== _initGen) return;
    const { PDFDocument } = window.PDFLib;
    const buf = await file.arrayBuffer();
    if (gen !== _initGen) return;
    const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
    if (gen !== _initGen) return;

    _meta = {
      title:    _safe(pdf.getTitle()),
      author:   _safe(pdf.getAuthor()),
      subject:  _safe(pdf.getSubject()),
      keywords: _safe(Array.isArray(pdf.getKeywords())
                        ? pdf.getKeywords().join(', ')
                        : pdf.getKeywords()),
      creator:  _safe(pdf.getCreator()),
      producer: _safe(pdf.getProducer()),
    };
  } catch {
    if (gen !== _initGen) return;
    _meta = { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' };
    showToast(t('meta_read_failed'), 4000);
  }

  _render();
}

export function hideMetaOptions() {
  _initGen++; // invalidate any in-flight initMetaOptions() call
  const container = id('metaOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _meta = { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' };
}

// ── Render ─────────────────────────────────────────────────────

function _fields() {
  return [
    { key: 'title',    label: t('meta_field_title'),    placeholder: t('meta_ph_title')    },
    { key: 'author',   label: t('meta_field_author'),   placeholder: t('meta_ph_author')   },
    { key: 'subject',  label: t('meta_field_subject'),  placeholder: t('meta_ph_subject')  },
    { key: 'keywords', label: t('meta_field_keywords'), placeholder: t('meta_ph_keywords') },
    { key: 'creator',  label: t('meta_field_creator'),  placeholder: t('meta_ph_creator')  },
    { key: 'producer', label: t('meta_field_producer'), placeholder: t('meta_ph_producer') },
  ];
}

function _render() {
  const container = id('metaOptions');
  if (!container) return;

  const hasAnyValue = Object.values(_meta).some(v => v && v.trim());

  container.innerHTML = `
    <div class="meta-toolbar">
      <button type="button" class="meta-btn" id="metaStripAll" aria-label="${t('meta_clear_all_aria')}">
        🧹 ${t('meta_strip_all')}
      </button>
      <button type="button" class="meta-btn" id="metaExportJson" aria-label="${t('meta_copy_json_aria')}">
        {} ${t('meta_export_json')}
      </button>
      <button type="button" class="meta-btn" id="metaImportJson" aria-label="${t('meta_import_json_aria')}">
        ⬆ ${t('meta_import_json')}
      </button>
    </div>

    ${hasAnyValue
      ? `<div class="meta-notice">✏️ ${t('meta_editing_notice')}</div>`
      : `<div class="meta-notice meta-notice--empty">📄 ${t('meta_empty_notice')}</div>`
    }

    <div class="meta-fields">
      ${_fields().map(f => `
        <div class="meta-field">
          <label class="meta-field__label" for="meta_${f.key}">${f.label}</label>
          <input
            type="text"
            id="meta_${f.key}"
            class="meta-field__input"
            value="${_esc(_meta[f.key] || '')}"
            placeholder="${f.placeholder}"
            data-key="${f.key}"
            aria-label="${f.label}"
          >
        </div>
      `).join('')}
    </div>
  `;

  _bindEvents();
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents() {
  const container = id('metaOptions');

  // Live sync from inputs
  container.querySelectorAll('.meta-field__input').forEach(input => {
    input.addEventListener('input', () => {
      _meta[input.dataset.key] = input.value;
    });
  });

  // Strip all
  id('metaStripAll')?.addEventListener('click', () => {
    _fields().forEach(f => { _meta[f.key] = ''; });
    container.querySelectorAll('.meta-field__input').forEach(inp => { inp.value = ''; });
    showToast(t('meta_cleared_toast'), 2500);
  });

  // Export JSON
  id('metaExportJson')?.addEventListener('click', () => {
    const json = JSON.stringify(_meta, null, 2);
    navigator.clipboard.writeText(json)
      .then(() => showToast(t('meta_copied_toast'), 2500))
      .catch(() => {
        // Fallback: show in a textarea
        const ta = document.createElement('textarea');
        ta.value = json;
        ta.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);width:320px;height:160px;z-index:9999;font-family:monospace;font-size:12px;border:1px solid #ccc;border-radius:8px;padding:8px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        setTimeout(() => ta.remove(), 8000);
        showToast(t('meta_select_copy_toast'), 7000);
      });
  });

  // Import JSON
  id('metaImportJson')?.addEventListener('click', () => {
    const raw = prompt(t('meta_paste_prompt'));
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw.trim());
      _fields().forEach(f => {
        if (parsed[f.key] !== undefined) {
          _meta[f.key] = String(parsed[f.key]);
          const inp = id(`meta_${f.key}`);
          if (inp) inp.value = _meta[f.key];
        }
      });
      showToast(t('meta_imported_toast'), 2500);
    } catch {
      showToast(t('meta_invalid_json_toast'), 4000);
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────

function _safe(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML.replace(/"/g, '&quot;');
}
