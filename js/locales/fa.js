// SPDX-License-Identifier: AGPL-3.0-only
// Persian/Farsi (fa) UI strings — loaded before app.js on /fa/ pages.
// Sets window.PDFREE_LOCALE which i18n.js merges over EN defaults.
//
// SCOPED, not exhaustive — same pattern as js/locales/zh-CN.js: this is a
// deliberately small subset covering only the strings the Merge tool's
// interactive flow actually renders (file processing, success/download,
// errors, and merge's own bookmark/blank-page options). fa currently has
// exactly one dedicated tool page (/fa/edgham-pdf/, no homepage). Every key
// NOT listed here gracefully falls back to English via i18n.js's
// `{ ...EN, ...PDFREE_LOCALE }` merge — intentional, not a gap to "finish"
// without a real signal to justify it.
window.PDFREE_LOCALE = {
  wait_processing:     '⏳ لطفاً تا پایان پردازش صبر کنید',
  done_time:           '⚡ در {time} ثانیه انجام شد — پردازش محلی، چیزی آپلود نشد',
  done_no_time:        '⚡ پردازش محلی انجام شد — فایل هرگز از دستگاه شما خارج نشد',
  saved_device:        '✓ روی دستگاه ذخیره شد',
  process_again:       '↺ پردازش دوباره',
  download_again:      '⬇ دانلود دوباره',
  auto_download_hint:  '✓ {filename} روی دستگاه شما ذخیره شد',
  download_toast:      '📥 {filename} دانلود شد',
  single_file_only:    'این ابزار هر بار فقط یک فایل را پردازش می‌کند. لطفاً ابتدا فایل فعلی را حذف کنید.',
  invalid_pdf:         'لطفاً یک فایل PDF انتخاب کنید — برنامه فایل‌ها را باز کنید، نه عکس‌ها یا دوربین را',
  drop_mobile_hint:    'برنامه فایل‌ها را باز کنید و یک PDF انتخاب کنید — نه عکس‌ها یا دوربین',
  not_valid_pdf:       '⚠️ «{name}» یک فایل PDF معتبر نیست',

  merge_bookmarks_title:    'ایجاد نشانک‌ها',
  merge_bookmarks_subtitle: 'برای هر فایل یک نشانک اضافه کنید تا بتوانید به‌سرعت در PDF ادغام‌شده جابه‌جا شوید.',
  merge_blank_pages_title:  'درج صفحات خالی',
  merge_blank_pages_none:   'هیچ‌کدام',
  merge_blank_pages_always: 'همیشه',
  merge_blank_pages_odd:    'وقتی تعداد صفحات فرد است',
};
