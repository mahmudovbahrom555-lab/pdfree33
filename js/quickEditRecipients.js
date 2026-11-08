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
      throw new Error('The table contains a malformed quoted value.');
    } else if (!closed) {
      cell += char;
    }
  }
  if (quoted) throw new Error('The table contains an unclosed quoted value.');
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

export function bindRecipientImport(panel, names, status) {
  const fileInput = panel.querySelector('[data-recipient-file]');
  const options = panel.querySelector('[data-import-options]');
  const sheet = options.querySelector('[data-import-sheet]');
  const start = options.querySelector('[data-import-start]');
  const column = options.querySelector('[data-import-column]');
  const preview = options.querySelector('[data-import-preview]');
  const apply = options.querySelector('[data-import-apply]');
  let sheets = [];
  let generation = 0;

  function selectedRows() {
    return sheets[Number(sheet.value)]?.data ?? [];
  }

  function selectedNames() {
    const index = Number(column.value);
    const first = Number(start.value);
    if (!Number.isInteger(first) || first < 1 || !column.value) return [];
    return selectedRows().slice(first - 1).map(row => row[index]).filter(value => typeof value === 'string')
      .map(value => value.trim()).filter(Boolean);
  }

  function refreshPreview() {
    const values = selectedNames();
    const multiline = values.some(value => /[\r\n]/.test(value));
    apply.disabled = !values.length || values.length > RECIPIENT_LIMIT || multiline;
    preview.textContent = multiline ? 'The selected column contains names on multiple lines.'
      : values.length > RECIPIENT_LIMIT ? `This column has ${values.length} names. The limit is ${RECIPIENT_LIMIT}.`
      : values.length ? `${values.length} names · ${values.slice(0, 3).join(' · ')}`
      : 'No text values in this column from the selected row.';
  }

  function refreshColumns() {
    const rows = selectedRows();
    const first = Number(start.value);
    const previous = column.value;
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const header = rows[first - 2] ?? [];
    column.replaceChildren(new window.Option('Choose a column', ''), ...Array.from({ length: width }, (_, index) =>
      new window.Option(`${columnName(index)}${header[index] ? ' · ' + String(header[index]).slice(0, 80) : ''}`, String(index))));
    column.value = previous;
    refreshPreview();
  }

  function show(data) {
    sheets = data.filter(entry => entry.data.some(row => row.some(value => value != null && value !== '')));
    if (!sheets.length) throw new Error('The table is empty.');
    sheet.replaceChildren(...sheets.map((entry, index) => new window.Option(entry.sheet, String(index))));
    options.hidden = false;
    column.value = '';
    start.value = selectedRows().length > 1 ? '2' : '1';
    refreshColumns();
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const request = ++generation;
    fileInput.value = '';
    options.hidden = true;
    status.textContent = 'Reading recipients locally…';
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose a spreadsheet smaller than 5 MB.');
      let data;
      if (/\.xlsx$/i.test(file.name)) {
        await loadExcelReader();
        data = await window.readXlsxFile(file);
      } else if (/\.(csv|tsv)$/i.test(file.name)) {
        data = [{ sheet: 'Imported table', data: parseRecipientTable(await file.text()) }];
      } else {
        throw new Error('Choose an XLSX, CSV, or TSV file.');
      }
      if (request !== generation || !panel.isConnected) return;
      show(data);
      status.textContent = 'Choose the first data row and the column containing full names.';
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
      show([{ sheet: 'Pasted table', data: parseRecipientTable(text) }]);
      status.textContent = 'Choose the first data row and the column containing full names.';
    } catch (error) {
      status.textContent = error.message;
    }
  });

  sheet.addEventListener('change', () => {
    column.value = '';
    start.value = selectedRows().length > 1 ? '2' : '1';
    refreshColumns();
  });
  start.addEventListener('input', refreshColumns);
  column.addEventListener('change', refreshPreview);
  apply.addEventListener('click', () => {
    if (apply.disabled) return;
    names.value = selectedNames().join('\n');
    sheets = [];
    sheet.replaceChildren();
    column.replaceChildren();
    preview.textContent = '';
    options.hidden = true;
    names.dispatchEvent(new Event('input'));
    status.textContent = 'Recipient list imported.';
    names.focus();
  });
}
