// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// priorityNav.js — collapses nav-links that don't fit into a "More" dropdown
// instead of letting the flexbox squeeze pills until their text wraps.
// Translated tool names (DE/ES/FR run longer than EN) used to wrap inside a
// pill and blow out the nav bar's height well before the 700px breakpoint
// where the existing horizontal-scroll strip takes over — this only runs
// above that breakpoint and leaves the scroll strip untouched below it.
(function () {
  var MIN_WIDTH_FOR_PRIORITY = 701;
  var GAP = 4;

  document.addEventListener('DOMContentLoaded', function () {
    var links = document.getElementById('navLinks');
    var more  = document.getElementById('navMore');
    if (!links || !more) return;

    var badge = more.querySelector('.nav-more__badge');
    var menu  = more.querySelector('.nav-more__menu');
    var items = Array.prototype.slice.call(links.querySelectorAll('.nav-link'));
    var widths = null;

    function measure() {
      items.forEach(function (el) { el.style.display = ''; });
      widths = items.map(function (el) { return el.getBoundingClientRect().width; });
    }

    function layout() {
      if (window.innerWidth < MIN_WIDTH_FOR_PRIORITY) {
        items.forEach(function (el) { el.style.display = ''; });
        more.style.visibility = 'hidden';
        return;
      }
      if (widths === null) measure();

      // Reserve the "More" button's width up front so links.clientWidth
      // never changes as a result of toggling the button itself — otherwise
      // hiding/showing it would shift the available width and could flip
      // the cutoff back and forth on every layout pass.
      more.style.visibility = 'hidden';
      var available = links.clientWidth;
      var total = 0, cut = items.length;
      for (var i = 0; i < items.length; i++) {
        total += widths[i] + (i > 0 ? GAP : 0);
        if (total > available) { cut = i; break; }
      }
      items.forEach(function (el, i) { el.style.display = i < cut ? '' : 'none'; });

      var overflow = items.slice(cut);
      if (overflow.length) {
        more.style.visibility = 'visible';
        badge.textContent = overflow.length;
        menu.innerHTML = overflow.map(function (el) {
          return '<a href="' + el.getAttribute('href') + '">' + el.innerHTML + '</a>';
        }).join('');
      } else {
        more.removeAttribute('open');
        menu.innerHTML = '';
      }
    }

    measure();
    layout();
    window.addEventListener('resize', layout);
  });
}());
