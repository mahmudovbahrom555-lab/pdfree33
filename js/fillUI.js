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
import { t, tp }             from './i18n.js';
import { bindDragReorder }   from './dragReorder.js';

// Locale-correct slug for the "Redact / Annotate" cross-link in the
// no-fillable-fields hint below. This module is shared across every locale's
// page, and the Redact PDF tool is served at a translated pathname in every
// non-English locale — a bare '/redact-pdf/' href resolves to the English
// page regardless of which locale the user is on. Mirrors the per-locale
// slugs in data/tools-config.json (same table/pattern as the fix in
// js/ocrUI.js).
const REDACT_SLUGS = { en: 'redact-pdf', de: 'pdf-schwaerzen', es: 'censurar-pdf', fr: 'censurer-pdf', pt: 'censurar-pdf', id: 'hapus-teks-pdf', vi: 'xoa-van-ban-pdf', ru: 'skryt-tekst-pdf', ja: 'pdf-kurotsubushi', tr: 'pdf-gizle', it: 'oscura-pdf', ko: 'pdf-garigi', nl: 'pdf-zwartmaken', pl: 'zaczernij-pdf' };
const KNOWN_LOCALES = new Set(['de', 'es', 'fr', 'pt', 'id', 'vi', 'ru', 'ja', 'it', 'ko', 'nl', 'pl', 'tr']);

function _redactHref() {
  const seg = location.pathname.split('/')[1];
  const lc  = KNOWN_LOCALES.has(seg) ? seg : 'en';
  const slug = REDACT_SLUGS[lc] || REDACT_SLUGS.en;
  return lc === 'en' ? `/${slug}/` : `/${lc}/${slug}/`;
}

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

// ── Custom tab order ──────────────────────────────────────────
// null: no reorder requested (default — output keeps the PDF's original
// tab order). 'auto': fillOrderWorker sorts by visual position, no
// _fieldOrder needed. 'manual': _fieldOrder (below) is the user's
// drag-arranged field-NAME order, sent as-is to the worker.
let _tabOrderMode = null;   // null | 'auto' | 'manual'
let _fieldOrder   = [];     // field names, manual mode only

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
  _tabOrderMode = null; _fieldOrder = [];
}

// Called via the 'fill' tool's onSuccess hook (toolRegistrations.js) once the
// filled PDF has actually downloaded — the draft's job (surviving an accidental
// tab close mid-fill) is done, and this tool can carry real PII (name/email/SSN,
// see _detectInputMeta), so it shouldn't linger in localStorage indefinitely
// after a successful export. Without this, drafts previously never expired.
export function clearFillDraft() {
  if (!_draftKey) return;
  try { localStorage.removeItem(_draftKey); } catch { /* storage unavailable */ }
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
    tabOrderMode:    _tabOrderMode,
    tabOrder:        _tabOrderMode === 'manual' ? [..._fieldOrder] : undefined,
  };
}

// ── Field extraction ──────────────────────────────────────────

async function _extractAndRender(file, container) {
  _loading = true;
  const myGen = ++_generation;
  container.innerHTML = _spinnerHTML(t('fill_analysing'));
  try {
    await loadPdfJs();
    if (myGen !== _generation) return; // superseded by newer upload
    if (!window.pdfjsLib) throw new Error(t('fill_pdfjs_unavailable'));

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
    _tabOrderMode = null;
    _fieldOrder = [];
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
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : t('fill_field_fallback');
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
          <strong id="fillDone">${totalFilled}</strong> ${t('fill_progress_suffix', { total: totalCount })}
        </span>
      </div>`;

  for (const page of pages) {
    if (multiPage) {
      html += `<details open style="margin-top:12px;border:1px solid var(--border);border-radius:10px;overflow:hidden;">
        <summary style="padding:12px 16px;cursor:pointer;font-weight:600;font-size:14px;background:var(--surface);list-style:none;display:flex;align-items:center;gap:8px;">
          <span>📄</span> ${t('rot_page_aria', { n: page })}
          <span style="margin-left:auto;font-size:12px;font-weight:400;color:var(--text3);">${tp(byPage[page].length, 'fill_fields_count_one', 'fill_fields_count_many', { n: byPage[page].length })}</span>
        </summary>
        <div style="padding:12px 16px;display:flex;flex-direction:column;gap:14px;">`;
    } else {
      html += `<div style="margin-top:12px;display:flex;flex-direction:column;gap:14px;">`;
    }

    for (const f of byPage[page]) html += _fieldHTML(f);

    html += multiPage ? `</div></details>` : `</div>`;
  }

  html += `
    <label style="margin-top:16px;padding:12px 16px;background:var(--surface);
      border:1px solid var(--border);border-radius:10px;display:flex;align-items:center;gap:10px;cursor:pointer;">
      <input type="checkbox" id="fillFlattenToggle" checked
        style="width:18px;height:18px;accent-color:var(--green);cursor:pointer;flex-shrink:0;">
      <span style="font-size:13px;color:var(--text2);line-height:1.4;">
        ${t('fill_flatten_label')}
        <span style="color:var(--text3);font-size:12px;">${t('fill_flatten_hint')}</span>
      </span>
    </label>`;

  html += _tabOrderBlockHTML(fields);

  html += `</div>`;
  return html;
}

// ── Custom tab order ─────────────────────────────────────────

function _tabOrderModeBtn(mode, label) {
  const active = _tabOrderMode === mode;
  return `<button type="button" data-tab-order-mode="${mode}" style="
    padding:8px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;
    border:1.5px solid ${active ? 'var(--green)' : 'var(--border)'};
    background:${active ? 'var(--green-light)' : 'var(--surface)'};
    color:${active ? 'var(--green)' : 'var(--text2)'};">${label}</button>`;
}

function _tabOrderBlockHTML(fields) {
  const orderable = fields.length > 1;
  if (!orderable) return '';
  return `
    <div id="fillTabOrderBlock" style="margin-top:12px;padding:12px 16px;background:var(--surface);
      border:1px solid var(--border);border-radius:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div>
          <p style="margin:0;font-size:13px;font-weight:600;color:var(--text);">${t('fill_tab_order_label')}</p>
          <p style="margin:2px 0 0;font-size:12px;color:var(--text3);">${t('fill_tab_order_hint')}</p>
        </div>
        <div style="display:flex;gap:6px;">
          ${_tabOrderModeBtn('auto', t('fill_tab_order_auto'))}
          ${_tabOrderModeBtn('manual', t('fill_tab_order_manual'))}
        </div>
      </div>
      ${_tabOrderMode ? `<p style="margin:8px 0 0;font-size:11px;color:var(--text3);">${t('fill_tab_order_flatten_note')}</p>` : ''}
      <div id="fillTabOrderList" style="margin-top:12px;${_tabOrderMode === 'manual' ? '' : 'display:none;'}">
        ${_tabOrderMode === 'manual' ? _fieldOrderListHTML() : ''}
      </div>
    </div>`;
}

function _fieldOrderListHTML() {
  return `<div style="display:flex;flex-direction:column;gap:6px;">
    ${_fieldOrder.map((name, i) => {
      const f = _fields.find(x => x.name === name);
      return `<div class="fill-order-item" data-i="${i}" draggable="true" style="
        display:flex;align-items:center;gap:10px;padding:9px 12px;
        border:1.5px solid var(--border);border-radius:8px;background:var(--bg,var(--surface));
        cursor:grab;font-size:13px;color:var(--text);">
        <span aria-hidden="true" style="color:var(--text3);font-size:14px;">☰</span>
        <span style="flex:1;">${_esc(f ? f.label : name)}</span>
      </div>`;
    }).join('')}
  </div>`;
}

function _bindFieldOrderDrag() {
  const list = document.getElementById('fillTabOrderList');
  if (!list) return;
  bindDragReorder({
    container:    list,
    itemSelector: '.fill-order-item',
    arrays:       [_fieldOrder],
    onReorder:    () => { list.innerHTML = _fieldOrderListHTML(); _bindFieldOrderDrag(); },
    mode:         'list',
  });
}

function _setTabOrderMode(mode, container) {
  _tabOrderMode = _tabOrderMode === mode ? null : mode; // click active mode again to turn off

  if (_tabOrderMode === 'manual' && _fieldOrder.length === 0) {
    _fieldOrder = _fields.map(f => f.name);
  }

  // A flattened PDF has no interactive fields left at all — reordering
  // tab order would have zero visible effect in the output. Auto-uncheck
  // so the feature isn't silently a no-op behind the default-on checkbox.
  if (_tabOrderMode) {
    const flattenBox = container.querySelector('#fillFlattenToggle');
    if (flattenBox) flattenBox.checked = false;
  }

  const block = container.querySelector('#fillTabOrderBlock');
  if (!block) return;
  block.outerHTML = _tabOrderBlockHTML(_fields);
  if (_tabOrderMode === 'manual') _bindFieldOrderDrag();
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
        ${_esc(f.label)}<span style="font-size:9px;margin-left:4px;opacity:0.6;text-transform:none;letter-spacing:0;">${t('fill_readonly_suffix')}</span>
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
    // A single wrapping <label> (not a <div> + separate <input>/<label for>) so
    // the whole row is the tap target — the previous version measured 22x22px
    // on the checkbox itself, below WCAG 2.5.8's 24px minimum, confirmed live.
    return `<label style="display:flex;align-items:center;gap:12px;padding:6px 0;min-height:24px;cursor:pointer;">
      <input type="checkbox" id="fill_${_esc(f.name)}"
        data-field-name="${_esc(f.name)}" data-export-value="${_esc(f.exportValue)}"
        style="width:22px;height:22px;min-width:22px;accent-color:var(--green);cursor:pointer;">
      <span style="font-size:15px;line-height:1.4;">
        ${_esc(f.label)}${req}
      </span>
    </label>`;
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
        <option value="">${t('fill_select_placeholder')}</option>
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
        <span style="font-size:20px;">✍️</span> ${t('fill_tap_to_sign')}
      </button>
      <p style="margin:4px 0 0;font-size:11px;color:var(--text3);line-height:1.4;">
        ${t('fill_sig_disclaimer')}
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
  container.removeEventListener('click',  _onTabOrderClick);
  container.addEventListener('input',  _onInput);
  container.addEventListener('change', _onInput);
  container.addEventListener('click',  _onSigClick);
  container.addEventListener('click',  _onTabOrderClick);
}

function _onSigClick(e) {
  const btn = e.target.closest('[data-sig-field]');
  if (!btn) return;
  const fieldName = btn.dataset.sigField;
  const rect      = JSON.parse(btn.dataset.sigRect  || '[0,0,200,60]');
  const pageIndex = parseInt(btn.dataset.sigPage || '0', 10);
  _openSigPad(fieldName, rect, pageIndex);
}

function _onTabOrderClick(e) {
  const btn = e.target.closest('[data-tab-order-mode]');
  if (!btn) return;
  const container = id('fillOptions');
  if (container) _setTabOrderMode(btn.dataset.tabOrderMode, container);
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
  const baselineY = Math.round(logH * 0.68);
  const baselineInsetX = Math.round(logW * 0.06);

  const savedSig    = _loadSignatureFromStorage();
  const useSavedBtn = savedSig ? `
    <button data-sig-action="use-saved"
      style="flex:1;padding:13px;background:#1a3a2a;color:#b6f5d0;border:none;border-radius:10px;
             font-size:13px;font-weight:500;cursor:pointer;">
      ${t('fill_use_saved')}
    </button>` : '';

  const TAB_LABELS = { draw: t('fill_tab_draw'), type: t('fill_tab_type'), upload: t('fill_tab_upload') };
  const _tabBtn = (tab, active) =>
    `<button data-sig-tab="${tab}" style="flex:1;padding:10px 4px;border:none;font-size:13px;` +
    `font-weight:${active ? '600' : '400'};cursor:pointer;` +
    `background:${active ? '#2D7A4F' : 'transparent'};color:${active ? '#fff' : '#888'};` +
    `transition:background .15s,color .15s;">${TAB_LABELS[tab]}</button>`;

  _sigModal = document.createElement('div');
  _sigModal.style.cssText = 'position:fixed;inset:0;background:#111;z-index:10000;display:flex;flex-direction:column;touch-action:none;overflow:hidden;';
  _sigModal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:#1a1a1a;flex-shrink:0;">
      <span style="color:#fff;font-size:15px;font-weight:600;">✍️ ${t('fill_sign_here')}</span>
      <button data-sig-action="cancel" style="color:#aaa;background:none;border:none;font-size:22px;padding:4px 8px;cursor:pointer;line-height:1;">✕</button>
    </div>
    <div style="display:flex;background:#1a1a1a;border-top:1px solid #2a2a2a;flex-shrink:0;">
      ${_tabBtn('draw', true)}${_tabBtn('type', false)}${_tabBtn('upload', false)}
    </div>

    <!-- Draw panel -->
    <div id="_sigPanelDraw" style="flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;">
      <div id="_sigCanvasWrap" style="position:relative;overflow:hidden;background:#fff;border-radius:8px;
             width:${logW}px;height:${logH}px;
             ${isPortrait ? 'transform:rotate(-90deg);' : ''}">
        <div style="position:absolute;left:${baselineInsetX}px;right:${baselineInsetX}px;top:${baselineY}px;
               border-top:1px dashed #d0d0d0;pointer-events:none;"></div>
        <canvas id="_fillSigCanvas"
          style="position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair;display:block;">
        </canvas>
      </div>
    </div>

    <!-- Type panel -->
    <div id="_sigPanelType" style="display:none;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:20px;gap:16px;overflow:hidden;">
      <input id="_sigTypeInput" type="text" placeholder="${t('fill_type_placeholder')}"
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
        ${t('fill_upload_tap')}
        <br><span style="font-size:12px;color:#555;">${t('fill_upload_formats')}</span>
        <input type="file" id="_sigUploadInput" accept="image/*" style="display:none;">
      </label>
      <img id="_sigUploadPreview" style="display:none;max-height:120px;max-width:100%;border-radius:8px;background:#fff;padding:8px;" alt="Signature preview">
    </div>

    <p id="_sigHint" style="text-align:center;color:#555;font-size:11px;padding:4px 0;margin:0;flex-shrink:0;">
      ${isPortrait ? t('fill_hint_draw_portrait') : t('fill_hint_draw')}
    </p>
    <div style="display:flex;gap:10px;padding:14px 20px;background:#1a1a1a;flex-shrink:0;">
      ${useSavedBtn}
      <button data-sig-action="clear" style="flex:1;padding:13px;background:#333;color:#fff;border:none;border-radius:10px;font-size:15px;cursor:pointer;">${t('ext_clear')}</button>
      <button data-sig-action="save"  style="flex:1;padding:13px;background:#2D7A4F;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;">${t('fill_done_btn')}</button>
    </div>
    <p style="text-align:center;color:#444;font-size:10px;padding:0 20px 12px;margin:0;line-height:1.5;flex-shrink:0;">
      ${t('fill_sig_disclaimer_footer')}
    </p>`;
  document.body.appendChild(_sigModal);

  // ── Draw canvas ───────────────────────────────────────────────
  const canvas = document.getElementById('_fillSigCanvas');
  canvas.width  = logW * dpr;
  canvas.height = logH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.strokeStyle = '#111';
  ctx.lineWidth   = 2.5;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  // Canvas stays transparent — the baseline guide lives on a CSS layer
  // behind it (see _sigCanvasWrap above), so ink capture and the
  // empty-signature check only ever see actual strokes.

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
        ? t('fill_hint_draw')
        : tab === 'type'   ? t('fill_hint_type')
        : t('fill_hint_upload');
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
        ctx.clearRect(0, 0, logW, logH);
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
  // Canvas is transparent except for actual ink strokes — any drawn
  // pixel has non-zero alpha, so scanning alpha is sufficient (and
  // unlike a color threshold, it isn't tripped by the CSS baseline
  // guide, which lives outside the canvas).
  const d = ctx.getImageData(0, 0, physW, physH).data;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > 10) return false;
  }
  return true;
}

function _captureSig(canvas, physW, physH, rotate90) {
  // Composite onto an opaque white background — the source canvas is
  // transparent (baseline guide lives on a CSS layer, not the bitmap).
  // If CSS-rotated, also rotate +90deg (clockwise) to restore natural orientation.
  const off = document.createElement('canvas');
  off.width  = rotate90 ? physH : physW;
  off.height = rotate90 ? physW : physH;
  const offCtx = off.getContext('2d');
  offCtx.fillStyle = '#fff';
  offCtx.fillRect(0, 0, off.width, off.height);
  if (rotate90) {
    offCtx.translate(physH / 2, physW / 2);
    offCtx.rotate(Math.PI / 2);
    offCtx.drawImage(canvas, -physW / 2, -physH / 2);
  } else {
    offCtx.drawImage(canvas, 0, 0);
  }
  return off.toDataURL('image/png');
}

function _updateSigBtn(fieldName, dataUrl) {
  const el = id('fillOptions');
  if (!el) return;
  const btn = Array.from(el.querySelectorAll('[data-sig-field]'))
    .find(b => b.dataset.sigField === fieldName);
  if (btn) {
    btn.innerHTML = `<img src="${dataUrl}" style="height:28px;vertical-align:middle;border-radius:3px;margin-right:8px;"> ${t('fill_re_sign')}`;
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
    <p style="margin:0 0 8px;font-weight:600;color:var(--text);">${t('fill_no_fields_title')}</p>
    <p style="margin:0;font-size:13px;color:var(--text3);line-height:1.5;">
      ${t('fill_no_fields_body')}
      <a href="${_redactHref()}" style="color:var(--green-text);">${t('fill_no_fields_link')}</a>${t('fill_no_fields_suffix')}
    </p>
  </div>`;
}

function _errorHTML(msg) {
  return `<div style="padding:16px;border:1px solid #fca5a5;border-radius:10px;background:#fff1f2;color:#dc2626;font-size:13px;">
    ${t('fill_error_prefix', { msg: _esc(msg) })}
  </div>`;
}
