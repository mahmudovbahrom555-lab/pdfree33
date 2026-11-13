import * as pdfjs from '../js/vendor/pdfjs-4.10.38/pdf.min.js';
import { suggestPageFrames } from './suggest-frames.js';
import { answerOptions, makeQuizFile } from './quiz-pptx.js';
import { loadJSZip, loadPptxGenJs } from '../js/lazyLibs.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../js/vendor/pdfjs-4.10.38/pdf.worker.min.js', import.meta.url).href;
const $ = id => document.getElementById(id);
const status = message => { $('status').textContent = message; };
const overlay = $('overlay');
const svgNS = 'http://www.w3.org/2000/svg';
let pdf, pageNumber = 1, renderedPage, viewport, renderVersion = 0;
let storageKey, boundaryProposal, pageSuggestions;
let reviewedPages = new Set(), slideReviewIndex = 0, slideReviewZoom = false, pendingExport;
let tasks = [], frames = [], history = [], taskId, frameId, drag, cutFrameId, busy = false;
const current = () => tasks.find(task => task.id === taskId);
const selected = () => frames.find(frame => frame.id === frameId);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function remember() {
  history.push(structuredClone({ tasks, frames, taskId, frameId }));
  if (history.length > 40) history.shift();
}
function saveDraft() {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ tasks, frames, taskId, space: $('space').value, reviewedPages: [...reviewedPages] }));
    $('saved').textContent = 'The frames are saved in this browser.';
  } catch {
    $('saved').textContent = 'The browser didn\'t save the frames. Keep this tab open.';
  }
}
function changed() {
  clearBoundaryProposal();
  cancelCut();
  saveDraft();
  $('slide').hidden = true;
  $('expand-preview').hidden = true;
  $('preview-placeholder').hidden = false;
  refresh();
}
function addTask(index = tasks.length) {
  const id = crypto.randomUUID();
  tasks.splice(index, 0, { id, number: 1 + Math.max(0, ...tasks.map(task => task.number)), frames: [] });
  taskId = id;
}
function drawOverlay(draft) {
  overlay.replaceChildren();
  if (!viewport) return;
  const onPage = frames.filter(frame => frame.page === pageNumber);
  for (const frame of draft?.id ? onPage.map(item => item.id === draft.id ? draft : item)
    : [...onPage, ...(draft ? [draft] : [])]) {
    const [x, y, right, bottom] = frame.rect;
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('class', `frame ${frame.kind} ${frame.id === frameId ? 'selected' : ''}`);
    for (const [name, value] of Object.entries({ x, y, width: right - x, height: bottom - y })) rect.setAttribute(name, value);
    if (frame.id) rect.dataset.frame = frame.id;
    overlay.append(rect);
    if (frame.id && frame.id === frameId) {
      const midX = (x + right) / 2;
      const midY = (y + bottom) / 2;
      const radius = 7 * viewport.width / overlay.clientWidth;
      const positions = [
        ['nw', x, y], ['n', midX, y], ['ne', right, y], ['e', right, midY],
        ['se', right, bottom], ['s', midX, bottom], ['sw', x, bottom], ['w', x, midY],
      ];
      for (const [direction, cx, cy] of positions) {
        const grip = document.createElementNS(svgNS, 'circle');
        for (const [name, value] of Object.entries({ cx, cy, r: radius, class: 'grip' })) grip.setAttribute(name, value);
        grip.dataset.frame = frame.id;
        grip.dataset.resize = direction;
        overlay.append(grip);
      }
    }
  }
  if (pageSuggestions && !hasPageFrames(pageNumber)) {
    const result = pageSuggestions.get(pageNumber);
    const proposed = result?.bands.map(band => ({ rect: band.rect, shared: false })) ?? [];
    if (result?.shared) proposed.push({ rect: result.shared, shared: true });
    for (const { rect: [x, y, right, bottom], shared } of proposed) {
      const suggestion = document.createElementNS(svgNS, 'rect');
      const className = shared ? 'suggested-frame suggested-shared' : 'suggested-frame';
      for (const [name, value] of Object.entries({ x, y, width: right - x, height: bottom - y, class: className })) {
        suggestion.setAttribute(name, value);
      }
      overlay.append(suggestion);
    }
  }
  const pending = tasks.filter(task => task.anchor?.page === pageNumber && !ready(task))
    .map(task => task.anchor);
  if (!hasPageFrames(pageNumber)) pending.push(...(pageSuggestions?.get(pageNumber)?.missing ?? []));
  for (const anchor of pending) {
    const marker = document.createElementNS(svgNS, 'rect');
    marker.setAttribute('class', 'missing-anchor');
    marker.setAttribute('x', Math.max(0, anchor.x - 3));
    marker.setAttribute('y', anchor.top + 5);
    marker.setAttribute('width', Math.min(24, viewport.width - anchor.x));
    marker.setAttribute('height', anchor.y - anchor.top);
    overlay.append(marker);
  }
  if (boundaryProposal && !draft) {
    const { frame, side, value } = boundaryProposal;
    const [left, top, right, bottom] = frame.rect;
    const vertical = side % 2 === 0;
    const line = document.createElementNS(svgNS, 'line');
    const endpoints = vertical ? [value, top, value, bottom] : [left, value, right, value];
    for (const [index, name] of ['x1', 'y1', 'x2', 'y2'].entries()) line.setAttribute(name, endpoints[index]);
    line.setAttribute('class', 'boundary-proposal');
    overlay.append(line);
  }
  drawFramePreview(draft ?? selected());
}

// Same 2.5× lens and crosshair as Document Scanner, using the PDF canvas.
function showResizeLoupe(rect, edge) {
  const [left, top, right, bottom] = rect;
  const x = edge.includes('w') ? left : edge.includes('e') ? right : (left + right) / 2;
  const y = edge.includes('n') ? top : edge.includes('s') ? bottom : (top + bottom) / 2;
  const point = new DOMPoint(x, y).matrixTransform(overlay.getScreenCTM());
  const lens = $('resize-loupe');
  const source = $('source');
  const ctx = lens.getContext('2d');
  const size = lens.width, half = size / 2, offset = 90;
  const pixelsX = source.width / viewport.width;
  const pixelsY = source.height / viewport.height;
  const cropW = size / 2.5 * source.width / overlay.clientWidth;
  const cropH = size / 2.5 * source.height / overlay.clientHeight;
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, x * pixelsX - cropW / 2, y * pixelsY - cropH / 2, cropW, cropH,
    0, 0, size, size);
  ctx.beginPath();
  ctx.moveTo(0, half);
  ctx.lineTo(size, half);
  ctx.moveTo(half, 0);
  ctx.lineTo(half, size);
  ctx.strokeStyle = getComputedStyle(lens).color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1;
  ctx.stroke();
  const yOffset = point.y - offset - half >= 60 ? -offset : offset;
  lens.style.left = `${clamp(point.x, half, window.innerWidth - half)}px`;
  lens.style.top = `${clamp(point.y + yOffset, half, window.innerHeight - half)}px`;
  lens.hidden = false;
}
function hideResizeLoupe() { $('resize-loupe').hidden = true; }

function drawFramePreview(frame) {
  const button = $('expand-frame');
  button.hidden = !frame || frame.page !== renderedPage;
  if (button.hidden) return;
  const [x, y, right, bottom] = frame.rect;
  const w = right - x, h = bottom - y;
  if (w <= 0 || h <= 0) { button.hidden = true; return; }
  const source = $('source');
  const sourceX = source.width / viewport.width, sourceY = source.height / viewport.height;
  const canvas = $('frame-preview');
  const scale = Math.min(520 / w, 320 / h);
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);
  canvas.getContext('2d').drawImage(source, x * sourceX, y * sourceY, w * sourceX, h * sourceY,
    0, 0, canvas.width, canvas.height);
}

function refresh() {
  $('task-count').textContent = String(tasks.length);
  const quiz = current().quiz;
  $('quiz-enabled').checked = Boolean(quiz);
  $('quiz-fields').hidden = !quiz;
  $('quiz-count').value = quiz?.count ?? 4;
  $('quiz-correct').options[5].disabled = quiz?.count !== 5;
  $('quiz-correct').value = quiz?.correct ?? '';
  $('quiz-explanation').value = quiz?.explanation ?? '';
  refreshReview();
  refreshSuggestions();
  $('task-list').replaceChildren(...tasks.map(task => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.task = task.id;
    button.setAttribute('aria-current', String(task.id === taskId));
    const count = document.createElement('small');
    count.textContent = task.frames.length ? String(task.frames.length) : 'Empty';
    button.append(task.anchor && !ready(task) ? `Frame No. ${task.anchor.number}` : `Question ${task.number}`, count);
    button.onclick = () => {
      selectTask(task.id);
      const first = task.frames.map(id => frames.find(frame => frame.id === id)).find(frame => frame?.kind === 'task');
      const targetPage = first?.page ?? task.anchor?.page;
      if (task.anchor && !first) $('kind').value = 'task';
      if (targetPage && targetPage !== pageNumber) void showPage(targetPage);
      $('task-list').querySelector('[aria-current="true"]')?.focus();
    };
    return button;
  }));
  $('fragment-count').textContent = String(current().frames.length);
  $('frame-tools').hidden = !selected();
  $('undo').disabled = !history.length;
  const taskIndex = tasks.indexOf(current());
  const frameIndex = current().frames.indexOf(frameId);
  $('task-up').disabled = taskIndex <= 0;
  $('task-down').disabled = taskIndex >= tasks.length - 1;
  $('frame-up').disabled = frameIndex <= 0;
  $('frame-down').disabled = frameIndex < 0 || frameIndex >= current().frames.length - 1;
  const moveTarget = $('move-target');
  moveTarget.replaceChildren(new Option('Choose a question', ''),
    ...tasks.filter(task => task !== current()).map(task => new Option(`Question ${task.number}`, task.id)));
  moveTarget.disabled = frameIndex < 0 || selected()?.kind !== 'task' || tasks.length < 2;
  $('cut-frame').disabled = frameIndex < 0 || selected()?.kind !== 'task' ||
    selected().page !== pageNumber || selected().rect[3] - selected().rect[1] < 10;
  $('split-task').disabled = frameIndex < 0 || selected()?.kind !== 'task' ||
    !current().frames.slice(0, frameIndex).some(id => frames.find(frame => frame.id === id)?.kind === 'task');
  $('merge-next').disabled = taskIndex >= tasks.length - 1;
  $('delete-frame').disabled = !selected();
  $('previous').disabled = $('mobile-previous').disabled = pageNumber <= 1;
  $('next').disabled = $('mobile-next').disabled = pageNumber >= (pdf?.numPages ?? 1);
  $('fragments').replaceChildren();
  const linked = current().frames.map(id => frames.find(frame => frame.id === id));
  if (!linked.length) {
    const hint = document.createElement('p');
    hint.textContent = 'No frames yet. Draw one around a question on the page.';
    $('fragments').append(hint);
  }
  const available = frames.filter(frame => frame.kind === 'shared' && !current().frames.includes(frame.id));
  for (const frame of [...linked, ...available]) {
    const row = document.createElement('div');
    row.className = 'fragment';
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = `${frame.kind === 'shared' ? 'Shared' : 'Part'} · p. ${frame.page}`;
    open.setAttribute('aria-pressed', String(frame.id === frameId));
    open.onclick = () => { frameId = frame.id; void showPage(frame.page); };
    row.append(open);
    if (frame.kind === 'shared') {
      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = current()?.frames.includes(frame.id) ?? false;
      checkbox.onchange = () => {
        remember();
        const task = current();
        task.frames = checkbox.checked ? [frame.id, ...task.frames] : task.frames.filter(id => id !== frame.id);
        changed();
      };
      label.append(checkbox, ' Add to question');
      row.append(label);
      const links = document.createElement('small');
      const linkedTasks = tasks.filter(task => task.frames.includes(frame.id)).map(task => task.number);
      links.textContent = linkedTasks.length ? `Questions: ${linkedTasks.join(', ')}` : 'Not attached';
      row.append(links);
      if (linkedTasks.length < tasks.length) {
        const attachAll = document.createElement('button');
        attachAll.type = 'button';
        attachAll.textContent = 'Attach to all questions';
        attachAll.onclick = () => {
          remember();
          for (const task of tasks) {
            if (!task.frames.includes(frame.id)) task.frames.unshift(frame.id);
          }
          changed();
        };
        row.append(attachAll);
      }
    }
    $('fragments').append(row);
  }
  drawOverlay();
}

function unlinkedShared() {
  const linked = new Set(tasks.flatMap(task => task.frames));
  return frames.filter(frame => frame.kind === 'shared' && !linked.has(frame.id));
}

function refreshReview() {
  const byPage = new Map();
  const byId = new Map(frames.map(frame => [frame.id, frame]));
  for (const task of tasks) {
    const pages = new Set(task.frames.map(id => byId.get(id)).filter(frame => frame?.kind === 'task').map(frame => frame.page));
    for (const page of pages) byPage.set(page, (byPage.get(page) ?? 0) + 1);
  }
  const select = $('review-page');
  const options = document.createDocumentFragment();
  for (let page = 1; page <= pdf.numPages; page++) {
    options.append(new Option(`P. ${page} · questions: ${byPage.get(page) ?? 0}${reviewedPages.has(page) ? ' · checked' : ''}`, page));
  }
  select.replaceChildren(options);
  select.value = pageNumber;
  $('reviewed').checked = reviewedPages.has(pageNumber);
  $('review-current').textContent = byPage.has(pageNumber) ? '' : 'This page has no question frames.';
  const unlinked = unlinkedShared();
  $('review-summary').textContent = `Check · ${reviewedPages.size} of ${pdf.numPages} pages${unlinked.length ? ` · not attached: ${unlinked.length}` : ''}`;
  $('review-shared').textContent = unlinked.length
    ? `Shared frames not attached on p. ${[...new Set(unlinked.map(frame => frame.page))].join(', ')}.` : '';
}
$('review-page').onchange = () => showPage($('review-page').value);
$('reviewed').onchange = () => {
  if ($('reviewed').checked) reviewedPages.add(pageNumber);
  else reviewedPages.delete(pageNumber);
  saveDraft();
  refreshReview();
};

async function showPage(number) {
  hideResizeLoupe();
  clearBoundaryProposal();
  cancelCut();
  const version = ++renderVersion;
  pageNumber = clamp(Math.trunc(Number(number)) || 1, 1, pdf.numPages);
  $('page').value = pageNumber;
  overlay.style.pointerEvents = 'none';
  try {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1, Math.max(100, $('paper').parentElement.clientWidth - 30) / base.width) * Number($('zoom').value);
    const view = page.getViewport({ scale });
    const next = document.createElement('canvas');
    next.width = Math.ceil(view.width);
    next.height = Math.ceil(view.height);
    await page.render({ canvasContext: next.getContext('2d'), viewport: view }).promise;
    if (version !== renderVersion) return;
    const source = $('source');
    source.width = next.width;
    source.height = next.height;
    source.getContext('2d').drawImage(next, 0, 0);
    viewport = base;
    renderedPage = pageNumber;
    overlay.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    $('paper').hidden = false;
    refresh();
  } catch (error) {
    if (version === renderVersion) status(error.message);
  } finally {
    if (version === renderVersion) overlay.style.pointerEvents = '';
  }
}

async function openDocument(file, decryptedBuffer) {
  if (!file || busy) return;
  busy = true;
  $('file').disabled = true;
  $('welcome-file').disabled = true;
  $('workspace').disabled = true;
  status('Opening the PDF…');
  try {
    const bytes = await file.arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const key = 'pdfree:worksheet-editor:v1:' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    let draft;
    try { draft = JSON.parse(localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }
    const next = await pdfjs.getDocument({
      data: new Uint8Array(decryptedBuffer ?? bytes),
      isEvalSupported: false,
      cMapUrl: new URL('../js/vendor/pdfjs-cmaps/', import.meta.url).href,
      cMapPacked: true,
    }).promise;
    await pdf?.destroy();
    pdf = next;
    tasks = []; frames = []; history = []; frameId = undefined; drag = undefined;
    storageKey = key;
    pageSuggestions = undefined;
    reviewedPages = new Set(Array.isArray(draft?.reviewedPages) ? draft.reviewedPages.filter(n => Number.isInteger(n) && n >= 1 && n <= pdf.numPages) : []);
    if (draft?.tasks?.length && Array.isArray(draft.frames)) {
      ({ tasks, frames, taskId } = draft);
      if (!current()) taskId = tasks[0].id;
      $('space').value = draft.space === 'less' ? 'less' : 'more';
    } else {
      addTask();
      $('space').value = 'more';
    }
    $('saved').textContent = draft?.tasks?.length ? 'Your saved frames are back.' : '';
    $('page').max = pdf.numPages;
    $('slide').hidden = true;
    $('expand-preview').hidden = true;
    $('document-name').textContent = file.name;
    $('document-pages').textContent = `Pages in the original: ${pdf.numPages}`;
    $('page-total').textContent = `/ ${pdf.numPages}`;
    $('preview-placeholder').hidden = false;
    $('welcome').hidden = true;
    $('workspace').hidden = false;
    status('');
    await showPage(1);
  } catch (error) {
    status(`Couldn't open the PDF. ${error.message}`);
  } finally {
    busy = false;
    $('workspace').disabled = !pdf;
    $('file').disabled = false;
    $('welcome-file').disabled = false;
  }
}
function openFile(event) {
  const file = event.currentTarget.files[0];
  event.currentTarget.value = '';
  return openDocument(file);
}
$('file').onchange = openFile;
$('welcome-file').onchange = openFile;

if (new URLSearchParams(location.search).get('embedded') === '1' && window.parent !== window) {
  document.body.classList.add('worksheet-embedded');
  document.querySelector('.app-header').hidden = true;
  $('welcome').hidden = true;
  $('suggest-tasks').hidden = true;
  const receiveFile = event => {
    if (event.origin !== location.origin || event.source !== window.parent) return;
    if (event.data?.type !== 'pdfree-worksheet-file' || !(event.data.file instanceof File)) return;
    window.removeEventListener('message', receiveFile);
    void openDocument(event.data.file, event.data.decryptedBuffer);
  };
  window.addEventListener('message', receiveFile);
}

function point(event) {
  const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(overlay.getScreenCTM().inverse());
  return [clamp(position.x, 0, viewport.width), clamp(position.y, 0, viewport.height)];
}
function cancelCut() {
  cutFrameId = undefined;
  $('cut-frame').setAttribute('aria-pressed', 'false');
  overlay.classList.remove('cutting');
  overlay.querySelector('.cut-line')?.remove();
}
function cutAt(x, y) {
  const frame = frames.find(item => item.id === cutFrameId);
  const [left, top, right, bottom] = frame.rect;
  if (x < left || x > right || y < top + 5 || y > bottom - 5) return;
  remember();
  const original = current();
  const index = original.frames.indexOf(frame.id);
  const shared = new Set(frames.filter(item => item.kind === 'shared').map(item => item.id));
  const lower = { ...frame, id: crypto.randomUUID(), rect: [left, y, right, bottom] };
  frame.rect = [left, top, right, y];
  frames.push(lower);
  addTask(tasks.indexOf(original) + 1);
  current().frames = original.frames.flatMap((id, position) => {
    if (position === index) return [lower.id];
    return shared.has(id) || position > index ? [id] : [];
  });
  original.frames = original.frames.filter((id, position) => shared.has(id) || position <= index);
  frameId = lower.id;
  status('The frame is split into two questions.');
  changed();
}
$('cut-frame').onclick = () => {
  if (cutFrameId) { cancelCut(); status('Cut cancelled.'); return; }
  cutFrameId = frameId;
  $('cut-frame').setAttribute('aria-pressed', 'true');
  overlay.classList.add('cutting');
  status('Pick a horizontal line inside the frame. Escape cancels the cut.');
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && cutFrameId) { cancelCut(); status('Cut cancelled.'); }
});
overlay.onpointerdown = event => {
  if (busy || !viewport || event.button !== 0 || drag) return;
  if (cutFrameId) { cutAt(...point(event)); return; }
  clearBoundaryProposal();
  const frame = frames.find(item => item.id === event.target.dataset.frame);
  frameId = frame?.id;
  if (frame?.kind === 'task') taskId = tasks.find(task => task.frames.includes(frame.id)).id;
  drag = { pointer: event.pointerId, start: point(event), frame, resize: event.target.dataset.resize };
  overlay.setPointerCapture(event.pointerId);
  drawOverlay();
  if (drag.resize) showResizeLoupe(frame.rect, drag.resize);
};
overlay.onpointermove = event => {
  if (cutFrameId) {
    overlay.querySelector('.cut-line')?.remove();
    const [x, y] = point(event);
    const [left, top, right, bottom] = selected().rect;
    if (x < left || x > right || y < top + 5 || y > bottom - 5) return;
    const line = document.createElementNS(svgNS, 'line');
    for (const [name, value] of Object.entries({ x1: left, x2: right, y1: y, y2: y, class: 'cut-line' })) line.setAttribute(name, value);
    overlay.append(line);
    return;
  }
  if (drag?.pointer !== event.pointerId) return;
  const [x, y] = point(event);
  const [sx, sy] = drag.start;
  let rect;
  if (drag.frame) {
    const [left, top, right, bottom] = drag.frame.rect;
    if (drag.resize) {
      const edge = drag.resize;
      rect = [
        edge.includes('w') ? clamp(left + x - sx, 0, right - 5) : left,
        edge.includes('n') ? clamp(top + y - sy, 0, bottom - 5) : top,
        edge.includes('e') ? clamp(right + x - sx, left + 5, viewport.width) : right,
        edge.includes('s') ? clamp(bottom + y - sy, top + 5, viewport.height) : bottom,
      ];
    } else {
      const dx = clamp(x - sx, -left, viewport.width - right);
      const dy = clamp(y - sy, -top, viewport.height - bottom);
      rect = [left + dx, top + dy, right + dx, bottom + dy];
    }
  } else rect = [Math.min(x, sx), Math.min(y, sy), Math.max(x, sx), Math.max(y, sy)];
  drag.draft = { ...drag.frame, page: pageNumber, kind: drag.frame?.kind ?? $('kind').value, rect };
  drawOverlay(drag.draft);
  if (drag.resize) showResizeLoupe(rect, drag.resize);
};
overlay.onpointerleave = () => overlay.querySelector('.cut-line')?.remove();
overlay.onpointerup = event => {
  if (drag?.pointer !== event.pointerId) return;
  const draft = drag.draft;
  drag = undefined;
  hideResizeLoupe();
  if (draft && draft.rect[2] - draft.rect[0] >= 5 && draft.rect[3] - draft.rect[1] >= 5) {
    remember();
    if (draft.id) frames = frames.map(frame => frame.id === draft.id ? draft : frame);
    else {
      draft.id = crypto.randomUUID();
      frames.push(draft);
      if (draft.kind === 'shared') current().frames.unshift(draft.id);
      else current().frames.push(draft.id);
    }
    frameId = draft.id;
  }
  changed();
};
overlay.onlostpointercapture = () => {
  hideResizeLoupe();
  if (drag) { drag = undefined; refresh(); }
};

$('previous').onclick = () => showPage(pageNumber - 1);
$('next').onclick = () => showPage(pageNumber + 1);
function showMobilePage(number) {
  document.querySelector('.viewer').scrollIntoView({ block: 'start' });
  return showPage(number);
}
$('mobile-previous').onclick = () => showMobilePage(pageNumber - 1);
$('mobile-next').onclick = () => showMobilePage(pageNumber + 1);
$('page').onchange = () => showPage($('page').value);
$('zoom').onchange = () => showPage(pageNumber);
function selectTask(id) {
  taskId = id;
  frameId = undefined;
  changed();
}
$('space').onchange = changed;
$('quiz-enabled').onchange = () => {
  remember();
  current().quiz = $('quiz-enabled').checked ? { count: 4, correct: '', explanation: '' } : undefined;
  changed();
};
function updateQuiz() {
  const quiz = current().quiz;
  if (!quiz) return;
  const count = Number($('quiz-count').value);
  const answer = $('quiz-correct').value;
  remember();
  current().quiz = {
    count,
    correct: answerOptions(count).includes(answer) ? answer : '',
    explanation: $('quiz-explanation').value.trim(),
  };
  changed();
}
$('quiz-count').onchange = $('quiz-correct').onchange = $('quiz-explanation').onchange = updateQuiz;

$('add-task').onclick = () => { remember(); addTask(); frameId = undefined; changed(); };
$('remove-task').onclick = () => {
  remember();
  const removed = current();
  frames = frames.filter(frame => frame.kind === 'shared' || !removed.frames.includes(frame.id));
  tasks = tasks.filter(task => task !== removed);
  taskId = tasks[0]?.id;
  if (!taskId) addTask();
  frameId = undefined;
  changed();
};
$('delete-frame').onclick = () => {
  if (!selected()) return;
  remember();
  frames = frames.filter(frame => frame.id !== frameId);
  for (const task of tasks) task.frames = task.frames.filter(id => id !== frameId);
  frameId = undefined;
  changed();
};
function reorder(list, index, offset) {
  const target = index + offset;
  if (index < 0 || target < 0 || target >= list.length) return;
  remember();
  [list[index], list[target]] = [list[target], list[index]];
  changed();
}
$('task-up').onclick = () => reorder(tasks, tasks.indexOf(current()), -1);
$('task-down').onclick = () => reorder(tasks, tasks.indexOf(current()), 1);
$('frame-up').onclick = () => reorder(current().frames, current().frames.indexOf(frameId), -1);
$('frame-down').onclick = () => reorder(current().frames, current().frames.indexOf(frameId), 1);
$('split-task').onclick = () => {
  const original = current();
  const index = original.frames.indexOf(frameId);
  const shared = new Set(frames.filter(frame => frame.kind === 'shared').map(frame => frame.id));
  const before = original.frames.slice(0, index);
  if (index < 0 || shared.has(frameId) || !before.some(id => !shared.has(id))) return;
  remember();
  const moved = new Set(original.frames.slice(index).filter(id => !shared.has(id)));
  addTask(tasks.indexOf(original) + 1);
  current().frames = original.frames.filter(id => shared.has(id) || moved.has(id));
  original.frames = original.frames.filter(id => !moved.has(id));
  changed();
};
$('merge-next').onclick = () => {
  const task = current();
  const nextIndex = tasks.indexOf(task) + 1;
  const next = tasks[nextIndex];
  if (!next) return;
  remember();
  task.frames = [...new Set([...task.frames, ...next.frames])];
  tasks.splice(nextIndex, 1);
  changed();
};
$('move-target').onchange = () => {
  const destination = tasks.find(task => task.id === $('move-target').value);
  if (!destination || selected()?.kind !== 'task' || !current().frames.includes(frameId)) return;
  remember();
  current().frames = current().frames.filter(id => id !== frameId);
  destination.frames.push(frameId);
  taskId = destination.id;
  changed();
};
$('undo').onclick = () => {
  const previous = history.pop();
  if (!previous) return;
  ({ tasks, frames, taskId, frameId } = previous);
  changed();
  status('The last frame change was undone.');
};

async function renderSlide(task, width, height) {
  const ordered = task.frames.map(id => frames.find(frame => frame.id === id));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = 'white';
  context.fillRect(0, 0, width, height);
  const margin = 32, gap = 10;
  const budget = height * ($('space').value === 'more' ? 0.52 : 0.8);
  const sizes = ordered.map(({ rect: [x, y, right, bottom] }) => [right - x, bottom - y]);
  const available = budget - margin - gap * (ordered.length - 1);
  if (available <= 0) throw new Error(`Too many parts in question ${task.number}.`);
  const scale = Math.min((width - 2 * margin) / Math.max(...sizes.map(size => size[0])),
    available / sizes.reduce((sum, size) => sum + size[1], 0));
  let offset = margin;
  for (const [index, part] of ordered.entries()) {
    const page = await pdf.getPage(part.page);
    const sourceScale = Math.max(1, scale);
    const [w, h] = sizes[index];
    const crop = document.createElement('canvas');
    crop.width = Math.ceil(w * sourceScale);
    crop.height = Math.ceil(h * sourceScale);
    await page.render({
      canvasContext: crop.getContext('2d'),
      viewport: page.getViewport({ scale: sourceScale }),
      transform: [1, 0, 0, 1, -part.rect[0] * sourceScale, -part.rect[1] * sourceScale],
    }).promise;
    context.drawImage(crop, margin, offset, w * scale, h * scale);
    offset += h * scale + gap;
  }
  return canvas;
}
function ready(task) {
  return task.frames.some(id => frames.find(frame => frame.id === id)?.kind === 'task');
}
async function run(action) {
  if (busy) return;
  busy = true;
  $('workspace').disabled = true;
  $('file').disabled = true;
  overlay.style.pointerEvents = 'none';
  try { await action(); }
  catch (error) { status(error.message); }
  finally {
    busy = false;
    $('workspace').disabled = false;
    $('file').disabled = false;
    overlay.style.pointerEvents = '';
  }
}
function hasPageFrames(page) {
  return frames.some(frame => frame.page === page && frame.kind === 'task');
}
function refreshSuggestions() {
  $('suggestions-panel').hidden = !pageSuggestions;
  if (!pageSuggestions) return;
  const result = pageSuggestions.get(pageNumber);
  const existing = hasPageFrames(pageNumber);
  $('suggestion-page').value = pageNumber;
  $('suggestions-message').textContent = existing
    ? 'This page already has question frames.'
    : result?.reason ?? '';
  $('apply-suggestions').disabled = existing || !result?.bands.length;
  $('suggest-shared-label').hidden = existing || !result?.shared;
  if ($('suggest-shared').dataset.page !== String(pageNumber)) {
    $('suggest-shared').checked = false;
    $('suggest-shared').dataset.page = pageNumber;
  }
}
$('suggest-tasks').onclick = () => run(async () => {
  const results = new Map();
  status('Looking for where questions start…');
  // Two columns: the site has no layout model, so such a page is left to the
  // teacher's own frames (a prototype loaded one, 2026-11-12; its weights'
  // licence and size are open)
  const suggestTwoColumns = async () => ({ reason: 'Two columns: draw the frames on this page yourself.', bands: [] });
  try {
    for (let page = 1; page <= pdf.numPages; page++) {
      if (hasPageFrames(page)) {
        results.set(page, { reason: '', bands: [] });
      } else {
        try {
          results.set(page, await suggestPageFrames(await pdf.getPage(page), suggestTwoColumns));
        } catch {
          results.set(page, { reason: 'Couldn\'t read this page. Check it yourself.', bands: [] });
        }
      }
    }
  } finally {
    pageSuggestions = results;
  }
  $('suggest-shared').checked = false;
  const options = document.createDocumentFragment();
  for (const [page, { bands }] of results) {
    options.append(new Option(`P. ${page} · ${bands.length ? `frames: ${bands.length}` : 'check'}`, page));
  }
  $('suggestion-page').replaceChildren(options);
  refresh();
  status('Look at the dashed frames on the pages and add the right ones.');
});
$('suggestion-page').onchange = () => showPage($('suggestion-page').value);
$('close-suggestions').onclick = () => { pageSuggestions = undefined; refresh(); };
$('apply-suggestions').onclick = () => {
  const result = pageSuggestions?.get(pageNumber);
  if (!result?.bands.length || hasPageFrames(pageNumber)) return;
  remember();
  let sharedId;
  if (result.shared && $('suggest-shared').checked) {
    sharedId = crypto.randomUUID();
    frames.push({ id: sharedId, kind: 'shared', page: pageNumber, rect: [...result.shared] });
  }
  const starter = tasks.length === 1 && tasks[0].frames.length === 0 ? tasks[0] : undefined;
  const entries = result.entries ?? result.bands.map(band => ({ band }));
  for (const [index, { band, anchor }] of entries.entries()) {
    if (!starter || index) addTask();
    else taskId = starter.id;
    if (anchor) current().anchor = { ...anchor, page: pageNumber };
    if (sharedId) current().frames.push(sharedId);
    if (!band) continue;
    const frame = { id: crypto.randomUUID(), kind: 'task', page: pageNumber, rect: [...band.rect] };
    frames.push(frame);
    current().frames.push(frame.id);
  }
  reviewedPages.delete(pageNumber);
  if (pdf.numPages === 1) pageSuggestions = undefined;
  const missingTask = tasks.find(task => task.anchor?.page === pageNumber && !ready(task));
  if (missingTask) {
    taskId = missingTask.id;
    $('kind').value = 'task';
  }
  frameId = undefined;
  changed();
  status(missingTask
    ? `Draw a frame around question No. ${missingTask.anchor.number}. Its place in the list is already made.`
    : 'Draft frames added. Check the questions and pictures before you download.');
};

function clearBoundaryProposal() {
  boundaryProposal = undefined;
  $('boundary-actions').hidden = true;
  $('boundary-message').textContent = '';
}
$('boundary-side').onchange = () => { clearBoundaryProposal(); drawOverlay(); };
$('reject-boundary').onclick = () => { clearBoundaryProposal(); drawOverlay(); };
$('accept-boundary').onclick = () => {
  if (!boundaryProposal) return;
  const { frame, side, value } = boundaryProposal;
  remember();
  frame.rect[side] = value;
  changed();
};
$('suggest-boundary').onclick = () => run(async () => {
  clearBoundaryProposal();
  drawOverlay();
  const frame = selected();
  if (!frame || frame.page !== pageNumber) return;
  const side = Number($('boundary-side').value);
  const vertical = side % 2 === 0;
  const direction = side < 2 ? -1 : 1;
  const edge = frame.rect[side];
  const page = await pdf.getPage(frame.page);
  const scale = 150 / 72;
  const view = page.getViewport({ scale });
  const limit = (vertical ? view.width : view.height) / scale;
  const low = Math.max(0, Math.min(edge - 1 / scale, edge + direction * 12));
  const high = Math.min(limit, Math.max(edge + 1 / scale, edge + direction * 12));
  const [left, top, right, bottom] = frame.rect;
  const x = vertical ? low : left, y = vertical ? top : low;
  const strip = document.createElement('canvas');
  strip.width = Math.max(1, Math.ceil((vertical ? high - low : right - left) * scale));
  strip.height = Math.max(1, Math.ceil((vertical ? bottom - top : high - low) * scale));
  const ctx = strip.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport: view, transform: [1, 0, 0, 1, -x * scale, -y * scale] }).promise;
  const { data } = ctx.getImageData(0, 0, strip.width, strip.height);
  const occupied = new Uint8Array(vertical ? strip.width : strip.height);
  for (let row = 0; row < strip.height; row++) {
    for (let col = 0; col < strip.width; col++) {
      const i = 4 * (row * strip.width + col);
      if (.299 * data[i] + .587 * data[i + 1] + .114 * data[i + 2] < 238) occupied[vertical ? col : row] = 1;
    }
  }
  const edgePixel = clamp(Math.round((edge - low) * scale), 0, occupied.length - 1);
  const message = $('boundary-message');
  if (!occupied[edgePixel]) {
    message.textContent = 'Nothing found at this edge.';
    return;
  }
  const minGap = Math.round(2 * scale);
  let quiet = 0;
  for (let i = edgePixel + direction; i >= 0 && i < occupied.length; i += direction) {
    quiet = occupied[i] ? 0 : quiet + 1;
    if (quiet !== minGap) continue;
    const value = low + (i - direction * (minGap - 1) / 2) / scale;
    if ((value - edge) * direction <= 0) continue;
    boundaryProposal = { frame, side, value };
    $('boundary-actions').hidden = false;
    message.textContent = 'The dashed line is the suggested edge. Check it before accepting.';
    drawOverlay();
    return;
  }
  message.textContent = 'No free space found next to this edge.';
});

$('preview').onclick = () => run(async () => {
  if (!ready(current())) throw new Error('Add a frame to the question before the preview.');
  const canvas = await renderSlide(current(), 1280, 720);
  const slide = $('slide');
  slide.width = canvas.width;
  slide.height = canvas.height;
  slide.getContext('2d').drawImage(canvas, 0, 0);
  slide.hidden = false;
  $('expand-preview').hidden = false;
  $('preview-placeholder').hidden = true;
  status(`Preview of question ${current().number}.`);
});
function zoomSlideContent(canvas) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return canvas;
  const crop = document.createElement('canvas');
  const x = Math.max(0, left - 12), y = Math.max(0, top - 12);
  crop.width = Math.min(width, right + 13) - x;
  crop.height = Math.min(height, bottom + 13) - y;
  crop.getContext('2d').drawImage(canvas, -x, -y);
  return crop;
}
function openSlideReview() {
  slideReviewIndex = tasks.indexOf(current());
  slideReviewZoom = false;
  return updateSlideReview();
}
function updateSlideReview() {
  return run(async () => {
    const task = tasks[slideReviewIndex];
    const hasFrame = ready(task);
    $('preview-title').textContent = slideReviewZoom ? 'Question enlarged' : 'Whole slide';
    $('preview-image').hidden = !hasFrame;
    $('preview-empty').hidden = hasFrame;
    $('preview-fix').disabled = !hasFrame;
    $('preview-zoom').disabled = !hasFrame;
    if (hasFrame) {
      const canvas = await renderSlide(task, 1280, 720);
      $('preview-image').alt = `Question ${task.number}`;
      $('preview-image').src = (slideReviewZoom ? zoomSlideContent(canvas) : canvas).toDataURL();
    }
    const quiz = task.quiz;
    $('quiz-preview').hidden = !hasFrame || !quiz;
    $('quiz-feedback').textContent = '';
    $('quiz-answers').replaceChildren();
    if (hasFrame && quiz) {
      for (const answer of answerOptions(quiz.count)) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = answer;
        choice.disabled = !quiz.correct;
        choice.onclick = () => {
          $('quiz-feedback').textContent = answer === quiz.correct
            ? ['Correct!', quiz.explanation].filter(Boolean).join(' ')
            : 'Try again';
        };
        $('quiz-answers').append(choice);
      }
      if (!quiz.correct) $('quiz-feedback').textContent = 'Mark the correct answer first.';
    }
    $('slide-review-tools').hidden = false;
    $('preview-position').textContent = `${slideReviewIndex + 1} / ${tasks.length}`;
    $('preview-previous').disabled = slideReviewIndex === 0;
    $('preview-next').disabled = slideReviewIndex === tasks.length - 1;
    $('preview-zoom').textContent = slideReviewZoom ? 'Whole slide' : 'Enlarge question';
    $('preview-zoom').setAttribute('aria-pressed', String(slideReviewZoom));
    if (!$('preview-dialog').open) $('preview-dialog').showModal();
  });
}
$('expand-preview').onclick = openSlideReview;
$('mobile-slide').onclick = openSlideReview;
$('mobile-page').onclick = () => document.querySelector('.viewer').scrollIntoView({ block: 'start' });
$('preview-previous').onclick = () => { if (!busy) { slideReviewIndex--; void updateSlideReview(); } };
$('preview-next').onclick = () => { if (!busy) { slideReviewIndex++; void updateSlideReview(); } };
$('preview-zoom').onclick = () => { if (!busy) { slideReviewZoom = !slideReviewZoom; void updateSlideReview(); } };
$('preview-fix').onclick = async () => {
  if (busy) return;
  const task = tasks[slideReviewIndex];
  const linked = task.frames.map(id => frames.find(frame => frame.id === id));
  const frame = linked.find(item => item.id === frameId) ?? linked.find(item => item.kind === 'task');
  if (!frame) return;
  $('preview-dialog').close();
  selectTask(task.id);
  frameId = frame.id;
  if (pageNumber !== frame.page) await showPage(frame.page);
  else refresh();
  document.querySelector('.viewer').scrollIntoView({ block: 'start' });
  overlay.querySelector('.frame.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
};
$('expand-frame').onclick = () => run(async () => {
  const frame = selected();
  if (!frame) return;
  const page = await pdf.getPage(frame.page);
  const bounds = page.getViewport({ scale: 1 });
  const [x1, y1, x2, y2] = frame.rect;
  const contextMargin = 12;
  const left = Math.max(0, x1 - contextMargin), top = Math.max(0, y1 - contextMargin);
  const right = Math.min(bounds.width, x2 + contextMargin), bottom = Math.min(bounds.height, y2 + contextMargin);
  const scale = Math.min(3, 1600 / Math.max(right - left, bottom - top));
  const crop = document.createElement('canvas');
  crop.width = Math.ceil((right - left) * scale);
  crop.height = Math.ceil((bottom - top) * scale);
  await page.render({
    canvasContext: crop.getContext('2d'),
    viewport: page.getViewport({ scale }),
    transform: [1, 0, 0, 1, -left * scale, -top * scale],
  }).promise;
  const ctx = crop.getContext('2d');
  ctx.fillStyle = 'rgba(20, 40, 30, .14)';
  const x = (x1 - left) * scale, y = (y1 - top) * scale;
  const w = (x2 - x1) * scale, h = (y2 - y1) * scale;
  ctx.fillRect(0, 0, crop.width, y);
  ctx.fillRect(0, y + h, crop.width, crop.height - y - h);
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, crop.width - x - w, h);
  ctx.strokeStyle = '#2d7a4f';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  $('slide-review-tools').hidden = true;
  $('quiz-preview').hidden = true;
  $('preview-empty').hidden = true;
  $('preview-image').hidden = false;
  $('preview-title').textContent = 'Check the cut-out';
  $('preview-image').alt = 'The chosen part of the page';
  $('preview-image').src = crop.toDataURL();
  $('preview-dialog').showModal();
});
$('preview-dialog').addEventListener('close', () => $('preview-image').removeAttribute('src'));

function download(bytes, type, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function checkExport() {
  const missing = tasks.filter(task => !ready(task)).map(task => task.number);
  if (missing.length) throw new Error(`Add frames to questions ${missing.join(', ')}, or delete the empty questions.`);
  status('Making the file…');
}
const exportPdf = () => run(async () => {
  checkExport();
  const output = await window.PDFLib.PDFDocument.create();
  for (const task of tasks) {
    const canvas = await renderSlide(task, 1240, 1754);
    const page = output.addPage([595.28, 841.89]);
    const image = await output.embedPng(canvas.toDataURL());
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  download(await output.save(), 'application/pdf', 'worksheet.pdf');
  status('The PDF for printing is ready.');
});
const exportPptx = () => run(async () => {
  checkExport();
  await loadPptxGenJs();
  const output = new window.PptxGenJS();
  output.layout = 'LAYOUT_WIDE';
  if (tasks.some(task => task.quiz)) {
    await loadJSZip();
    const file = await makeQuizFile(output, tasks, task => renderSlide(task, 1280, 720), window.JSZip);
    download(file, file.type, 'worksheet-quiz.pptx');
    status('The interactive PowerPoint is ready.');
    return;
  }
  for (const task of tasks) {
    const canvas = await renderSlide(task, 1280, 720);
    output.addSlide().addImage({ data: canvas.toDataURL(), x: 0, y: 0, w: 40 / 3, h: 7.5 });
  }
  await output.writeFile({ fileName: 'worksheet.pptx' });
  status('The PowerPoint is ready.');
});

function requestExport(action) {
  if (busy) return;
  try {
    checkExport();
    if (action === exportPptx) {
      const invalid = tasks.filter(({ quiz }) => quiz && (!quiz.correct || !answerOptions(quiz.count).includes(quiz.correct)));
      if (invalid.length) throw new Error(`Mark the correct answer for questions ${invalid.map(task => task.number).join(', ')}.`);
    }
  } catch (error) { status(error.message); return; }
  const remaining = pdf.numPages - reviewedPages.size;
  const unlinked = unlinkedShared().length;
  if (!remaining && !unlinked) { void action(); return; }
  pendingExport = action;
  $('export-review-message').textContent = [
    remaining ? `Pages not marked as checked: ${remaining}.` : '',
    unlinked ? `Shared frames not attached to any question: ${unlinked}.` : '',
  ].filter(Boolean).join(' ');
  status('');
  $('export-review').showModal();
}
$('export-pdf').onclick = () => requestExport(exportPdf);
$('export-pptx').onclick = () => requestExport(exportPptx);
$('export-back').onclick = () => {
  $('export-review').close();
  $('review').open = true;
  $('review').scrollIntoView({ block: 'nearest' });
};
$('export-continue').onclick = () => {
  const action = pendingExport;
  $('export-review').close();
  if (action) void action();
};
$('export-review').addEventListener('close', () => { pendingExport = undefined; });
