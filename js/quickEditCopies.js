import { copyText } from './quickEditCopyText.js';
import { walkDomToPdfContent, pdfContentToBlob } from './docxToPdfCore.js';
import { loadJSZip } from './lazyLibs.js';
import { openOriginalPdf, originalLines, planOriginalCopies, prepareOriginalCopy, writeOriginalCopy } from './quickEditOriginal.js';
import { bindRecipientImport, RECIPIENT_LIMIT } from './quickEditRecipients.js';

export function substituteFields(text, fields, name) {
  for (const { start, end } of [...fields].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, start) + name + text.slice(end);
  }
  return text;
}

function nameParts(text, ranges, name) {
  const parts = [];
  let offset = 0;
  for (const { start, end } of [...ranges].sort((a, b) => a.start - b.start)) {
    if (start > offset) parts.push({ text: text.slice(offset, start), name: false });
    parts.push({ text: name, name: true });
    offset = end;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), name: false });
  return parts;
}

export function copyFilename(name, index) {
  const safe = Array.from(name, char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    ? '_' : char).join('').replace(/[<>:"/\\|?*]/g, '_').trim();
  return `${index + 1} - ${Array.from(safe).slice(0, 60).join('')}.pdf`;
}

export function bindQuickEditCopies(panel, source, file, fitDocument, originalOnly = false) {
  const names = panel.querySelector('textarea');
  const status = panel.querySelector('[role="status"]');
  const bind = panel.querySelector('[data-bind]');
  const reset = panel.querySelector('[data-reset]');
  const preview = panel.querySelector('[data-preview]');
  const download = panel.querySelector('[data-download]');
  const stop = panel.querySelector('[data-stop]');
  let activeJob = null;
  stop.addEventListener('click', () => {
    if (!activeJob) return;
    activeJob.cancelled = true;
    stop.disabled = true;
    status.textContent = copyText('Stopping after the current operation…', "正在停止，当前操作完成后将结束导出…");
  });
  const recipient = panel.querySelector('#qeCopyRecipient');
  const dialog = panel.closest('[role="dialog"]');
  const toggle = dialog.querySelector('[data-copies-toggle]');
  const save = dialog.querySelector('#qeModalSaveBtn');
  const hint = dialog.querySelector('.qe-modal__hint');
  const fields = new Map();
  const place = panel.querySelector('[data-place]');
  const styling = panel.querySelector('[data-name-style]');
  const styleEnabled = styling.querySelector('[data-style-enable]');
  const styleOptions = styling.querySelector('[data-style-options]');
  styleEnabled.addEventListener('change', () => { styleOptions.disabled = !styleEnabled.checked; });
  let placement = null;
  let scannedPage = null;

  function stopPlacement() {
    placement = null;
    place.setAttribute('aria-pressed', 'false');
    originalView.classList.remove('qe-original-page--placing');
  }

  function appearance() {
    if (!styleEnabled.checked) return null;
    const sizeInput = styling.querySelector('[data-style-size]');
    const size = sizeInput.value ? Number(sizeInput.value) : null;
    if (!sizeInput.validity.valid) throw new Error(copyText('Choose a name size from 6 to 48 pt.', "请将姓名字号设为 6 至 48 磅。"));
    const hex = styling.querySelector('[data-style-color]').value;
    return {
      family: styling.querySelector('[data-style-font]').value,
      size,
      color: [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255),
      bold: styling.querySelector('[data-style-bold]').checked,
      italic: styling.querySelector('[data-style-italic]').checked,
    };
  }
  bindRecipientImport(panel, names, status);
  const preserve = panel.querySelector('[data-preserve-layout]');
  const originalOptions = panel.querySelector('[data-original-options]');
  const pageSelect = panel.querySelector('#qeOriginalPage');
  const smallerText = panel.querySelector('[data-smaller-text]');
  const layoutHint = panel.querySelector('[data-layout-hint]');
  const stage = source.parentElement;
  const originalView = document.createElement('div');
  originalView.className = 'qe-original-page';
  originalView.hidden = true;
  stage.appendChild(originalView);
  let original = null;
  let originalRows = new Map();
  let renderVersion = 0;
  let pointerSelection = null;

  function currentRange() {
    const selection = document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    return selection.getRangeAt(0);
  }

  async function renderOriginal() {
    const version = ++renderVersion;
    stopPlacement();
    scannedPage = null;
    place.hidden = true;
    pointerSelection = null;
    originalRows.clear();
    originalView.replaceChildren();
    bind.disabled = true;
    const pageIndex = Number(pageSelect.value);
    const page = await original.pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    if (viewport.rotation !== 0) throw new Error(copyText('Rotated pages are not supported in this mode.', "此模式暂不支持旋转页面。"));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const { items } = await page.getTextContent();
    const lines = originalLines(items);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (version !== renderVersion || !panel.isConnected) return;
    originalView.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
    originalView.style.maxWidth = `${viewport.width}px`;
    originalView.replaceChildren(canvas);
    originalRows = new Map();
    for (const line of lines) {
      const next = lines.find(other => other.y === line.y && other.x > line.right);
      line.page = pageIndex;
      line.maxRight = next ? Math.max(line.right, next.x - 12) : line.right;
      const span = document.createElement('span');
      span.className = 'qe-original-line';
      span.textContent = line.text;
      span.style.left = `${line.x / viewport.width * 100}%`;
      span.style.top = `${(viewport.height - line.y - line.size) / viewport.height * 100}%`;
      span.style.width = `${(line.right - line.x) / viewport.width * 100}%`;
      span.style.fontSize = `${line.size / viewport.width * 100}cqw`;
      const key = `${line.page}:${line.x}:${line.y}`;
      if (fields.has(key)) span.classList.add('qe-copy-field');
      originalRows.set(span, { key, line });
      originalView.appendChild(span);
    }
    bind.disabled = !lines.length;
    if (!items.some(item => item.str?.trim())) {
      scannedPage = { page: pageIndex, width: viewport.width, height: viewport.height };
      place.hidden = false;
      for (const ranges of fields.values()) {
        const { line } = ranges[0];
        if (line.placed && line.page === pageIndex) showPlacement(line);
      }
    }
    status.textContent = lines.length ? '' : scannedPage
      ? copyText('No selectable text. Add a name in a blank area of the scan.', "此页没有可选文字。可在扫描页的空白处添加姓名。")
      : copyText('This page has no selectable horizontal text.', "此页没有可选的横排文字。");
  }

  function showPlacement(line) {
    const mark = document.createElement('span');
    mark.className = 'qe-scan-field';
    mark.textContent = copyText('Name', "姓名");
    mark.style.left = `${line.x / scannedPage.width * 100}%`;
    mark.style.top = `${(scannedPage.height - line.y - line.size) / scannedPage.height * 100}%`;
    mark.style.width = `${(line.maxRight - line.x) / scannedPage.width * 100}%`;
    originalView.appendChild(mark);
  }

  place.addEventListener('click', () => {
    if (!scannedPage || activeJob) return;
    if (placement) {
      stopPlacement();
      return;
    }
    placement = scannedPage;
    place.setAttribute('aria-pressed', 'true');
    originalView.classList.add('qe-original-page--placing');
    status.textContent = copyText('Click a blank area where the recipient’s name should start.', "点击空白处，设置收件人姓名的起始位置。");
  });

  originalView.addEventListener('click', event => {
    if (!placement || activeJob) return;
    const { page, width, height } = placement;
    const box = originalView.getBoundingClientRect();
    const x = Math.round((event.clientX - box.left) * width / box.width);
    const y = Math.round(height - (event.clientY - box.top) * height / box.height - 12);
    const maxRight = Math.min(width - 12, x + 180);
    if (x < 12 || maxRight - x < 36 || y < 14 || y > height - 18) {
      status.textContent = copyText('Choose a blank area farther from the page edges.', "请选择离页边更远的空白位置。");
      return;
    }
    if ([...fields.values()].some(([{ line }]) => line.placed && line.page === page &&
        Math.abs(line.y - y) < 55 && x < line.maxRight + 20 && line.x < maxRight + 20)) {
      status.textContent = copyText('Leave more space between name fields.', "请在姓名字段之间留出更多空间。");
      return;
    }
    const line = { page, x, y, maxRight, pageHeight: height, size: 12, skew: 0, placed: true };
    fields.set(`placed:${page}:${x}:${y}`, [{ start: 0, end: 0, text: '', line }]);
    showPlacement(line);
    stopPlacement();
    status.textContent = copyText('Name field added. Download a sample to check its placement.', "已添加姓名字段。请下载样本检查位置。");
    refreshActions();
  });

  async function changeOriginalPage() {
    try {
      await renderOriginal();
    } catch (error) {
      originalView.replaceChildren();
      status.textContent = error.message;
    }
  }

  pageSelect.addEventListener('change', changeOriginalPage);
  preserve.addEventListener('change', async () => {
    clearFields();
    refreshActions();
    status.textContent = '';
    if (!preserve.checked) {
      renderVersion++;
      originalView.hidden = originalOptions.hidden = true;
      source.hidden = false;
      bind.disabled = false;
      layoutHint.textContent = copyText('Quick Edit rebuilds the PDF. Check the sample for changes to page breaks or layout.', "快速编辑会重新生成 PDF。请查看样本，确认分页和版式。");
      fitDocument(source);
      return;
    }
    preserve.disabled = toggle.disabled = bind.disabled = true;
    status.textContent = copyText('Opening original PDF…', "正在打开原始 PDF…");
    try {
      original ??= await openOriginalPdf(file);
      if (!panel.isConnected) {
        await original.pdf.destroy();
        return;
      }
      pageSelect.replaceChildren(...Array.from({ length: original.pdf.numPages }, (_, index) =>
        new window.Option(copyText(`Page ${index + 1}`, `第 ${index + 1} 页`), String(index))));
      source.hidden = true;
      originalView.hidden = originalOptions.hidden = false;
      layoutHint.textContent = copyText('Select text on the original PDF. Only marked lines will be changed.', "请在原始 PDF 中选中文字。仅修改已标记的行。");
      status.textContent = '';
      await changeOriginalPage();
    } catch (error) {
      preserve.checked = false;
      bind.disabled = false;
      status.textContent = error.message;
    } finally {
      preserve.disabled = originalOnly;
      toggle.disabled = false;
    }
  });
  const readNames = () => names.value.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  let busy = false;

  function refreshActions() {
    const count = readNames().length;
    const fieldCount = [...fields.values()].reduce((total, ranges) => total + ranges.length, 0);
    panel.querySelector('[data-recipient-count]').textContent = count > RECIPIENT_LIMIT
      ? copyText(`${count} recipients. Remove ${count - RECIPIENT_LIMIT} to continue.`, `共有 ${count} 位收件人。请移除 ${count - RECIPIENT_LIMIT} 位后继续。`)
      : copyText(`${count} ${count === 1 ? 'recipient' : 'recipients'}`, `${count} 位收件人`);
    panel.querySelector('[data-field-count]').textContent =
      copyText(`${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} selected`, `已选 ${fieldCount} 个字段`);
    reset.disabled = busy || !fieldCount;
    recipient.disabled = busy || !count || count > RECIPIENT_LIMIT;
    preview.disabled = download.disabled = busy || !fieldCount || !count || count > RECIPIENT_LIMIT;
  }

  names.addEventListener('input', () => {
    const previous = recipient.selectedIndex;
    const entries = readNames();
    recipient.replaceChildren(...(entries.length && entries.length <= RECIPIENT_LIMIT
      ? entries.map((name, index) => new window.Option(`${index + 1}. ${name}`, String(index)))
      : [new window.Option(entries.length ? copyText('Too many recipients', "收件人过多") : copyText('Add names first', "请先添加姓名"))]));
    recipient.selectedIndex = Math.max(0, Math.min(previous, recipient.options.length - 1));
    status.textContent = '';
    refreshActions();
  });

  toggle.addEventListener('click', () => {
    if (!panel.hidden && preserve.checked) {
      preserve.checked = false;
      preserve.dispatchEvent(new Event('change'));
    }
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    toggle.textContent = panel.hidden ? copyText('Create personalized copies', "生成个性化副本") : copyText('Back to PDF editing', "返回 PDF 编辑");
    save.hidden = hint.hidden = !panel.hidden;
    dialog.classList.toggle('qe-modal__card--copies', !panel.hidden);
    fitDocument(source);
    if (!panel.hidden) names.focus();
  });

  bind.addEventListener('pointerdown', event => {
    pointerSelection = currentRange()?.cloneRange() ?? null;
    event.preventDefault();
  });
  bind.addEventListener('click', () => {
    const range = currentRange() ?? pointerSelection;
    pointerSelection = null;
    if (!range || range.collapsed) {
      status.textContent = copyText('Select the name or placeholder in the PDF first.', "请先在 PDF 中选中姓名或占位文字。");
      return;
    }
    const node = range.startContainer;
    const span = node.parentElement;
    const originalRow = originalRows.get(span);
    const allowed = preserve.checked ? originalRow : span?.matches('.qe-editable-run') && source.contains(span);
    if (node !== range.endContainer || node.nodeType !== window.Node.TEXT_NODE || !allowed ||
        span.childNodes.length !== 1) {
      status.textContent = copyText('Select text within one editable part of a line.', "请在同一行的一个可编辑文本片段内选中文字。");
      return;
    }
    const key = originalRow?.key ?? span;
    const existing = fields.get(key) ?? [];
    const { startOffset: start, endOffset: end } = range;
    if (existing.some(field => start < field.end && end > field.start)) {
      status.textContent = copyText('This selection overlaps an existing field.', "所选文字与已有字段重叠。");
      return;
    }
    fields.set(key, [...existing, { start, end, text: span.textContent, line: originalRow?.line }]);
    span.classList.add('qe-copy-field');
    pointerSelection = null;
    document.getSelection()?.removeAllRanges();
    status.textContent = copyText('Name field added.', "已添加姓名字段。");
    refreshActions();
  });

  function clearFields() {
    for (const span of stage.querySelectorAll('.qe-copy-field')) span.classList.remove('qe-copy-field');
    for (const mark of originalView.querySelectorAll('.qe-scan-field')) mark.remove();
    stopPlacement();
    fields.clear();
    pointerSelection = null;
  }

  reset.addEventListener('click', () => {
    clearFields();
    status.textContent = copyText('Fields cleared.', "已清除字段。");
    refreshActions();
  });

  async function generate(batch) {
    const recipients = readNames();
    if (!recipients.length || !fields.size || recipients.length > RECIPIENT_LIMIT) {
      status.textContent = copyText(`Select at least one field and enter 1–${RECIPIENT_LIMIT} names.`, `请至少选中一个字段，并输入 1 至 ${RECIPIENT_LIMIT} 个姓名。`);
      return;
    }

    if (busy) return;
    let custom;
    try {
      custom = preserve.checked ? appearance() : null;
    } catch (error) {
      status.textContent = error.message;
      return;
    }
    stopPlacement();
    const sampleIndex = recipient.selectedIndex;
    const job = { cancelled: false };
    activeJob = job;
    stop.hidden = false;
    stop.disabled = false;
    const controls = [names, bind, reset, preview, download, toggle, recipient, preserve, pageSelect, smallerText, place, ...styling.querySelectorAll('input, select')].filter(control => !control.disabled);
    const importControls = Array.from(panel.querySelectorAll('[data-recipient-file], [data-import-options] input, [data-import-options] select, [data-import-options] button'))
      .filter(control => !control.disabled);
    controls.push(...importControls);
    busy = true;
    controls.forEach(control => { control.disabled = true; });
    const editable = [...source.querySelectorAll('.qe-editable-run')];
    const clone = preserve.checked ? null : source.cloneNode(true);
    if (clone) {
      clone.style.cssText += ';position:fixed;left:-100000px;top:0;pointer-events:none;';
      clone.setAttribute('aria-hidden', 'true');
      clone.inert = true;
      panel.appendChild(clone);
    }
    const cancelled = () => job.cancelled || !panel.isConnected;

    try {
      const copied = clone ? [...clone.querySelectorAll('.qe-editable-run')] : [];
      const zip = batch ? await loadJSZip().then(() => new window.JSZip()) : null;
      const count = batch ? recipients.length : 1;
      const assignments = [...fields.values()];
      let prepared;
      let planned;
      if (preserve.checked) {
        status.textContent = copyText('Preparing the selected lines…', "正在准备选中的文本行…");
        prepared = await prepareOriginalCopy(original, assignments.map(ranges => ranges[0].line));
        if (cancelled()) return;
        status.textContent = copyText(`Checking ${count} ${count === 1 ? 'recipient' : 'recipients'} before export…`, `导出前正在检查 ${count} 位收件人…`);
        const copies = Array.from({ length: count }, (_, index) => {
          const recipientIndex = batch ? index : sampleIndex;
          return { recipientIndex, changes: assignments.map(ranges => ({
            line: ranges[0].line,
            text: substituteFields(ranges[0].text, ranges, recipients[recipientIndex]),
            parts: custom ? nameParts(ranges[0].text, ranges, recipients[recipientIndex]) : null,
            appearance: custom,
          })) };
        });
        planned = await planOriginalCopies(prepared, copies, smallerText.checked, cancelled);
        if (cancelled()) return;
      }
      let result;
      let totalBytes = 0;
      for (let index = 0; index < count; index++) {
        if (cancelled()) return;
        const name = recipients[batch ? index : sampleIndex];
        status.textContent = copyText(`Building copy ${index + 1} of ${count}…`, `正在生成第 ${index + 1} 份副本，共 ${count} 份…`);
        if (preserve.checked) {
          try {
            result = await writeOriginalCopy(prepared, planned[index]);
          } catch (error) {
            throw new Error(copyText(`Recipient ${batch ? index + 1 : sampleIndex + 1}: ${error.message}`, `第 ${batch ? index + 1 : sampleIndex + 1} 位收件人：${error.message}`), { cause: error });
          }
        } else {
          for (const [span, ranges] of fields) {
            const originalText = ranges[0].text;
            if (span.textContent !== originalText || !source.contains(span)) {
              throw new Error(copyText('A selected field changed. Clear fields and select it again.', "所选字段已变化。请清除字段后重新选择。"));
            }
            copied[editable.indexOf(span)].textContent = substituteFields(originalText, ranges, name);
          }
          const parsed = await walkDomToPdfContent(clone, { isCancelled: cancelled });
          if (parsed.hasUnsupportedScript || parsed.skippedImages) {
            throw new Error(copyText(`Copy ${index + 1} contains text or images this editor cannot export safely.`, `第 ${index + 1} 份副本包含无法安全导出的文字或图片。`));
          }
          result = await pdfContentToBlob(parsed, { isCancelled: cancelled });
        }
        if (cancelled()) return;
        if (zip) {
          totalBytes += result.size;
          if (totalBytes > 100 * 1024 * 1024) throw new Error(copyText('The ZIP exceeds 100 MB. Split the list into smaller batches.', "ZIP 超过 100 MB。请将收件人分成较小的批次。"));
          zip.file(copyFilename(name, index), result);
        }
      }
      if (zip) result = await zip.generateAsync({ type: 'blob' });
      if (cancelled()) return;
      const url = URL.createObjectURL(result);
      const link = document.createElement('a');
      link.href = url;
      link.download = batch ? 'personalized-copies.zip' : copyFilename(recipients[sampleIndex], sampleIndex);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status.textContent = batch ? copyText(`ZIP ready: ${count} PDFs.`, `ZIP 已准备就绪，包含 ${count} 份 PDF。`) : copyText('Sample PDF ready.', "样本 PDF 已准备就绪。");
    } catch (error) {
      if (!cancelled()) status.textContent = error.message;
    } finally {
      clone?.remove();
      if (job.cancelled && panel.isConnected) status.textContent = copyText('Export stopped. You can edit the list and try again.', "已停止导出。可编辑列表后重试。");
      activeJob = null;
      stop.hidden = true;
      busy = false;
      controls.forEach(control => { control.disabled = false; });
      refreshActions();
    }
  }

  preview.addEventListener('click', () => generate(false));
  download.addEventListener('click', () => generate(true));
  if (originalOnly) {
    toggle.click();
    toggle.hidden = true;
    preserve.closest('label').hidden = true;
    preserve.checked = true;
    preserve.dispatchEvent(new Event('change'));
  }
  return () => {
    clearFields();
    renderVersion++;
    void original?.pdf.destroy().catch(() => {});
    source.hidden = false;
  };
}
