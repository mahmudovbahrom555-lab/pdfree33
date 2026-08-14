// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  heicDecode.js — client-side HEIC/HEIF → JPEG conversion
//
//  iPhone's default photo format (HEIC, standard since iOS 11) isn't
//  something createImageBitmap()/<img> can decode in any browser except
//  Safari — jpg2pdfUI.js's previews and js/worker.js's handleJpg2Pdf()
//  both silently fail on it otherwise. This module decodes HEIC/HEIF to
//  a JPEG Blob entirely in the browser via a vendored libheif WASM build
//  (js/vendor/libheif-bundle.mjs, LGPL-3.0 — see js/vendor/SOURCE.txt),
//  loaded lazily so the ~1.46MB WASM payload never touches users who
//  don't select a HEIC file.
//
//  worker.js itself is off-limits (CLAUDE.md) — this runs entirely on
//  the main thread BEFORE processor.js's _runJpg2Pdf() hands buffers to
//  the shared worker, so worker.js keeps seeing exactly what it already
//  understands (JPEG/PNG/WebP bytes). Same "pre-process, then fall
//  through to the shared pipeline" shape as js/fillOrderWorker.js.
//
//  libheif's image.display() bakes in any irot/imir orientation
//  transform stored in the HEIC container during decode, so the output
//  JPEG is already correctly oriented — unlike JPEG, HEIC inputs need
//  no separate EXIF-angle handling (jpg2pdfUI.js's _readExifAngle()
//  already returns 0 for non-JPEG files, so this falls out for free).
// ============================================================

let _libheifPromise = null;

function _loadLibheif() {
  if (!_libheifPromise) {
    _libheifPromise = import('./vendor/libheif-bundle.mjs').then(m => (m.default ? m.default() : m));
  }
  return _libheifPromise;
}

/**
 * Проверяет, является ли файл HEIC/HEIF.
 * MIME-тип часто пустой на не-Apple платформах — расширение обязательно
 * проверяем отдельно, как и в isFileAccepted() (js/utils.js).
 * @param {File} file
 * @returns {boolean}
 */
export function isHeicFile(file) {
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return type === 'image/heic' || type === 'image/heif' ||
         name.endsWith('.heic') || name.endsWith('.heif');
}

// File → Promise<Blob|null>. Cached so a HEIC file decoded once for the
// thumbnail preview (jpg2pdfUI.js) isn't decoded a second time for the
// actual PDF conversion (processor.js) — same WASM cost paid only once.
const _decodeCache = new WeakMap();

/**
 * Декодирует HEIC/HEIF файл в JPEG Blob. Возвращает null при ошибке
 * (повреждённый файл, неподдерживаемый вариант кодека и т.д.) —
 * вызывающий код должен обработать null как "пропустить это изображение",
 * не бросая исключение на весь батч.
 * @param {File} file
 * @param {number} quality  JPEG quality 0–1
 * @returns {Promise<Blob|null>}
 */
export function decodeHeicToJpegBlob(file, quality = 0.92) {
  if (_decodeCache.has(file)) return _decodeCache.get(file);
  const p = _decode(file, quality);
  _decodeCache.set(file, p);
  return p;
}

async function _decode(file, quality) {
  try {
    const libheif = await _loadLibheif();
    const buf     = await file.arrayBuffer();
    const decoder = new libheif.HeifDecoder();
    const images  = decoder.decode(buf);
    if (!images || !images.length) return null;

    const image  = images[0]; // primary image; ignore thumbnails/depth maps
    const width  = image.get_width();
    const height = image.get_height();
    if (!width || !height) return null;

    const imgData = { data: new Uint8ClampedArray(width * height * 4), width, height };
    await new Promise((resolve, reject) => {
      image.display(imgData, (displayData) => {
        if (!displayData) { reject(new Error('HEIC decode failed')); return; }
        resolve();
      });
    });

    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(imgData.data, width, height), 0, 0);

    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  } catch {
    return null;
  }
}
