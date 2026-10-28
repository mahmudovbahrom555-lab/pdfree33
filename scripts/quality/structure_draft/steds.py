"""STEDS (HRDoc, Ma et al. AAAI 2023): 1 - TreeEditDistance(T, T') / max(|T|, |T'|),
a node matching only when its role and its text are the same (text compared as
compare.key: NFKC, word characters, lower case). APTED (Pawlik & Augsten) via
the `apted` package (MIT).
Tree: headings open sections — a heading's level is its rank among the levels
the document uses (Word's tag levels themselves aren't reliable); paragraphs,
list items, cells and captions are children of the section they fall in."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from apted import APTED, Config
import compare
MAX_NODES = 1500
class Node:
    __slots__ = ('role', 'text', 'kids', 'g')
    def __init__(self, role, text):
        self.role, self.text, self.kids = role, text, []
        self.g = {text[i:i + 3] for i in range(max(1, len(text) - 2))}
class Cfg(Config):
    # strict (HRDoc): same role and same text
    def rename(self, a, b): return 0 if (a.role, a.text) == (b.role, b.text) else 1
    def children(self, n): return n.kids
class Soft(Cfg):
    # ours: same role and texts 90 % alike (3-gram Jaccard) — one space or
    # hyphen more is still the same paragraph; a merged one is not
    def rename(self, a, b):
        if a.role != b.role: return 1
        if a.text == b.text: return 0
        return 0 if len(a.g & b.g) / (len(a.g | b.g) or 1) >= 0.9 else 1
def build(blocks):
    levels = sorted({l for r, l, _ in blocks if r == 'heading'})
    rank = {l: i + 1 for i, l in enumerate(levels)}
    root = Node('doc', ''); stack = [(0, root)]; n = 1
    for r, l, t in blocks:
        k = compare.key(t)
        if not compare.judgeable(k): continue
        node = Node('heading' if r == 'heading' else ('item' if r in ('item', 'lookalike') else r), k); n += 1
        if r == 'heading':
            lv = rank[l]
            while len(stack) > 1 and stack[-1][0] >= lv: stack.pop()
            stack[-1][1].kids.append(node); stack.append((lv, node))
        else:
            stack[-1][1].kids.append(node)
    return root, n
def steds(gt_blocks, out_blocks):
    a, na = build(gt_blocks); b, nb = build(out_blocks)
    if max(na, nb) > MAX_NODES: return None, max(na, nb)
    m = max(na, nb)
    strict = APTED(a, b, Cfg()).compute_edit_distance()
    soft = APTED(a, b, Soft()).compute_edit_distance()
    # an edit distance can pass the larger tree's size: floored at 0
    return {'strict': round(max(0, 1 - strict / m), 4), 'soft': round(max(0, 1 - soft / m), 4)}, m
