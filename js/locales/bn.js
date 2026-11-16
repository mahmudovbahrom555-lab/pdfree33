// SPDX-License-Identifier: AGPL-3.0-only
// Bengali (bn) UI strings — loaded before app.js on /bn/ pages.
// Sets window.PDFREE_LOCALE which i18n.js merges over EN defaults.
//
// SCOPED, not exhaustive — same pattern as js/locales/zh-CN.js: this is a
// deliberately small subset covering only the strings the Merge tool's
// interactive flow actually renders (file processing, success/download,
// errors, and merge's own bookmark/blank-page options). bn currently has
// exactly one dedicated tool page (/bn/ekotrikoron-pdf/, no homepage).
// Every key NOT listed here gracefully falls back to English via
// i18n.js's `{ ...EN, ...PDFREE_LOCALE }` merge — intentional, not a gap
// to "finish" without a real signal to justify it.
window.PDFREE_LOCALE = {
  p2e_mode_hint: "শনাক্ত করা টেবিলগুলো আলাদা Excel শিটে রাখা হয়। অন্য উদ্ধার করা লেখা «Text» শিটে থাকে।",
  p2e_ocr_hint: "পরীক্ষা করা পৃষ্ঠাগুলোতে বের করার মতো লেখা পাওয়া যায়নি। ",
  p2e_skipped_pages: "বের করার মতো লেখা না থাকায় এই পৃষ্ঠাগুলো বাদ গেছে: {pages}।",
  p2e_ocr_scans: "স্ক্যান করা পৃষ্ঠায় OCR চালান",
  p2e_number_format: "দশমিক বিভাজক",
  p2e_number_auto: "স্বয়ংক্রিয়",
  p2e_preview_meta: "{n} সারি · PDF পৃষ্ঠা {pages}",
  wait_processing:     '⏳ প্রক্রিয়াকরণ শেষ হওয়া পর্যন্ত অপেক্ষা করুন',
  done_time:           '⚡ {time} সেকেন্ডে সম্পন্ন হয়েছে — স্থানীয় প্রক্রিয়াকরণ, কিছুই আপলোড করা হয়নি',
  done_no_time:        '⚡ স্থানীয় প্রক্রিয়াকরণ সম্পন্ন হয়েছে — ফাইল কখনও আপনার ডিভাইস ছেড়ে যায়নি',
  saved_device:        '✓ ডিভাইসে সংরক্ষিত হয়েছে',
  process_again:       '↺ আবার প্রক্রিয়া করুন',
  download_again:      '⬇ আবার ডাউনলোড করুন',
  auto_download_hint:  '⬇ {filename} ডাউনলোড শুরু হয়েছে',
  download_toast:      '📥 {filename} ডাউনলোড হচ্ছে…',
  single_file_only:    'এই টুলটি একবারে শুধুমাত্র একটি ফাইল প্রক্রিয়া করে। অনুগ্রহ করে প্রথমে বর্তমান ফাইলটি সরিয়ে ফেলুন।',
  invalid_pdf:         'অনুগ্রহ করে একটি PDF ফাইল নির্বাচন করুন — আপনার ফাইলস অ্যাপ খুলুন, ছবি বা ক্যামেরা নয়',
  drop_mobile_hint:    'আপনার ফাইলস অ্যাপ খুলুন এবং একটি PDF নির্বাচন করুন — ছবি বা ক্যামেরা নয়',
  not_valid_pdf:       '⚠️ "{name}" একটি বৈধ PDF ফাইল নয়',

  merge_bookmarks_title:    'বুকমার্ক তৈরি করুন',
  merge_bookmarks_subtitle: 'প্রতিটি ফাইলের জন্য একটি নামযুক্ত বুকমার্ক যোগ করুন যাতে আপনি একত্রিত PDF-এর মধ্যে দ্রুত নেভিগেট করতে পারেন।',
  merge_blank_pages_title:  'খালি পৃষ্ঠা যোগ করুন',
  merge_blank_pages_none:   'কোনোটিই না',
  merge_blank_pages_always: 'সবসময়',
  merge_blank_pages_odd:    'যখন পৃষ্ঠার সংখ্যা বিজোড়',
};
