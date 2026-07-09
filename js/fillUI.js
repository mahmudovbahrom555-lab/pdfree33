// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  fillUI.js — AcroForm PDF fill tool
//
//  Flow:
//    1. initFillOptions(file) — loads pdf.js, extracts Widget
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

import { id }                from './utils.js';
import { loadPdfJs }         from './pdf2jpgUI.js';
import { setButtonDisabled } from './ui.js';

// ── Saved signature ───────────────────────────────────────────
const _SIG_STORAGE_KEY = 'pdfree_saved_sig';

function _saveSignatureToStorage(dataUrl) {
  try { localStorage.setItem(_SIG_STORAGE_KEY, dataUrl); } catch (_e) { /* storage unavailable */ }
}

function _loadSignatureFromStorage() {
  try { return localStorage.getItem(_SIG_STORAGE_KEY); } catch { return null; }
}

// ── Module state ──────────────────────────────────────────────
let _fields      = [];
let _values      = {};
let _draftKey    = null;
let _sigImages   = {};   // fieldName → { dataUrl, rect, pageIndex }
let _sigModal    = null; // active signature pad DOM node
let _loading     = false; // true while _extractAndRender is in progress
let _generation  = 0;    // incremented on each new extraction; stale calls bail early

// ── Public API ────────────────────────────────────────────────

export function initFillOptions(file) {
  const el = id('fillOptions');
  if (!el) return;
  el.style.display = '';
  if (!file) { el.innerHTML = ''; return; }
  _extractAndRender(file, el);
}

export function hideFillOptions() {
  const el = id('fillOptions');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  _closeSigPad();
  _fields = []; _values = {}; _draftKey = null; _sigImages = {}; _loading = false; _generation++;
}

export function getFillParams() {
  _syncValuesFromDOM();
  return {
    fieldValues:     { ..._values },
    hasFields:       _fields.length > 0,
    sigImages:       { ..._sigImages },
    loading:         _loading,
    missingRequired: _validateRequired(),
    fieldMeta:       Object.fromEntries(
      _fields.map(f => [f.name, { editable: !!f.editable }])
    ),
    flatten:         document.getElementById('fillFlattenToggle')?.checked ?? true,
  };
}

// ── Field extraction ──────────────────────────────────────────

async function _extractAndRender(file, container) {
  _loading = true;
  const myGen = ++_generation;
  container.innerHTML = _spinnerHTML('Analysing form fields…');
  try {
    await loadPdfJs();
    if (myGen !== _generation) return; // superseded by newer upload
    if (!window.pdfjsLib) throw new Error('pdf.js renderer not available');

    const rawBuf = await file.arrayBuffer();
    const pdfDoc = await window.pdfjsLib.getDocument({
      data: new Uint8Array(rawBuf), useSystemFonts: false,
      verbosity: 0, disableJavaScript: true,
    }).promise;

    const raw = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      if (myGen !== _generation) return; // superseded mid-scan
      const page   = await pdfDoc.getPage(p);
      const annots = await page.getAnnotations();
      for (const a of annots) {
        if (a.subtype === 'Widget') raw.push({ ...a, _page: p });
      }
    }

    if (myGen !== _generation) return; // superseded after scan

    _fields = _processRawAnnotations(raw);
    _loading = false;

    if (_fields.length === 0) {
      container.innerHTML = _noFieldsHTML();
      setButtonDisabled();
      return;
    }

    _sigImages = {};
    _draftKey = `pdfree_fill_${file.name}_${file.size}_${file.lastModified}`;
    const draft = _loadDraft(_draftKey);
    _values = draft || _defaultValues(_fields);

    container.innerHTML = _buildFormHTML(_fields);
    _bindEvents(container);
    _applyValues(container);
    _updateProgress(container);

  } catch (err) {
    if (myGen !== _generation) return;
    _loading = false;
    container.innerHTML = _errorHTML(err.message);
    setButtonDisabled();
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

    if (a.readOnly) {
      const key = `${name}@${a._page}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push({
        name, type: 'text', label, page: a._page,
        readOnly: true, required: false,
        value: a.fieldValue || a.defaultValue || '',
      });
      continue;
    }

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
        value:    a.fieldValue || '',
        editable: !!(a.combo && a.editable),
        options:  (a.options || []).map(o => ({
          value: o.exportValue || String(o),
          label: o.displayValue || o.exportValue || String(o),
        })),
      });
      continue;
    }

    if (a.fieldType === 'Sig') {
      fields.push({
        name, type: 'sig', label, page: a._page, required: a.required || false,
        rect:      Array.from(a.rect || [0, 0, 200, 60]),
        pageIndex: a._page - 1,
      });
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
  const fillable    = fields.filter(f => f.type !== 'sig' && !f.readOnly);
  const totalFilled = fillable.filter(f => _values[f.name] !== undefined && String(_values[f.name]).trim() !== '').length
                    + Object.keys(_sigImages).length;
  const totalCount  = fields.filter(f => !f.readOnly).length;

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
          <strong id="fillDone">${totalFilled}</strong> / ${totalCount} filled
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

  html += `
    <div style="margin-top:16px;padding:12px 16px;background:var(--surface);
      border:1px solid var(--border);border-radius:10px;display:flex;align-items:center;gap:10px;">
      <input type="checkbox" id="fillFlattenToggle" checked
        style="width:18px;height:18px;accent-color:var(--green);cursor:pointer;flex-shrink:0;">
      <label for="fillFlattenToggle" style="font-size:13px;color:var(--text2);cursor:pointer;line-height:1.4;">
        Flatten fields
        <span style="color:var(--text3);font-size:12px;">(prevents editing after download)</span>
      </label>
    </div>`;

  html += `</div>`;
  return html;
}

function _fieldHTML(f) {
  const req = f.required ? '<span style="color:#dc2626;margin-left:3px;">*</span>' : '';

  if (f.readOnly) {
    const roBase = `width:100%;box-sizing:border-box;padding:11px 13px;
      border:1.5px solid var(--border);border-radius:8px;
      background:var(--bg-secondary,var(--surface));color:var(--text3);font-size:16px;
      font-family:inherit;cursor:not-allowed;opacity:0.65;`;
    return `<div>
      <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;
        letter-spacing:.4px;color:var(--text3);margin-bottom:5px;">
        ${_esc(f.label)}<span style="font-size:9px;margin-left:4px;opacity:0.6;text-transform:none;letter-spacing:0;">(read-only)</span>
      </label>
      <input type="text" disabled value="${_esc(f.value || '')}" style="${roBase}">
    </div>`;
  }

  const labelHTML = `<label for="fill_${_esc(f.name)}" style="
    display:block;font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:.4px;color:var(--text3);margin-bottom:5px;">
    ${_esc(f.label)}${req}
  </label>`;

  const baseStyle = `width:100%;box-sizing:border-box;padding:11px 13px;
    border:1.5px solid var(--border);border-radius:8px;
    background:var(--surface);color:var(--text);font-size:16px;
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
    return `<div data-radio-group="${_esc(f.name)}" style="padding:6px 0 4px;border-radius:8px;transition:outline .15s;">
      ${labelHTML}
      <div style="display:flex;flex-direction:column;gap:4px;padding:4px 0;">${opts}</div>
    </div>`;
  }

  if (f.type === 'select') {
    const opts = f.options.map(o =>
      `<option value="${_esc(o.value)}">`
    ).join('');
    if (f.editable) {
      const listId = `fill_opts_${_esc(f.name)}`;
      return `<div>
        ${labelHTML}
        <input type="text" id="fill_${_esc(f.name)}" data-field-name="${_esc(f.name)}"
          list="${listId}" autocomplete="off"
          style="${baseStyle}" placeholder="${_esc(f.label)}">
        <datalist id="${listId}">${opts}</datalist>
      </div>`;
    }
    const selectOpts = f.options.map(o =>
      `<option value="${_esc(o.value)}">${_esc(o.label)}</option>`
    ).join('');
    return `<div>
      ${labelHTML}
      <select id="fill_${_esc(f.name)}" data-field-name="${_esc(f.name)}"
        style="${baseStyle}appearance:auto;">
        <option value="">— Select —</option>
        ${selectOpts}
      </select>
    </div>`;
  }

  if (f.type === 'sig') {
    const rectJson = _esc(JSON.stringify(f.rect));
    return `<div>
      ${labelHTML}
      <button type="button"
        data-sig-field="${_esc(f.name)}"
        data-sig-rect="${rectJson}"
        data-sig-page="${f.pageIndex}"
        style="${baseStyle}cursor:pointer;display:flex;align-items:center;gap:10px;
          border-color:var(--border);color:var(--text2);justify-content:center;">
        <span style="font-size:20px;">✍️</span> Tap to sign
      </button>
      <p style="margin:4px 0 0;font-size:11px;color:var(--text3);line-height:1.4;">
        Visual signature — not a certified digital signature
      </p>
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
  container.removeEventListener('input',  _onInput);
  container.removeEventListener('change', _onInput);
  container.removeEventListener('click',  _onSigClick);
  container.addEventListener('input',  _onInput);
  container.addEventListener('change', _onInput);
  container.addEventListener('click',  _onSigClick);
}

function _onSigClick(e) {
  const btn = e.target.closest('[data-sig-field]');
  if (!btn) return;
  const fieldName = btn.dataset.sigField;
  const rect      = JSON.parse(btn.dataset.sigRect  || '[0,0,200,60]');
  const pageIndex = parseInt(btn.dataset.sigPage || '0', 10);
  _openSigPad(fieldName, rect, pageIndex);
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
  _updateProgress(input.closest('.fill-form') || input.closest('#fillOptions'));
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

function _validateRequired() {
  const container = id('fillOptions');
  const missing = [];
  for (const f of _fields) {
    if (!f.required || f.readOnly) continue;
    const isEmpty = f.type === 'sig'
      ? !_sigImages[f.name]
      : !_values[f.name] || String(_values[f.name]).trim() === '';
    if (isEmpty) missing.push(f.label);
    if (!container) continue;
    if (f.type === 'sig') {
      container.querySelectorAll('[data-sig-field]').forEach(b => {
        if (b.dataset.sigField === f.name) b.style.borderColor = isEmpty ? '#dc2626' : '';
      });
    } else if (f.type === 'radio') {
      try {
        const el = container.querySelector(`[data-radio-group="${CSS.escape(f.name)}"]`);
        if (el) el.style.outline = isEmpty ? '2px solid #dc2626' : '';
      } catch { /* field name not valid CSS selector — skip highlight */ }
    } else {
      try {
        const el = container.querySelector(`#fill_${CSS.escape(f.name)}`);
        if (el) el.style.borderColor = isEmpty ? '#dc2626' : '';
      } catch { /* field name not valid CSS identifier — skip highlight */ }
    }
  }
  return missing;
}

function _updateProgress(root) {
  if (!root) return;
  const fillBar   = document.getElementById('fillProgressFill');
  const fillLabel = document.getElementById('fillDone');
  if (!fillBar || !fillLabel) return;
  const fillable = _fields.filter(f => f.type !== 'sig' && !f.readOnly);
  const filled   = fillable.filter(f => _values[f.name] !== undefined && String(_values[f.name]).trim() !== '').length
                 + Object.keys(_sigImages).length;
  const total    = _fields.filter(f => !f.readOnly).length;
  const pct      = total > 0 ? Math.round((filled / total) * 100) : 0;
  fillBar.style.width   = `${pct}%`;
  fillLabel.textContent = String(filled);
}

// ── Signature pad ─────────────────────────────────────────────

function _openSigPad(fieldName, rect, pageIndex) {
  if (_sigModal) return;

  let _activeTab    = 'draw';
  let _uploadDataUrl = null;

  const isPortrait = window.innerHeight > window.innerWidth;

  // Canvas logical dimensions: always landscape (wide × short)
  // On portrait: W = screen height minus controls, H = screen width
  // CSS rotate(-90deg) makes this fill the portrait screen naturally
  const CTRL_H = 200;
  const logW   = isPortrait ? (window.innerHeight - CTRL_H) : (window.innerWidth  - CTRL_H);
  const logH   = isPortrait ?  window.innerWidth             :  window.innerHeight - CTRL_H;
  const typeH  = Math.max(80, Math.min(120, Math.round(logH * 0.45)));
  const dpr    = window.devicePixelRatio || 1;

  const savedSig    = _loadSignatureFromStorage();
  const useSavedBtn = savedSig ? `
    <button data-sig-action="use-saved"
      style="flex:1;padding:13px;background:#1a3a2a;color:#b6f5d0;border:none;border-radius:10px;
             font-size:13px;font-weight:500;cursor:pointer;">
      Use saved ↑
    </button>` : '';

  const _tabBtn = (t, active) =>
    `<button data-sig-tab="${t}" style="flex:1;padding:10px 4px;border:none;font-size:13px;` +
    `font-weight:${active ? '600' : '400'};cursor:pointer;` +
    `background:${active ? '#2D7A4F' : 'transparent'};color:${active ? '#fff' : '#888'};` +
    `transition:background .15s,color .15s;">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`;

  _sigModal = document.createElement('div');
  _sigModal.style.cssText = 'position:fixed;inset:0;background:#111;z-index:10000;display:flex;flex-direction:column;touch-action:none;overflow:hidden;';
  _sigModal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:#1a1a1a;flex-shrink:0;">
      <span style="color:#fff;font-size:15px;font-weight:600;">✍️ Sign here</span>
      <button data-sig-action="cancel" style="color:#aaa;background:none;border:none;font-size:22px;padding:4px 8px;cursor:pointer;line-height:1;">✕</button>
    </div>
    <div style="display:flex;background:#1a1a1a;border-top:1px solid #2a2a2a;flex-shrink:0;">
      ${_tabBtn('draw', true)}${_tabBtn('type', false)}${_tabBtn('upload', false)}
    </div>

    <!-- Draw panel -->
    <div id="_sigPanelDraw" style="flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;">
      <canvas id="_fillSigCanvas"
        style="background:#fff;border-radius:8px;touch-action:none;cursor:crosshair;display:block;
               ${isPortrait ? 'transform:rotate(-90deg);' : ''}
               width:${logW}px;height:${logH}px;">
      </canvas>
    </div>

    <!-- Type panel -->
    <div id="_sigPanelType" style="display:none;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:20px;gap:16px;overflow:hidden;">
      <input id="_sigTypeInput" type="text" placeholder="Type your name"
        style="width:100%;max-width:480px;padding:14px 16px;font-size:20px;border:none;border-radius:10px;
               text-align:center;background:#222;color:#fff;outline:none;box-sizing:border-box;">
      <canvas id="_fillSigTypeCanvas"
        style="background:#fff;border-radius:8px;display:block;max-width:100%;"
        width="${Math.round(logW * dpr)}" height="${Math.round(typeH * dpr)}">
      </canvas>
    </div>

    <!-- Upload panel -->
    <div id="_sigPanelUpload" style="display:none;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:20px;gap:16px;overflow:hidden;">
      <label id="_sigUploadLabel" style="width:100%;max-width:480px;border:2px dashed #444;border-radius:12px;
             padding:28px 20px;text-align:center;cursor:pointer;color:#888;font-size:14px;line-height:1.6;box-sizing:border-box;">
        Tap to choose a signature image
        <br><span style="font-size:12px;color:#555;">PNG, JPG, SVG</span>
        <input type="file" id="_sigUploadInput" accept="image/*" style="display:none;">
      </label>
      <img id="_sigUploadPreview" style="display:none;max-height:120px;max-width:100%;border-radius:8px;background:#fff;padding:8px;" alt="Signature preview">
    </div>

    <p id="_sigHint" style="text-align:center;color:#555;font-size:11px;padding:4px 0;margin:0;flex-shrink:0;">
      ${isPortrait ? 'Sign along the dashed line — draw left to right' : 'Sign along the dashed line'}
    </p>
    <div style="display:flex;gap:10px;padding:14px 20px;background:#1a1a1a;flex-shrink:0;">
      ${useSavedBtn}
      <button data-sig-action="clear" style="flex:1;padding:13px;background:#333;color:#fff;border:none;border-radius:10px;font-size:15px;cursor:pointer;">Clear</button>
      <button data-sig-action="save"  style="flex:1;padding:13px;background:#2D7A4F;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;">Done ✓</button>
    </div>
    <p style="text-align:center;color:#444;font-size:10px;padding:0 20px 12px;margin:0;line-height:1.5;flex-shrink:0;">
      Visual signature only — not a PKI digital signature.
    </p>`;
  document.body.appendChild(_sigModal);

  // ── Draw canvas ───────────────────────────────────────────────
  const canvas = document.getElementById('_fillSigCanvas');
  canvas.width  = logW * dpr;
  canvas.height = logH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, logW, logH);
  ctx.strokeStyle = '#111';
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  // Baseline guide — draw once on blank canvas
  const _baselineY = Math.round(logH * 0.68);
  function _drawBaseline() {
    ctx.save();
    ctx.strokeStyle = '#d0d0d0';
    ctx.lineWidth   = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(Math.round(logW * 0.06), _baselineY);
    ctx.lineTo(Math.round(logW * 0.94), _baselineY);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#111';
    ctx.lineWidth   = 2.5;
    ctx.setLineDash([]);
  }
  _drawBaseline();

  let drawing = false, lastX = 0, lastY = 0, lastMidX = 0, lastMidY = 0;

  function _coords(e) {
    const px = e.clientX, py = e.clientY;
    const r  = canvas.getBoundingClientRect();
    if (isPortrait) return { x: logW - (py - r.top), y: px - r.left };
    return { x: px - r.left, y: py - r.top };
  }

  canvas.addEventListener('pointerdown', e => {
    drawing = true;
    const { x, y } = _coords(e);
    lastX = lastMidX = x; lastY = lastMidY = y;
    ctx.beginPath();
    ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#111';
    ctx.fill();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    e.preventDefault();
    const { x, y } = _coords(e);
    const mx = (lastX + x) / 2, my = (lastY + y) / 2;
    ctx.beginPath();
    ctx.moveTo(lastMidX, lastMidY);
    ctx.quadraticCurveTo(lastX, lastY, mx, my);
    ctx.stroke();
    lastMidX = mx; lastMidY = my;
    lastX = x;     lastY = y;
  });
  canvas.addEventListener('pointerup',     () => { drawing = false; });
  canvas.addEventListener('pointercancel', () => { drawing = false; });

  // ── Type canvas ───────────────────────────────────────────────
  const typeCanvas = document.getElementById('_fillSigTypeCanvas');
  const typeCtx    = typeCanvas.getContext('2d');
  const typeW      = Math.round(logW * dpr);
  const typeH_px   = Math.round(typeH * dpr);
  typeCanvas.style.width  = `${logW}px`;
  typeCanvas.style.height = `${typeH}px`;

  function _renderType(text) {
    typeCtx.fillStyle = '#fff';
    typeCtx.fillRect(0, 0, typeW, typeH_px);
    if (!text.trim()) return;
    typeCtx.fillStyle    = '#111';
    typeCtx.font         = `italic ${Math.min(typeH_px * 0.55, 72)}px "Segoe Script","Brush Script MT","Apple Chancery","Comic Sans MS",cursive`;
    typeCtx.textBaseline = 'middle';
    typeCtx.textAlign    = 'center';
    typeCtx.fillText(text, typeW / 2, typeH_px / 2);
  }
  _renderType('');

  const typeInput = document.getElementById('_sigTypeInput');
  typeInput.addEventListener('input', () => _renderType(typeInput.value));

  // ── Upload panel ──────────────────────────────────────────────
  const uploadInput   = document.getElementById('_sigUploadInput');
  const uploadPreview = document.getElementById('_sigUploadPreview');
  const uploadLabel   = document.getElementById('_sigUploadLabel');

  uploadInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      _uploadDataUrl            = ev.target.result;
      uploadPreview.src         = _uploadDataUrl;
      uploadPreview.style.display = 'block';
      uploadLabel.style.borderColor = '#2D7A4F';
    };
    reader.readAsDataURL(file);
  });

  // ── Tab switching ─────────────────────────────────────────────
  const _hint = document.getElementById('_sigHint');

  function _switchTab(tab) {
    _activeTab = tab;
    for (const t of ['draw', 'type', 'upload']) {
      const panel  = document.getElementById(`_sigPanel${t.charAt(0).toUpperCase() + t.slice(1)}`);
      const btn    = _sigModal.querySelector(`[data-sig-tab="${t}"]`);
      const active = t === tab;
      if (panel) panel.style.display = active ? 'flex' : 'none';
      if (btn) {
        btn.style.background = active ? '#2D7A4F' : 'transparent';
        btn.style.color      = active ? '#fff'    : '#888';
        btn.style.fontWeight = active ? '600'     : '400';
      }
    }
    if (_hint) {
      _hint.textContent = tab === 'draw'
        ? 'Sign along the dashed line'
        : tab === 'type'   ? 'Type your name — preview updates live'
        : 'Upload a PNG, JPG, or SVG image of your signature';
    }
    if (tab === 'type') setTimeout(() => typeInput.focus(), 50);
  }

  // ── Event delegation ──────────────────────────────────────────
  _sigModal.addEventListener('click', e => {
    const tab    = e.target.closest('[data-sig-tab]')?.dataset.sigTab;
    const action = e.target.closest('[data-sig-action]')?.dataset.sigAction;

    if (tab) { _switchTab(tab); return; }
    if (!action) return;

    if (action === 'cancel') {
      _closeSigPad();

    } else if (action === 'clear') {
      if (_activeTab === 'draw') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, logW, logH);
        _drawBaseline();
      } else if (_activeTab === 'type') {
        typeInput.value = '';
        _renderType('');
        typeInput.focus();
      } else {
        _uploadDataUrl              = null;
        uploadPreview.style.display = 'none';
        uploadPreview.src           = '';
        uploadLabel.style.borderColor = '#444';
        uploadInput.value           = '';
      }

    } else if (action === 'use-saved' && savedSig) {
      _sigImages[fieldName] = { dataUrl: savedSig, rect, pageIndex };
      _closeSigPad();
      _updateSigBtn(fieldName, savedSig);

    } else if (action === 'save') {
      let dataUrl = null;

      if (_activeTab === 'draw') {
        if (_isSigEmpty(ctx, logW * dpr, logH * dpr)) {
          canvas.style.outline = '3px solid #dc2626';
          setTimeout(() => { if (canvas) canvas.style.outline = ''; }, 900);
          return;
        }
        dataUrl = _captureSig(canvas, logW * dpr, logH * dpr, isPortrait);

      } else if (_activeTab === 'type') {
        if (!typeInput.value.trim()) {
          typeInput.style.outline = '3px solid #dc2626';
          setTimeout(() => { if (typeInput) typeInput.style.outline = ''; }, 900);
          return;
        }
        dataUrl = typeCanvas.toDataURL('image/png');

      } else {
        if (!_uploadDataUrl) {
          uploadLabel.style.borderColor = '#dc2626';
          setTimeout(() => { if (uploadLabel) uploadLabel.style.borderColor = '#444'; }, 900);
          return;
        }
        dataUrl = _uploadDataUrl;
      }

      _saveSignatureToStorage(dataUrl);
      _sigImages[fieldName] = { dataUrl, rect, pageIndex };
      _closeSigPad();
      _updateSigBtn(fieldName, dataUrl);
    }
  });
}

function _closeSigPad() {
  if (_sigModal) { _sigModal.remove(); _sigModal = null; }
}

function _isSigEmpty(ctx, physW, physH) {
  const d = ctx.getImageData(0, 0, physW, physH).data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) return false;
  }
  return true;
}

function _captureSig(canvas, physW, physH, rotate90) {
  // If canvas was CSS-rotated, the logical pixel data is also rotated.
  // Rotate captured image +90deg (clockwise) to restore natural orientation.
  if (!rotate90) return canvas.toDataURL('image/png');
  const off = document.createElement('canvas');
  off.width  = physH;
  off.height = physW;
  const offCtx = off.getContext('2d');
  offCtx.translate(physH / 2, physW / 2);
  offCtx.rotate(Math.PI / 2);
  offCtx.drawImage(canvas, -physW / 2, -physH / 2);
  return off.toDataURL('image/png');
}

function _updateSigBtn(fieldName, dataUrl) {
  const el = id('fillOptions');
  if (!el) return;
  const btn = Array.from(el.querySelectorAll('[data-sig-field]'))
    .find(b => b.dataset.sigField === fieldName);
  if (btn) {
    btn.innerHTML = `<img src="${dataUrl}" style="height:28px;vertical-align:middle;border-radius:3px;margin-right:8px;"> Re-sign`;
    btn.style.borderColor = 'var(--green)';
    btn.style.color       = 'var(--text)';
  }
  _updateProgress(el);
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
