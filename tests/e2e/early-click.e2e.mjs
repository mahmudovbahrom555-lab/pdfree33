// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// A press on Convert while the page is still reading the file ("Analysing
// PDF…") was turned away and started nothing — the user had to press again
// (found 2026-10-28: the corpus run recorded such files as refused). Now the
// press is kept and the conversion starts once the reading is done; a file
// changed meanwhile drops it. pdf.js is held back 4 s here so the press
// always comes early.
// Run: node tests/e2e/early-click.e2e.mjs   (dist/ served on :8934)

import { chromium, devices, webkit } from 'playwright';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BASE_URL = process.env.PDFREE_BASE_URL || 'http://localhost:8934';
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 3; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1} of an early press`, { x: 60, y: 760, size: 14, font });
const file = path.join(os.tmpdir(), `early-click-${process.pid}.pdf`);
fs.writeFileSync(file, await doc.save());

const browser = await chromium.launch();
async function earlyPress(tool, then) {
  const ctx = await browser.newContext();
  // the page reads the file with pdf.js: hold the library back
  await ctx.route(/pdf\.js|pdf\.min\.js|pdfjs/, async r => { await new Promise(res => setTimeout(res, 4000)); await r.continue(); });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__blob = null; window.__armed = false; window.__runs = 0;
    document.addEventListener('pdfree:success', () => { window.__runs++; });
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = b => { if (window.__armed && !window.__blob && b instanceof Blob && b.size && !/javascript/.test(b.type)) window.__blob = b; return orig(b); };
  });
  await page.goto(`${BASE_URL}/${tool}/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', file);
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__armed = true; });
  await page.click('#mergeBtn');
  // the press is handled on the next frame: its message comes a moment later
  const early = await page.waitForFunction(() => /Analys/i.test(document.querySelector('#toast')?.innerText || ''), null, { timeout: 2000 }).then(() => true, () => false);
  if (!early) throw new Error('the press should come while the file is being analysed');
  const r = await then(page);
  await ctx.close();
  return r;
}

for (const tool of ['pdf-to-word', 'pdf-to-excel']) {
  await test(`${tool}: an early press converts once the file is read, with no second press`, async () => {
    const made = await earlyPress(tool, page => page.waitForFunction(() => !!window.__blob, null, { timeout: 60_000 }).then(() => true, () => false));
    if (!made) throw new Error('no result came out');
  });
}

await test('pressed early and again once the file is read: one conversion, not two', async () => {
  const runs = await earlyPress('pdf-to-word', async page => {
    // the reading ends ~4 s in; press again right after it does
    await page.waitForFunction(() => !/Analys/i.test(document.querySelector('#pdf2wordOptions')?.innerText || ''), null, { timeout: 30_000 });
    await page.click('#mergeBtn').catch(() => {});
    await page.waitForFunction(() => !!window.__blob, null, { timeout: 60_000 });
    await page.waitForTimeout(3000);
    return page.evaluate(() => window.__runs);
  });
  if (runs !== 1) throw new Error(`${runs} conversions`);
});

await test('a file removed while waiting: nothing starts', async () => {
  const started = await earlyPress('pdf-to-word', async page => {
    await page.evaluate(() => document.querySelector('#fileList .file-remove, #fileList [data-action="remove"], #fileList button')?.click());
    await page.waitForTimeout(7000);
    return page.evaluate(() => !!window.__blob || !!document.querySelector('#mergeBtn')?.classList.contains('merge-btn--processing'));
  });
  if (started) throw new Error('a conversion started for a file no longer there');
});

// A range typed and run at once (within the field's 400 ms settle): the run
// used the previous selection — a ZIP of every page instead of a PDF of the
// range (user journey 2026-11-13; the same field drew rage clicks 2026-10-21..27).
await test('split: a range typed and run at once uses that range', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}/split-pdf/`, { waitUntil: 'load' });
    await page.setInputFiles('#fileInput', file);
    const range = page.locator('#extRangeInput');
    await range.waitFor({ timeout: 20000 });
    const download = page.waitForEvent('download', { timeout: 30000 });
    await range.evaluate(input => {   // the edit and the press in one task: the 400 ms can't pass
      input.value = '2-3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('mergeBtn').click();
    });
    const got = await download;
    if (!/\.pdf$/.test(got.suggestedFilename())) throw new Error(`got ${got.suggestedFilename()}`);
    const pages = (await PDFDocument.load(fs.readFileSync(await got.path()))).getPageCount();
    if (pages !== 2) throw new Error(`${pages} pages`);
  } finally {
    await ctx.close();
  }
});

// A file chosen or dropped before the tool page's first frame (a slow phone
// draws it late) was added, then wiped by the tool's deferred setup — no
// file, no message (pdfree.io, 2026-11-13: 3 of ~60 fresh loads in a row).
for (const tool of ['merge-pdf', 'quick-edit-pdf']) {
  await test(`${tool}: a file added before the first frame is kept`, async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const start = performance.now(), raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = cb => performance.now() - start < 1500
        ? setTimeout(() => raf(cb), 1500 - (performance.now() - start)) : raf(cb);
    });
    await page.goto(`${BASE_URL}/${tool}/`, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(3000);
    const kept = await page.evaluate(async () => (await import('/js/files.js')).selectedFiles.length);
    const shown = await page.locator('#fileList > *').count();
    await ctx.close();
    if (kept !== 1 || shown !== 1) throw new Error(`${kept} files kept, ${shown} shown after the page finished setting up`);
  });
}

async function scanEarlyPress(engine, options = {}, batch = false, remove = false) {
  const context = await engine.newContext({ ...options, serviceWorkers: 'block' });
  let releaseFilter;
  const filterReleased = new Promise(resolve => { releaseFilter = resolve; });
  try {
    await context.route('**/js/scanFilterWorker.js', async route => {
      await filterReleased;
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto(BASE_URL + '/scan-document/');
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 560;
      canvas.height = 320;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#151515';
      ctx.fillRect(0, 0, 560, 320);
      ctx.fillStyle = '#fff';
      ctx.fillRect(160, 40, 210, 240);
      ctx.fillStyle = '#151515';
      for (let y = 80; y < 240; y += 24) ctx.fillRect(195, y, 135, 5);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const photo = { name: 'crop-test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') };
    const photos = batch ? [photo, { ...photo, name: 'crop-test-2.png' }] : photo;
    await page.setInputFiles('#fileInput', photos);
    const confirm = page.locator(batch ? '#sdBatchAutoAll' : '#scanCamConfirmBtn');
    if (options.hasTouch) await confirm.tap(); else await confirm.click();
    await confirm.waitFor({ state: 'hidden' });
    if (remove) {
      releaseFilter();
      const discard = page.getByRole('button', { name: 'Remove crop-test-2-scan.jpg', exact: true });
      await discard.waitFor({ timeout: 8000 });
      const target = await discard.boundingBox();
      if (target.width < 44 || target.height < 44) throw new Error('Expected a 44 × 44 removal target');
      if (options.hasTouch) await discard.tap(); else await discard.click();
      await discard.waitFor({ state: 'hidden' });
    }
    const button = page.locator('#mergeBtn');
    const downloadEvent = page.waitForEvent('download', { timeout: 12000 }).catch(() => null);
    if (options.hasTouch) await button.tap(); else await button.click();
    if (!remove) {
      try {
        await page.waitForFunction(() => /Processing/i.test(document.getElementById('mergeBtn').textContent), null, { timeout: 3000 });
        const status = await page.locator('#sdCropStatus').textContent();
        if (!/Processing/i.test(status)) throw new Error('Missing accessible crop processing status');
      } catch {
        throw new Error('No processing status after confirming crop. Message: ' + await page.locator('#toast').textContent());
      } finally {
        releaseFilter();
      }
    }
    const download = await downloadEvent;
    if (!download) throw new Error('PDF did not download after the single press');
    const pdf = await PDFDocument.load(fs.readFileSync(await download.path()));
    if (pdf.getPageCount() !== (batch && !remove ? 2 : 1) || pdf.getPages().some(p => p.getWidth() >= p.getHeight())) {
      throw new Error('Expected the cropped portrait document inside the landscape source photo');
    }
  } finally {
    releaseFilter();
    await context.close();
  }
}

await test('Document Scanner: download pressed during crop processing exports the cropped PDF once ready', async () => {
  await scanEarlyPress(browser);
});
await test('Document Scanner: early download waits for every auto-cropped page in a batch', async () => {
  await scanEarlyPress(browser, {}, true);
});
await test('Document Scanner: remove one scanned page and download only the remaining page', () => scanEarlyPress(browser, {}, true, true));
if (process.env.PDFREE_SCAN_MOBILE === '1') {
  await test('Document Scanner: Android touch download after crop', () => scanEarlyPress(browser, devices['Pixel 7']));
  await test('Document Scanner: Android touch removal', () => scanEarlyPress(browser, devices['Pixel 7'], true, true));
  const safari = await webkit.launch();
  try {
    await test('Document Scanner: iPhone touch download after crop', () => scanEarlyPress(safari, devices['iPhone 13']));
    await test('Document Scanner: iPhone touch removal', () => scanEarlyPress(safari, devices['iPhone 13'], true, true));
  } finally {
    await safari.close();
  }
}

await test('Document Scanner: B&W preserves fine strokes on shaded paper and offers a before/after preview', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(BASE_URL + '/scan-document/');
    const result = await page.evaluate(async () => {
      const { filterScanPhoto } = await import('/js/scanFilter.js');
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 420;
      const ctx = canvas.getContext('2d');
      const shade = ctx.createLinearGradient(0, 0, canvas.width, 0);
      shade.addColorStop(0, '#8a8a8a');
      shade.addColorStop(1, '#f5f5f5');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const strokes = [[120, 135], [590, 135], [135, 100], [605, 100]];
      ctx.fillStyle = '#323232';
      for (const x of [120, 590]) ctx.fillRect(x, 97, 1, 65);
      for (const x of [124, 594]) ctx.fillRect(x, 100, 20, 1);
      ctx.fillRect(100, 65, 1, 1);
      ctx.fillRect(330, 78, 6, 35);
      const png = canvas.toDataURL('image/png').split(',')[1];
      const bitmap = await createImageBitmap(await filterScanPhoto(canvas, 'bw'));
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const at = ([x, y]) => ctx.getImageData(x, y, 1, 1).data[0];
      return { png, strokes: strokes.map(at), paper: [[80, 135], [560, 135], [100, 65]].map(at) };
    });
    if (result.strokes.some(value => value > 45) || result.paper.some(value => value < 245)) {
      throw new Error('Expected dark strokes and clean paper: ' + JSON.stringify({ strokes: result.strokes, paper: result.paper }));
    }
    await page.setInputFiles('#fileInput', { name: 'shaded.png', mimeType: 'image/png', buffer: Buffer.from(result.png, 'base64') });

    await page.locator('#scanCamConfirmBtn').click();
    await page.getByRole('button', { name: 'Before / After' }).click();
    const comparison = page.getByRole('dialog', { name: 'Before / After' });
    await comparison.waitFor();
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('#sdComparison img')];
      return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)
        && images[0].src !== images[1].src;
    });
    await comparison.getByRole('button', { name: 'Close' }).click();
    await comparison.waitFor({ state: 'hidden' });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#mergeBtn').click(),
    ]);
    const pdf = await PDFDocument.load(fs.readFileSync(await download.path()));
    if (pdf.getPageCount() !== 1) throw new Error('Expected one downloadable scanned page');
  } finally {
    await context.close();
  }
});

await test('Document Scanner: keep scanning, review two pages, and export the page kept', async () => {
  const camera = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const page = await camera.newPage({ ...devices['Pixel 7'], serviceWorkers: 'block' });
    await page.goto(BASE_URL + '/scan-document/');
    await page.locator('#sdTakePhotoBtn').tap();
    await page.locator('#scanCamCaptureBtn').tap();
    await page.locator('#scanCamNextBtn').tap({ timeout: 15000 });
    await page.locator('#scanCamCaptureBtn').tap();
    await page.locator('#scanCamConfirmBtn').tap();
    await page.locator('#scanCamStage').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('#scanDocumentOptions .j2p-thumb').length === 2);
    const remove = page.locator('#scanDocumentOptions [data-sd-remove]').first();
    await remove.tap();
    await page.waitForFunction(() => document.querySelectorAll('#scanDocumentOptions .j2p-thumb').length === 1);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.locator('#mergeBtn').tap(),
    ]);
    const pdf = await PDFDocument.load(fs.readFileSync(await download.path()));
    if (pdf.getPageCount() !== 1) throw new Error('Expected only the remaining camera capture in the PDF');
  } finally {
    await camera.close();
  }
});

async function scanOcrExport(engine, options = {}, unavailable = false) {
  const context = await engine.newContext({ ...options, serviceWorkers: 'block' });
  try {
    if (unavailable) await context.route('**/eng.traineddata.gz', route => route.abort());
    const page = await context.newPage();
    await page.goto(BASE_URL + '/scan-document/');
    const phrases = ['ORANGE INVOICE', 'BLUE RECEIPT'];
    const photos = await page.evaluate(labels => labels.map((label, index) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1000;
      canvas.height = 700;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 1000, 700);
      ctx.font = 'bold 70px sans-serif';
      ctx.fillStyle = '#000';
      ctx.fillText(label, 120, 330);
      return { name: `ocr-photo-${index}.png`, png: canvas.toDataURL().split(',')[1] };
    }), phrases);
    async function addPhotos() {
      await page.setInputFiles('#fileInput', photos.map(({ name, png }) => ({
        name, mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
      })));
      await page.locator('#sdBatchAutoAll').click();
      await page.waitForFunction(() => document.querySelectorAll('[data-sd-compare]').length === 2);
    }
    await addPhotos();
    async function downloadScan() {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 90000 }),
        page.locator('#mergeBtn').click(),
      ]);
      return { name: download.suggestedFilename(), bytes: fs.readFileSync(await download.path()) };
    }
    const plain = unavailable ? null : await downloadScan();
    if (plain) {
      await page.locator('#mergeBtn').click();
      await addPhotos();
    }
    await page.locator('#sdRecognizeText').check();
    await page.locator('#sdOcrLanguage').selectOption('eng');
    const result = await downloadScan();
    if (result.name.endsWith('-searchable.pdf') !== !unavailable) {
      throw new Error('Unexpected file name: ' + result.name + ' ' + await page.locator('#successCard').innerText());
    }
    if (unavailable && !(await page.locator('#successCard').innerText()).includes('Saved a regular PDF')) {
      throw new Error('Missing OCR fallback notice');
    }
    const rendered = await page.evaluate(async ({ output, original }) => {
      const { loadPdfJs } = await import('/js/pdf2jpgUI.js');
      await loadPdfJs();
      const open = data => window.pdfjsLib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
      const pdf = await open(output);
      const plain = original ? await open(original) : null;
      const render = async page => {
        const viewport = page.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        return canvas.toDataURL();
      };
      const pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const { items } = await page.getTextContent();
        pages.push({
          text: items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim(),
          sameImage: !plain || await render(page) === await render(await plain.getPage(n)),
        });
      }
      await pdf.destroy();
      await plain?.destroy();
      return pages;
    }, { output: [...result.bytes], original: plain ? [...plain.bytes] : null });
    if (rendered.length !== 2 || rendered.some((p, index) => !p.sameImage || (!unavailable && !p.text.includes(phrases[index])))) {
      throw new Error('Unexpected scan pages: ' + JSON.stringify(rendered));
    }
  } finally {
    await context.close();
  }
}

await test('Document Scanner: OCR makes both pages searchable without changing their appearance', () => scanOcrExport(browser));
await test('Document Scanner: missing OCR model still downloads a regular PDF', () => scanOcrExport(browser, {}, true));

async function scanPageFilter(engine, options = {}) {
  const context = await engine.newContext({ ...options, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(BASE_URL + '/scan-document/');
    const pngs = await page.evaluate(() => ['#e28546', '#4989cd'].map(color => {
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 420;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 600, 420);
      ctx.fillStyle = color;
      ctx.fillRect(200, 150, 200, 120);
      return canvas.toDataURL().split(',')[1];
    }));
    const photos = pngs.map((png, i) => ({ name: `filter-${i}.png`, mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }));
    async function addPhotos() {
      await page.setInputFiles('#fileInput', photos);
      await page.locator('#sdBatchAutoAll').click();
      await page.locator('[data-sd-compare]').nth(1).waitFor();
    }
    async function download() {
      const [file] = await Promise.all([page.waitForEvent('download'), page.locator('#mergeBtn').click()]);
      return [...fs.readFileSync(await file.path())];
    }
    await addPhotos();
    const before = await download();
    await page.locator('#mergeBtn').click();
    await addPhotos();
    const edit = page.locator('[data-sd-edit-filter]').first();
    if (options.hasTouch) await edit.tap(); else await edit.click();
    const dialog = page.locator('#sdPageFilter');
    const preview = dialog.locator('img');
    const initial = await preview.getAttribute('src');
    await dialog.locator('select').selectOption('color');
    await page.waitForFunction(src => {
      const image = document.querySelector('#sdPageFilter img');
      return image?.src !== src && image?.complete && image?.naturalWidth > 0;
    }, initial);
    const color = await preview.getAttribute('src');
    await dialog.locator('[name="brightness"]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(src => {
      const image = document.querySelector('#sdPageFilter img');
      return image?.src !== src && image?.complete && image?.naturalWidth > 0;
    }, color);
    const brighter = await preview.getAttribute('src');
    await dialog.locator('[name="contrast"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(src => {
      const image = document.querySelector('#sdPageFilter img');
      return image?.src !== src && image?.complete && image?.naturalWidth > 0;
    }, brighter);
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const after = await download();
    const pixels = await page.evaluate(async ({ before, after }) => {
      const { loadPdfJs } = await import('/js/pdf2jpgUI.js');
      await loadPdfJs();
      const results = [];
      for (const bytes of [before, after]) {
        const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
        const bitmaps = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const viewport = page.getViewport({ scale: 0.4 });
          const c = document.createElement('canvas');
          c.width = Math.ceil(viewport.width);
          c.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
          bitmaps.push(c.toDataURL());
        }
        await pdf.destroy();
        results.push(bitmaps);
      }
      return results;
    }, { before, after });
    if (pixels.some(p => p.length !== 2) || pixels[0][0] === pixels[1][0] || pixels[0][1] !== pixels[1][1]) {
      throw new Error('Expected only the edited page to change in the downloaded PDF');
    }
  } finally {
    await context.close();
  }
}

await test('Document Scanner: edit the filter on one page without changing the other', () => scanPageFilter(browser));

async function scanRecrop(engine, options = {}) {
  const context = await engine.newContext({ ...options, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(BASE_URL + '/scan-document/');
    const photo = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 420;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#151515';
      ctx.fillRect(0, 0, 600, 420);
      ctx.fillStyle = '#fff';
      ctx.fillRect(60, 45, 330, 330);
      ctx.fillStyle = '#db2222';
      ctx.fillRect(460, 150, 67, 90);
      ctx.fillStyle = '#202020';
      ctx.fillRect(90, 120, 170, 12);
      return canvas.toDataURL().split(',')[1];
    });
    const photos = ['recrop-first.png', 'recrop-second.png'].map(name => ({
      name, mimeType: 'image/png', buffer: Buffer.from(photo, 'base64'),
    }));
    const click = locator => options.hasTouch ? locator.tap() : locator.click();
    const confirm = page.locator('#scanCamConfirmBtn');
    async function ready() {
      await page.waitForFunction(() => document.querySelector('#scanCamConfirmBtn')?.disabled === false);
    }
    async function addPhotos(reopen) {
      await page.setInputFiles('#fileInput', photos);
      await click(page.locator('#sdBatchReviewEach'));
      await ready();
      await click(confirm);
      await page.locator('#scanDocumentOptions [data-sd-edit-filter]').first().waitFor({ state: 'attached' });
      await ready();
      await click(confirm);
      await page.locator('#scanDocumentOptions [data-sd-edit-filter]').nth(1).waitFor();
      const editor = page.locator('#sdPageFilter');
      await click(page.locator('[data-sd-edit-filter]').first());
      const img = editor.locator('img');
      const prior = await img.getAttribute('src');
      await editor.locator('select').selectOption('original');
      await page.waitForFunction(url => document.querySelector('#sdPageFilter img')?.src !== url, prior);
      await click(editor.getByRole('button', { name: 'Apply' }));
      if (reopen) {
        await click(page.locator('#scanDocumentOptions .j2p-thumb__canvas').first());
        await ready();
        await click(page.locator('#scanCamFullFrame'));
        await click(confirm);
        await confirm.waitFor({ state: 'hidden' });
      }
    }
    async function download() {
      const [file] = await Promise.all([page.waitForEvent('download'), click(page.locator('#mergeBtn'))]);
      return [...fs.readFileSync(await file.path())];
    }
    await addPhotos(false);
    const before = await download();
    await click(page.locator('#mergeBtn'));
    await addPhotos(true);
    const after = await download();
    const result = await page.evaluate(async ({ before, after }) => {
      const { loadPdfJs } = await import('/js/pdf2jpgUI.js');
      await loadPdfJs();
      const result = [];
      for (const bytes of [before, after]) {
        const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const c = document.createElement('canvas');
          const vp = page.getViewport({ scale: 0.4 });
          c.width = Math.ceil(vp.width);
          c.height = Math.ceil(vp.height);
          const ctx = c.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let red = 0;
          for (let j = 0; j < data.length; j += 4) if (data[j] > data[j + 1] + 80 && data[j] > data[j + 2] + 80) red++;
          pages.push({ red, rendered: i === 2 ? c.toDataURL() : null });
        }
        await doc.destroy();
        result.push(pages);
      }
      return { counts: result.map(p => p.length), red: result.map(p => p[0]?.red), neighborUnchanged: result[0][1]?.rendered === result[1][1]?.rendered };
    }, { before, after });
    if (result.counts.some(n => n !== 2) || result.red[0] !== 0 || result.red[1] < 100 || !result.neighborUnchanged) {
      throw new Error('Expected the expanded crop to restore the red mark with its filter and leave the next page intact: ' + JSON.stringify(result));
    }
  } finally {
    await context.close();
  }
}

await test('Document Scanner: re-crop restores a clipped mark and preserves per-page filter', () => scanRecrop(browser));

await test('Document Scanner: auto-crop a narrow receipt from a wide photo', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(BASE_URL + '/scan-document/');
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 900;
      c.height = 680;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#514b48';
      ctx.fillRect(0, 0, 900, 680);
      ctx.fillStyle = '#f3f0e8';
      ctx.fillRect(175, 94, 94, 470);
      ctx.fillStyle = '#504b40';
      ctx.font = '11px monospace';
      for (let i = 0; i < 18; i++) ctx.fillText('ITEM 120.00', 185, 130 + i * 17);
      return c.toDataURL().split(',')[1];
    });
    await page.setInputFiles('#fileInput', { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.locator('#scanCamConfirmBtn').click();
    await page.locator('[data-sd-edit-filter]').waitFor();
    const [file] = await Promise.all([page.waitForEvent('download'), page.locator('#mergeBtn').click()]);
    const pdf = await PDFDocument.load(fs.readFileSync(await file.path()));
    const [receipt] = pdf.getPages();
    if (pdf.getPageCount() !== 1 || receipt.getHeight() / receipt.getWidth() < 4) {
      throw new Error('Expected a narrow portrait receipt instead of the landscape background');
    }
  } finally {
    await context.close();
  }
});

await test('Document Scanner: preserve receipt margins when no edges are detected', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(BASE_URL + '/scan-document/');
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 280;
      canvas.height = 900;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 280, 900);
      ctx.fillStyle = '#000';
      ctx.font = '16px monospace';
      ctx.fillText('TOTAL 19.75', 7, 882);
      return canvas.toDataURL().split(',')[1];
    });
    await page.setInputFiles('#fileInput', { name: 'tight-receipt.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const confirm = page.locator('#scanCamConfirmBtn');
    await confirm.click();
    await page.locator('[data-sd-edit-filter]').waitFor();
    const [file] = await Promise.all([page.waitForEvent('download'), page.locator('#mergeBtn').click()]);
    const pdf = await PDFDocument.load(fs.readFileSync(await file.path()));
    const [receipt] = pdf.getPages();
    const image = pdf.context.enumerateIndirectObjects().map(([, obj]) => obj.dict)
      .find(dict => dict?.get(PDFName.of('Subtype'))?.toString() === '/Image');
    if (pdf.getPageCount() !== 1 || !receipt || Number(image?.get(PDFName.of('Height'))?.toString()) < 895) {
      throw new Error('The fallback crop trimmed the bottom of a tightly framed receipt');
    }
  } finally {
    await context.close();
  }
});

await browser.close();
fs.unlinkSync(file);
console.log(`\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
process.exit(failed ? 1 : 0);
