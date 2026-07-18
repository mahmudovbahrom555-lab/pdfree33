// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// i18n.js — lightweight translation module (~70 lines, zero dependencies)
//
// Usage:
//   Localized pages load js/locales/<lang>.js BEFORE app.js, which sets
//   window.PDFREE_LOCALE = { key: 'translated string', ... }.
//   This module merges that object over EN defaults at import time.
//   English pages omit the locale script — all keys fall back to EN.
//
// t(key, vars?)        — translate key, interpolate {var} placeholders
// tp(n, one, many, vars?) — choose singular/plural key, then translate

const EN = {
  // ── app.js ─────────────────────────────────────────────────────
  wait_processing:     '⏳ Please wait for processing to finish',
  coming_soon:         '🚧 Coming soon!',
  done_time:           '⚡ Done in {time}s — processed locally, nothing uploaded',
  done_no_time:        '⚡ Processed locally — your files never left your device',
  saved_device:        '✓ Saved to device',
  sent:                '✓ Sent',
  process_again:       '↺ Process again',
  download_again:      '⬇ Download again',
  auto_download_hint:  'Your download should start automatically.',

  // ── files.js ───────────────────────────────────────────────────
  split_one_only:  'Split works with one PDF only. Remove the current file first.',
  invalid_pdf:     'Please select a PDF file — open your Files app, not Photos or Camera',
  invalid_img:     'Please select a JPG or PNG image',
  dupe_skip_one:   '{n} duplicate skipped',
  dupe_skip_many:  '{n} duplicates skipped',
  not_valid_pdf:   '⚠️ "{name}" is not a valid PDF file',
  aes_help:        '🔒 {ver}-encrypted PDF — cannot be processed without the owner password. {restricted} To fix: 1) Open in Adobe Acrobat. 2) File → Properties → Security. 3) Set Security Method: No Security → Save. Then re-upload here.',

  // ── ui.js ──────────────────────────────────────────────────────
  btn_processing:   '⏳ Processing...',
  drop_mobile_hint: 'Open your Files app and select a PDF — not Photos or Camera',

  // ── processor.js — progress ────────────────────────────────────
  cancelled:         'Processing cancelled',
  prog_reading:      'Reading files...',
  prog_merging:      'Merging...',
  prog_done:         'Done!',
  prog_loading_pdf:  'Loading PDF...',
  prog_loading_imgs: 'Loading images...',
  prog_packaging:    'Packaging...',
  prog_zip:          'Building ZIP...',
  prog_compressing:  'Compressing...',
  prog_processing:   'Processing...',
  prog_rendering:    'Rendering page {i} of {n}...',
  prog_watermark:    'Applying watermark...',
  prog_pagenum:      'Adding page numbers...',

  // ── pageNumUI — start number card ────────────────────────────
  pn_apply_to_pages:  'Apply to pages',
  pn_start_label:     'Start number',
  pn_auto_tag:        'Auto',
  pn_custom_tag:      'Custom',
  pn_auto_follows:    'Automatically follows From page',
  pn_customize:       'Customize',
  pn_back_auto:       '↺ Back to auto',
  prog_meta:         'Updating metadata...',
  prog_protect:      'Encrypting PDF...',
  prog_rotate:       'Applying rotations...',
  prog_redact:       'Covering areas...',
  prog_flatten:      'Flattening form fields...',

  // ── processor.js — success descriptions ───────────────────────
  desc_merged_partial:      'Merged {n} of {total} files · {pages} pages · {size}',
  desc_merged:              'Merged {total} files · {pages} pages · {size}',
  desc_compress_saved:      'Compressed · processed locally · no upload',
  desc_compress_optimized:  'Already optimized · processed locally · no upload',
  desc_watermark:           'Watermarked · {pages} pages · {size}',
  desc_pagenum:             'Page numbers added · {pages} pages · {size}',
  desc_meta:                'Metadata updated · {pages} pages · {size}',
  desc_protect:             'AES-256 protected · {pages} pages · {size}{extra}',
  desc_rotate:              'Rotated · {pages} pages · {size}',
  desc_redact:              'Areas covered · {pages} pages · {size}',
  desc_fill:                'Form filled · {pages} pages · {size}',
  warn_fill_skip_one:       "{n} field couldn't be filled and was skipped — please check the downloaded PDF.",
  warn_fill_skip_many:      "{n} fields couldn't be filled and were skipped — please check the downloaded PDF.",
  desc_flatten:             'Fields locked · {pages} pages · {size}',
  warn_xfa_form:            'ℹ️ No editable fields found — file returned unchanged. XFA forms use a format that isn\'t supported by browser-based PDF tools.',
  desc_split_single:        'Extracted {n} page · {size}',
  desc_split_single_many:   'Extracted {n} pages · {size}',
  desc_split_separate:      'Split into {n} file · {size}',
  desc_split_separate_many: 'Split into {n} files · {size}',
  desc_pdf2jpg_one:         '1 page · {ext} · {size}',
  desc_pdf2jpg_many:        '{n} {ext} images · {size}',

  // word units for composing double-plural strings
  word_page:   'page',
  word_pages:  'pages',
  word_image:  'image',
  word_images: 'images',

  // ── processor.js — toasts / warnings ──────────────────────────
  skipped_files_one:   '⚠️ {n} file skipped: {labels}',
  skipped_files_many:  '⚠️ {n} files skipped: {labels}',
  hint_protected:      ' (password-protected)',
  hint_corrupted:      ' (corrupted)',
  more_files:          '+{n} more',
  warn_encrypted_pdf:  '⚠️ Encrypted PDF was processed with limitations',
  skipped_imgs_one:    '⚠️ {n} image skipped (could not decode): #{nums}',
  skipped_imgs_many:   '⚠️ {n} images skipped (could not decode): #{nums}',
  warn_large_export:   '⏳ Large export ({n} pages at {dpi} DPI) — processing may take a minute.',
  warn_page_fail:      '⚠️ Page {page} failed: {msg}',
  already_protected:   'ℹ️ File was already protected — password updated',
  warn_file_too_large:  '⚠️ File is {size} — browser processes PDFs in RAM, limit is {max} MB for this tool. Tip: use Split PDF first, then process each part.',
  warn_total_too_large: '⚠️ Total size is {size} — browser limit is {max} MB. Remove some files to continue.',

  // ── splitUI.js ─────────────────────────────────────────────────
  no_pages_pdf:             'This PDF has no pages',
  warn_large_pdf:           '⚠️ Large PDF ({n} pages) — processing may take a while',
  split_info_page:          '{n} page',
  split_info_pages:         '{n} pages',
  split_mode_separate:      'Separate files',
  split_mode_separate_desc: 'Each page → individual PDF',
  split_mode_single:        'Single file',
  split_mode_single_desc:   'Selected pages → one PDF',
  split_pages_label:        'Pages to extract',
  err_read_pages:           'Could not read PDF pages: {msg}',
  select_all:               'Select all',
  deselect_all:             'Deselect all',
  select_all_short:         'All',
  deselect_all_short:       'None',
  pages_selected:           '{n} of {total} pages selected',
  invalid_range:            'Invalid range — no valid pages found',
  split_btn_separate:       '✂️ Split into {n} file',
  split_btn_separate_many:  '✂️ Split into {n} files',
  split_btn_single:         '📄 Extract {n} page',
  split_btn_single_many:    '📄 Extract {n} pages',
  split_btn_disabled:       '✂️ Select pages to split',

  // ── pdf2jpgUI.js ───────────────────────────────────────────────
  err_pdf_engine: 'PDF engine could not load. Check your internet connection — pdf.js is loaded from CDN.',
  retry:          '⟳ Try again',

  // ── ocrUI.js ───────────────────────────────────────────────────
  install_ocr_first:    'Install OCR engine first — click "Install OCR PDF"',

  // ── errors ────────────────────────────────────────────────────
  no_pages_selected:    'No valid pages selected',
  err_no_render:        'No pages were rendered successfully',
  err_no_renderer:      'PDF renderer not loaded — please reopen the tool',
  err_enc_unavailable:  'Encryption library failed to load. Please refresh the page and try again.',
  err_enc_failed:       'Encryption failed. The PDF may be in an unsupported format.',
  err_encrypted_pdf:    'This PDF has an unusual or corrupted structure (this can also happen with password-protected files). Try re-saving it from another PDF app, or removing any password, then try again.',
  err_compress_timeout: '⏱ Compression timed out — the file may be too image-heavy for the browser. Try the Light preset or split the PDF into smaller parts first.',
  warn_compress_large:  '⚠️ Large file ({size}) — compression may take 1–2 minutes. The browser processes everything locally in RAM.',
  compress_scan_skipped: 'Large file — pre-scan skipped to save memory',

  // ── compressUI — scan banner & doc type ───────────────────────
  compress_placeholder:      'Analysis runs automatically when you compress',
  compress_doc_scan:         'Scanned document',
  compress_doc_mixed:        'Mixed document',
  compress_doc_text:         'Text document',
  compress_doc_clean:        'PDF looks well-optimized',
  compress_tier_high:        'High savings expected · Image-heavy PDF',
  compress_tier_moderate:    'Moderate savings expected · Mixed text and images',
  compress_tier_minor:       'Minor savings expected · Text-only PDF',
  compress_findings_found:   'found',
  compress_dpi_downsample:   'will downsample to {dpi} DPI',
  compress_time_est:         '⏱ ~{t}',
  compress_img:              '{n} image',
  compress_imgs:             '{n} images',
  compress_thumb:            '{n} thumbnail',
  compress_thumbs:           '{n} thumbnails',

  // ── compressUI — Target Size Mode ─────────────────────────────
  compress_target_label:     'Compress to',
  compress_target_best:      'Best quality',
  compress_target_email:     'Email',
  compress_target_web:       'Web',
  compress_target_small:     'Small',
  compress_target_met:       '✅ {size} — fits {target} limit',
  compress_target_over:      '⚠️ {size} — still over {target} limit. Try splitting the PDF first.',

  error_msg:            'Error: {msg}',
  error_report_hint:    ' — tap to report',
  still_working:        'Still working… Large documents can take a few minutes.',

  // ── search (homepage intent search) ───────────────────────────
  search_placeholder: 'merge pdf, compress, rotate, watermark, pdf to word…',
  search_aria:        'Search PDF tools',
  search_drop:        'or drop PDF here',
  search_start:       'Start →',
  search_miss:        'No tool found for "{q}" — try "merge", "compress", or "split"',

  // ── hero drop zone ────────────────────────────────────────────
  hero_drop:          'Start with your PDF',
  hero_or:            'or',
  hero_drop_choose:   'Choose File',
  hero_file_single:   '{name} ({size})',
  hero_file_multi:    '{n} PDFs selected',
  hero_or_search:     'or search by name',
  hero_pick_which:    'which file?',
  hero_pick_back:     '← Back',
  hero_hint_multi:    'Recommended: {tool}',
  hero_chip_one_file: '1 file',
  hero_img_hint:      '🖼️ Have an image instead?',

  // ── feedback.js — personalized modal ──────────────────────────
  fb_intro:              'Goes straight to Murod on Telegram — no tickets, no CRM. I read every message myself.',
  fb_title_bug:          '🐛 Report a bug',
  fb_title_idea:         '💡 Share an idea',
  fb_title_other:        '💬 Tell me what you think',
  fb_title_error:        '⚠️ What went wrong?',
  fb_placeholder_bug:    'What went wrong? Which file type or tool?',
  fb_placeholder_idea:   'What feature would help you most?',
  fb_placeholder_other:  'What\'s on your mind?',
  fb_placeholder_error:  'A few details help me fix it faster (optional)',
  fb_email_placeholder:  'Email (optional — only if you\'d like a reply)',
  fb_send:               'Send to Murod',
  fb_thanks:             'Thank you — I read this myself.',
};

const L = { ...EN, ...(window.PDFREE_LOCALE ?? {}) };

export const t = (key, vars = {}) =>
  (L[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

export const tp = (n, keyOne, keyMany, vars = {}) =>
  t(n === 1 ? keyOne : keyMany, { n, ...vars });
