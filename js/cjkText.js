// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors

// Chinese and Japanese are written without spaces between words. Where two
// pieces of text meet — OCR words, wrapped lines — and both sides are
// Chinese/Japanese characters or full-width punctuation, they join with no
// space: "为 什么 压缩" in Word was Tesseract's word split, "移除这 些隐藏" a
// line wrap (2026-10-10). Next to Latin a space stays ("的 PDF 看", as
// typeset). Korean separates words with spaces: Hangul is not in the set.
const _CJK_JOIN_RE = /[\u3000-\u30FF\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
export function cjkJoin(a, b) {
  return _CJK_JOIN_RE.test(a.slice(-1)) && _CJK_JOIN_RE.test(b.charAt(0));
}
