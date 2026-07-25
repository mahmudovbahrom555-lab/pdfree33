// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// sdk-waitlist.js — waitlist form on /pdf-sdk/, posts to the existing
// /api/feedback Telegram relay with type=waitlist (see src/index.js).
(function () {
  document.addEventListener('DOMContentLoaded', function () {
    const form = document.getElementById('waitlistForm');
    if (!form) return;

    const emailInput = document.getElementById('waitlistEmail');
    const textInput = document.getElementById('waitlistText');
    const hpInput = document.getElementById('waitlistHp');
    const statusEl = document.getElementById('waitlistStatus');
    const submitBtn = document.getElementById('waitlistSubmit');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const email = emailInput.value.trim();
      if (!email) return;

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'waitlist',
          email: email,
          text: textInput.value.trim(),
          hp: hpInput.value,
          tool: 'sdk-landing',
          url: location.href,
        }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('bad response');
          statusEl.textContent = "You're on the list — we'll email you when it's ready.";
          statusEl.style.color = 'var(--green)';
          form.reset();
          submitBtn.textContent = 'Joined ✓';
        })
        .catch(function () {
          statusEl.textContent = 'Something went wrong — please try again.';
          statusEl.style.color = '#c0392b';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Join the waitlist';
        });
    });
  });
})();
