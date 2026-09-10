// SPDX-License-Identifier: AGPL-3.0-only
// Arabic (ar) UI strings — loaded before app.js on /ar/ pages.
// Sets window.PDFREE_LOCALE which i18n.js merges over EN defaults.
//
// SCOPED, not exhaustive — same pattern as js/locales/zh-CN.js: this is a
// deliberately small subset covering only the strings the Merge tool's
// interactive flow actually renders (file processing, success/download,
// errors, and merge's own bookmark/blank-page options). ar currently has
// exactly one dedicated tool page (/ar/damj-pdf/, no homepage). Every key
// NOT listed here gracefully falls back to English via i18n.js's
// `{ ...EN, ...PDFREE_LOCALE }` merge — intentional, not a gap to "finish"
// without a real signal to justify it.
window.PDFREE_LOCALE = {
  wait_processing:     '⏳ يرجى الانتظار حتى انتهاء المعالجة',
  done_time:           '⚡ اكتمل خلال {time} ثانية — معالجة محلية، لم يتم رفع أي شيء',
  done_no_time:        '⚡ اكتملت المعالجة المحلية — الملف لم يغادر جهازك أبدًا',
  saved_device:        '✓ تم الحفظ على الجهاز',
  process_again:       '↺ معالجة مرة أخرى',
  download_again:      '⬇ تنزيل مرة أخرى',
  auto_download_hint:  '✓ تم حفظ {filename} على جهازك',
  download_toast:      '📥 تم تنزيل {filename}',
  single_file_only:    'هذه الأداة تعالج ملفًا واحدًا فقط في كل مرة. يرجى إزالة الملف الحالي أولاً.',
  invalid_pdf:         'يرجى اختيار ملف PDF — افتح تطبيق الملفات، وليس الصور أو الكاميرا',
  drop_mobile_hint:    'افتح تطبيق الملفات واختر ملف PDF — وليس الصور أو الكاميرا',
  not_valid_pdf:       '⚠️ "{name}" ليس ملف PDF صالحًا',

  merge_bookmarks_title:    'إنشاء إشارات مرجعية',
  merge_bookmarks_subtitle: 'أضف إشارة مرجعية لكل ملف حتى تتمكن من التنقل بسرعة داخل ملف PDF المدمج.',
  merge_blank_pages_title:  'إدراج صفحات فارغة',
  merge_blank_pages_none:   'بدون',
  merge_blank_pages_always: 'دائمًا',
  merge_blank_pages_odd:    'عند وجود عدد صفحات فردي',
};
