// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  fillUI.js — AcroForm PDF fill tool
//
//  Flow:
//    1. initFillOptions(files) — loads pdf.js, extracts Widget
//       annotations, renders native mobile-first form
//    2. User fills inputs — values stored in _values, drafted
//       to localStorage on every change
//    3. getFillParams() — returns { fieldValues } for worker
//    4. Worker writes values with pdf-lib and flattens PDF
//
//  Design decisions:
//    - Native HTML form instead of PDF canvas overlay
//      → proper keyboard types, autocomplete, 44px touch targets
//    - Grouped by PDF page (accordion when > 1 page)
//    - Radio buttons deduplicated by fieldName into one group
//    - XFA / no-field PDFs handled with honest error message
// ============================================================

import { id }        from './utils.js';
import { showToast } from './ui.js';
import { loadPdfJs } from './pdf2jpgUI.js';

// ── Module state ──────────────────────────────────────────────
let _fields   = [];
let _values   = {};
let _draftKey = null;

// ── Public API ────────────────────────────────────────────────

export function initFillOptions(files) {
  const el = id('fillOptions');
  if (!el) return;
  el.style.display = '';
  if (!files || files.length === 0) { el.innerHTML = ''; return; }
  _extractAndRender(files[0], el);
}

export function hideFillOptions() {
  const el = id('fillOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _fields = []; _values = {}; _draftKey = null;
}

export function getFillParams() {
  _syncValuesFromDOM();
  return { fieldValues: { ..._values }, hasFields: _fields.length > 0 };
}

// ── Field extraction ──────────────────────────────────────────

async function _extractAndRender(file, container) {
  container.innerHTML = _spinnerHTML('Analysing form fields…');
  try {
    await loadPdfJs();
    if (!window.pdfjsLib) throw new Error('pdf.js renderer not available');

    const rawBuf = await file.arrayBuffer();
    const pdfDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(rawBuf), useSystemFonts: false,
      verbosity: 0, disableJavaScript: true,
    }).promise;

    const raw = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      const page   = await pdfDoc.getPage(p);
      const annots = await page.getAnnotations();
      for (const a of annots) {
        if (a.subtype === 'Widget' && !a.readOnly) raw.push({ ...a, _page: p });
      }
    }

    _fields = _processRawAnnotations(raw);

    if (_fields.length === 0) {
      container.innerHTML = _noFieldsHTML();
      return;
    }

    _draftKey = `pdfree_fill_${file.name}_${file.size}`;
    const draft = _loadDraft(_draftKey);
    _values = draft || _defaultValues(_fields);

    container.innerHTML = _buildFormHTML(_fields);
    _bindEvents(container);
    _applyValues(container);
    _updateProgress(container);

  } catch (err) {
    container.innerHTML = _errorHTML(err.message);
  }
}

// ── Field processing ──────────────────────────────────────────

function _processRawAnnotations(raw) {
  const fields   = [];
  const radioMap = {};
  const seen     = new Set();

  for (const a of raw) {
    const name  = a.fieldName || `_field_${fields.length + Object.keys(radioMap).length}`;
    const label = _humanizeLabel(a);

    if (a.radioButton) {
      if (!radioMap[name]) {
        radioMap[name] = {
          name, type: 'radio', label, page: a._page,
          value: a.fieldValue || '', options: [], required: a.required || false,
        };
        fields.push(radioMap[name]);
      }
      const val = a.exportValue || a.buttonValue || 'On';
      if (!radioMap[name].options.find(o => o.value === val)) {
        radioMap[name].options.push({ value: val, label: _titleCase(val) });
      }
      continue;
    }

    const key = `${name}@${a._page}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (a.checkBox) {
      fields.push({
        name, type: 'checkbox', label, page: a._page, required: a.required || false,
        exportValue: a.exportValue || 'Yes',
        value: _isTruthy(a.fieldValue) ? (a.exportValue || 'Yes') : '',
      });
      continue;
    }

    if (a.fieldType === 'Ch') {
      fields.push({
        name, type: 'select', label, page: a._page, required: a.required || false,
        value: a.fieldValue || '',
        options: (a.options || []).map(o => ({
          value: o.exportValue || String(o),
          label: o.displayValue || o.exportValue || String(o),
        })),
      });
      continue;
    }

    if (a.fieldType === 'Sig') {
      fields.push({ name, type: 'sig', label, page: a._page, required: a.required || false });
      continue;
    }

    // Text field (Tx)
    const meta = _detectInputMeta(label, name);
    fields.push({
      name, type: 'text', label, page: a._page, required: a.required || false,
      value:     a.fieldValue || a.defaultValue || '',
      multiLine: a.multiLine || false,
      maxLen:    a.maxLen || null,
      ...meta,
    });
  }

  return fields;
}

function _humanizeLabel(a) {
  if (a.alternativeText) return a.alternativeText.trim();
  let n = (a.fieldName || '').split('.').pop().replace(/\[\d+\]/g, '');
  n = n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Field';
}

function _detectInputMeta(label, name) {
  const t = (label + ' ' + name).toLowerCase();
  if (/\bemail\b/.test(t))                             return { inputType: 'email', inputmode: 'email',   autocomplete: 'email' };
  if (/\b(phone|tel|mobile|cell)\b/.test(t))           return { inputType: 'tel',   inputmode: 'tel',     autocomplete: 'tel' };
  if (/\b(date|dob|birth|born)\b/.test(t))             return { inputType: 'date' };
  if (/\b(zip|postal)\b/.test(t))                      return { inputType: 'text',  inputmode: 'numeric', autocomplete: 'postal-code' };
  if (/\bfirst.?name\b|\bfname\b|\bgiven\b/.test(t))  return { inputType: 'text',  autocomplete: 'given-name' };
  if (/\blast.?name\b|\blname\b|\bsurname\b/.test(t)) return { inputType: 'text',  autocomplete: 'family-name' };
  if (/\bfull.?name\b/.test(t))                        return { inputType: 'text',  autocomplete: 'name' };
  if (/\b(address|street)\b/.test(t))                  return { inputType: 'text',  autocomplete: 'street-address' };
  if (/\bcity\b/.test(t))                              return { inputType: 'text',  autocomplete: 'address-level2' };
  if (/\bstate\b/.test(t))                             return { inputType: 'text',  autocomplete: 'address-level1' };
  if (/\bcountry\b/.test(t))                           return { inputType: 'text',  autocomplete: 'country-name' };
  if (/\b(url|website)\b/.test(t))                     return { inputType: 'url',   inputmode: 'url' };
  if (/\bssn\b|\bsocial.security\b/.test(t))           return { inputType: 'text',  inputmode: 'numeric', autocomplete: 'off' };
  return { inputType: 'text' };
}

// ── HTML builders ─────────────────────────────────────────────

function _buildFormHTML(fields) {
  const byPage = {};
  for (const f of fields) {
    (byPage[f.page] = byPage[f.page] || []).push(f);
  }
  const pages      = Object.keys(byPage).map(Number).sort((a, b) => a - b);
  const multiPage  = pages.length > 1;
  const fillable    = fields.filter(f => f.type !== 'sig');
  const totalFilled = fillable.filter(f => _values[f.name] !== undefined && _values[f.name] !== '').length;

  let html = `
    <div class="fill-form" style="padding:0 0 16px;">
      <div id="fillProgressBar" style="
        display:flex;align-items:center;gap:10px;
        padding:12px 16px;margin-bottom:4px;
        background:var(--surface);border:1px solid var(--border);border-radius:10px;
        font-size:13px;color:var(--text2);">
        <div style="flex:1;height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
          <div id="fillProgressFill" style="height:100%;background:var(--green);border-radius:3px;width:0%;transition:width .3s ease;"></div>
        </div>
        <span id="fillProgressLabel" style="white-space:nowrap;min-width:80px;text-align:right;">
          <strong id="fillDone">${totalFilled}</strong> / ${fillable.length} filled
        </span>
      </div>`;

  for (const page of pages) {
    if (multiPage) {
      html += `<details open style="margin-top:12px;border:1px solid var(--border);border-radius:10px;overflow:hidden;">
        <summary style="padding:12px 16px;cursor:pointer;font-weight:600;font-size:14px;background:var(--surface);list-style:none;display:flex;align-items:center;gap:8px;">
          <span>📄</span> Page ${page}
          <span style="margin-left:auto;font-size:12px;font-weight:400;color:var(--text3);">${byPage[page].length} fields</span>
        </summary>
        <div style="padding:12px 16px;display:flex;flex-direction:column;gap:14px;">`;
    } else {
      html += `<div style="margin-top:12px;display:flex;flex-direction:column;gap:14px;">`;
    }

    for (const f of byPage[page]) html += _fieldHTML(f);

    html += multiPage ? `</div></details>` : `</div>`;
  }

  html += `</div>`;
  return html;
}

function _fieldHTML(f) {
  const req = f.required ? '<span style="color:#dc2626;margin-left:3px;">*</span>' : '';

  const labelHTML = `<label for="fill_${_esc(f.name)}" style="
    display:block;font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:.4px;color:var(--text3);margin-bottom:5px;">
    ${_esc(f.label)}${req}
  </label>`;

  const baseStyle = `width:100%;box-sizing:border-box;padding:11px 13px;
    border:1.5px solid var(--border);border-radius:8px;
    background:var(--surface);color:var(--text);font-size:15px;
    font-family:inherit;outline:none;transition:border-color .15s;`;

  if (f.type === 'checkbox') {
    return `<div style="display:flex;align-items:center;gap:12px;padding:4px 0;">
      <input type="checkbox" id="fill_${_esc(f.name)}"
        data-field-name="${_esc(f.name)}" data-export-value="${_esc(f.exportValue)}"
        style="width:22px;height:22px;min-width:22px;accent-color:var(--green);cursor:pointer;">
      <label for="fill_${_esc(f.name)}" style="font-size:15px;cursor:pointer;line-height:1.4;">
        ${_esc(f.label)}${req}
      </label>
    </div>`;
  }

  if (f.type === 'radio') {
    const opts = f.options.map(o => `
      <label style="display:flex;align-items:center;gap:10px;padding:4px 0;cursor:pointer;font-size:15px;">
        <input type="radio" name="fill_${_esc(f.name)}" value="${_esc(o.value)}"
          data-field-name="${_esc(f.name)}"
          style="width:20px;height:20px;min-width:20px;accent-color:var(--green);">
        ${_esc(o.label)}
      </label>`).join('');
    return `<div>
      ${labelHTML}
      <div style="display:flex;flex-direction:column;gap:4px;padding:4px 0;">${opts}</div>
    </div>`;
  }

  if (f.type === 'select') {
    const opts = f.options.map(o =>
      `<option value="${_esc(o.value)}">${_esc(o.label)}</option>`
    ).join('');
    return `<div>
      ${labelHTML}
      <select id="fill_${_esc(f.name)}" data-field-name="${_esc(f.name)}"
        style="${baseStyle}appearance:auto;">
        <option value="">— Select —</option>
        ${opts}
      </select>
    </div>`;
  }

  if (f.type === 'sig') {
    return `<div>
      ${labelHTML}
      <div style="${baseStyle}color:var(--text3);font-size:13px;border-style:dashed;display:flex;align-items:center;gap:8px;">
        <span>✍️</span> Signature field — must be signed in Acrobat or Adobe Reader
      </div>
    </div>`;
  }

  if (f.type === 'text' && f.multiLine) {
    return `<div>
      ${labelHTML}
      <textarea id="fill_${_esc(f.name)}" data-field-name="${_esc(f.name)}"
        rows="3" ${f.maxLen ? `maxlength="${f.maxLen}"` : ''}
        style="${baseStyle}resize:vertical;min-height:80px;"
        placeholder="${_esc(f.label)}"></textarea>
    </div>`;
  }

  // Single-line text, email, tel, date, url
  const inputType  = f.inputType  || 'text';
  const inputmode  = f.inputmode  ? `inputmode="${f.inputmode}"` : '';
  const autocomplete = f.autocomplete ? `autocomplete="${f.autocomplete}"` : '';
  const maxlen     = f.maxLen ? `maxlength="${f.maxLen}"` : '';

  return `<div>
    ${labelHTML}
    <input type="${inputType}" id="fill_${_esc(f.name)}" data-field-name="${_esc(f.name)}"
      ${inputmode} ${autocomplete} ${maxlen}
      style="${baseStyle}"
      placeholder="${_esc(f.label)}">
  </div>`;
}

// ── Event binding ─────────────────────────────────────────────

function _bindEvents(container) {
  container.addEventListener('input',  _onInput);
  container.addEventListener('change', _onInput);
}

function _onInput(e) {
  const input = e.target;
  if (!input.dataset.fieldName) return;
  const name = input.dataset.fieldName;
  if (input.type === 'checkbox') {
    _values[name] = input.checked ? (input.dataset.exportValue || 'Yes') : '';
  } else if (input.type === 'radio') {
    if (input.checked) _values[name] = input.value;
  } else {
    _values[name] = input.value;
  }
  _saveDraft(_draftKey, _values);
  _updateProgress(input.closest('.fill-form') || input.closest('[id="fillOptions"]'));
}

function _applyValues(container) {
  container.querySelectorAll('[data-field-name]').forEach(input => {
    const v = _values[input.dataset.fieldName];
    if (v === undefined) return;
    if (input.type === 'checkbox') {
      input.checked = Boolean(v);
    } else if (input.type === 'radio') {
      input.checked = input.value === v;
    } else {
      input.value = v;
    }
  });
}

function _syncValuesFromDOM() {
  const el = id('fillOptions');
  if (!el) return;
  el.querySelectorAll('[data-field-name]').forEach(input => {
    const n = input.dataset.fieldName;
    if (input.type === 'checkbox') {
      _values[n] = input.checked ? (input.dataset.exportValue || 'Yes') : '';
    } else if (input.type === 'radio') {
      if (input.checked) _values[n] = input.value;
    } else {
      _values[n] = input.value;
    }
  });
}

function _updateProgress(root) {
  if (!root) return;
  const fillBar   = document.getElementById('fillProgressFill');
  const fillLabel = document.getElementById('fillDone');
  if (!fillBar || !fillLabel) return;
  const fillable = _fields.filter(f => f.type !== 'sig');
  const filled   = fillable.filter(f => _values[f.name] !== undefined && String(_values[f.name]).trim() !== '').length;
  const pct      = fillable.length > 0 ? Math.round((filled / fillable.length) * 100) : 0;
  fillBar.style.width   = `${pct}%`;
  fillLabel.textContent = String(filled);
}

// ── Draft persistence ─────────────────────────────────────────

function _defaultValues(fields) {
  const vals = {};
  for (const f of fields) { if (f.value) vals[f.name] = f.value; }
  return vals;
}

function _saveDraft(key, values) {
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(values)); } catch { /* quota */ }
}

function _loadDraft(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Utility ───────────────────────────────────────────────────

function _isTruthy(v) {
  return v && !['off', 'Off', 'false', '0', ''].includes(v);
}

function _titleCase(s) {
  return s.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ')
    .trim().replace(/^\w/, c => c.toUpperCase());
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Status HTML templates ─────────────────────────────────────

function _spinnerHTML(msg) {
  return `<div style="padding:24px 16px;text-align:center;color:var(--text3);font-size:14px;">
    <div style="font-size:24px;margin-bottom:8px;">⏳</div>${_esc(msg)}</div>`;
}

function _noFieldsHTML() {
  return `<div style="padding:20px 16px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
    <p style="margin:0 0 8px;font-weight:600;color:var(--text);">No fillable fields found</p>
    <p style="margin:0;font-size:13px;color:var(--text3);line-height:1.5;">
      This PDF doesn't have AcroForm fields. It may use the legacy XFA format
      (open in Adobe Acrobat) or it's a scanned/flat PDF — for those, use the
      <a href="/redact-pdf/" style="color:var(--green);">Redact / Annotate</a> tool to overlay text.
    </p>
  </div>`;
}

function _errorHTML(msg) {
  return `<div style="padding:16px;border:1px solid #fca5a5;border-radius:10px;background:#fff1f2;color:#dc2626;font-size:13px;">
    Could not read form fields: ${_esc(msg)}
  </div>`;
}
