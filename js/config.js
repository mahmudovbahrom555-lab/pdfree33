// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/yourusername/pdfree

// ============================================================
//  config.js — App constants & tool definitions
//  Чтобы добавить новый инструмент — добавь запись сюда
// ============================================================

/** Build version — used to detect stale SW cache in console */
export const APP_VERSION = '6.2';

/**
 * Maximum image dimension (px on the longest side) when compressing
 * images in the JPG→PDF converter.
 *
 * This is a product decision balancing quality, file size, and RAM:
 *   HIGH   (3200px) — near-original quality, large PDFs, more RAM
 *   MEDIUM (2400px) — good quality for screen/print, reasonable size
 *   LOW    (1200px) — small files, noticeable quality loss on large prints
 *
 * The default is MEDIUM. Users with compress=false get the original size.
 * Change this when making quality/size tradeoff decisions, not randomly.
 */
export const IMAGE_DIM_PRESETS = {
  high:   3200,
  medium: 2400,   // ← default used in handleJpg2Pdf
  low:    1200,
};

/**
 * Допустимые MIME-типы для каждого формата файла.
 * Используется в files.js для валидации при drag-and-drop
 * (атрибут accept на инпуте не защищает от D&D сторонних файлов).
 */
export const ACCEPTED_MIME = {
  '.pdf': ['application/pdf'],
  '.jpg,.jpeg,.png': ['image/jpeg', 'image/png'],
};

/**
 * Определения всех инструментов.
 * Чтобы добавить новый — просто добавь запись.
 * @type {Record<string, {icon, title, desc, btn, multi, accept, implemented}>}
 */
export const TOOLS = {
  merge: {
    icon:        '🔗',
    title:       'Merge PDF',
    desc:        'Combine unlimited PDF files — no restrictions',
    btn:         '🔗 Merge PDF files',
    multi:       true,
    accept:      '.pdf',
    implemented: true,
  },
  split: {
    icon:        '✂️',
    title:       'Split PDF',
    desc:        'Extract pages or split into separate files',
    btn:         '✂️ Split PDF',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  compress: {
    icon:          '🗜️',
    title:         'Compress PDF',
    desc:          'Reduce file size while preserving text and vector quality',
    btn:           '🗜️ Compress PDF',
    multi:         false,
    accept:        '.pdf',
    implemented:   true,
    defaultPreset: 'medium',
  },
  jpg2pdf: {
    icon:        '🖼️',
    title:       'JPG to PDF',
    desc:        'Convert images to PDF — EXIF rotation corrected automatically',
    btn:         '🖼️ Convert to PDF',
    multi:       true,
    accept:      '.jpg,.jpeg,.png',
    implemented: true,
  },
  pdf2jpg: {
    icon:        '📸',
    title:       'PDF to JPG',
    desc:        'Extract pages as high-quality JPG or PNG images',
    btn:         '📸 Export images',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  redact: {
    icon:        '🖌️',
    title:       'Cover Area',
    desc:        'Hide watermarks, signatures or sensitive data with an opaque cover',
    btn:         '🖌️ Cover Area',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  rotate: {
    icon:        '🔄',
    title:       'Rotate PDF',
    desc:        'Fix page orientation in any PDF',
    btn:         '🔄 Rotate PDF',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  extract: {
    icon:        '📑',
    title:       'Extract Pages',
    desc:        'Pull selected pages into a new PDF — with smart presets',
    btn:         '📑 Extract Pages',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  watermark: {
    title:       'Watermark PDF',
    desc:        'Add text watermark to every page — diagonal, tiled or positioned',
    btn:         '💧 Apply Watermark',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  pagenum: {
    icon:        '🔢',
    title:       'Add Page Numbers',
    desc:        'Number pages — Arabic, Roman or alphabetic, any position',
    btn:         '🔢 Add Numbers',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  meta: {
    icon:        '🏷️',
    title:       'Edit Metadata',
    desc:        'View and edit PDF title, author, subject and other fields',
    btn:         '🏷️ Save Metadata',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  protect: {
    icon:        '🔒',
    title:       'Protect PDF',
    desc:        'Add open password & restrict permissions — AES-256, fully client-side',
    btn:         '🔒 Protect PDF',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
};
