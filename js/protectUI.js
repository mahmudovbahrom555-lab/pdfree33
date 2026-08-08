// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  protectUI.js — Protect PDF options panel
//
//  Layout: two columns — Passwords (left) · Permissions (right)
//  Features:
//    · User password (open document)
//    · Owner password (change restrictions) — auto-generated if blank
//    · Show/hide toggles on both fields
//    · Live password strength bar (entropy-based, not just length)
//    · Crypto password generator
//    · Three presets: Open / Read-only / Fort Knox
//    · Six permission checkboxes
//    · DOM cleared immediately on submit (password never lingers)
// ============================================================

import { id }        from './utils.js';
import { showToast } from './ui.js';
import { group, infoBanner, checkbox } from './uiComponents.js';
import { t } from './i18n.js';
import { loadPreset, clearPreset } from './presets.js';

// ── State ──────────────────────────────────────────────────────
const _state = {
  printing:     true,
  modifying:    true,
  copying:      true,
  annotating:   true,
  fillingForms: true,
  assembly:     true,
};

let _userPwd  = '';
let _ownerPwd = '';
let _rememberLoaded = false; // "Remember my settings" applied once per tool session

// ── Public API ─────────────────────────────────────────────────

export function initProtectOptions() {
  // Restore saved permission toggles once per tool session — passwords are
  // never part of the saved preset (see presetFilter in toolRegistrations.js
  // and the "never caches passwords" note on getProtectParams above).
  if (!_rememberLoaded) {
    _rememberLoaded = true;
    const saved = loadPreset('protect');
    if (saved?.permissions) Object.assign(_state, saved.permissions);
  }

  const container = id('protectOptions');
  if (!container) return;
  container.style.display = 'block';
  _render(container);
}

export function hideProtectOptions() {
  const container = id('protectOptions');
  if (!container) return;
  container.style.display = 'none';
  // Wipe state — paranoid but right
  _userPwd  = '';
  _ownerPwd = '';
  _rememberLoaded = false;
  container.innerHTML = '';
}

export function getProtectParams() {
  // Passwords are read from DOM here so caller owns the timing.
  // protectUI never caches passwords across async gaps.
  const userInput  = id('protUserPwd');
  const ownerInput = id('protOwnerPwd');

  const userPassword  = (userInput?.value  || '').normalize('NFC');
  const ownerPassword = (ownerInput?.value || '').normalize('NFC');

  // Wipe DOM immediately — don't wait for worker to finish
  if (userInput)  userInput.value  = '';
  if (ownerInput) ownerInput.value = '';
  _userPwd  = '';
  _ownerPwd = '';

  // Auto-generate owner password if user set permissions but left it blank.
  // Without an owner password, Acrobat ignores the permission bits entirely.
  const effectiveOwner = ownerPassword || _generatePassword(20);

  return {
    userPassword,
    ownerPassword: effectiveOwner,
    permissions: {
      printing:             _state.printing  ? 'highResolution' : false,
      modifying:            _state.modifying,
      copying:              _state.copying,
      annotating:           _state.annotating,
      fillingForms:         _state.fillingForms,
      contentAccessibility: true,   // always on — required by accessibility law
      documentAssembly:     _state.assembly,
    },
  };
}

// ── Presets ────────────────────────────────────────────────────

function _applyPreset(preset) {
  if (preset === 'open') {
    // Password required to open, but all operations allowed
    Object.assign(_state, {
      printing: true, modifying: true, copying: true,
      annotating: true, fillingForms: true, assembly: true,
    });
  } else if (preset === 'readonly') {
    // Can view and print, cannot copy or modify
    Object.assign(_state, {
      printing: true, modifying: false, copying: false,
      annotating: false, fillingForms: true, assembly: false,
    });
  } else if (preset === 'fortknox') {
    // Maximum restrictions
    Object.assign(_state, {
      printing: false, modifying: false, copying: false,
      annotating: false, fillingForms: false, assembly: false,
    });
  }
  
  // Visual feedback — highlight active preset
  document.querySelectorAll('.prot-preset').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
  
  _renderPermissions();
}

// ── Render ─────────────────────────────────────────────────────

function _render(container) {
  container.innerHTML = `
    <div class="prot-wrap">

      <!-- LEFT: Passwords -->
      <div class="prot-col">

        ${group(t('prot_open_pwd_label'), `
          <div class="prot-pwd-row">
            <input type="password" id="protUserPwd" class="prot-input"
                   placeholder="${t('prot_open_pwd_placeholder')}" maxlength="128"
                   autocomplete="new-password" aria-label="${t('prot_open_pwd_label')}"
                   spellcheck="false">
            <button type="button" class="prot-eye" id="protUserEye"
                    aria-label="${t('prot_show_password')}" title="${t('prot_show_hide_title')}">👁</button>
            <button type="button" class="prot-gen" id="protUserGen"
                    aria-label="${t('prot_generate_password')}" title="${t('prot_generate_strong_title')}">⚡</button>
          </div>
          <div class="prot-strength" role="presentation" aria-hidden="true">
            <div class="prot-strength__bar" id="protStrBar"></div>
          </div>
          <div class="prot-strength__label" id="protStrLabel" aria-live="polite"></div>
        `)}

        ${group(t('prot_owner_pwd_label'), `
          <div class="prot-pwd-row">
            <input type="password" id="protOwnerPwd" class="prot-input"
                   placeholder="${t('prot_owner_pwd_placeholder')}" maxlength="128"
                   autocomplete="new-password" aria-label="${t('prot_owner_pwd_label')}"
                   spellcheck="false">
            <button type="button" class="prot-eye" id="protOwnerEye"
                    aria-label="${t('prot_show_owner_password')}" title="${t('prot_show_hide_title')}">👁</button>
          </div>
          <div class="prot-hint">
            ${t('prot_owner_hint')}
          </div>
        `)}

      </div>

      <!-- RIGHT: Permissions -->
      <div class="prot-col">

        <div class="j2p-group">
          <div class="j2p-label">${t('prot_presets_label')}</div>
          <div class="prot-presets">
            <button type="button" class="prot-preset" data-preset="open"
                    title="${t('prot_preset_open_title')}">
              <span class="prot-preset__icon">🔓</span>
              <span class="prot-preset__name">${t('prot_preset_open_name')}</span>
            </button>
            <button type="button" class="prot-preset" data-preset="readonly"
                    title="${t('prot_preset_readonly_title')}">
              <span class="prot-preset__icon">📖</span>
              <span class="prot-preset__name">${t('prot_preset_readonly_name')}</span>
            </button>
            <button type="button" class="prot-preset" data-preset="fortknox"
                    title="${t('prot_preset_fortknox_title')}">
              <span class="prot-preset__icon">🏰</span>
              <span class="prot-preset__name">${t('prot_preset_fortknox_name')}</span>
            </button>
          </div>
        </div>

        <div class="j2p-group">
          <div class="j2p-label">${t('prot_permissions_label')}</div>
          <div id="protPermissions" class="prot-perms"></div>
        </div>

        ${checkbox({
          id:       'protectRememberCheck',
          checked:  loadPreset('protect') !== null,
          title:    t('preset_remember_title'),
          subtitle: t('preset_remember_sub_protect'),
          ariaLabel: t('preset_remember_title'),
        })}

      </div>
    </div>

    ${infoBanner(t('prot_banner'), 'info')}
  `;

  _renderPermissions();
  _bindEvents(container);
}

function _renderPermissions() {
  const el = id('protPermissions');
  if (!el) return;

  const perms = [
    { key: 'printing',     label: t('prot_perm_print'),     sub: t('prot_perm_print_sub')     },
    { key: 'copying',      label: t('prot_perm_copy'),      sub: t('prot_perm_copy_sub')      },
    { key: 'modifying',    label: t('prot_perm_edit'),      sub: t('prot_perm_edit_sub')      },
    { key: 'annotating',   label: t('prot_perm_annotate'),  sub: t('prot_perm_annotate_sub')  },
    { key: 'fillingForms', label: t('prot_perm_fill'),      sub: t('prot_perm_fill_sub')      },
    { key: 'assembly',     label: t('prot_perm_assemble'),  sub: t('prot_perm_assemble_sub')  },
  ];

  el.innerHTML = perms.map(p => `
    <label class="prot-perm">
      <input type="checkbox" id="perm_${p.key}" ${_state[p.key] ? 'checked' : ''}
             data-perm="${p.key}" aria-label="${p.label}: ${p.sub}">
      <span class="prot-perm__box" aria-hidden="true"></span>
      <div class="prot-perm__text">
        <strong>${p.label}</strong>
        <small>${p.sub}</small>
      </div>
    </label>
  `).join('');

  // Re-bind permission checkboxes
  el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      _state[cb.dataset.perm] = cb.checked;
    });
  });
}

// ── Events ─────────────────────────────────────────────────────

function _bindEvents(container) {
  // Password strength meter
  const userInput = id('protUserPwd');
  userInput?.addEventListener('input', () => {
    _userPwd = userInput.value;
    _updateStrength(userInput.value);
  });

  // Show/hide toggles
  id('protUserEye')?.addEventListener('click', () => _toggleVisibility('protUserPwd', 'protUserEye'));
  id('protOwnerEye')?.addEventListener('click', () => _toggleVisibility('protOwnerPwd', 'protOwnerEye'));

  // Generate user password
  id('protUserGen')?.addEventListener('click', () => {
    const pwd = _generatePassword(16);
    const input = id('protUserPwd');
    if (!input) return;
    input.value = pwd;
    input.type  = 'text';   // show it so user can copy
    _updateStrength(pwd);
    id('protUserEye') && (id('protUserEye').textContent = '🙈');
    showToast(t('prot_gen_toast'), 5000);
  });

  // Presets
  container.querySelectorAll('.prot-preset[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => _applyPreset(btn.dataset.preset));
  });

  // "Remember my settings" — unchecking forgets immediately. Saving (of
  // permissions only, never passwords) happens centrally in app.js
  // (_maybeSavePreset) right before processing starts.
  id('protectRememberCheck')?.addEventListener('change', e => {
    if (!e.target.checked) clearPreset('protect');
  });
}

// ── Password strength ──────────────────────────────────────────
// Entropy-based: log2(pool^length). Pool: 26 lower + 26 upper + 10 digits + symbols.

function _updateStrength(pwd) {
  const bar   = id('protStrBar');
  const label = id('protStrLabel');
  if (!bar || !label) return;

  if (!pwd) {
    bar.className   = 'prot-strength__bar';
    label.textContent = '';
    return;
  }

  const entropy = _entropy(pwd);
  let cls, text;
  if (entropy < 28)      { cls = 'weak';   text = t('prot_strength_weak');   }
  else if (entropy < 50) { cls = 'fair';   text = t('prot_strength_fair');   }
  else if (entropy < 72) { cls = 'good';   text = t('prot_strength_good');   }
  else                   { cls = 'strong'; text = t('prot_strength_strong'); }

  bar.className     = `prot-strength__bar prot-strength__bar--${cls}`;
  label.textContent = text;
}

function _entropy(pwd) {
  let pool = 0;
  if (/[a-z]/.test(pwd)) pool += 26;
  if (/[A-Z]/.test(pwd)) pool += 26;
  if (/\d/.test(pwd))    pool += 10;
  if (/[^a-zA-Z0-9]/.test(pwd)) pool += 32;
  return pool > 0 ? Math.log2(Math.pow(pool, pwd.length)) : 0;
}

// ── Helpers ────────────────────────────────────────────────────

function _toggleVisibility(inputId, btnId) {
  const input = id(inputId);
  const btn   = id(btnId);
  if (!input) return;
  const isText  = input.type === 'text';
  input.type    = isText ? 'password' : 'text';
  if (btn) btn.textContent = isText ? '👁' : '🙈';
}

function _generatePassword(len = 16) {
  // crypto.getRandomValues → Base64url (URL-safe, printable, high entropy)
  const bytes  = new Uint8Array(Math.ceil(len * 0.75));
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    .slice(0, len);
}
