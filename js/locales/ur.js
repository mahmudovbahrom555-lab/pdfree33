// SPDX-License-Identifier: AGPL-3.0-only
// Urdu (ur) UI strings — loaded before app.js on /ur/ pages.
// Sets window.PDFREE_LOCALE which i18n.js merges over EN defaults.
//
// SCOPED, not exhaustive — same pattern as js/locales/zh-CN.js: this is a
// deliberately small subset covering only the strings the Merge tool's
// interactive flow actually renders (file processing, success/download,
// errors, and merge's own bookmark/blank-page options). ur currently has
// exactly one dedicated tool page (/ur/zam-pdf/, no homepage). Every key
// NOT listed here gracefully falls back to English via i18n.js's
// `{ ...EN, ...PDFREE_LOCALE }` merge — intentional, not a gap to "finish"
// without a real signal to justify it.
window.PDFREE_LOCALE = {
  wait_processing:     '⏳ براہ کرم پروسیسنگ مکمل ہونے تک انتظار کریں',
  done_time:           '⚡ {time} سیکنڈ میں مکمل ہوا — مقامی کارروائی، کچھ بھی اپلوڈ نہیں ہوا',
  done_no_time:        '⚡ مقامی کارروائی مکمل ہوئی — فائل کبھی بھی آپ کے آلے سے باہر نہیں گئی',
  saved_device:        '✓ آلے پر محفوظ ہو گیا',
  process_again:       '↺ دوبارہ کارروائی کریں',
  download_again:      '⬇ دوبارہ ڈاؤن لوڈ کریں',
  auto_download_hint:  '✓ {filename} آپ کے آلے پر محفوظ ہو گیا',
  download_toast:      '📥 {filename} ڈاؤن لوڈ ہو گیا',
  single_file_only:    'یہ ٹول ایک وقت میں صرف ایک فائل پر کارروائی کرتا ہے۔ براہ کرم پہلے موجودہ فائل کو ہٹا دیں۔',
  invalid_pdf:         'براہ کرم ایک PDF فائل منتخب کریں — اپنی فائلز ایپ کھولیں، تصاویر یا کیمرہ نہیں',
  drop_mobile_hint:    'اپنی فائلز ایپ کھولیں اور ایک PDF منتخب کریں — تصاویر یا کیمرہ نہیں',
  not_valid_pdf:       '⚠️ "{name}" ایک درست PDF فائل نہیں ہے',

  merge_bookmarks_title:    'بک مارکس بنائیں',
  merge_bookmarks_subtitle: 'ہر فائل کے لیے ایک نامزد بک مارک شامل کریں تاکہ آپ ضم شدہ PDF کے اندر تیزی سے نیویگیٹ کر سکیں۔',
  merge_blank_pages_title:  'خالی صفحات شامل کریں',
  merge_blank_pages_none:   'کوئی نہیں',
  merge_blank_pages_always: 'ہمیشہ',
  merge_blank_pages_odd:    'جب صفحات کی تعداد طاق ہو',
};
