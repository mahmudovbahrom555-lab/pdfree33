#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Chinese and Japanese PDF->Word quality, per pain (metric v1, 2026-10-27).

  python3 scripts/quality/chinese.py <docs_dir> <files_dir> <out.jsonl>
      (files_dir holds <doc>.pdf2word.docx, as robust.mjs --save writes them)
      [--results <robust results.jsonl>]
  python3 scripts/quality/chinese.py --merge <out.jsonl> <shard.jsonl>...
  python3 scripts/quality/chinese.py --summary <out.jsonl> [--private]
  python3 scripts/quality/chinese.py --compare <base.jsonl> <new.jsonl> [--fail-on-worse] [--private] [--exact]

--private prints totals only — no document names, no per-document lines: what
a closed holdout's report may show. --exact drops every tolerance (see exact()).

The reference is the PDF's own text as two independent readers give it, MuPDF
and poppler (pdftotext): a Han character, bigram or number is scored only
where BOTH read it. Agreement is a stronger signal, not truth: where both read
a document the same wrong way it proves nothing. The readers' text is
normalised the way Unicode says glyph-identical code points are one character
(NFKC + EquivalentUnifiedIdeograph.txt, Unicode 17.0.0, next to this file —
Kangxi radicals and the CJK Radicals Supplement stand in for ideographs in
some fonts' ToUnicode); the .docx is NOT normalised, so a radical left in it
counts as missing.

Per document:
  recall     Han characters both readers agree on, found in the .docx (multiset)
  bigrams    Han bigrams both readers agree on, found in the .docx — catches
             spaces inside text, characters out of order, lines interleaved
  extra      Han characters in the .docx beyond what either reader has: a
             duplicated line, a wrong glyph (v0 subtracted both readers in turn,
             so a duplicate of text they have counted 0 — found by this file's
             control case, fixed in v1)
  radicals   Kangxi/radical code points left in the .docx (search and copy break)
  pua        private-use code points left in the .docx
  hanSpaces  spaces between two Han characters in the .docx; readerHanSpaces
             the fewer of the readers' own (they put line breaks there too, so
             this is a count to watch, not an error count: Japanese family and
             given names, separate fields, name lists are spaced in the source)
  numbers    digit runs (>= 2 digits) both readers agree on, found in the .docx
  order      share of anchors (Han 4-grams unique in both readers and the
             .docx, in the order both readers agree on) the .docx keeps in
             that order (longest increasing run) — columns read across each
             other, paragraphs moved; fewer than MIN_ANCHORS agreed anchors:
             no score, `orderUnverifiable`
  brokenParas  share of the .docx's Chinese paragraphs that end mid-sentence
             and are followed by one starting with Han — a proxy for lines
             left as paragraphs; no reader gives the truth, so it is reported,
             never judged
  lang       'ja' when kana are more than 5 % of the agreed Han + kana, else 'zh'
  readersSuspect  share of letters the readers give that are not Han, kana,
             Hangul or Latin (> 20 %: they read glyph codes, not text) — such
             a document is reported, never judged

Validated (draft v0 = this logic, 2026-10-23, 128 zh/ja documents of
sample-v1): an identical build twice → 0 worse, 0 better; deliberately broken
copies of the outputs caught: spaces 21/22, dropped paragraphs 24/24, radicals
18/20, digits 16/19, a swapped paragraph 9/13 where order is measurable (small
moves stay under the 3 % tolerance). Re-validated for v1 in the pull request
that adds this file.

What it does not see (known limits, not bugs to fix quietly):
  - Word headers and footers: docx_text reads word/document.xml only — text a
    converter moves into the header part scores as missing.
  - Tables, headings, lists, paragraph boundaries as structure: text only.
  - Fonts and language tags (w:eastAsia, w:lang): appearance, not content.
  - Scans: no text layer, no reference — OCR is not measured here.
  - Vertical text: the readers' orders differ; order is often unverifiable.
Changing what this file measures is a new METRIC_VERSION: results of two
versions are not compared.
"""
import collections, json, os, re, subprocess, sys, unicodedata

import fitz

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from arabic import _longest_run, corpus_hash, docx_text, file_sha, load, night_summary, robust_results, versions  # noqa: E402

METRIC_VERSION = 1
SCHEMA = 1
MIN_ANCHORS = 20
SHORT = 200
HAN = re.compile(r'[㐀-䶿一-鿿豈-﫿\U00020000-\U0003134F]')
KANA = re.compile(r'[぀-ヿㇰ-ㇿｦ-ﾟ]')
HANGUL = re.compile(r'[가-힯ᄀ-ᇿ㄰-㆏]')
LATIN = re.compile(r'[A-Za-zÀ-ɏ]')
RADICAL = re.compile(r'[⺀-⻿⼀-⿟]')
PUA = re.compile(r'[-\U000F0000-\U0010FFFD]')
SENT_END = set('。！？；：…」』）》】”’.!?;:)')
HAN_SPACE = re.compile(r'(?<=%s) +(?=%s)' % (HAN.pattern, HAN.pattern))
# a change beyond these is "worse" (or "better"); shares, then counts
TOLERANCE = (('recall', 0.005), ('bigrams', 0.005), ('order', 0.03), ('numbers', 0.005))
COUNTS = ('radicals', 'pua', 'hanSpaces', 'extra')

EQ = {}
for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'EquivalentUnifiedIdeograph.txt'), encoding='utf8'):
    line = line.split('#')[0].strip()
    if not line:
        continue
    cps, target = [x.strip() for x in line.split(';')]
    a, _, b = cps.partition('..')
    for cp in range(int(a, 16), int(b or a, 16) + 1):
        EQ[chr(cp)] = chr(int(target, 16))


def norm_reader(t):
    return ''.join(EQ.get(c, c) for c in unicodedata.normalize('NFKC', t))


def han_stream(t):
    """Han runs: anything else (space, line break, Latin, punctuation) separates."""
    return re.findall(r'(?:%s)+' % HAN.pattern, t)


def chars(runs):
    return [c for r in runs for c in r]


def grams(runs, n):
    return [r[i:i + n] for r in runs for i in range(len(r) - n + 1)]


def numbers(t):
    return [n for n in re.findall(r'[0-9]+', unicodedata.normalize('NFKC', t)) if len(n) >= 2]


def readers(pdf):
    doc = fitz.open(pdf)
    mu = '\n'.join(p.get_text() for p in doc)
    pp = subprocess.run(['pdftotext', '-enc', 'UTF-8', pdf, '-'], capture_output=True, text=True, timeout=300).stdout
    return mu, pp, doc.page_count, (doc.metadata or {}).get('producer') or ''


def order_of(M, P, O):
    cm, cp, co = (collections.Counter(grams(x, 4)) for x in (M, P, O))
    anchors = [g for g in grams(P, 4) if cp[g] == 1 and cm[g] == 1 and co[g] == 1]
    if not anchors:
        return {'order': None, 'anchors': 0}
    in_m = {g: i for i, g in enumerate(grams(M, 4)) if cm[g] == 1}
    agreed = [anchors[i] for i in _longest_run([in_m[g] for g in anchors])]
    row = {'anchors': len(agreed), 'readersAgree': round(len(agreed) / len(anchors), 4)}
    if len(agreed) < MIN_ANCHORS:
        return {'order': None, **row, **({'orderUnverifiable': True} if len(anchors) >= MIN_ANCHORS else {})}
    pos = {g: i for i, g in enumerate(grams(O, 4)) if co[g] == 1}
    return {'order': round(len(_longest_run([pos[g] for g in agreed])) / len(agreed), 4), **row}


def broken_paras(out):
    paras = [p.strip() for p in out.split('\n') if p.strip()]
    zh = [i for i, p in enumerate(paras) if len(HAN.findall(p)) >= 5]
    if len(zh) < 5:
        return None
    broken = sum(1 for i in zh if i + 1 < len(paras) and paras[i][-1] not in SENT_END
                 and HAN.match(paras[i][-1]) and HAN.match(paras[i + 1][0]))
    return round(broken / len(zh), 4)


def score(pdf, docx):
    mu, pp, pages, producer = readers(pdf)
    M, P = han_stream(norm_reader(mu)), han_stream(norm_reader(pp))
    cM, cP = collections.Counter(chars(M)), collections.Counter(chars(P))
    T = cM & cP
    n = sum(T.values())
    row = {'pages': pages, 'producer': producer[:60], 'han': n,
           'agree': round(n / (max(sum(cM.values()), sum(cP.values())) or 1), 3)}
    letters = [ch for ch in norm_reader(mu + pp) if ch.isalpha()]
    junk = sum(1 for ch in letters if not (HAN.match(ch) or KANA.match(ch) or HANGUL.match(ch) or LATIN.match(ch)))
    kana = sum(1 for ch in letters if KANA.match(ch))
    row['lang'] = 'ja' if kana > 0.05 * ((kana + n) or 1) else 'zh'
    if letters and junk > 0.2 * len(letters):
        row['readersSuspect'] = round(junk / len(letters), 3)
    if n == 0:
        return {**row, 'skip': 'no Chinese text both readers agree on'}
    out = docx_text(docx)
    O = han_stream(out)
    cO = collections.Counter(chars(O))
    bM, bP, bO = (collections.Counter(grams(x, 2)) for x in (M, P, O))
    bT = bM & bP
    nm, np_ = collections.Counter(numbers(mu)), collections.Counter(numbers(pp))
    nt = nm & np_
    no = collections.Counter(numbers(out))
    return {**row, 'short': n < SHORT,
            'recall': round(sum((T & cO).values()) / n, 4),
            'missing': sum((T - cO).values()),
            'bigrams': round(sum((bT & bO).values()) / sum(bT.values()), 4) if bT else None,
            'extra': sum((cO - (cM | cP)).values()),
            'radicals': len(RADICAL.findall(out)), 'pua': len(PUA.findall(out)),
            'hanSpaces': len(HAN_SPACE.findall(out)),
            'readerHanSpaces': min(len(HAN_SPACE.findall(x)) for x in (mu, pp)),
            'numbers': round(sum((nt & no).values()) / sum(nt.values()), 4) if nt else None,
            'numbersMissing': sum((nt - no).values()), 'numbersAgreed': sum(nt.values()),
            'brokenParas': broken_paras(out),
            **order_of(M, P, O)}


def run(docs, files, out_path, results=None, score=score, metric=METRIC_VERSION, schema=SCHEMA, measure='chinese'):
    runs = robust_results(results) if results else {}
    names = sorted(n for n in os.listdir(docs) if n.lower().endswith('.pdf'))
    rows = [{'doc': name, 'sha': file_sha(os.path.join(docs, name))} for name in names]
    for row in rows:
        name = row['doc']
        r = runs.get(name)
        if r:
            row.update({'outcome': r.get('outcome'), 'ms': r.get('ms')})
            if r.get('ocrPages') is not None:
                row['ocrPages'] = r['ocrPages']
        docx = os.path.join(files, name + '.pdf2word.docx')
        if not os.path.exists(docx):
            row['skip'] = r['outcome'] if r and r.get('outcome') != 'ok' else 'no output'
        else:
            try:
                row.update(score(os.path.join(docs, name), docx))
            except Exception as e:  # one unreadable file must not end the run
                row['skip'] = f'error: {str(e)[:120]}'
    with open(out_path, 'w') as out:
        out.write(json.dumps({'measure': measure, 'schema': schema, 'metric': metric, 'oracle': versions(), 'corpus': corpus_hash(rows),
                              'docs': len(rows), **night_summary(rows)}, ensure_ascii=False) + '\n')
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + '\n')


def merge(out_path, paths):
    """Shards of one run → one result (arabic.py's merge, plus `measure`):
    every shard scored by the same metric, version and readers; the corpus
    hash recomputed over all rows."""
    heads, rows = [], {}
    for p in paths:
        head, part = load(p)
        heads.append(head)
        for d in part:
            if d in rows:
                raise SystemExit(f'{d} is in two shards')
        rows.update(part)
    keys = ('measure', 'schema', 'metric', 'oracle')
    if not heads or any(tuple(h.get(k) for k in keys) != tuple(heads[0].get(k) for k in keys) for h in heads):
        raise SystemExit('shards scored by different metrics, versions or readers')
    with open(out_path, 'w') as out:
        out.write(json.dumps({**{k: heads[0].get(k) for k in keys}, 'corpus': corpus_hash(rows.values()),
                              'docs': len(rows), 'shards': len(paths), **night_summary(rows.values())}, ensure_ascii=False) + '\n')
        for d in sorted(rows):
            out.write(json.dumps(rows[d], ensure_ascii=False) + '\n')


def judged(rows):
    """Scored documents the readers can be trusted on."""
    return [r for r in rows if r.get('recall') is not None and not r.get('readersSuspect')]


def summary(path, private=False):
    head, docs = load(path)
    rows = list(docs.values())
    ok = judged(rows)
    lines = [f"metric v{head.get('metric')} (schema {head.get('schema')}), readers {head.get('oracle')}, "
             f"corpus {head.get('corpus')} — {len(rows)} docs, judged {len(ok)}"]
    sus = [r for r in rows if r.get('recall') is not None and r.get('readersSuspect')]
    skips = collections.Counter(r['skip'].split(' (')[0].split(':')[0] for r in rows if 'skip' in r)
    lines.append(f"readers read junk, not judged: {len(sus)}" + ('' if private or not sus else ' — ' + ', '.join(r['doc'] for r in sus)))
    lines.append('not scored: ' + (', '.join(f'{k} {v}' for k, v in sorted(skips.items())) or 'none'))
    for lang in ('zh', 'ja'):
        L = [r for r in ok if r.get('lang') == lang]
        if not L:
            continue
        han = sum(r['han'] for r in L)

        def w(k):
            S = [r for r in L if r.get(k) is not None]
            return 100 * sum(r[k] * r['han'] for r in S) / (sum(r['han'] for r in S) or 1)
        od = [r for r in L if r.get('order') is not None]
        lines.append(f"**{lang}: {len(L)} docs** — Han agreed {han}, recall {w('recall'):.2f} %, bigrams {w('bigrams'):.2f} %, "
                     f"extra {sum(r['extra'] for r in L)}, radicals {sum(r['radicals'] for r in L)} in {sum(1 for r in L if r['radicals'])} docs, "
                     f"pua {sum(r['pua'] for r in L)}, Han spaces {sum(r['hanSpaces'] for r in L)} (readers {sum(r['readerHanSpaces'] for r in L)}), "
                     f"numbers missing {sum(r['numbersMissing'] for r in L)} of {sum(r['numbersAgreed'] for r in L)}, "
                     f"order {100 * sum(r['order'] * r['anchors'] for r in od) / max(1, sum(r['anchors'] for r in od)):.2f} % on {len(od)} docs "
                     f"({sum(1 for r in L if r.get('orderUnverifiable'))} unverifiable)")
        if not private:
            for k in ('recall', 'bigrams', 'order'):
                worst = sorted((r for r in L if r.get(k) is not None), key=lambda r: r[k])[:8]
                lines.append(f'  worst {k}: ' + ', '.join(f"{r['doc']} {r[k]:.2f}" for r in worst))
    return '\n'.join(lines)


def changes(x, y, tolerance=TOLERANCE, counts=COUNTS, size='han', relative=('extra', 'hanSpaces')):
    """What got worse and what got better from result x to result y of one
    document: a share beyond its tolerance; a count beyond 0 (or, for the
    `relative` counts, beyond 2 or 1 % of the document's size)."""
    why, good = [], []
    for k, tol in tolerance:
        if x.get(k) is not None and y.get(k) is not None:
            if y[k] < x[k] - tol:
                why.append(f'{k} {x[k]:.3f}→{y[k]:.3f}')
            elif y[k] > x[k] + tol:
                good.append(f'{k} {x[k]:.3f}→{y[k]:.3f}')
    for k in counts:
        lim = max(2, 0.01 * x[size]) if k in relative else 0
        if y[k] > x[k] + lim:
            why.append(f'{k} {x[k]}→{y[k]}')
        elif y[k] < x[k] - lim:
            good.append(f'{k} {x[k]}→{y[k]}')
    return why, good


def exact(rules):
    """The same rules with no tolerance: any lower share, any higher count.
    Only for two builds run on the same documents on the same machine in one
    run (the holdout) — conversions are deterministic there (two runs of one
    build: 0 differences on 128 Chinese/Japanese and 60 English documents,
    2026-10-27); across nights and machines the tolerances stay."""
    return {**rules, 'tolerance': tuple((k, 0) for k, _ in rules['tolerance']), 'relative': ()}


RULES = {'tolerance': TOLERANCE, 'counts': COUNTS, 'size': 'han', 'relative': ('extra', 'hanSpaces')}


def compare(base_path, new_path, private=False, rules=None, title='Chinese/Japanese', summarize=None, exact_mode=False):
    """(report, failures): worse, mixed (worse on one pain, better on another —
    a human looks, owner rule) and documents no longer scored all count as
    failures; better ones never make up for them."""
    hb, B = load(base_path)
    hn, N = load(new_path)
    keys = ('measure', 'schema', 'metric', 'oracle')
    if tuple(hb.get(k) for k in keys) != tuple(hn.get(k) for k in keys):
        raise SystemExit('results of different metrics, versions or readers are not compared: '
                         + json.dumps({k: hb.get(k) for k in keys}) + ' vs ' + json.dumps({k: hn.get(k) for k in keys}))
    worse, mixed, better, lost, gained = [], [], [], [], []
    common = sorted(set(B) & set(N))
    for d in common:
        x, y = B[d], N[d]
        sx, sy = x in judged([x]), y in judged([y])
        if sx and not sy:
            lost.append((d, y.get('skip') or ('readers junk' if y.get('readersSuspect') else 'not judged')))
            continue
        if sy and not sx:
            gained.append(d)
            continue
        if not sx:
            continue
        why, good = changes(x, y, **(exact(rules or RULES) if exact_mode else (rules or RULES)))
        if why and good:
            mixed.append((d, why + good))
        elif why:
            worse.append((d, why))
        elif good:
            better.append((d, good))
    lines = [f"## {title} PDF→Word: {os.path.basename(base_path)} → {os.path.basename(new_path)}", '',
             f"metric v{hn.get('metric')} (schema {hn.get('schema')}), readers {hn.get('oracle')}; corpus {hb.get('corpus')} → {hn.get('corpus')}"
             + ('' if hb.get('corpus') == hn.get('corpus') else ' — DIFFERENT documents: only the ones in both are compared'),
             f"documents in both: {len(common)}" + (' — exact: no tolerance (two builds, one run)' if exact_mode else ''), '',
             f'**worse: {len(worse)}, mixed: {len(mixed)}, no longer scored: {len(lost)}** — better: {len(better)}, newly scored: {len(gained)}']
    if not private:
        lines += [f'- WORSE {d}: ' + '; '.join(w) for d, w in worse]
        lines += [f'- MIXED {d}: ' + '; '.join(w) for d, w in mixed]
        lines += [f'- NO LONGER SCORED {d}: {why}' for d, why in lost]
        lines += [f'- better {d}: ' + '; '.join(g) for d, g in better[:40]]
    lines += ['', (summarize or summary)(new_path, private)]
    return '\n'.join(lines), len(worse) + len(mixed) + len(lost)


if __name__ == '__main__':
    a = sys.argv[1:]
    private = '--private' in a
    a = [x for x in a if x != '--private']
    if a[0] == '--merge':
        merge(a[1], a[2:])
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
        run(a[0], a[1], a[2], res)
