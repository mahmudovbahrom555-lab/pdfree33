// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// theme.js — synchronous theme init (no defer!) + toggle button wiring
// Runs before first paint so stored preference is applied without FOUC.

(function () {
  const MOON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const SUN  = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>';

  const stored = localStorage.getItem('pdfree-theme');
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.dataset.theme = stored;
  }

  function _isDark() {
    const t = document.documentElement.dataset.theme;
    return t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function _updateBtn(btn) {
    btn.innerHTML = _isDark() ? SUN : MOON;
    btn.setAttribute('aria-label', _isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  }

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    _updateBtn(btn);
    btn.addEventListener('click', function () {
      const next = _isDark() ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('pdfree-theme', next);
      _updateBtn(btn);
    });
  });
}());
