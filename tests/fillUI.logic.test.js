// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// ============================================================
//  tests/fillUI.logic.test.js
//
//  Pure-logic tests for fillUI.js.  All tested functions are
//  copied verbatim from the source so the suite runs in Node.js
//  without a DOM.
//
//  Covers:
//    • _humanizeLabel   — field-name → human label
//    • _detectInputMeta — keyword → input type / autocomplete
//    • _isTruthy        — PDF checkbox boolean
//    • _titleCase       — option label formatting
//    • _esc             — HTML escape (inline copy)
//    • _processRawAnnotations — field extraction / dedup logic
//    • _defaultValues   — initial value seeding from field defs
//    • progress-count logic
//    • draft save / load round-trip
//    • field validation helpers
// ============================================================

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      r.then(() => { console.log(`  ✓ ${name}`); passed++; })
       .catch(e => { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; });
    } else {
      console.log(`  ✓ ${name}`); passed++;
    }
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`); failed++;
  }
}

function expect(actual) {
  return {
    toBe:           (e) => { if (actual !== e) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toEqual:        (e) => { if (JSON.stringify(actual) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`); },
    toBeTruthy:     ()  => { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`); },
    toBeFalsy:      ()  => { if (actual)  throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`); },
    toHaveLength:   (n) => { if (actual.length !== n) throw new Error(`Expected length ${n}, got ${actual.length}`); },
    toContain:      (v) => { if (!actual.includes(v)) throw new Error(`Expected array/string to contain ${JSON.stringify(v)}`); },
    toBeGreaterThan:(n) => { if (actual <= n) throw new Error(`Expected ${actual} > ${n}`); },
    toBeUndefined:  ()  => { if (actual !== undefined) throw new Error(`Expected undefined, got ${JSON.stringify(actual)}`); },
  };
}

// ── Pure copies from fillUI.js ─────────────────────────────────

function _isTruthy(v) {
  return v && !['off', 'Off', 'false', '0', ''].includes(v);
}

function _titleCase(s) {
  return s.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ')
    .trim().replace(/^\w/, c => c.toUpperCase());
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _humanizeLabel(a) {
  if (a.alternativeText) return a.alternativeText.trim();
  let n = (a.fieldName || '').split('.').pop().replace(/\[\d+\]/g, '');
  n = n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Field';
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

    // Text field
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

function _defaultValues(fields) {
  const vals = {};
  for (const f of fields) { if (f.value) vals[f.name] = f.value; }
  return vals;
}

// Progress count — matches _updateProgress in fillUI.js
function _countFilled(fields, values, sigImages) {
  const fillable = fields.filter(f => f.type !== 'sig' && !f.readOnly);
  const filled   = fillable.filter(f =>
    values[f.name] !== undefined && String(values[f.name]).trim() !== ''
  ).length + Object.keys(sigImages).length;
  const total    = fields.filter(f => !f.readOnly).length;
  const pct      = total > 0 ? Math.round((filled / total) * 100) : 0;
  return { filled, total, pct };
}

// Validate required fields — returns array of missing labels
function _validateRequired(fields, values, sigImages) {
  const missing = [];
  for (const f of fields) {
    if (!f.required || f.readOnly) continue;
    const isEmpty = f.type === 'sig'
      ? !sigImages[f.name]
      : !values[f.name] || String(values[f.name]).trim() === '';
    if (isEmpty) missing.push(f.label);
  }
  return missing;
}

// ── _isTruthy ─────────────────────────────────────────────────

console.log('\n_isTruthy (PDF checkbox boolean):');

test('undefined → falsy', () => expect(_isTruthy(undefined)).toBeFalsy());
test('null → falsy',      () => expect(_isTruthy(null)).toBeFalsy());
test('"" → falsy',        () => expect(_isTruthy('')).toBeFalsy());
test('"off" → falsy',     () => expect(_isTruthy('off')).toBeFalsy());
test('"Off" → falsy',     () => expect(_isTruthy('Off')).toBeFalsy());
test('"false" → falsy',   () => expect(_isTruthy('false')).toBeFalsy());
test('"0" → falsy',       () => expect(_isTruthy('0')).toBeFalsy());
test('"Yes" → truthy',    () => expect(_isTruthy('Yes')).toBeTruthy());
test('"On" → truthy',     () => expect(_isTruthy('On')).toBeTruthy());
test('"true" → truthy',   () => expect(_isTruthy('true')).toBeTruthy());
test('"1" → truthy',      () => expect(_isTruthy('1')).toBeTruthy());
test('"X" → truthy',      () => expect(_isTruthy('X')).toBeTruthy());

// ── _titleCase ────────────────────────────────────────────────

console.log('\n_titleCase (option label):');

test('single word: first letter capitalised', () => expect(_titleCase('yes')).toBe('Yes'));
test('already title-case unchanged',         () => expect(_titleCase('Yes')).toBe('Yes'));
test('camelCase splits and capitalises',     () => expect(_titleCase('yesNo')).toBe('Yes No'));
test('underscore replaced by space',         () => expect(_titleCase('yes_no')).toBe('Yes no'));
test('hyphen replaced by space',             () => expect(_titleCase('yes-no')).toBe('Yes no'));
test('mixed: CamelCase + underscore',        () => expect(_titleCase('optionA_value')).toBe('Option A value'));

// ── _esc ──────────────────────────────────────────────────────

console.log('\n_esc (HTML escape):');

test('& → &amp;',         () => expect(_esc('a&b')).toBe('a&amp;b'));
test('" → &quot;',        () => expect(_esc('"q"')).toBe('&quot;q&quot;'));
test('< → &lt;',          () => expect(_esc('<script>')).toBe('&lt;script&gt;'));
test('> → &gt;',          () => expect(_esc('a>b')).toBe('a&gt;b'));
test('plain string untouched', () => expect(_esc('hello world')).toBe('hello world'));
test('empty string → ""', () => expect(_esc('')).toBe(''));
test('null → ""',         () => expect(_esc(null)).toBe(''));
test('undefined → ""',    () => expect(_esc(undefined)).toBe(''));
test('number → string',   () => expect(_esc(42)).toBe('42'));
test('XSS payload escaped', () => {
  const r = _esc('<img onload="alert(1)">');
  expect(r).toContain('&lt;');
  expect(r).toContain('&quot;');
});

// ── _humanizeLabel ────────────────────────────────────────────

console.log('\n_humanizeLabel (field name → label):');

test('alternativeText takes priority', () => {
  expect(_humanizeLabel({ alternativeText: 'Full Name', fieldName: 'fn' })).toBe('Full Name');
});
test('alternativeText is trimmed', () => {
  expect(_humanizeLabel({ alternativeText: '  Email  ' })).toBe('Email');
});
test('dotted path: take last segment', () => {
  expect(_humanizeLabel({ fieldName: 'person.firstName' })).toBe('First Name');
});
test('array index stripped from last segment', () => {
  expect(_humanizeLabel({ fieldName: 'address.zip[0]' })).toBe('Zip');
});
test('camelCase split into words', () => {
  expect(_humanizeLabel({ fieldName: 'phoneNumber' })).toBe('Phone Number');
});
test('underscore replaced by space + capitalised', () => {
  expect(_humanizeLabel({ fieldName: 'first_name' })).toBe('First name');
});
test('hyphen replaced by space', () => {
  expect(_humanizeLabel({ fieldName: 'date-of-birth' })).toBe('Date of birth');
});
test('empty fieldName → "Field"', () => {
  expect(_humanizeLabel({ fieldName: '' })).toBe('Field');
});
test('no fieldName and no alternativeText → "Field"', () => {
  expect(_humanizeLabel({})).toBe('Field');
});
test('array index in name only (no dot) stripped', () => {
  expect(_humanizeLabel({ fieldName: 'items[2]' })).toBe('Items');
});

// ── _detectInputMeta ─────────────────────────────────────────

console.log('\n_detectInputMeta (keyword detection):');

test('email label → type=email', () => {
  expect(_detectInputMeta('Email Address', 'email')).toEqual({ inputType: 'email', inputmode: 'email', autocomplete: 'email' });
});
test('phone label → type=tel', () => {
  expect(_detectInputMeta('Phone Number', 'phone')).toEqual({ inputType: 'tel', inputmode: 'tel', autocomplete: 'tel' });
});
test('mobile label → type=tel', () => {
  const m = _detectInputMeta('Mobile', 'mobile');
  expect(m.inputType).toBe('tel');
});
test('cell label → type=tel', () => {
  const m = _detectInputMeta('Cell Phone', 'cell');
  expect(m.inputType).toBe('tel');
});
test('date label → type=date', () => {
  const m = _detectInputMeta('Date of Birth', 'dob');
  expect(m.inputType).toBe('date');
});
test('zip label → inputmode=numeric', () => {
  const m = _detectInputMeta('Zip Code', 'zip');
  expect(m.inputmode).toBe('numeric');
  expect(m.autocomplete).toBe('postal-code');
});
test('postal label → postal-code autocomplete', () => {
  const m = _detectInputMeta('Postal Code', 'postal');
  expect(m.autocomplete).toBe('postal-code');
});
test('first name label → given-name autocomplete', () => {
  const m = _detectInputMeta('First Name', 'firstName');
  expect(m.autocomplete).toBe('given-name');
});
test('fname label → given-name autocomplete', () => {
  const m = _detectInputMeta('Fname', 'fname');
  expect(m.autocomplete).toBe('given-name');
});
test('last name label → family-name autocomplete', () => {
  const m = _detectInputMeta('Last Name', 'lastName');
  expect(m.autocomplete).toBe('family-name');
});
test('surname label → family-name autocomplete', () => {
  const m = _detectInputMeta('Surname', 'surname');
  expect(m.autocomplete).toBe('family-name');
});
test('full name label → name autocomplete', () => {
  const m = _detectInputMeta('Full Name', 'fullname');
  expect(m.autocomplete).toBe('name');
});
test('address label → street-address', () => {
  const m = _detectInputMeta('Street Address', 'address');
  expect(m.autocomplete).toBe('street-address');
});
test('city label → address-level2', () => {
  const m = _detectInputMeta('City', 'city');
  expect(m.autocomplete).toBe('address-level2');
});
test('state label → address-level1', () => {
  const m = _detectInputMeta('State', 'state');
  expect(m.autocomplete).toBe('address-level1');
});
test('country label → country-name', () => {
  const m = _detectInputMeta('Country', 'country');
  expect(m.autocomplete).toBe('country-name');
});
test('url label → type=url', () => {
  const m = _detectInputMeta('Website URL', 'url');
  expect(m.inputType).toBe('url');
});
test('website label → type=url', () => {
  const m = _detectInputMeta('Website', 'website');
  expect(m.inputType).toBe('url');
});
test('ssn label → inputmode=numeric autocomplete=off', () => {
  const m = _detectInputMeta('SSN', 'ssn');
  expect(m.inputmode).toBe('numeric');
  expect(m.autocomplete).toBe('off');
});
test('social security label → numeric', () => {
  const m = _detectInputMeta('Social Security Number', 'ssn');
  expect(m.inputmode).toBe('numeric');
});
test('unknown label → plain text', () => {
  const m = _detectInputMeta('Comments', 'comments');
  expect(m.inputType).toBe('text');
  expect(m.autocomplete).toBeUndefined();
});
test('email as a standalone word in name → detected', () => {
  // \bemail\b requires a word boundary; 'emailAddress' → no boundary after 'email'
  const m = _detectInputMeta('Email', 'someField');
  expect(m.inputType).toBe('email');
});
test('emailAddress name (no word boundary) → NOT detected as email', () => {
  // 'emailAddress' in lowercase is 'emailaddress' — \bemail\b does not match
  const m = _detectInputMeta('', 'emailAddress');
  expect(m.inputType).toBe('text'); // falls through to default
});

// ── _processRawAnnotations ────────────────────────────────────

console.log('\n_processRawAnnotations (field extraction):');

// Helpers to build mock pdf.js annotations
function mkText(overrides = {}) {
  return { subtype: 'Widget', fieldType: 'Tx', _page: 1, fieldName: 'name', ...overrides };
}
function mkCheckbox(overrides = {}) {
  return { subtype: 'Widget', checkBox: true, _page: 1, fieldName: 'agree',
           exportValue: 'Yes', fieldValue: '', ...overrides };
}
function mkRadio(overrides = {}) {
  return { subtype: 'Widget', radioButton: true, _page: 1, fieldName: 'color',
           exportValue: 'red', ...overrides };
}
function mkSelect(overrides = {}) {
  return { subtype: 'Widget', fieldType: 'Ch', _page: 1, fieldName: 'country',
           options: [{ exportValue: 'US', displayValue: 'United States' }], ...overrides };
}
function mkSig(overrides = {}) {
  return { subtype: 'Widget', fieldType: 'Sig', _page: 1, fieldName: 'sig1',
           rect: [10, 20, 200, 60], ...overrides };
}

test('single text field processed correctly', () => {
  const fields = _processRawAnnotations([mkText({ fieldName: 'fullName', fieldValue: 'Alice' })]);
  expect(fields).toHaveLength(1);
  expect(fields[0].type).toBe('text');
  expect(fields[0].name).toBe('fullName');
  expect(fields[0].value).toBe('Alice');
});

test('text field uses defaultValue when fieldValue empty', () => {
  const fields = _processRawAnnotations([mkText({ fieldName: 'x', fieldValue: '', defaultValue: 'default' })]);
  expect(fields[0].value).toBe('default');
});

test('read-only field detected', () => {
  const fields = _processRawAnnotations([mkText({ readOnly: true, fieldValue: 'fixed' })]);
  expect(fields[0].readOnly).toBeTruthy();
  expect(fields[0].value).toBe('fixed');
});

test('read-only duplicate on same page is deduplicated', () => {
  const ann = mkText({ readOnly: true, fieldName: 'ro', _page: 1 });
  const fields = _processRawAnnotations([ann, ann]);
  expect(fields).toHaveLength(1);
});

test('read-only same name different pages → both kept', () => {
  const a1 = mkText({ readOnly: true, fieldName: 'ro', _page: 1 });
  const a2 = mkText({ readOnly: true, fieldName: 'ro', _page: 2 });
  const fields = _processRawAnnotations([a1, a2]);
  expect(fields).toHaveLength(2);
});

test('checkbox unchecked → value=""', () => {
  const fields = _processRawAnnotations([mkCheckbox({ fieldValue: '' })]);
  expect(fields[0].type).toBe('checkbox');
  expect(fields[0].value).toBe('');
});

test('checkbox checked via truthy fieldValue', () => {
  const fields = _processRawAnnotations([mkCheckbox({ fieldValue: 'Yes', exportValue: 'Yes' })]);
  expect(fields[0].value).toBe('Yes');
});

test('checkbox "off" fieldValue treated as unchecked', () => {
  const fields = _processRawAnnotations([mkCheckbox({ fieldValue: 'off', exportValue: 'Yes' })]);
  expect(fields[0].value).toBe('');
});

test('checkbox "false" fieldValue treated as unchecked', () => {
  const fields = _processRawAnnotations([mkCheckbox({ fieldValue: 'false', exportValue: 'Yes' })]);
  expect(fields[0].value).toBe('');
});

test('checkbox "0" fieldValue treated as unchecked', () => {
  const fields = _processRawAnnotations([mkCheckbox({ fieldValue: '0', exportValue: 'On' })]);
  expect(fields[0].value).toBe('');
});

test('checkbox exportValue defaults to "Yes"', () => {
  const fields = _processRawAnnotations([mkCheckbox({ fieldValue: 'X', exportValue: undefined })]);
  expect(fields[0].exportValue).toBe('Yes');
  expect(fields[0].value).toBe('Yes');
});

test('duplicate checkbox on same page is deduplicated', () => {
  const cb = mkCheckbox({ fieldName: 'agree', _page: 1 });
  const fields = _processRawAnnotations([cb, cb]);
  expect(fields).toHaveLength(1);
});

test('radio options deduplicated into one group', () => {
  const r1 = mkRadio({ exportValue: 'red' });
  const r2 = mkRadio({ exportValue: 'blue' });
  const fields = _processRawAnnotations([r1, r2]);
  expect(fields).toHaveLength(1);
  expect(fields[0].type).toBe('radio');
  expect(fields[0].options).toHaveLength(2);
});

test('radio duplicate option values not duplicated', () => {
  const r1 = mkRadio({ exportValue: 'red' });
  const r2 = mkRadio({ exportValue: 'red' }); // same value
  const fields = _processRawAnnotations([r1, r2]);
  expect(fields[0].options).toHaveLength(1);
});

test('radio option label uses _titleCase (capitalises + splits camelCase)', () => {
  const fields = _processRawAnnotations([mkRadio({ exportValue: 'redColor' })]);
  expect(fields[0].options[0].label).toBe('Red Color');
});

test('radio uses buttonValue when exportValue absent', () => {
  const r = mkRadio({ exportValue: undefined, buttonValue: 'btn_val' });
  const fields = _processRawAnnotations([r]);
  expect(fields[0].options[0].value).toBe('btn_val');
});

test('radio falls back to "On" when no exportValue or buttonValue', () => {
  const r = mkRadio({ exportValue: undefined, buttonValue: undefined });
  const fields = _processRawAnnotations([r]);
  expect(fields[0].options[0].value).toBe('On');
});

test('radio required flag propagated', () => {
  const fields = _processRawAnnotations([mkRadio({ required: true })]);
  expect(fields[0].required).toBeTruthy();
});

test('select field with options', () => {
  const fields = _processRawAnnotations([mkSelect()]);
  expect(fields[0].type).toBe('select');
  expect(fields[0].options[0].value).toBe('US');
  expect(fields[0].options[0].label).toBe('United States');
});

test('select non-editable by default', () => {
  const fields = _processRawAnnotations([mkSelect({ combo: false })]);
  expect(fields[0].editable).toBeFalsy();
});

test('select editable when combo+editable', () => {
  const fields = _processRawAnnotations([mkSelect({ combo: true, editable: true })]);
  expect(fields[0].editable).toBeTruthy();
});

test('sig field type recognised', () => {
  const fields = _processRawAnnotations([mkSig()]);
  expect(fields[0].type).toBe('sig');
  expect(fields[0].rect).toEqual([10, 20, 200, 60]);
  expect(fields[0].pageIndex).toBe(0); // _page 1 → index 0
});

test('sig rect defaults to [0,0,200,60] when missing', () => {
  const fields = _processRawAnnotations([mkSig({ rect: undefined })]);
  expect(fields[0].rect).toEqual([0, 0, 200, 60]);
});

test('missing fieldName gets auto-generated name', () => {
  const fields = _processRawAnnotations([mkText({ fieldName: undefined })]);
  expect(fields[0].name).toContain('_field_');
});

test('multi-page: fields on different pages both present', () => {
  const a1 = mkText({ fieldName: 'name', _page: 1 });
  const a2 = mkText({ fieldName: 'addr', _page: 2 });
  const fields = _processRawAnnotations([a1, a2]);
  expect(fields).toHaveLength(2);
  expect(fields.map(f => f.page)).toEqual([1, 2]);
});

test('multiLine flag propagated', () => {
  const fields = _processRawAnnotations([mkText({ multiLine: true })]);
  expect(fields[0].multiLine).toBeTruthy();
});

test('maxLen propagated', () => {
  const fields = _processRawAnnotations([mkText({ maxLen: 100 })]);
  expect(fields[0].maxLen).toBe(100);
});

test('required flag propagated on text field', () => {
  const fields = _processRawAnnotations([mkText({ required: true })]);
  expect(fields[0].required).toBeTruthy();
});

test('email field name → inputType=email', () => {
  const fields = _processRawAnnotations([mkText({ fieldName: 'email', fieldValue: '' })]);
  expect(fields[0].inputType).toBe('email');
});

// ── _defaultValues ────────────────────────────────────────────

console.log('\n_defaultValues (initial value seeding):');

test('text field with value → included', () => {
  const fields = [{ name: 'n', type: 'text', value: 'Alice' }];
  const vals = _defaultValues(fields);
  expect(vals['n']).toBe('Alice');
});

test('text field with empty value → NOT included', () => {
  const fields = [{ name: 'n', type: 'text', value: '' }];
  const vals = _defaultValues(fields);
  expect(vals['n']).toBeUndefined();
});

test('checked checkbox (value = exportValue) → included', () => {
  const fields = [{ name: 'agree', type: 'checkbox', value: 'Yes' }];
  const vals = _defaultValues(fields);
  expect(vals['agree']).toBe('Yes');
});

test('unchecked checkbox (value = "") → NOT included', () => {
  const fields = [{ name: 'agree', type: 'checkbox', value: '' }];
  const vals = _defaultValues(fields);
  expect(vals['agree']).toBeUndefined();
});

test('radio with pre-selected value → included', () => {
  const fields = [{ name: 'color', type: 'radio', value: 'red', options: [] }];
  const vals = _defaultValues(fields);
  expect(vals['color']).toBe('red');
});

test('radio with no pre-selection → NOT included', () => {
  const fields = [{ name: 'color', type: 'radio', value: '', options: [] }];
  const vals = _defaultValues(fields);
  expect(vals['color']).toBeUndefined();
});

test('sig field (no value property) → NOT included', () => {
  const fields = [{ name: 'sig1', type: 'sig', rect: [0,0,100,40], pageIndex: 0 }];
  const vals = _defaultValues(fields);
  expect(vals['sig1']).toBeUndefined();
});

test('read-only field with value → included (it has a value prop)', () => {
  const fields = [{ name: 'ro', type: 'text', readOnly: true, value: 'fixed' }];
  const vals = _defaultValues(fields);
  expect(vals['ro']).toBe('fixed');
});

test('multiple fields processed correctly', () => {
  const fields = [
    { name: 'a', type: 'text', value: 'foo' },
    { name: 'b', type: 'text', value: '' },
    { name: 'c', type: 'text', value: 'bar' },
  ];
  const vals = _defaultValues(fields);
  expect(vals['a']).toBe('foo');
  expect(vals['b']).toBeUndefined();
  expect(vals['c']).toBe('bar');
});

// ── Progress count logic ──────────────────────────────────────

console.log('\nProgress count logic:');

const textField   = { name: 'name',   type: 'text',     readOnly: false };
const roField     = { name: 'ro',     type: 'text',     readOnly: true  };
const checkField  = { name: 'agree',  type: 'checkbox', readOnly: false };
const radioField  = { name: 'color',  type: 'radio',    readOnly: false };
const sigField    = { name: 'sig1',   type: 'sig',      readOnly: false };

test('no fields → 0/0, 0%', () => {
  const r = _countFilled([], {}, {});
  expect(r.filled).toBe(0);
  expect(r.total).toBe(0);
  expect(r.pct).toBe(0);
});

test('one text field empty → 0/1, 0%', () => {
  const r = _countFilled([textField], {}, {});
  expect(r.filled).toBe(0);
  expect(r.total).toBe(1);
  expect(r.pct).toBe(0);
});

test('one text field filled → 1/1, 100%', () => {
  const r = _countFilled([textField], { name: 'Alice' }, {});
  expect(r.filled).toBe(1);
  expect(r.pct).toBe(100);
});

test('whitespace-only value does NOT count as filled', () => {
  const r = _countFilled([textField], { name: '   ' }, {});
  expect(r.filled).toBe(0);
});

test('read-only fields excluded from filled count', () => {
  const r = _countFilled([roField], { ro: 'fixed' }, {});
  expect(r.filled).toBe(0);
  expect(r.total).toBe(0); // read-only excluded from total too
});

test('sig field counted in total', () => {
  const r = _countFilled([sigField], {}, {});
  expect(r.total).toBe(1);
});

test('sig field counts as filled when in sigImages', () => {
  const r = _countFilled([sigField], {}, { sig1: { dataUrl: 'data:...' } });
  expect(r.filled).toBe(1);
  expect(r.pct).toBe(100);
});

test('mixed: 2 text filled + 1 sig filled → 3/3', () => {
  const fields = [textField, checkField, sigField];
  const values = { name: 'Alice', agree: 'Yes' };
  const sigs   = { sig1: { dataUrl: 'data:...' } };
  const r      = _countFilled(fields, values, sigs);
  expect(r.filled).toBe(3);
  expect(r.total).toBe(3);
  expect(r.pct).toBe(100);
});

test('partial: 1 of 2 text filled → 50%', () => {
  const fields = [textField, { name: 'email', type: 'text', readOnly: false }];
  const r = _countFilled(fields, { name: 'Alice' }, {});
  expect(r.filled).toBe(1);
  expect(r.total).toBe(2);
  expect(r.pct).toBe(50);
});

test('radio field counts toward total and filled', () => {
  const r = _countFilled([radioField], { color: 'red' }, {});
  expect(r.filled).toBe(1);
  expect(r.total).toBe(1);
});

// ── _validateRequired ─────────────────────────────────────────

console.log('\n_validateRequired (missing required fields):');

test('no required fields → empty missing list', () => {
  const fields = [{ name: 'n', type: 'text', required: false, readOnly: false }];
  expect(_validateRequired(fields, { n: 'Alice' }, {})).toHaveLength(0);
});

test('required text empty → label in missing', () => {
  const fields = [{ name: 'n', type: 'text', required: true, readOnly: false, label: 'Name' }];
  const missing = _validateRequired(fields, {}, {});
  expect(missing).toContain('Name');
});

test('required text filled → not in missing', () => {
  const fields = [{ name: 'n', type: 'text', required: true, readOnly: false, label: 'Name' }];
  const missing = _validateRequired(fields, { n: 'Alice' }, {});
  expect(missing).toHaveLength(0);
});

test('whitespace-only required text → still missing', () => {
  const fields = [{ name: 'n', type: 'text', required: true, readOnly: false, label: 'Name' }];
  const missing = _validateRequired(fields, { n: '   ' }, {});
  expect(missing).toContain('Name');
});

test('required read-only field is skipped', () => {
  const fields = [{ name: 'ro', type: 'text', required: true, readOnly: true, label: 'RO' }];
  const missing = _validateRequired(fields, {}, {});
  expect(missing).toHaveLength(0);
});

test('required sig absent → label in missing', () => {
  const fields = [{ name: 'sig1', type: 'sig', required: true, readOnly: false, label: 'Signature' }];
  const missing = _validateRequired(fields, {}, {});
  expect(missing).toContain('Signature');
});

test('required sig present → not in missing', () => {
  const fields = [{ name: 'sig1', type: 'sig', required: true, readOnly: false, label: 'Signature' }];
  const missing = _validateRequired(fields, {}, { sig1: { dataUrl: 'data:...' } });
  expect(missing).toHaveLength(0);
});

test('required radio with no selection → in missing', () => {
  const fields = [{ name: 'color', type: 'radio', required: true, readOnly: false, label: 'Color' }];
  const missing = _validateRequired(fields, {}, {});
  expect(missing).toContain('Color');
});

test('required radio with selection → not in missing', () => {
  const fields = [{ name: 'color', type: 'radio', required: true, readOnly: false, label: 'Color' }];
  const missing = _validateRequired(fields, { color: 'red' }, {});
  expect(missing).toHaveLength(0);
});

test('required checkbox unchecked → in missing', () => {
  const fields = [{ name: 'agree', type: 'checkbox', required: true, readOnly: false, label: 'I agree' }];
  const missing = _validateRequired(fields, { agree: '' }, {});
  expect(missing).toContain('I agree');
});

test('required checkbox checked → not in missing', () => {
  const fields = [{ name: 'agree', type: 'checkbox', required: true, readOnly: false, label: 'I agree' }];
  const missing = _validateRequired(fields, { agree: 'Yes' }, {});
  expect(missing).toHaveLength(0);
});

test('multiple required fields: all missing → all labels returned', () => {
  const fields = [
    { name: 'a', type: 'text', required: true, readOnly: false, label: 'A' },
    { name: 'b', type: 'text', required: true, readOnly: false, label: 'B' },
  ];
  const missing = _validateRequired(fields, {}, {});
  expect(missing).toContain('A');
  expect(missing).toContain('B');
  expect(missing).toHaveLength(2);
});

// ── Draft persistence (round-trip logic) ──────────────────────

console.log('\nDraft persistence:');

// Inline mock for localStorage-like round-trip
function makeDraftStore() {
  const store = {};
  return {
    save(key, values) {
      if (!key) return;
      try { store[key] = JSON.stringify(values); } catch { /* quota */ }
    },
    load(key) {
      if (!key) return null;
      try {
        const raw = store[key];
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
  };
}

test('save and load round-trip preserves string values', () => {
  const ds = makeDraftStore();
  ds.save('k', { name: 'Alice', email: 'a@b.com' });
  const loaded = ds.load('k');
  expect(loaded.name).toBe('Alice');
  expect(loaded.email).toBe('a@b.com');
});

test('load from missing key returns null', () => {
  const ds = makeDraftStore();
  expect(ds.load('missing')).toBeFalsy();
});

test('null key → save is no-op', () => {
  const ds = makeDraftStore();
  ds.save(null, { x: 1 });
  expect(ds.load(null)).toBeFalsy();
});

test('empty object round-trips correctly', () => {
  const ds = makeDraftStore();
  ds.save('k', {});
  const loaded = ds.load('k');
  expect(JSON.stringify(loaded)).toBe('{}');
});

test('checkbox state "" round-trips as empty string', () => {
  const ds = makeDraftStore();
  ds.save('k', { agree: '' });
  const loaded = ds.load('k');
  expect(loaded.agree).toBe('');
});

test('checkbox state exportValue round-trips', () => {
  const ds = makeDraftStore();
  ds.save('k', { agree: 'Yes' });
  const loaded = ds.load('k');
  expect(loaded.agree).toBe('Yes');
});

test('overwriting existing draft replaces values', () => {
  const ds = makeDraftStore();
  ds.save('k', { name: 'Alice' });
  ds.save('k', { name: 'Bob', email: 'b@c.com' });
  const loaded = ds.load('k');
  expect(loaded.name).toBe('Bob');
  expect(loaded.email).toBe('b@c.com');
});

// ── Edge cases ────────────────────────────────────────────────

console.log('\nEdge cases:');

test('processRawAnnotations: empty input → empty array', () => {
  expect(_processRawAnnotations([])).toHaveLength(0);
});

test('processRawAnnotations: only read-only fields → all kept', () => {
  const fields = _processRawAnnotations([
    mkText({ readOnly: true, fieldName: 'a', _page: 1 }),
    mkText({ readOnly: true, fieldName: 'b', _page: 1 }),
  ]);
  expect(fields).toHaveLength(2);
});

test('processRawAnnotations: radio on multiple pages → one group', () => {
  const r1 = mkRadio({ fieldName: 'color', _page: 1, exportValue: 'red' });
  const r2 = mkRadio({ fieldName: 'color', _page: 2, exportValue: 'blue' });
  const fields = _processRawAnnotations([r1, r2]);
  expect(fields).toHaveLength(1);
  expect(fields[0].options).toHaveLength(2);
  expect(fields[0].page).toBe(1); // page of FIRST occurrence
});

test('processRawAnnotations: mix of all field types', () => {
  const raw = [
    mkText({ fieldName: 'name' }),
    mkCheckbox({ fieldName: 'agree' }),
    mkRadio({ fieldName: 'color', exportValue: 'red' }),
    mkRadio({ fieldName: 'color', exportValue: 'blue' }),
    mkSelect({ fieldName: 'country' }),
    mkSig({ fieldName: 'sig1' }),
  ];
  const fields = _processRawAnnotations(raw);
  expect(fields).toHaveLength(5); // name, agree, color(1 group), country, sig1
  const types = fields.map(f => f.type);
  expect(types).toContain('text');
  expect(types).toContain('checkbox');
  expect(types).toContain('radio');
  expect(types).toContain('select');
  expect(types).toContain('sig');
});

test('defaultValues: empty fields array → empty object', () => {
  expect(JSON.stringify(_defaultValues([]))).toBe('{}');
});

test('countFilled: all read-only → 0 filled, 0 total', () => {
  const r = _countFilled([roField], { ro: 'fixed' }, {});
  expect(r.filled).toBe(0);
  expect(r.total).toBe(0);
});

test('countFilled: sig NOT in sigImages → 0 filled', () => {
  const r = _countFilled([sigField], {}, {});
  expect(r.filled).toBe(0);
  expect(r.pct).toBe(0);
});

// ── Summary ───────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Tests: ${passed + failed} | ✓ ${passed} | ${failed > 0 ? '✗ ' + failed : '0 failed'}`);
  if (failed > 0) process.exit(1);
}, 50);
