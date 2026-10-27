#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Deliberately broken copies of PDF->Word outputs: does a metric catch them?

A metric is trusted only when it passes a correct build AND flags prepared
defects (owner, 2026-10-25). This makes the defects: one kind per copy, in a
paragraph with enough Chinese/Japanese text to be measured, seeded so a run
can be repeated.

  python3 scripts/quality/break_docx.py <files_dir> <out_dir> [--seed N] [--latin]
      writes <out_dir>/<kind>/<doc>.pdf2word.docx and <out_dir>/kinds.json
      (per kind: the documents broken and how)

Kinds (Han text; with --latin, a paragraph needs 20 Latin-script words and
`spaces` spaces one word's letters, and two more kinds exist — glue: two
words joined, split: one long word cut in two):
  spaces    spaces put between the Han characters of one paragraph
  drop      one paragraph removed
  radicals  up to three characters replaced by the Kangxi radical they look like
  digits    one digit run (>= 2 digits) removed
  swap      one paragraph from the second half moved to the start
  dup       one paragraph written twice
A document with no paragraph fit for a kind is left out of that kind, never
broken some other way — nor one where the change would leave the text as it
was (spaces inside runs that hold one character each).
"""
import json, os, random, re, sys, zipfile

HAN = re.compile(r'[㐀-䶿一-鿿豈-﫿]')
PARA = re.compile(r'<w:p[ >].*?</w:p>', re.S)
TEXT = re.compile(r'(<w:t(?: [^>]*)?>)([^<]*)(</w:t>)')
RADICAL = {'一': '⼀', '人': '⼈', '口': '⼝', '日': '⽇', '月': '⽉', '大': '⼤', '山': '⼭', '水': '⽔', '心': '⼼',
           '女': '⼥', '子': '⼦', '土': '⼟', '工': '⼯', '目': '⽬', '生': '⽣', '力': '⼒', '文': '⽂', '方': '⽅', '长': '⻓'}
LATIN_WORD = re.compile(r'[A-Za-zÀ-ɏ]+')
MIN_HAN = 20
KINDS = ('spaces', 'drop', 'radicals', 'digits', 'swap', 'dup')
LATIN_KINDS = ('spaces', 'drop', 'digits', 'swap', 'dup', 'glue', 'split')


def text_of(p):
    return ''.join(m.group(2) for m in TEXT.finditer(p))


def in_text(p, fn):
    """p with fn applied to each run's text."""
    return TEXT.sub(lambda m: m.group(1) + fn(m.group(2)) + m.group(3), p)


def once(p, pattern, fn):
    """p with the first match of pattern inside one run replaced by fn(match),
    or None when no run holds one."""
    done = [False]

    def sub(t):
        if done[0]:
            return t
        m = re.search(pattern, t)
        if not m:
            return t
        done[0] = True
        return t[:m.start()] + fn(m.group(0)) + t[m.end():]
    new = in_text(p, sub)
    return new if done[0] else None


def break_one(xml, kind, rnd, latin=False):
    paras = PARA.findall(xml)
    size = (lambda t: len(LATIN_WORD.findall(t))) if latin else (lambda t: len(HAN.findall(t)))
    fit = [i for i, p in enumerate(paras) if size(text_of(p)) >= MIN_HAN]
    if kind == 'digits':
        fit = [i for i, p in enumerate(paras) if re.search(r'[0-9]{2,}', text_of(p)) and size(text_of(p)) >= 5]
    if kind == 'radicals':
        fit = [i for i in fit if any(c in RADICAL for c in text_of(paras[i]))]
    if kind == 'swap':
        fit = [i for i in fit if i > len(paras) // 2]
    if not fit:
        return None, None
    i = rnd.choice(fit)
    p = paras[i]
    if latin and kind in ('spaces', 'glue', 'split'):
        if kind == 'spaces':
            new = once(p, r'\b[A-Za-z]{5,}\b', lambda w: ' '.join(w))
        elif kind == 'glue':
            new = once(p, r'\b[A-Za-z]{3,} [A-Za-z]{3,}\b', lambda w: w.replace(' ', ''))
        else:
            new = once(p, r'\b[A-Za-z]{8,}\b', lambda w: w[:len(w) // 2] + ' ' + w[len(w) // 2:])
        if new is None:
            return None, None
        how = f'paragraph {i}: {kind}'
    elif kind == 'spaces':
        new = in_text(p, lambda t: re.sub(r'(?<=%s)(?=%s)' % (HAN.pattern, HAN.pattern), ' ', t))
        how = f'paragraph {i}: {len(HAN.findall(text_of(p)))} Han spaced'
    elif kind == 'drop':
        new = ''
        how = f'paragraph {i} removed ({size(text_of(p))} {"words" if latin else "Han"})'
    elif kind == 'radicals':
        left = [3]

        def swap(t):
            out = []
            for c in t:
                if left[0] and c in RADICAL:
                    out.append(RADICAL[c])
                    left[0] -= 1
                else:
                    out.append(c)
            return ''.join(out)
        new = in_text(p, swap)
        how = f'paragraph {i}: {3 - left[0]} radicals'
    elif kind == 'digits':
        done = [None]

        def cut(t):
            if done[0] is None:
                m = re.search(r'[0-9]{2,}', t)
                if m:
                    done[0] = m.group(0)
                    return t[:m.start()] + t[m.end():]
            return t
        new = in_text(p, cut)
        if done[0] is None:   # the digits span two runs: not this paragraph
            return None, None
        how = f'paragraph {i}: number {done[0]} removed'
    elif kind == 'swap':
        body = xml.index('<w:body>') + len('<w:body>')
        start = xml.index(p)
        out = xml[:start] + xml[start + len(p):]
        return out[:body] + p + out[body:], f'paragraph {i} of {len(paras)} moved to the start'
    elif kind == 'dup':
        new = p + p
        how = f'paragraph {i} written twice ({size(text_of(p))} {"words" if latin else "Han"})'
    if kind in ('spaces', 'radicals') and text_of(new) == text_of(p):
        # nothing changed: one character per run leaves no gap inside a run
        # to space — a copy that isn't broken must not count as a miss
        return None, None
    start = xml.index(p)
    return xml[:start] + new + xml[start + len(p):], how


def main(files, out, seed=20261027, latin=False):
    kinds = {k: {} for k in (LATIN_KINDS if latin else KINDS)}
    for name in sorted(os.listdir(files)):
        if not name.endswith('.pdf2word.docx'):
            continue
        doc = name[:-len('.pdf2word.docx')]
        src = os.path.join(files, name)
        try:
            z = zipfile.ZipFile(src)
            xml = z.read('word/document.xml').decode('utf8')
        except Exception:
            continue
        for kind in kinds:
            rnd = random.Random(f'{seed}:{doc}:{kind}')
            broken, how = break_one(xml, kind, rnd, latin)
            if broken is None:
                continue
            os.makedirs(os.path.join(out, kind), exist_ok=True)
            with zipfile.ZipFile(os.path.join(out, kind, name), 'w', zipfile.ZIP_DEFLATED) as w:
                for item in z.infolist():
                    # by name, not the ZipInfo: writestr(info) rewrites the
                    # source entry's header offset, and the next read of the
                    # source then lands in the wrong place
                    data = broken.encode('utf8') if item.filename == 'word/document.xml' else z.read(item.filename)
                    w.writestr(item.filename, data)
            kinds[kind][doc] = how
    json.dump({'seed': seed, 'kinds': kinds}, open(os.path.join(out, 'kinds.json'), 'w'), ensure_ascii=False, indent=1)
    print(', '.join(f'{k} {len(v)}' for k, v in kinds.items()))


if __name__ == '__main__':
    a = sys.argv[1:]
    seed = 20261027
    if '--seed' in a:
        i = a.index('--seed')
        seed = int(a[i + 1])
        del a[i:i + 2]
    latin = '--latin' in a
    a = [x for x in a if x != '--latin']
    main(a[0], a[1], seed, latin)
