import { t } from './i18n.js';
import { loadExcelReader } from './lazyLibs.js';

export const RECIPIENT_LIMIT = 100;

export function parseRecipientTable(input) {
  const source = input.replace(/^\uFEFF/, '').trimEnd();
  // Detect a delimiter outside quotes, across several nonempty rows.
  const delimiters = [',', ';', '\t'];
  const counts = [0, 0, 0];
  let quoted = false;
  let lines = 0;
  for (const char of source) {
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    const index = delimiters.indexOf(char);
    if (index >= 0) counts[index]++;
    if (char === '\n' && ++lines >= 8) break;
  }
  const delimiter = delimiters[counts.indexOf(Math.max(...counts))];

  const rows = [];
  let row = [];
  let cell = '';
  let closed = false;
  quoted = false;
  const finishCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
  };
  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === delimiter) {
      finishCell();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      finishRow();
    } else if (!cell && !closed && char === '"') {
      quoted = true;
    } else if (closed && char !== ' ') {
      throw new Error(t('rc_bad_quote'));
    } else if (!closed) {
      cell += char;
    }
  }
  if (quoted) throw new Error(t('rc_unclosed_quote'));
  finishRow();
  return rows;
}

function columnName(index) {
  let name = '';
  for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

// Name columns are ticked, one or several: surname, first name and
// patronymic in their own columns are joined with spaces, in column order
// ("Shukurov" + "Murod" + "Akbaraliyevich", owner 2026-11-24).
export function bindRecipientImport(panel, names, status) {
  const fileInput = panel.querySelector('[data-recipient-file]');
  const options = panel.querySelector('[data-import-options]');
  const sheet = options.querySelector('[data-import-sheet]');
  const start = options.querySelector('[data-import-start]');
  const columns = options.querySelector('[data-import-column]');
  const preview = options.querySelector('[data-import-preview]');
  const apply = options.querySelector('[data-import-apply]');
  let sheets = [];
  let generation = 0;

  function selectedRows() {
    return sheets[Number(sheet.value)]?.data ?? [];
  }

  function chosenColumns() {
    return [...columns.querySelectorAll('input:checked')].map(box => Number(box.value)).sort((a, b) => a - b);
  }

  function selectedNames() {
    const chosen = chosenColumns();
    const first = Number(start.value);
    if (!Number.isInteger(first) || first < 1 || !chosen.length) return [];
    return selectedRows().slice(first - 1)
      .map(row => chosen.map(i => row[i]).filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean).join(' '))
      .filter(Boolean);
  }

  function refreshPreview() {
    const values = selectedNames();
    const rows = selectedRows();
    const first = Number(start.value);
    const duplicates = values.length - new Set(values).size;
    const skipped = Number.isInteger(first) && first > 0 ? Math.max(0, rows.length - first + 1 - values.length) : 0;
    const notes = [
      skipped ? t('rc_skipped', { n: skipped }) : '',
      duplicates ? t('rc_duplicates', { n: duplicates }) : '',
    ].filter(Boolean);
    const multiline = values.some(value => /[\r\n]/.test(value));
    apply.disabled = !values.length || values.length > RECIPIENT_LIMIT || multiline;
    preview.textContent = !chosenColumns().length ? t('rc_tick_columns')
      : multiline ? t('rc_multiline')
      : values.length > RECIPIENT_LIMIT ? t('rc_too_many', { n: values.length, max: RECIPIENT_LIMIT })
      : values.length ? t('rc_preview', { n: values.length, list: [...values.slice(0, 3), ...notes].join(' · ') })
      : t('rc_no_values');
  }

  function refreshColumns() {
    const rows = selectedRows();
    const first = Number(start.value);
    const previous = new Set(chosenColumns());
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const header = rows[first - 2] ?? [];
    const sample = rows[first - 1] ?? [];
    columns.replaceChildren(...Array.from({ length: width }, (_, index) => {
      const label = document.createElement('label');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: String(index) });
      box.checked = previous.has(index) || width === 1;
      const title = [columnName(index), header[index], sample[index]].filter(v => v != null && v !== '')
        .map(v => String(v).slice(0, 60)).join(' · ');
      label.append(box, ` ${title}`);
      return label;
    }));
    refreshPreview();
  }

  function show(data) {
    sheets = data.filter(entry => entry.data.some(row => row.some(value => value != null && value !== '')));
    if (!sheets.length) throw new Error(t('rc_empty'));
    sheet.replaceChildren(...sheets.map((entry, index) => new window.Option(entry.sheet, String(index))));
    options.hidden = false;
    columns.replaceChildren();
    start.value = selectedRows().length > 1 ? '2' : '1';
    refreshColumns();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const request = ++generation;
    fileInput.value = '';
    options.hidden = true;
    status.textContent = t('rc_reading');
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error(t('rc_too_big'));
      let data;
      if (/\.xlsx$/i.test(file.name)) {
        await loadExcelReader();
        data = await window.readXlsxFile(file);
      } else if (/\.(csv|tsv)$/i.test(file.name)) {
        data = [{ sheet: t('rc_imported_table'), data: parseRecipientTable(await file.text()) }];
      } else {
        throw new Error(t('rc_wrong_type'));
      }
      if (request !== generation || !panel.isConnected) return;
      show(data);
      status.textContent = /\.xlsx$/i.test(file.name) ? t('rc_choose_hidden_rows') : t('rc_choose');
    } catch (error) {
      if (request === generation && panel.isConnected) status.textContent = error.message;
    }
  });

  names.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text?.includes('\t')) return;
    event.preventDefault();
    generation++;
    try {
      show([{ sheet: t('rc_pasted_table'), data: parseRecipientTable(text) }]);
      status.textContent = t('rc_choose');
    } catch (error) {
      status.textContent = error.message;
    }
  });

  sheet.addEventListener('change', () => {
    columns.replaceChildren();
    start.value = selectedRows().length > 1 ? '2' : '1';
    refreshColumns();
  });
  start.addEventListener('input', refreshColumns);
  columns.addEventListener('change', refreshPreview);
  apply.addEventListener('click', () => {
    if (apply.disabled) return;
    names.value = selectedNames().join('\n');
    sheets = [];
    sheet.replaceChildren();
    columns.replaceChildren();
    preview.textContent = '';
    options.hidden = true;
    names.dispatchEvent(new Event('input'));
    status.textContent = t('rc_done');
    names.focus();
  });
}
