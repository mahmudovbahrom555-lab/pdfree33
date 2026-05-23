// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// theme.js — synchronous theme init (no defer!) + toggle button wiring
// Runs before first paint so stored preference is applied without FOUC.

(function () {
  const stored = localStorage.getItem('pdfree-theme');
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.dataset.theme = stored;
  }

  function _isDark() {
    const t = document.documentElement.dataset.theme;
    return t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const next = _isDark() ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('pdfree-theme', next);
    });
  });
}());
