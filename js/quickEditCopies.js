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
    status.textContent = 'Stopping after the current operation…';
  });
  const recipient = panel.querySelector('#qeCopyRecipient');
  const dialog = panel.closest('[role="dialog"]');
  const toggle = dialog.querySelector('[data-copies-toggle]');
  const save = dialog.querySelector('#qeModalSaveBtn');
  const hint = dialog.querySelector('.qe-modal__hint');
  const fields = new Map();
  const place = panel.querySelector('[data-place]');
  const styling = panel.querySelector('[data-name-style]');
  let placement = null;
  let scannedPage = null;

  function stopPlacement() {
    placement = null;
    place.setAttribute('aria-pressed', 'false');
    originalView.classList.remove('qe-original-page--placing');
  }

  function appearance() {
    if (!styling.querySelector('[data-style-enable]').checked) return null;
    const sizeInput = styling.querySelector('[data-style-size]');
    const size = sizeInput.value ? Number(sizeInput.value) : null;
    if (!sizeInput.validity.valid) throw new Error('Choose a name size from 6 to 48 pt.');
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
    if (viewport.rotation !== 0) throw new Error('Rotated pages are not supported in this mode.');
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
      ? 'No selectable text. Add a name in a blank area of the scan.'
      : 'This page has no selectable horizontal text.';
  }

  function showPlacement(line) {
    const mark = document.createElement('span');
    mark.className = 'qe-scan-field';
    mark.textContent = 'Name';
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
    status.textContent = 'Click a blank area where the recipient’s name should start.';
  });

  originalView.addEventListener('click', event => {
    if (!placement || activeJob) return;
    const { page, width, height } = placement;
    const box = originalView.getBoundingClientRect();
    const x = Math.round((event.clientX - box.left) * width / box.width);
    const y = Math.round(height - (event.clientY - box.top) * height / box.height - 12);
    const maxRight = Math.min(width - 12, x + 180);
    if (x < 12 || maxRight - x < 36 || y < 14 || y > height - 18) {
      status.textContent = 'Choose a blank area farther from the page edges.';
      return;
    }
    if ([...fields.values()].some(([{ line }]) => line.placed && line.page === page &&
        Math.abs(line.y - y) < 55 && x < line.maxRight + 20 && line.x < maxRight + 20)) {
      status.textContent = 'Leave more space between name fields.';
      return;
    }
    const line = { page, x, y, maxRight, pageHeight: height, size: 12, skew: 0, placed: true };
    fields.set(`placed:${page}:${x}:${y}`, [{ start: 0, end: 0, text: '', line }]);
    showPlacement(line);
    stopPlacement();
    status.textContent = 'Name field added. Download a sample to check its placement.';
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
      layoutHint.textContent = 'Quick Edit rebuilds the PDF. Check the sample for changes to page breaks or layout.';
      fitDocument(source);
      return;
    }
    preserve.disabled = toggle.disabled = bind.disabled = true;
    status.textContent = 'Opening original PDF…';
    try {
      original ??= await openOriginalPdf(file);
      if (!panel.isConnected) {
        await original.pdf.destroy();
        return;
      }
      pageSelect.replaceChildren(...Array.from({ length: original.pdf.numPages }, (_, index) =>
        new window.Option(`Page ${index + 1}`, String(index))));
      source.hidden = true;
      originalView.hidden = originalOptions.hidden = false;
      layoutHint.textContent = 'Select text on the original PDF. Only marked lines will be changed.';
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
      ? `${count} recipients. Remove ${count - RECIPIENT_LIMIT} to continue.`
      : `${count} ${count === 1 ? 'recipient' : 'recipients'}`;
    panel.querySelector('[data-field-count]').textContent =
      `${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} selected`;
    reset.disabled = busy || !fieldCount;
    recipient.disabled = busy || !count || count > RECIPIENT_LIMIT;
    preview.disabled = download.disabled = busy || !fieldCount || !count || count > RECIPIENT_LIMIT;
  }

  names.addEventListener('input', () => {
    const previous = recipient.selectedIndex;
    const entries = readNames();
    recipient.replaceChildren(...(entries.length && entries.length <= RECIPIENT_LIMIT
      ? entries.map((name, index) => new window.Option(`${index + 1}. ${name}`, String(index)))
      : [new window.Option(entries.length ? 'Too many recipients' : 'Add names first')]));
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
    toggle.textContent = panel.hidden ? 'Create personalized copies' : 'Back to PDF editing';
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
      status.textContent = 'Select the name or placeholder in the PDF first.';
      return;
    }
    const node = range.startContainer;
    const span = node.parentElement;
    const originalRow = originalRows.get(span);
    const allowed = preserve.checked ? originalRow : span?.matches('.qe-editable-run') && source.contains(span);
    if (node !== range.endContainer || node.nodeType !== window.Node.TEXT_NODE || !allowed ||
        span.childNodes.length !== 1) {
      status.textContent = 'Select text within one editable part of a line.';
      return;
    }
    const key = originalRow?.key ?? span;
    const existing = fields.get(key) ?? [];
    const { startOffset: start, endOffset: end } = range;
    if (existing.some(field => start < field.end && end > field.start)) {
      status.textContent = 'This selection overlaps an existing field.';
      return;
    }
    fields.set(key, [...existing, { start, end, text: span.textContent, line: originalRow?.line }]);
    span.classList.add('qe-copy-field');
    pointerSelection = null;
    document.getSelection()?.removeAllRanges();
    status.textContent = 'Name field added.';
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
    status.textContent = 'Fields cleared.';
    refreshActions();
  });

  async function generate(batch) {
    const recipients = readNames();
    if (!recipients.length || !fields.size || recipients.length > RECIPIENT_LIMIT) {
      status.textContent = `Select at least one field and enter 1–${RECIPIENT_LIMIT} names.`;
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
        status.textContent = 'Preparing the selected lines…';
        prepared = await prepareOriginalCopy(original, assignments.map(ranges => ranges[0].line));
        if (cancelled()) return;
        status.textContent = `Checking ${count} ${count === 1 ? 'recipient' : 'recipients'} before export…`;
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
        status.textContent = `Building copy ${index + 1} of ${count}…`;
        if (preserve.checked) {
          try {
            result = await writeOriginalCopy(prepared, planned[index]);
          } catch (error) {
            throw new Error(`Recipient ${batch ? index + 1 : sampleIndex + 1}: ${error.message}`, { cause: error });
          }
        } else {
          for (const [span, ranges] of fields) {
            const originalText = ranges[0].text;
            if (span.textContent !== originalText || !source.contains(span)) {
              throw new Error('A selected field changed. Clear fields and select it again.');
            }
            copied[editable.indexOf(span)].textContent = substituteFields(originalText, ranges, name);
          }
          const parsed = await walkDomToPdfContent(clone, { isCancelled: cancelled });
          if (parsed.hasUnsupportedScript || parsed.skippedImages) {
            throw new Error(`Copy ${index + 1} contains text or images this editor cannot export safely.`);
          }
          result = await pdfContentToBlob(parsed, { isCancelled: cancelled });
        }
        if (cancelled()) return;
        if (zip) {
          totalBytes += result.size;
          if (totalBytes > 100 * 1024 * 1024) throw new Error('The ZIP exceeds 100 MB. Split the list into smaller batches.');
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
      status.textContent = batch ? `ZIP ready: ${count} PDFs.` : 'Sample PDF ready.';
    } catch (error) {
      if (!cancelled()) status.textContent = error.message;
    } finally {
      clone?.remove();
      if (job.cancelled && panel.isConnected) status.textContent = 'Export stopped. You can edit the list and try again.';
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
