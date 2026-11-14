// Drafts for single-column numbered pages. The full width keeps diagrams next
// to the text, and each result still needs a visual check against the source.
const NUMBERED_START = /^(?:(?:q|задание|вопрос)\s*)?(\d{1,3})[.)、．](?:\s|$)/iu;

async function lastBandBottom(page, viewport, top) {
  const height = viewport.height - top;
  const scale = Math.min(150 / 72, 1800 / Math.max(viewport.width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({
    canvasContext: context,
    viewport: page.getViewport({ scale }),
    transform: [1, 0, 0, 1, 0, -top * scale],
    background: '#ffffff',
  }).promise;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  // Keep even a single visible pixel and leave a margin below it.
  for (let row = canvas.height - 1; row >= 0; row--) {
    const start = row * canvas.width * 4;
    const end = start + canvas.width * 4;
    for (let i = start; i < end; i += 4) {
      if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) continue;
      const bottom = top + (row + 1) / scale + 8;
      return viewport.height - bottom >= 20 ? bottom : viewport.height;
    }
  }
  return viewport.height;
}

// A nearby directive can be offered separately from page titles and metadata.
const INSTRUCTION = /^(?:circle|choose|select|mark|answer|show|use|выберите|укажите|отметьте|scegli|indica|seleziona)\b|^(?:выберите|укажите|отметьте)\s/iu;

function sharedInstruction(text, viewport, firstTop) {
  const lines = text.map(item => {
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return { item, x, y };
  }).filter(line => line.y < firstTop && firstTop - line.y <= 52)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const start = lines.findIndex(({ item }) => INSTRUCTION.test(item.str.trim()));
  if (start < 0) return undefined;
  const first = lines[start];
  let last = first;
  for (const line of lines.slice(start + 1)) {
    if (line.y - last.y > Math.max(first.item.height, last.item.height) * 1.6) break;
    last = line;
  }
  const top = Math.max(0, first.y - first.item.height - 3);
  const bottom = Math.min(firstTop, last.y + last.item.height * .3 + 3);
  return [0, top, viewport.width, bottom];
}

function twoColumnSplit(anchors, pageWidth) {
  const columns = [];
  for (const anchor of [...anchors].sort((a, b) => a.x - b.x)) {
    const column = columns.at(-1);
    if (column && anchor.x - column[0].x <= 14) column.push(anchor);
    else columns.push([anchor]);
  }
  // Formula fragments can look like numbers. Require a consecutive run at
  // each column margin before trusting a two-column interpretation.
  const numberedColumns = columns.filter(column => {
    if (column.length < 2) return false;
    column.sort((a, b) => a.top - b.top);
    return column.slice(1).every((anchor, i) =>
      anchor.number === column[i].number + 1 && anchor.top - column[i].top >= 16);
  });
  if (numberedColumns.length !== 2) return;
  const [left, right] = numberedColumns;
  const rightEdge = Math.min(...right.map(anchor => anchor.x));
  if (rightEdge - Math.min(...left.map(anchor => anchor.x)) < pageWidth / 4 ||
      left.at(-1).number + 1 !== right[0].number ||
      Math.max(left[0].top, right[0].top) >= Math.min(left.at(-1).top, right.at(-1).top)) return;
  return { split: rightEdge - 12, anchors: [...left, ...right] };
}

export async function suggestPageFrames(page, suggestTwoColumns) {
  const viewport = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  const text = items.filter(item => item.str?.trim());
  if (!text.length) return { reason: 'This page has no text to read.', bands: [] };
  if (/^answer\s+key\b/i.test(text.slice(0, 2).map(item => item.str.trim()).join(' '))) {
    return { reason: 'This looks like an answer key. Check the page.', bands: [] };
  }
  const anchors = text.flatMap(item => {
    const marker = NUMBERED_START.exec(item.str.trim());
    if (!marker) return [];
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return [{ x, y, top: Math.max(0, y - item.height - 8), number: Number(marker[1]) }];
  });
  if (anchors.length < 2) return { reason: 'Too few question numbers for reliable frames.', bands: [] };
  const first = Math.min(...anchors.map(anchor => anchor.x));
  if (anchors.some(anchor => anchor.x - first > 10)) {
    const columns = twoColumnSplit(anchors, viewport.width);
    if (columns && suggestTwoColumns) {
      return suggestTwoColumns(page, columns.split, columns.anchors);
    }
    return { reason: 'Questions start at different indents. Check the columns yourself.', bands: [] };
  }
  anchors.sort((a, b) => a.top - b.top);
  if (anchors.some((anchor, index) => index &&
    (anchor.number <= anchors[index - 1].number || anchor.top - anchors[index - 1].top < 16))) {
    return { reason: 'Question numbers or edges are unclear.', bands: [] };
  }
  const gap = anchors.some((anchor, index) => index && anchor.number > anchors[index - 1].number + 1);
  const preamble = text.some(item => {
    const [, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    return y < anchors[0].top && anchors[0].top - y <= 52;
  });
  const shared = sharedInstruction(text, viewport, anchors[0].top);
  let bottom = viewport.height;
  try { bottom = await lastBandBottom(page, viewport, anchors.at(-1).top); }
  catch { /* Keep the original lower boundary if the page cannot be rendered. */ }
  return {
    reason: [
      gap ? 'Check the gap in the numbering.' : '',
      preamble && !shared ? 'There is text above the first question. Check whether it should be attached.' : '',
      'Check the frames and shared pictures.',
    ].filter(Boolean).join(' '),
    shared,
    bands: anchors.map((anchor, index) => ({
      number: anchor.number,
      rect: [0, anchor.top, viewport.width, anchors[index + 1]?.top ?? bottom],
    })),
  };
}
