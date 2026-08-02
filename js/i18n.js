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

export const EN = {
  // search_tags: per-tool localized search synonyms for the homepage search
  // box (js/search.js buildIndex). Not a translatable string like the rest
  // of this file — English tags already live in js/config.js's TOOLS[key]
  // .tags array, so this stays empty on English pages; non-English
  // js/locales/<lc>.js files populate it with { toolKey: [synonym, ...] }.
  search_tags: {},

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
  aes_help:        '🔒 {ver}-encrypted PDF — cannot be processed without the owner password. {restricted} Use Unlock PDF to remove the password (if you know it), then re-upload the unlocked file here.',

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
  pn_pos_bottom_center: '↓ Bottom center',
  pn_pos_bottom_right:  '↘ Bottom right',
  pn_pos_bottom_left:   '↙ Bottom left',
  pn_pos_top_center:    '↑ Top center',
  pn_pos_book:          '📖 Book style (outer edge)',
  pn_from_page:         'From page',
  pn_to_page:           'To page',
  pn_to_page_all:       '(∞ = all)',
  pn_aria_dec_from:     'Decrease from page',
  pn_aria_inc_from:     'Increase from page',
  pn_aria_dec_to:       'Decrease to page',
  pn_aria_inc_to:       'Increase to page',
  pn_aria_dec_start:    'Decrease start',
  pn_aria_inc_start:    'Increase start',
  pn_section_numbering: 'Numbering',
  pn_aria_number_format: 'Number format',
  pn_section_position:  'Position',
  pn_section_options:   'Options',
  pn_show_total_title:    'Show total (1 / N)',
  pn_show_total_subtitle: 'Displays current page out of total',
  pn_size_label:        'Size',
  pn_aria_font_size:    'Font size {size}pt',
  pn_preview_label:     'Preview:',
  pn_preview_range:     'pages {from}–{to}',
  pn_preview_from:      'from page {from}',
  prog_meta:         'Updating metadata...',
  prog_protect:      'Encrypting PDF...',
  prog_rotate:       'Applying rotations...',
  prog_redact:       'Covering areas...',
  prog_flatten:      'Flattening form fields...',

  // ── processor.js — batch queue (compress/watermark/rotate, 2+ files) ──
  prog_batch_file:        'Processing file {i} of {n}...',
  desc_batch_done:        'Processed {n} files · {size}',
  desc_batch_partial:     '{ok} of {total} files processed · {size}',
  warn_batch_failed_one:  '⚠️ {n} file failed and was skipped: {names}',
  warn_batch_failed_many: '⚠️ {n} files failed and were skipped: {names}',
  err_batch_all_failed:   'All files failed to process — nothing to download.',
  batch_status_pending:    'Waiting',
  batch_status_processing: 'Processing…',
  batch_status_done:       'Done',
  batch_status_error:      'Failed',

  // ── processor.js — success descriptions ───────────────────────
  desc_merged_partial:      'Merged {n} of {total} files · {pages} pages · {size}',
  desc_merged:              'Merged {total} files · {pages} pages · {size}',
  desc_compress_saved:      'Compressed · processed locally · no upload',
  desc_compress_optimized:  'Already optimized · processed locally · no upload',
  desc_watermark:           'Watermarked · {pages} pages · {size}',
  desc_pagenum:             'Page numbers added · {pages} pages · {size}',
  desc_meta:                'Metadata updated · {pages} pages · {size}',
  desc_protect:             'Password protected · {pages} pages · {size}{extra}',
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
  err_cdn_lib_unavailable: '{lib} library unavailable — check your internet connection',
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

  // ── rotateUI.js ────────────────────────────────────────────────
  rot_loading:           'Loading PDF…',
  rot_err_load:          'Could not read PDF: {msg}',
  rot_toolbar_aria:      'Rotation',
  rot_ccw_title:         'Rotate 90° counter-clockwise',
  rot_180_title:         'Rotate 180°',
  rot_cw_title:          'Rotate 90° clockwise',
  rot_quick_aria:        'Quick select',
  rot_select_label:      'Select:',
  rot_odd:               'Odd',
  rot_even:              'Even',
  rot_undo:              '↩ Undo',
  rot_reset:             '⊘ Reset all',
  rot_hint_click:        'Click pages to select, then rotate',
  rot_hint_selected_one:  '{n} page selected',
  rot_hint_selected_many: '{n} pages selected',
  rot_grid_aria:         'PDF pages',
  rot_page_aria:         'Page {n}',
  rot_selected_suffix:   ' (selected)',
  rot_rotated_suffix:    ' rotated {delta}°',
  rot_badge_aria:        'Rotated {delta}°',
  rot_page_alt:          'Page {n}',
  rot_select_first:      'Select pages first, then rotate',
  rot_btn_one:           '🔄 Rotate {n} page',
  rot_btn_many:          '🔄 Rotate {n} pages',
  rot_btn_disabled:      '🔄 Select and rotate pages',
  rot_banner:            '🔒 Processed entirely in your browser · No upload',

  // ── search (homepage intent search) ───────────────────────────
  search_placeholder:     'merge pdf, compress, rotate, watermark, pdf to word…',
  search_aria:            'Search PDF tools',
  search_drop:            'or drop PDF here',
  search_start:           'Start →',
  search_miss:            'No tool found for "{q}" — try one of these:',
  search_candidates_label: 'Matching tools',

  // ── PDF/A compliance checker ────────────────────────────────────
  pdfa_analyzing:         'Analyzing PDF/A-2b compliance…',
  pdfa_error:             'Could not analyze this file: {message}',
  pdfa_error_generic:     'Could not analyze this file.',
  pdfa_row_encryption:        'No password / encryption',
  pdfa_row_encryption_detail: 'Remove the password first, then re-check.',
  pdfa_row_signature:         'No applied digital signature',
  pdfa_row_signature_detail:  'Converting would invalidate the existing signature. Sign the converted file again afterward, or convert before signing.',
  pdfa_row_fonts:             'All fonts embedded',
  pdfa_row_fonts_detail:      'Not embedded: {fonts}. Re-export the source document with these fonts embedded (most word processors and design tools support this), then re-check.',
  pdfa_row_actions:           'No interactive actions or scripts',
  pdfa_row_actions_detail:    'Found: {actions}',
  pdfa_row_actions_willremove: 'Will be removed automatically during conversion: {actions}. This may disable functionality such as calculated form fields or clickable links.',
  pdfa_action_openAction:     'a document open action',
  pdfa_action_aa:             'document-level actions',
  pdfa_action_javascript:     'embedded JavaScript',
  pdfa_action_annotAction:    'a page or annotation action (e.g. a link or form field running JavaScript)',
  pdfa_row_lzw:               'No LZW-compressed streams',
  pdfa_row_lzw_detail:        'PDF/A does not permit the LZWDecode filter.',
  pdfa_row_unicode:           'Text has Unicode mapping (PDF/A-2u eligible)',
  pdfa_row_unicode_detail:    'Some fonts are missing a Unicode mapping — this file will convert to PDF/A-2b instead of the stricter PDF/A-2u.',
  pdfa_compliant:         '✓ This PDF can be converted to {level}.',
  pdfa_not_compliant:     'This PDF is not PDF/A-2b compliant yet — see the issues above.',
  pdfa_convert_btn:       '📐 Convert to {level}',
  pdfa_converting:        'Converting…',
  pdfa_convert_failed:        'Conversion failed',
  pdfa_convert_failed_detail: 'Conversion failed: {message}',
  pdfa_convert_success:   '✓ Converted to {level} — self-check confirmed the OutputIntent and XMP markers in the downloaded file.',
  pdfa_convert_warn:      '⚠ Converted, but the self-check could not confirm all markers in the output file — verify with a dedicated PDF/A validator before relying on this file.',
  pdfa_removed_summary:   'Removed during conversion: {items}',
  pdfa_removed_pageOrAnnot_one:  '{n} page or annotation action',
  pdfa_removed_pageOrAnnot_many: '{n} page or annotation actions',
  pdfa_unlock_link:       'Remove password →',
  pdfa_disclaimer:        'This is a self-check of the structural requirements most likely to fail, run entirely in your browser. It is not a substitute for a full ISO 19005 validator (e.g. veraPDF) for legally mandated archiving.',
  pdfa_verapdf_link:      'Verify independently with veraPDF ↗',
  pdfa_substitute_offer:    'These fonts have a free, metric-verified substitute available (Liberation family): {fonts}. PDFree verifies the exact metric match before ever using it — if verification fails, nothing is changed and conversion stays refused.',
  pdfa_substitute_checkbox: 'Try font substitution',
  pdfa_substitute_btn:      '📐 Verify & Convert',
  pdfa_substitute_verifying: 'Verifying fonts…',
  pdfa_substitute_failed:   "Substitution couldn't be safely verified for: {fonts}. Nothing was changed — try re-exporting the source document with fonts embedded instead.",
  pdfa_substitute_note:     'Fonts substituted (Liberation, verified metric-compatible): {fonts}.',
  pdfa_aria_label:        'PDF/A compliance report',

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
  hero_img_hint:      'Have an image instead?',
  home_title:         'PDFree — Free PDF Tools, No Limits',

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

  // ── redactUI.js ────────────────────────────────────────────────
  rdct_loading:            'Loading PDF…',
  rdct_err_read:           'Could not read PDF: {msg}',

  // Banners
  rdct_banner_true:        '🔒 <strong>True PDF Redaction</strong> — permanently removes content from the document. Redacted pages are converted to images so underlying text cannot be recovered. Files never leave your device.',
  rdct_banner_cover:       '🛡️ <strong>Cover Area</strong> — draws an opaque rectangle over the selected region. The content underneath is hidden visually but <em>not cryptographically deleted</em>. For legal redaction use the <a href="/redact-pdf/" style="color:var(--green)">Redact PDF</a> tool.',
  rdct_banner_annotate:    '✏️ <strong>Annotate PDF</strong> — draw colored boxes, highlights, or covers on any page. Everything runs locally in your browser — your PDF never leaves your device.',
  rdct_footer_true:        '🔒 Processed entirely in your browser · Files never leave your device · Content permanently removed',
  rdct_footer:             '🔒 Processed entirely in your browser · Files never leave your device',

  // Shape tool
  rdct_shape_tool:         'Shape Tool',
  rdct_undo_title:         'Undo (Cmd+Z)',
  rdct_redo_title:         'Redo (Cmd+Shift+Z)',
  rdct_tool_box:           'Box',
  rdct_tool_arrow:         'Arrow',
  rdct_tool_cross:         'Cross',
  rdct_tool_check:         'Check',
  rdct_tool_plus:          'Plus',
  rdct_tool_minus:         'Minus',
  rdct_tool_text:          'Text',

  // Controls
  rdct_color:              'Color',
  rdct_opacity:            'Opacity',
  rdct_zoom:               'Zoom:',

  // Canvas drag hints
  rdct_drag_hint_single:   'Drag to draw a shape',
  rdct_drag_hint_page:     'Drag to draw a shape on page {n}',
  rdct_drag_hint_all:      'Drag on page {n} — applies to all pages',
  rdct_drag_hint_perpage:  'Drag on page {n} — only this page',

  // Page navigation
  rdct_page_of:            'Page {cur} of {total}',
  rdct_prev_page:          'Previous page',
  rdct_next_page:          'Next page',

  // Areas list
  rdct_no_areas:           'No areas yet',
  rdct_areas_all_one:      '1 area · all pages',
  rdct_areas_all_many:     '{n} areas · all pages',
  rdct_no_areas_page:      'No areas on page {n}',
  rdct_areas_page_one:     '1 area on page {n}',
  rdct_areas_page_many:    '{n} areas on page {page}',
  rdct_drag_empty:         'Drag on the preview to add areas',
  rdct_remove_all:         '✕ Remove all',

  // Apply-all
  rdct_apply_all:          'Repeat on every page',
  rdct_apply_all_desc:     'Same position on all {n} pages — ideal for diagonal DRAFT stamps',

  // Search & Redact
  rdct_search_title:       'Search & Redact',
  rdct_search_placeholder: 'Type text or /regex/…',
  rdct_search_btn:         'Find & Mark',
  rdct_searching:          'Searching…',
  rdct_search_empty:       'Enter text to search.',
  rdct_no_matches:         'No matches found.',

  // Match preview panel
  rdct_matches_found:      '{n} match — choose which to redact:',
  rdct_matches_found_many: '{n} matches — choose which to redact:',
  rdct_mark_one:           'Mark {n} match for redaction',
  rdct_mark_many:          'Mark {n} matches for redaction',
  rdct_mark_empty:         'No matches selected',
  rdct_marked_one:         '1 area marked for redaction',
  rdct_marked_many:        '{n} areas marked for redaction',

  // Hide boxes / metadata
  rdct_hide_boxes:         'Hide redaction boxes',
  rdct_hide_boxes_desc:    'Temporarily show document without black boxes to review context',
  rdct_remove_meta:        'Remove metadata',
  rdct_remove_meta_tip:    'Removes Author, Creator, Producer, Keywords and other hidden fields embedded in the PDF',
  rdct_remove_meta_desc:   'Strip Author, Creator, keywords and other hidden fields from PDF',

  // No-preview fallback
  rdct_no_preview:         'Preview unavailable.',
  rdct_no_preview_hint:    'Use the options below to cover all pages.',

  // Toasts
  rdct_max_areas:          'Maximum {n} areas per page — remove some first',
  rdct_invalid_regex:      'Invalid regex pattern',

  // Merge button
  rdct_btn_redact_one:     '🔒 Redact {n} area',
  rdct_btn_redact_many:    '🔒 Redact {n} areas',
  rdct_btn_redact_dis:     '🔒 Draw areas to redact',
  rdct_btn_cover_one:      '🛡️ Cover {n} area',
  rdct_btn_cover_many:     '🛡️ Cover {n} areas',
  rdct_btn_cover_dis:      '🛡️ Draw areas to cover',
  rdct_btn_apply_one:      '✏️ Apply {n} area',
  rdct_btn_apply_many:     '✏️ Apply {n} areas',
  rdct_btn_apply_dis:      '✏️ Draw areas to apply',
  rdct_suffix_all_pages:   ' · all pages',
  rdct_suffix_pages:       ' · {n} pages',

  // PII pattern button labels
  rdct_pii_email:          '📧 Email',
  rdct_pii_phone:          '📞 Phone',
  rdct_pii_cc:             '💳 Credit Card',
  rdct_pii_iban:           '🏦 IBAN',
  rdct_pii_url:            '🌐 URL',
};

const L = { ...EN, ...(window.PDFREE_LOCALE ?? {}) };

export const t = (key, vars = {}) =>
  (L[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

export const tp = (n, keyOne, keyMany, vars = {}) =>
  t(n === 1 ? keyOne : keyMany, { n, ...vars });
