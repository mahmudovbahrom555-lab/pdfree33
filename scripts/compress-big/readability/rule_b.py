#!/usr/bin/env python3
"""Addendum B page rule (calibrated on DEV; frozen in the commit that adds this file).
Features at 300 dpi from the despeckled ink mask: line count, median line height, square-piece share
(CJK-likeness), coloured-ink share.  Returns 'J200' | 'J96' | 'MRC-M300B50'."""
LINES_MIN, PIECES_MIN = 5, 100
CJK_SQUARE = 0.40
SMALL_LINE_PX = 34
COLOR_INK = 0.03


def choose(lines, lh_med, square_share, pieces, color_ink):
    if lines < LINES_MIN or pieces < PIECES_MIN or square_share is None: return 'J200', 'unknown layout'
    if square_share >= CJK_SQUARE: return 'J200', 'CJK'
    if lh_med < SMALL_LINE_PX: return 'J200', 'small print'
    if color_ink >= COLOR_INK: return 'MRC-M300B50', 'coloured ink'
    return 'J96', 'large text'
