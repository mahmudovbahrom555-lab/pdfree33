// SPDX-License-Identifier: AGPL-3.0-only
// Simplified Chinese (zh-CN) UI strings — loaded before app.js on /zh/ pages.
// Sets window.PDFREE_LOCALE which i18n.js merges over EN defaults.
//
// SCOPED, not exhaustive: unlike the other 13 locales (which translate all
// ~1006 keys in js/i18n.js), this is a deliberately small subset covering
// only the strings the Merge tool's interactive flow actually renders
// (file processing, success/download, errors, and merge's own bookmark/
// blank-page options). zh-CN currently has exactly one dedicated tool page
// (/zh/merge-pdf/, no homepage) — see the market-research memory this
// locale shipped from for why. Every key NOT listed here gracefully falls
// back to English via i18n.js's `{ ...EN, ...PDFREE_LOCALE }` merge — this
// is intentional, not a gap to "finish" without a real signal to justify it.
window.PDFREE_LOCALE = {
  wait_processing:     '⏳ 请等待处理完成',
  done_time:           '⚡ {time} 秒内完成 — 本地处理，未上传任何内容',
  done_no_time:        '⚡ 本地处理完成 — 文件从未离开您的设备',
  saved_device:        '✓ 已保存到设备',
  process_again:       '↺ 再次处理',
  download_again:      '⬇ 重新下载',
  auto_download_hint:  '✓ {filename} 已保存到您的设备',
  download_toast:      '📥 {filename} 已下载',
  single_file_only:    '此工具一次只能处理一个文件。请先移除当前文件。',
  invalid_pdf:         '请选择一个 PDF 文件 — 打开您的文件应用，而不是照片或相机',
  drop_mobile_hint:    '打开您的文件应用并选择一个 PDF — 而不是照片或相机',
  not_valid_pdf:       '⚠️ "{name}" 不是有效的 PDF 文件',

  merge_bookmarks_title:    '创建书签',
  merge_bookmarks_subtitle: '为每个文件添加书签，方便您在合并后的 PDF 中快速跳转。',
  merge_blank_pages_title:  '插入空白页',
  merge_blank_pages_none:   '无',
  merge_blank_pages_always: '始终',
  merge_blank_pages_odd:    '页数为奇数时',
};
