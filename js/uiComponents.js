// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  uiComponents.js — Shared HTML component factories
//
//  All tool UI modules (splitUI, compressUI, watermarkUI, …)
//  previously duplicated the same HTML snippets for chips,
//  sliders, checkboxes, and group labels.
//  This module is the single source for those components.
//
//  All functions are pure: (params) → HTML string.
//  No DOM side-effects — the caller owns innerHTML.
// ============================================================

// ── Chip (radio-button styled as pill) ────────────────────────

/**
 * Render a chip radio-button.
 * @param {string} name    radio group name
 * @param {string} value   this chip's value
 * @param {string} current currently selected value
 * @param {string} label   display text
 * @param {object} [opts]
 * @param {string} [opts.style]  extra inline style on the label
 * @param {string} [opts.radius] border-radius override (e.g. '8px')
 */
export function chip(name, value, current, label, opts = {}) {
  const style  = opts.style  ? ` style="${opts.style}"` : '';
  const radius = opts.radius ? ` style="border-radius:${opts.radius}"` : '';
  const active = current === value ? ' j2p-chip--active' : '';
  const checked = current === value ? ' checked' : '';
  return `<label class="j2p-chip${active}" data-value="${_esc(value)}" data-name="${_esc(name)}"${radius}${style}>
    <input type="radio" name="${_esc(name)}" value="${_esc(value)}"${checked}>
    ${label}
  </label>`;
}

/**
 * Render a group of chips.
 * @param {string} name       radio group name
 * @param {Array<{value,label}>} options
 * @param {string} current    currently selected value
 * @param {string} ariaLabel  accessible label for the group
 * @param {object} [opts]     passed through to chip()
 */
export function chipGroup(name, options, current, ariaLabel, opts = {}) {
  const style = opts.vertical ? ' style="flex-direction:column;align-items:flex-start"' : '';
  return `<div class="j2p-chips" role="group" aria-label="${_esc(ariaLabel)}"${style}>
    ${options.map(o => chip(name, o.value, current, o.label, opts)).join('\n    ')}
  </div>`;
}

// ── Slider row ────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.id         element id for the input
 * @param {string} opts.label      left label
 * @param {string} opts.valId      element id for the live value display
 * @param {string} opts.valText    initial value text (e.g. "80%")
 * @param {number} opts.min
 * @param {number} opts.max
 * @param {number} opts.step
 * @param {number} opts.value
 * @param {string} opts.ariaLabel
 */
export function sliderRow({ id, label, valId, valText, min, max, step, value, ariaLabel, containerId, style = '' }) {
  const containerStyle = style ? ` style="${style}"` : '';
  const containerIdAttr = containerId ? ` id="${_esc(containerId)}"` : '';
  return `<div class="j2p-quality-row"${containerIdAttr}${containerStyle}>
    <div class="j2p-quality-header">
      <span>${label}</span>
      <span class="j2p-quality-val" id="${_esc(valId)}">${valText}</span>
    </div>
    <input type="range" id="${_esc(id)}" class="j2p-quality-slider"
           min="${min}" max="${max}" step="${step}" value="${value}"
           aria-label="${_esc(ariaLabel)}">
  </div>`;
}

// ── Checkbox (styled with custom box) ─────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.id        element id
 * @param {boolean} opts.checked
 * @param {string} opts.title     bold text
 * @param {string} opts.subtitle  small text below
 * @param {string} [opts.style]   extra style on the label
 * @param {string} [opts.ariaLabel]
 */
export function checkbox({ id, checked, title, subtitle, style = '', ariaLabel }) {
  const styleAttr = style ? ` style="${style}"` : '';
  const aria      = ariaLabel ? ` aria-label="${_esc(ariaLabel)}"` : '';
  return `<div class="ui-toggle-row"${styleAttr}>
    <div class="ui-toggle-label">
      <strong>${title}</strong>
      ${subtitle ? `<small>${subtitle}</small>` : ''}
    </div>
    <label class="j2p-toggle"${aria}>
      <input type="checkbox" id="${_esc(id)}"${checked ? ' checked' : ''}>
      <span class="j2p-toggle__track"></span>
      <span class="j2p-toggle__thumb"></span>
    </label>
  </div>`;
}

// ── Label + group wrapper ─────────────────────────────────────

/**
 * Wraps a label + content in a .j2p-group div.
 * @param {string} label   section label
 * @param {string} content inner HTML
 * @param {string} [style] extra inline style
 */
export function group(label, content, style = '') {
  const styleAttr = style ? ` style="${style}"` : '';
  return `<div class="j2p-group"${styleAttr}>
    <div class="j2p-group__label">${label}</div>
    ${content}
  </div>`;
}

/**
 * Two-column .j2p-row
 */
export function row(...groups) {
  return `<div class="j2p-row">${groups.join('\n')}</div>`;
}

// ── Info banner ───────────────────────────────────────────────

/**
 * Compact info strip (green-light background).
 * @param {string} html  inner content
 * @param {'info'|'warn'|'found'|'clean'} [variant]
 */
export function infoBanner(html, variant = 'info') {
  const cls = variant === 'warn'  ? 'meta-notice'
            : variant === 'found' ? 'compress-scan compress-scan--found'
            : variant === 'clean' ? 'compress-scan compress-scan--clean'
            :                       'compress-info';
  return `<div class="${cls}" role="status">${html}</div>`;
}

// ── Spinner / loading ─────────────────────────────────────────

export function loadingRow(text = 'Loading…') {
  return `<div class="compress-loading">
    <span class="compress-loading__spinner" aria-hidden="true"></span>
    ${text}
  </div>`;
}

// ── Helpers ───────────────────────────────────────────────────

function _esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
