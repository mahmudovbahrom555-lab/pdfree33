// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  toolRegistry.js — Single Source of Truth for Tools
//
//  Each tool registers itself here. app.js and processor.js
//  use the registry instead of hard-coded if-else chains.
//
//  Adding a new tool now means:
//    1. Add a TOOLS entry in config.js
//    2. Create a UI module and register it here
//    3. Add a handler in worker.js (if needed)
//    That's it. No touching app.js or processor.js chains.
//
//  Registry descriptor shape:
//  {
//    // UI lifecycle
//    init?:      (file|files) => Promise<void>   — called when files added
//    hide?:      () => void                      — called on tool switch / reset
//    getParams?: () => object                    — called before doProcess
//    validate?:  (params) => string|null         — error message or null if ok
//
//    // Processor routing
//    runner:     'merge'|'split'|'compress'|'jpg2pdf'
//               |'pdf2jpg'|'worker'|string  — key into runnerMap in processor.js
//               Adding a new runner type = add entry to runnerMap in processor.js
//               Adding a new tool using existing runner = only toolRegistrations.js
//    workerTool?: string  — worker switch-case name (only when runner='worker')
//    multiFile?: boolean  — init receives array instead of single file
//    minFiles?:  number   — for multi-file init (default 1)
//  }
// ============================================================

/** @type {Map<string, object>} */
const _registry = new Map();

/**
 * Register a tool descriptor.
 * @param {string} key — must match TOOLS key in config.js
 * @param {object} descriptor
 */
export function registerTool(key, descriptor) {
  _registry.set(key, descriptor);
}

/** @returns {object|undefined} */
export function getToolDescriptor(key) {
  return _registry.get(key);
}

/** Run hide() on all registered tools */
export function hideAllToolOptions() {
  for (const desc of _registry.values()) {
    desc.hide?.();
  }
}

/**
 * Call the appropriate init for the currently active tool.
 * @param {string} key
 * @param {File[]} files  — current selectedFiles array
 */
export function initToolOptions(key, files) {
  const desc = _registry.get(key);
  if (!desc?.init) return;
  const minFiles = desc.minFiles ?? 1;
  if (files.length < minFiles) return;
  if (desc.multiFile) {
    desc.init([...files]);
  } else {
    desc.init(files[0]);
  }
}

/**
 * Collect params + validate for the active tool.
 * @returns {{ params: object|null, error: string|null }}
 */
export function collectToolParams(key) {
  const desc = _registry.get(key);
  if (!desc?.getParams) return { params: {}, error: null };
  const params = desc.getParams();
  const error  = desc.validate ? desc.validate(params) : null;
  return { params, error };
}

/**
 * Map tool key → processor runner name.
 * Returns the runner string from the descriptor.
 * @param {string} key
 * @returns {string}
 */
export function getRunner(key) {
  return _registry.get(key)?.runner ?? 'stub';
}

/**
 * Returns the worker tool name for runner='worker' tools.
 * @param {string} key
 * @returns {string|undefined}
 */
export function getWorkerTool(key) {
  return _registry.get(key)?.workerTool;
}
