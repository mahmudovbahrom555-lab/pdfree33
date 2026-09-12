// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// enterprise-waitlist.js — lead-capture form on /enterprise-pdf-tools/,
// posts to the existing /api/feedback Telegram relay with type=waitlist
// (see src/index.js) — same relay js/sdk-waitlist.js uses for /pdf-sdk/,
// distinguished in the Telegram message by the `tool` field below rather
// than a new feedback type (avoids touching src/index.js's
// _FEEDBACK_TYPES/_TYPE_LABEL for what's otherwise an identical mechanism).
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
          tool: 'enterprise-landing',
          url: location.href,
        }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('bad response');
          statusEl.textContent = "Got it — we'll reply by email.";
          statusEl.style.color = 'var(--green)';
          form.reset();
          submitBtn.textContent = 'Sent ✓';
        })
        .catch(function () {
          statusEl.textContent = 'Something went wrong — please try again.';
          statusEl.style.color = '#c0392b';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Get in touch';
        });
    });
  });
})();
