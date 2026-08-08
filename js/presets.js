// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  presets.js — "Remember my settings" via localStorage
//
//  One JSON blob per tool, keyed pdfree.preset.<tool>. Never stores
//  passwords or file bytes — each tool's registerTool() call in
//  toolRegistrations.js supplies a presetFilter() that strips anything
//  unsafe or document-specific before it reaches savePreset(). See
//  toolRegistry.js's descriptor shape comment for presetFilter's contract.
// ============================================================

const _key = tool => `pdfree.preset.${tool}`;

/** @param {string} tool  @param {object} params — already filtered, safe to persist */
export function savePreset(tool, params) {
  try {
    localStorage.setItem(_key(tool), JSON.stringify(params));
  } catch {
    // Storage full, disabled by the browser, or private-mode quirks — the
    // feature degrades to "doesn't remember", never a crash.
  }
}

/** @param {string} tool  @returns {object|null} */
export function loadPreset(tool) {
  try {
    const raw = localStorage.getItem(_key(tool));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** @param {string} tool */
export function clearPreset(tool) {
  try {
    localStorage.removeItem(_key(tool));
  } catch {
    // ignore
  }
}

/** @param {string} tool  @returns {boolean} */
export function hasPreset(tool) {
  return loadPreset(tool) !== null;
}
