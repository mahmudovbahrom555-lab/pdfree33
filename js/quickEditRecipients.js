import { copyText } from './quickEditCopyText.js';
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
      throw new Error(copyText('The table contains a malformed quoted value.', "表格中有一处带引号的数据格式不正确。"));
    } else if (!closed) {
      cell += char;
    }
  }
  if (quoted) throw new Error(copyText('The table contains an unclosed quoted value.', "表格中有一处引号未闭合。"));
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
    const rows = selectedRows();
    const first = Number(start.value);
    const duplicates = values.length - new Set(values).size;
    const skipped = Number.isInteger(first) && first > 0 ? Math.max(0, rows.length - first + 1 - values.length) : 0;
    const notes = [
      skipped ? copyText(`${skipped} blank or non-text rows skipped`, `已跳过 ${skipped} 个空白或非文本行`) : '',
      duplicates ? copyText(`${duplicates} repeated names kept as separate copies`, `保留 ${duplicates} 个重复姓名，每行生成一份副本`) : '',
    ].filter(Boolean);
    const multiline = values.some(value => /[\r\n]/.test(value));
    apply.disabled = !values.length || values.length > RECIPIENT_LIMIT || multiline;
    preview.textContent = multiline ? copyText('The selected column contains names on multiple lines.', "所选列中有跨多行的姓名。")
      : values.length > RECIPIENT_LIMIT ? copyText(`This column has ${values.length} names. The limit is ${RECIPIENT_LIMIT}.`, `此列有 ${values.length} 个姓名，最多支持 ${RECIPIENT_LIMIT} 个。`)
      : values.length ? copyText(`${values.length} names · ${[...values.slice(0, 3), ...notes].join(' · ')}`, `${values.length} 个姓名 · ${[...values.slice(0, 3), ...notes].join(' · ')}`)
      : copyText('No text values in this column from the selected row.', "从所选行开始，此列没有文本值。");
  }

  function refreshColumns() {
    const rows = selectedRows();
    const first = Number(start.value);
    const previous = column.value;
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const header = rows[first - 2] ?? [];
    column.replaceChildren(new window.Option(copyText('Choose a column', "请选择一列"), ''), ...Array.from({ length: width }, (_, index) =>
      new window.Option(`${columnName(index)}${header[index] ? ' · ' + String(header[index]).slice(0, 80) : ''}`, String(index))));
    column.value = previous;
    refreshPreview();
  }

  function show(data) {
    sheets = data.filter(entry => entry.data.some(row => row.some(value => value != null && value !== '')));
    if (!sheets.length) throw new Error(copyText('The table is empty.', "表格为空。"));
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
    status.textContent = copyText('Reading recipients locally…', "正在本地读取收件人…");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error(copyText('Choose a spreadsheet smaller than 5 MB.', "请选择小于 5 MB 的表格。"));
      let data;
      if (/\.xlsx$/i.test(file.name)) {
        await loadExcelReader();
        data = await window.readXlsxFile(file);
      } else if (/\.(csv|tsv)$/i.test(file.name)) {
        data = [{ sheet: copyText('Imported table', "导入的表格"), data: parseRecipientTable(await file.text()) }];
      } else {
        throw new Error(copyText('Choose an XLSX, CSV, or TSV file.', "请选择 XLSX、CSV 或 TSV 文件。"));
      }
      if (request !== generation || !panel.isConnected) return;
      show(data);
      status.textContent = /\.xlsx$/i.test(file.name)
        ? copyText('Choose the first data row and the full-name column. Hidden rows can be included; review the resulting list.', "请选择姓名起始行和所在列。隐藏行也可能被导入，请核对列表。")
        : copyText('Choose the first data row and the column containing full names.', "请选择姓名起始行和所在列。");
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
      show([{ sheet: copyText('Pasted table', "粘贴的表格"), data: parseRecipientTable(text) }]);
      status.textContent = copyText('Choose the first data row and the column containing full names.', "请选择姓名起始行和所在列。");
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
    status.textContent = copyText('Recipient list imported.', "收件人列表已导入。");
    names.focus();
  });
}
