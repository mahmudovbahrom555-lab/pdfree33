// SPDX-License-Identifier: AGPL-3.0-only
// Hebrew (he) UI strings — loaded before app.js on /he/ pages.
// Sets window.PDFREE_LOCALE which i18n.js merges over EN defaults.
//
// SCOPED, not exhaustive — same pattern as js/locales/zh-CN.js: this is a
// deliberately small subset covering only the strings the Merge tool's
// interactive flow actually renders (file processing, success/download,
// errors, and merge's own bookmark/blank-page options). he currently has
// exactly one dedicated tool page (/he/mizug-pdf/, no homepage). Every key
// NOT listed here gracefully falls back to English via i18n.js's
// `{ ...EN, ...PDFREE_LOCALE }` merge — intentional, not a gap to "finish"
// without a real signal to justify it.
window.PDFREE_LOCALE = {
  wait_processing:     '⏳ נא להמתין עד לסיום העיבוד',
  done_time:           '⚡ הושלם תוך {time} שניות — עיבוד מקומי, שום דבר לא הועלה',
  done_no_time:        '⚡ העיבוד המקומי הושלם — הקובץ לעולם לא יצא מהמכשיר שלכם',
  saved_device:        '✓ נשמר במכשיר',
  process_again:       '↺ עיבוד מחדש',
  download_again:      '⬇ הורדה מחדש',
  auto_download_hint:  '✓ {filename} נשמר במכשיר שלכם',
  download_toast:      '📥 {filename} הורד',
  single_file_only:    'הכלי הזה מעבד קובץ אחד בכל פעם. נא להסיר את הקובץ הנוכחי תחילה.',
  invalid_pdf:         'נא לבחור קובץ PDF — פתחו את אפליקציית הקבצים, לא את התמונות או המצלמה',
  drop_mobile_hint:    'פתחו את אפליקציית הקבצים ובחרו PDF — לא תמונות או מצלמה',
  not_valid_pdf:       '⚠️ "{name}" אינו קובץ PDF תקין',

  merge_bookmarks_title:    'יצירת סימניות',
  merge_bookmarks_subtitle: 'הוסיפו סימנייה בשם לכל קובץ כדי שתוכלו לנווט במהירות בתוך קובץ ה-PDF הממוזג.',
  merge_blank_pages_title:  'הוספת עמודים ריקים',
  merge_blank_pages_none:   'ללא',
  merge_blank_pages_always: 'תמיד',
  merge_blank_pages_odd:    'כאשר יש מספר עמודים אי-זוגי',
};
