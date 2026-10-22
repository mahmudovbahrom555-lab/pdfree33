# SPDX-License-Identifier: AGPL-3.0-only
"""Words as the page's glyphs spell them, where both readers turn a glyph's
letters around (metric v6).

Class C11 (tests/corpus/ERROR_CLASSES.md): Word draws a right-to-left line
glyph by glyph in visual order and names a ligature glyph by its letters in
reading order — "ير", "لا", Urdu "سے". MuPDF and poppler turn the line around
letter by letter, the glyph's letters with it, and agree on "سرية" for
"سيرة", "اإلسالمية" for "الإسلامية": a converter that keeps the glyphs'
letters scored as having lost the word. This reads the glyphs on its own,
from MuPDF's text trace, without PDFree's code:

1. a span drawn left to right (its glyphs' x rising, on 3 of 4 steps at
   least: Nastaleeq stacks letters back) that holds Arabic-script
   letters is in visual order; a glyph's letters are its first character and
   the characters after it the trace marks as no glyph of their own (glyph
   id -1);
2. the span read right to left by glyph — each glyph's letters kept — against
   the same span read right to left by letter, as the readers read it; a word
   whose two readings differ is a correction (read → spelled), as many times
   as the page draws it.

Spans drawn right to left (logical order) are read glyph after glyph by the
readers already and give none. A word cut across two spans is not corrected.

corrections(pdf, words) → Counter((as read, as spelled)) — words as the
metric tokenizes them (arabic.ar_words), for arabic.redrawn to correct both
readers' words with.
"""
import collections
import fitz

ARABIC = range(0x0600, 0x0700)


def _glyphs(chars):
    """A span's characters grouped into glyphs: a character with glyph id -1
    belongs to the glyph before it."""
    out = []
    for c in chars:
        if c[0] <= 0:
            continue
        if c[1] == -1 and out:
            out[-1][0] += chr(c[0])
        else:
            out.append([chr(c[0]), c[2][0]])
    return out


def _visual(glyphs):
    """Drawn left to right: x rises along the span — on 3 of 4 of its steps
    at least, as Nastaleeq stacks a word's letters back over each other
    ("ی" at 402.2, then "ٹ" at 393.2) — and ends right of where it starts."""
    xs = [g[1] for g in glyphs]
    steps = [b - a for a, b in zip(xs, xs[1:]) if abs(b - a) > 0.01]
    return len(xs) >= 2 and xs[-1] > xs[0] and bool(steps) and sum(d > 0 for d in steps) >= 0.75 * len(steps)


def corrections(pdf, words, max_pages=None):
    doc = fitz.open(pdf)
    out = collections.Counter()
    pages = range(doc.page_count if max_pages is None else min(max_pages, doc.page_count))
    for p in pages:
        for sp in doc[p].get_texttrace():
            g = _glyphs(sp['chars'])
            if not any(len(t) > 1 for t, _ in g) or not any(ord(c) in ARABIC for t, _ in g for c in t):
                continue
            if not _visual(g):
                continue
            by_letter = ''.join(t for t, _ in g)[::-1]
            by_glyph = ''.join(t for t, _ in reversed(g))
            if by_letter == by_glyph:
                continue
            a, b = words(by_letter), words(by_glyph)
            if len(a) == len(b):
                out.update((x, y) for x, y in zip(a, b) if x != y)
    return out
