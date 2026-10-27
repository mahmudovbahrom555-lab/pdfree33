#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""English (Latin-script) PDF->Word quality, per pain (metric v1, 2026-10-27).

  python3 scripts/quality/latin.py <docs_dir> <files_dir> <out.jsonl> [--results <robust results.jsonl>]
  python3 scripts/quality/latin.py --merge <out.jsonl> <shard.jsonl>...
  python3 scripts/quality/latin.py --summary <out.jsonl> [--private]
  python3 scripts/quality/latin.py --compare <base.jsonl> <new.jsonl> [--fail-on-worse] [--private] [--exact]

The reference is the PDF's own text as two independent readers give it, MuPDF
and poppler (pdftotext): a word, word pair or number is scored only where BOTH
read it. Agreement is a stronger signal, not truth. Words are NFKC, letters
only (Latin script, digits apart), case kept; a hyphen between two letters
(-, or U+2010/U+2011 as Chromium prints it) is dropped in the readers' text
AND the .docx alike, so a word hyphenated at a line end ("conver-\\nsion")
and the joined word score the same, and "well-known" is "wellknown"
everywhere.

Per document:
  recall     words both readers agree on, found in the .docx (multiset)
  pairs      adjacent word pairs both readers agree on, found in the .docx —
             catches lines read across columns, words moved
  extra      words in the .docx beyond what either reader has (duplicates)
  glued      .docx words that are two words both readers show side by side,
             and neither reads as one
  split      two adjacent .docx words that together are a missing agreed word
  spaced     letters in runs of 3+ one-letter .docx "words" ("T H E") beyond
             what EITHER reader has: a title letter-spaced in the source is
             read spaced by one reader and joined by the other, so the larger
             count is the source's (found on the English dev set, 2026-10-27:
             against the smaller one, 16,021 letters on 58 documents were the
             sources' own spacing)
  numbers    digit runs (>= 2 digits) both readers agree on, found in the .docx
  order      as in chinese.py: share of anchors (word 4-grams unique in both
             readers and the .docx, in the order both agree on) kept in order
  readersSuspect  agreed words under 30 % of the larger reader's — the readers
             disagree too much for either to be the reference; reported, never
             judged

Not seen (known limits): Word headers and footers (document.xml only), tables
and headings as structure, fonts, scans (no text layer). Changing what this
file measures is a new METRIC_VERSION.
"""
import collections, os, re, sys, unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chinese  # noqa: E402
from arabic import docx_text  # noqa: E402

METRIC_VERSION = 1
SCHEMA = 1
SHORT = 50
WORD = re.compile(r'[A-Za-zÀ-ɏḀ-ỿ]+')
RULES = {'tolerance': (('recall', 0.005), ('pairs', 0.005), ('order', 0.03), ('numbers', 0.005)),
         'counts': ('extra', 'glued', 'split', 'spaced'), 'size': 'words',
         'relative': ('extra', 'glued', 'split', 'spaced')}


def norm(t):
    t = unicodedata.normalize('NFKC', t).replace('­', '')
    return re.sub(r'(?<=[A-Za-zÀ-ɏḀ-ỿ])[-\u2010\u2011]\s*(?=[A-Za-zÀ-ɏḀ-ỿ])', '', t)


def words(t):
    return WORD.findall(norm(t))


def score(pdf, docx):
    mu, pp, pages, producer = chinese.readers(pdf)
    M, P = words(mu), words(pp)
    cM, cP = collections.Counter(M), collections.Counter(P)
    T = cM & cP
    n = sum(T.values())
    row = {'pages': pages, 'producer': producer[:60], 'words': n, 'agree': round(n / (max(len(M), len(P)) or 1), 3)}
    if n == 0:
        return {**row, 'skip': 'no Latin-script text both readers agree on'}
    if row['agree'] < 0.3:
        row['readersSuspect'] = row['agree']
    out = docx_text(docx)
    O = words(out)
    cO = collections.Counter(O)
    missing = T - cO
    pM, pP, pO = (collections.Counter(a + ' ' + b for a, b in zip(x, x[1:])) for x in (M, P, O))
    pT = pM & pP
    seen = set(M) | set(P)
    joined_m = collections.Counter(a + b for a, b in zip(M, M[1:]))
    joined_p = collections.Counter(a + b for a, b in zip(P, P[1:]))
    glued = sum(min(c, joined_m[w], joined_p[w]) for w, c in cO.items() if w not in seen)
    split = sum(1 for a, b in zip(O, O[1:]) if missing[a + b] > 0)
    single = lambda t: sum(len(m) for m in re.findall(r'(?:\b[A-Za-z]\b ){2,}\b[A-Za-z]\b', norm(t)))
    nm, np_ = collections.Counter(chinese.numbers(mu)), collections.Counter(chinese.numbers(pp))
    nt = nm & np_
    no = collections.Counter(chinese.numbers(out))
    return {**row, 'short': n < SHORT,
            'recall': round(sum((T & cO).values()) / n, 4),
            'missing': sum(missing.values()),
            'pairs': round(sum((pT & pO).values()) / sum(pT.values()), 4) if pT else None,
            'extra': sum((cO - (cM | cP)).values()),
            'glued': glued, 'split': split,
            'spaced': max(0, single(out) - max(single(mu), single(pp))),
            'numbers': round(sum((nt & no).values()) / sum(nt.values()), 4) if nt else None,
            'numbersMissing': sum((nt - no).values()), 'numbersAgreed': sum(nt.values()),
            **order_of(M, P, O)}


def order_of(M, P, O):
    # chinese.order_of takes 4-grams over runs of characters; here the one
    # run is the word list, so a gram is four words
    return chinese.order_of([tuple(M)], [tuple(P)], [tuple(O)])


def summary(path, private=False):
    head, docs = chinese.load(path)
    rows = list(docs.values())
    ok = chinese.judged(rows)
    sus = [r for r in rows if r.get('recall') is not None and r.get('readersSuspect')]
    skips = collections.Counter(r['skip'].split(' (')[0].split(':')[0] for r in rows if 'skip' in r)
    lines = [f"metric v{head.get('metric')} (schema {head.get('schema')}), readers {head.get('oracle')}, "
             f"corpus {head.get('corpus')} — {len(rows)} docs, judged {len(ok)}",
             f"readers disagree, not judged: {len(sus)}" + ('' if private or not sus else ' — ' + ', '.join(r['doc'] for r in sus)),
             'not scored: ' + (', '.join(f'{k} {v}' for k, v in sorted(skips.items())) or 'none')]
    if ok:
        def w(k):
            S = [r for r in ok if r.get(k) is not None]
            return 100 * sum(r[k] * r['words'] for r in S) / (sum(r['words'] for r in S) or 1)
        od = [r for r in ok if r.get('order') is not None]
        lines.append(f"**{len(ok)} docs** — words agreed {sum(r['words'] for r in ok)}, recall {w('recall'):.2f} %, pairs {w('pairs'):.2f} %, "
                     f"extra {sum(r['extra'] for r in ok)}, glued {sum(r['glued'] for r in ok)}, split {sum(r['split'] for r in ok)}, "
                     f"spaced {sum(r['spaced'] for r in ok)}, numbers missing {sum(r['numbersMissing'] for r in ok)} of {sum(r['numbersAgreed'] for r in ok)}, "
                     f"order {100 * sum(r['order'] * r['anchors'] for r in od) / max(1, sum(r['anchors'] for r in od)):.2f} % on {len(od)} docs")
        if not private:
            for k in ('recall', 'pairs', 'order'):
                worst = sorted((r for r in ok if r.get(k) is not None), key=lambda r: r[k])[:8]
                lines.append(f'  worst {k}: ' + ', '.join(f"{r['doc']} {r[k]:.2f}" for r in worst))
    return '\n'.join(lines)


def compare(base_path, new_path, private=False, exact_mode=False):
    return chinese.compare(base_path, new_path, private, rules=RULES, title='English', summarize=summary, exact_mode=exact_mode)


if __name__ == '__main__':
    a = sys.argv[1:]
    private = '--private' in a
    a = [x for x in a if x != '--private']
    if a[0] == '--merge':
        chinese.merge(a[1], a[2:])
    elif a[0] == '--summary':
        print(summary(a[1], private))
    elif a[0] == '--compare':
        text, failures = compare(a[1], a[2], private, exact_mode='--exact' in a)
        print(text)
        sys.exit(1 if failures and '--fail-on-worse' in a else 0)
    else:
        res = None
        if '--results' in a:
            i = a.index('--results')
            res = a[i + 1]
            del a[i:i + 2]
        chinese.run(a[0], a[1], a[2], res, score=score, metric=METRIC_VERSION, schema=SCHEMA, measure='latin')
