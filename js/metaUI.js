// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

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

// ── State ──────────────────────────────────────────────────────
let _meta = { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' };
let _originalSize = 0;

export function getMetaParams() {
  return { meta: { ..._meta } };
}

// ── Public API ─────────────────────────────────────────────────

export async function initMetaOptions(file) {
  const container = id('metaOptions');
  if (!container) return;

  _originalSize = file.size;
  container.innerHTML = `
    <div class="compress-loading">
      <span class="compress-loading__spinner" aria-hidden="true"></span>
      Reading metadata…
    </div>
  `;
  container.style.display = 'block';

  try {
    const { PDFDocument } = window.PDFLib;
    const buf = await file.arrayBuffer();
    const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });

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
    _meta = { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' };
    showToast('Could not read metadata — editing from scratch', 4000);
  }

  _render();
}

export function hideMetaOptions() {
  const container = id('metaOptions');
  if (!container) return;
  container.style.display = 'none';
  container.innerHTML = '';
  _meta = { title: '', author: '', subject: '', keywords: '', creator: '', producer: '' };
}

// ── Render ─────────────────────────────────────────────────────

const FIELDS = [
  { key: 'title',    label: 'Title',    placeholder: 'Document title' },
  { key: 'author',   label: 'Author',   placeholder: 'Author name' },
  { key: 'subject',  label: 'Subject',  placeholder: 'Document subject' },
  { key: 'keywords', label: 'Keywords', placeholder: 'keyword1, keyword2' },
  { key: 'creator',  label: 'Creator',  placeholder: 'Application name' },
  { key: 'producer', label: 'Producer', placeholder: 'PDF library' },
];

function _render() {
  const container = id('metaOptions');
  if (!container) return;

  const hasAnyValue = Object.values(_meta).some(v => v && v.trim());

  container.innerHTML = `
    <div class="meta-toolbar">
      <button type="button" class="meta-btn" id="metaStripAll" aria-label="Clear all fields">
        🧹 Strip all
      </button>
      <button type="button" class="meta-btn" id="metaExportJson" aria-label="Copy as JSON">
        {} Export JSON
      </button>
      <button type="button" class="meta-btn" id="metaImportJson" aria-label="Import from JSON">
        ⬆ Import JSON
      </button>
    </div>

    ${hasAnyValue
      ? `<div class="meta-notice">✏️ Editing existing metadata — blank fields will be cleared</div>`
      : `<div class="meta-notice meta-notice--empty">📄 No metadata found — fill in fields below</div>`
    }

    <div class="meta-fields">
      ${FIELDS.map(f => `
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
    FIELDS.forEach(f => { _meta[f.key] = ''; });
    container.querySelectorAll('.meta-field__input').forEach(inp => { inp.value = ''; });
    showToast('All metadata fields cleared', 2500);
  });

  // Export JSON
  id('metaExportJson')?.addEventListener('click', () => {
    const json = JSON.stringify(_meta, null, 2);
    navigator.clipboard.writeText(json)
      .then(() => showToast('📋 Metadata copied as JSON', 2500))
      .catch(() => {
        // Fallback: show in a textarea
        const ta = document.createElement('textarea');
        ta.value = json;
        ta.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);width:320px;height:160px;z-index:9999;font-family:monospace;font-size:12px;border:1px solid #ccc;border-radius:8px;padding:8px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        setTimeout(() => ta.remove(), 8000);
        showToast('📋 Select all and copy (Ctrl+A, Ctrl+C)', 7000);
      });
  });

  // Import JSON
  id('metaImportJson')?.addEventListener('click', () => {
    const raw = prompt('Paste metadata JSON:');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw.trim());
      FIELDS.forEach(f => {
        if (parsed[f.key] !== undefined) {
          _meta[f.key] = String(parsed[f.key]);
          const inp = id(`meta_${f.key}`);
          if (inp) inp.value = _meta[f.key];
        }
      });
      showToast('✅ Metadata imported', 2500);
    } catch {
      showToast('⚠️ Invalid JSON — paste the exported format', 4000);
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────

function _safe(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

function _esc(str) {
  const d = document.createElement('div'); d.textContent = str; return d.innerHTML;
}
