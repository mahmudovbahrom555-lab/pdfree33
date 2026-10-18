#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Arabic-script PDF->Word quality, strict, per pain (2026-10-17).

  python3 scripts/quality/arabic.py <docs_dir> <files_dir> <out.jsonl>
      (files_dir holds <doc>.pdf2word.docx, as robust.mjs --save writes them)
      [--results <robust results.jsonl>]
  python3 scripts/quality/arabic.py --merge <out.jsonl> <shard.jsonl>...
  python3 scripts/quality/arabic.py --compare <baseline.jsonl> <new.jsonl> [--fail-on-worse]
  python3 scripts/quality/arabic.py --migrate <old-metric.jsonl> <new-metric.jsonl>
      (the same outputs scored by two metric versions: what the new one moves)

The reference is the PDF's own text as two independent readers give it, MuPDF
and poppler (pdftotext): a word or a number is scored only where BOTH read it
("agreed"; MuPDF alone reverses Arabic-Indic dates: "٨١٠٢" for ٢٠١٨). Agreement
is a stronger signal, not truth: where both read a document the same wrong way
— a broken font encoding, letters spaced apart — it proves nothing. `agree`
and `numbersAgree` say how much of each reader's text the other confirmed
(low: the scores on that document mean little); hand-checked gold pages
(tests/corpus/gold/) are what say how far the agreement itself can be trusted.
Changing what this file measures is a new METRIC_VERSION: results of two
versions are not compared (see scripts/check_gold.py).

Words are NFKC (presentation forms -> letters), vowel marks and tatweel
stripped, letters NOT folded: ي≠ی, ة≠ه, أ≠ا — a dot is a letter.
Per document:
  recall      share of trusted words in the output (multiset)
  dots        output words with a trusted word's skeleton but other dots
  reversed    output words that are a missing trusted word backwards
  glued       output words that are two words both readers show side by side,
              and neither reads as one
  split       two output words that together are a missing trusted word
  numbers     share of trusted numbers (exact digits, Arabic-Indic kept)
  missing / extra   counts, for short documents (< 50 words) whose shares
              swing on one word: an invoice's one wrong total is one error
  rotated     pages with /Rotate — known limit: PDF→Word's OCR skips them, and a
              rotated scan under a watermark scores nothing here
Documents without an Arabic-script text layer (scans) have no reference here:
what OCR made of them is not measured by this file. A document PDF→Word read
partly with OCR (`ocrPages`, from robust.mjs's results) is reported in a group
of its own: its words are OCR's, not the text layer's reconstruction.

Schema 2 (2026-10-18) adds, without changing any score: each document's
content `sha` (the corpus hash is computed over every row, so a merge of
shards hashes all of them); `numbersAgreed` (the denominator of `numbers`);
`numberCauses` (what the output has in place of each lost number, or that
it was page furniture — a header, a footer, a page number — or a list item's
number Word now numbers itself); and, from
robust.mjs's results.jsonl, `outcome` (ok / timeout / error …), `ms` and
`ocrPages`. tests/corpus/cloud/arabic-known.json lists documents a human found
both readers wrong on, or unverifiable: reported, never judged.

Metric v2, schema 3 (2026-10-18): the header lists `timedOut` and
`notEvaluated` (each with why); a set-aside entry says what is not judged on
its document — numbers, words or all (`scope`) — with a status and a dated
history; dot errors, reversed and glued words judge "worse" per word found
(see worse_on). No score changes.
"""
import collections, hashlib, json, os, re, subprocess, sys, unicodedata, zipfile

import fitz

AR = re.compile(r'[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]')
MARKS = re.compile(r'[ً-ْٰ]')
SHORT = 50
METRIC_VERSION = 2
SCHEMA = 3
KNOWN = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'tests', 'corpus', 'cloud', 'arabic-known.json')
FOLD = str.maketrans('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')
RASM = {}
for base, letters in {'ٮ': 'بتثنيىئپٹیۍ', 'ح': 'جحخچ', 'د': 'دذڈ', 'ر': 'رزژڑ', 'س': 'سش', 'ص': 'صض',
                      'ط': 'طظ', 'ع': 'عغ', 'ڡ': 'فقڤ', 'ه': 'هةۃھ', 'ا': 'اأإآٱ', 'و': 'وؤ', 'ک': 'كکگ'}.items():
    for ch in letters:
        RASM[ch] = base


def rasm(w):
    return ''.join(RASM.get(c, c) for c in w)


def clean(t):
    return re.sub(r'[ـ‌‍‎‏‪-‮⁦-⁩]', '', unicodedata.normalize('NFKC', t))


def ar_words(t):
    return [w for w in re.findall(r'\w+', MARKS.sub('', clean(t))) if AR.search(w)]


def numbers(t):
    return [n for n in re.findall(r'[0-9٠-٩۰-۹]+', clean(t)) if len(n) >= 2]


def docx_text(path):
    xml = zipfile.ZipFile(path).read('word/document.xml').decode('utf8')
    paras = []
    for m in re.finditer(r'<w:p[ >].*?</w:p>', xml, re.S):
        t = ''.join(re.findall(r'<w:t(?: [^>]*)?>([^<]*)</w:t>', m.group(0).replace('<w:tab/>', '<w:t> </w:t>')))
        paras.append(t.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>').replace('&quot;', '"').replace('&apos;', "'"))
    return '\n'.join(paras)


def readers(pdf):
    doc = fitz.open(pdf)
    mu = '\n'.join(page.get_text() for page in doc)
    pp = subprocess.run(['pdftotext', '-enc', 'UTF-8', pdf, '-'], capture_output=True, text=True, timeout=300).stdout
    rotated = sum(1 for page in doc if page.rotation)
    return mu, pp, doc.page_count, (doc.metadata or {}).get('producer') or '', rotated


def versions():
    pop = subprocess.run(['pdftotext', '-v'], capture_output=True, text=True)
    return {'pymupdf': fitz.VersionBind, 'poppler': (pop.stderr or pop.stdout).split('\n')[0].strip()}


def score(pdf, docx):
    mu, pp, pages, producer, rotated = readers(pdf)
    M, P = ar_words(mu), ar_words(pp)
    T = collections.Counter(M) & collections.Counter(P)
    n = sum(T.values())
    row = {'pages': pages, 'producer': producer[:60], 'rotated': rotated, 'words': n,
           'agree': round(n / (max(len(M), len(P)) or 1), 3)}
    if n == 0:
        return {**row, 'skip': 'no Arabic-script text both readers agree on'}
    out = docx_text(docx)
    O = collections.Counter(ar_words(out))
    hit = T & O
    missing, extra = T - hit, O - collections.Counter(M) - collections.Counter(P)
    by_rasm = collections.defaultdict(int)
    for w, c in missing.items():
        by_rasm[rasm(w)] += c
    dots = 0
    for w, c in extra.items():
        k = min(c, by_rasm.get(rasm(w), 0))
        dots += k
        by_rasm[rasm(w)] -= k
    reversed_ = sum(min(c, missing[w[::-1]]) for w, c in extra.items() if len(w) > 2 and w[::-1] != w)
    pairs_m = collections.Counter(a + b for a, b in zip(M, M[1:]))
    pairs_p = collections.Counter(a + b for a, b in zip(P, P[1:]))
    seen = set(M) | set(P)
    glued = sum(min(c, pairs_m[w], pairs_p[w]) for w, c in O.items() if w not in seen)
    seq = ar_words(out)
    split = sum(1 for a, b in zip(seq, seq[1:]) if missing[a + b] > 0)
    nm, np_ = collections.Counter(numbers(mu)), collections.Counter(numbers(pp))
    nt = nm & np_
    out_numbers = numbers(out)
    no = collections.Counter(out_numbers)
    lost = nt - no
    causes = number_causes(lost, out_numbers, nt, furniture(pp) & nt, list_marks(pp, docx) & nt) if lost else None
    return {**row, 'short': n < SHORT,
            'recall': round(sum(hit.values()) / n, 4),
            'missing': sum(missing.values()), 'extra': sum(extra.values()),
            'dots': dots, 'reversed': reversed_, 'glued': glued, 'split': split,
            'numbers': round(sum((nt & no).values()) / sum(nt.values()), 4) if nt else None,
            'numbersMissing': sum(lost.values()), 'numbersAgreed': sum(nt.values()),
            **({'numberCauses': causes} if causes else {}),
            'numbersAgree': round(sum(nt.values()) / (max(sum(nm.values()), sum(np_.values())) or 1), 3)}


def furniture(pp):
    """Numbers of page furniture in poppler's text (pages split by form feed):
    running headers and footers — a line with words on at least 3 pages and a
    third of them, its digits masked (its own page number changes), or the
    same line word for word — and page
    numbers: a number in one of a page's first or last two short lines that
    runs with the page, at the document's own offset (page 64 printed "67").
    PDF→Word leaves those out on purpose (Word numbers its own pages); a lost
    one is still lost, its cause is named."""
    pages = [[l for l in (clean(x).strip() for x in pg.split('\n')) if l] for pg in pp.split('\f')]
    mask = lambda l: re.sub(r'[0-9٠-٩۰-۹]+', '#', l)
    seen = collections.Counter(m for pg in pages for m in {mask(l) for l in pg})
    # the same line word for word on many pages — a running header's date
    # ("۱۴۰۰/۰۴/۲۲" on 10 of 11 pages, 4364566) — is furniture even without
    # words; a table's column of bare numbers repeats only once masked
    same = collections.Counter(l for pg in pages for l in set(pg))
    out = collections.Counter()
    edge = []   # (page index, number) on a page's first or last two short lines
    for p, pg in enumerate(pages):
        for i, l in enumerate(pg):
            words = len(re.findall(r'\w', mask(l).replace('#', '')))
            many = max(3, len(pages) / 3)
            if len(pages) >= 3 and ((words >= 3 and seen[mask(l)] >= many) or same[l] >= many):
                out.update(numbers(l))
            elif (i < 2 or i >= len(pg) - 2) and len(l) <= 40:
                edge += [(p, n) for n in numbers(l)]
    offsets = collections.Counter(int(n.translate(FOLD)) - p for p, n in edge)
    if offsets:
        off, k = offsets.most_common(1)[0]
        if k >= 3:
            out.update(n for p, n in edge if int(n.translate(FOLD)) - p == off)
    return out


LIST_MARK = re.compile(r'^[(\[]?([0-9٠-٩۰-۹]{2,})\s*[.)\]\-–]|^[)\]]\s*([0-9٠-٩۰-۹]{2,})|[(\[]\s*([0-9٠-٩۰-۹]{2,})\s*$|([0-9٠-٩۰-۹]{2,})\s*[.)\]]\s*$')


def list_marks(pp, docx):
    """Numbers that mark a numbered list's items in poppler's text ("11)",
    ")11" in RTL), as many as the output has Word-numbered paragraphs: PDF→Word
    makes such items a real Word list, whose numbers live in numbering.xml,
    not in the text — this file can't read them, so the cause is named, not
    hidden. (Whether Word numbers them the same is not checked here.)"""
    xml = zipfile.ZipFile(docx).read('word/document.xml').decode('utf8')
    listed = xml.count('<w:numPr>')
    marks = collections.Counter()
    if listed:
        for l in clean(pp).split('\n'):
            m = LIST_MARK.search(l.strip())
            if m and len(l.strip()) > 6:
                marks[next(g for g in m.groups() if g)] += 1
    while sum(marks.values()) > listed:
        marks[max(marks, key=marks.get)] -= 1
    return +marks


def number_causes(lost, out_numbers, trusted, furniture_numbers=None, list_numbers=None):
    """What the output has in place of each lost trusted number, first match:
    script — the same digits in another digit script (١٢ for 12);
    reversed — its digits backwards (in either script);
    split — two neighbouring output numbers that make it, in either order;
    inside — part of a longer output number (glued to a neighbour);
    furniture — a running header/footer's or a page number (furniture());
    list — a numbered list item's number, now Word's own numbering (list_marks());
    unexplained — none of these: dropped, or changed some other way.
    An output number explains one loss at most (split/inside: the ones shown)."""
    furniture_numbers = collections.Counter(furniture_numbers or {})
    list_numbers = collections.Counter(list_numbers or {})
    spare = collections.Counter(out_numbers) - trusted
    pairs = collections.Counter()
    for a, b in zip(out_numbers, out_numbers[1:]):
        pairs[(a + b).translate(FOLD)] += 1
        pairs[(b + a).translate(FOLD)] += 1
    causes = collections.Counter()

    def take(match):
        for m in sorted(spare):
            if spare[m] > 0 and match(m):
                spare[m] -= 1
                return True
        return False

    for n, c in sorted(lost.items()):
        f = n.translate(FOLD)
        for _ in range(c):
            if take(lambda m: m != n and m.translate(FOLD) == f):
                causes['script'] += 1
            elif f[::-1] != f and take(lambda m: m.translate(FOLD) == f[::-1]):
                causes['reversed'] += 1
            elif pairs[f] > 0:
                pairs[f] -= 1
                causes['split'] += 1
            elif take(lambda m: len(m) > len(n) and f in m.translate(FOLD)):
                causes['inside'] += 1
            elif furniture_numbers[n] > 0:
                furniture_numbers[n] -= 1
                causes['furniture'] += 1
            elif list_numbers[n] > 0:
                list_numbers[n] -= 1
                causes['list'] += 1
            else:
                causes['unexplained'] += 1
    return dict(causes)


def file_sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16]


def corpus_hash(rows):
    """Over every row's (doc, content sha), in doc order: the same documents
    hash the same in any order, in one file or merged from shards; one changed
    byte in any of them changes it."""
    h = hashlib.sha256()
    for doc, sha in sorted((r['doc'], r.get('sha', '')) for r in rows):
        h.update(doc.encode() + b'\0' + sha.encode() + b'\n')
    return h.hexdigest()[:16]


def robust_results(path):
    # robust.mjs's results.jsonl: one PDF→Word row per document
    rows = (json.loads(l) for l in open(path) if l.strip())
    return {r['doc']: r for r in rows if r.get('tool') == 'pdf2word'}


def night_summary(rows):
    """What a result's header says of its documents beyond the scores: the
    ones that ran out of time, and every one not evaluated, with why."""
    rows = list(rows)
    return {'timedOut': sorted(r['doc'] for r in rows if r.get('skip') == 'timeout'),
            'notEvaluated': {r['doc']: r['skip'] for r in sorted(rows, key=lambda r: r['doc']) if 'recall' not in r and 'skip' in r}}


def run(docs, files, out_path, results=None):
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
            # a timeout is its own status, not "no output"
            row['skip'] = r['outcome'] if r and r.get('outcome') != 'ok' else 'no output'
        else:
            try:
                row.update(score(os.path.join(docs, name), docx))
            except Exception as e:  # one unreadable file must not end the night
                row['skip'] = f'error: {str(e)[:120]}'
    with open(out_path, 'w') as out:
        out.write(json.dumps({'schema': SCHEMA, 'metric': METRIC_VERSION, 'oracle': versions(), 'corpus': corpus_hash(rows),
                              'docs': len(rows), **night_summary(rows)}, ensure_ascii=False) + '\n')
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + '\n')


def merge(out_path, paths):
    """Shards of one night → one result. Every shard must have been scored by
    the same metric, schema and readers; the corpus hash is recomputed over
    all rows, not taken from a shard."""
    heads, rows = [], {}
    for p in paths:
        head, part = load(p)
        heads.append(head)
        for d in part:
            if d in rows:
                raise SystemExit(f'{d} is in two shards')
        rows.update(part)
    keys = ('schema', 'metric', 'oracle')
    if not heads or any(tuple(h.get(k) for k in keys) != tuple(heads[0].get(k) for k in keys) for h in heads):
        raise SystemExit('shards scored by different metric versions or readers: ' + '; '.join(json.dumps({k: h.get(k) for k in keys}) for h in heads))
    with open(out_path, 'w') as out:
        out.write(json.dumps({**{k: heads[0][k] for k in keys}, 'corpus': corpus_hash(rows.values()),
                              'docs': len(rows), 'shards': len(paths), **night_summary(rows.values())}, ensure_ascii=False) + '\n')
        for d in sorted(rows):
            out.write(json.dumps(rows[d], ensure_ascii=False) + '\n')


def load(path):
    lines = [json.loads(l) for l in open(path)]
    head = lines[0] if lines and 'doc' not in lines[0] else {}
    return head, {r['doc']: r for r in lines if 'doc' in r}


def serious(r):
    # a short document is judged by its errors, not a share: one lost word in
    # twelve, one wrong number on an invoice
    return r['missing'] >= 3 or r['numbersMissing'] >= 1 or r['dots'] >= 1 or r['reversed'] >= 1 or r['recall'] < 0.9


KNOWN_STATUS = ('unreviewed', 'known_issue', 'fixed', 'excluded')
KNOWN_SCOPE = ('all', 'numbers', 'words')


def load_known(path=KNOWN):
    """{doc: entry} of documents a human set aside (tests/corpus/cloud/
    arabic-known.json): `kind` bothWrong (both readers read it the same wrong
    way — agreement scores the wrong text) or unverifiable (no reference this
    metric can trust); `scope` what is not judged on it — its numbers, its
    words, or all of it; `issue`, `check` (how a human verifies it), `status`
    (unreviewed, known_issue, fixed — judged again, excluded), `sha` and a
    dated `history` of its status. Only an entry not `fixed` sets anything
    aside, and only within its scope."""
    if not path or not os.path.exists(path):
        return {}
    docs = json.load(open(path)).get('docs', {})
    for d, e in docs.items():
        if e.get('status') not in KNOWN_STATUS or e.get('scope') not in KNOWN_SCOPE:
            raise SystemExit(f'{path}: {d} — status must be one of {KNOWN_STATUS}, scope one of {KNOWN_SCOPE}')
    return {d: e for d, e in docs.items() if e['status'] != 'fixed'}


def hits(r):
    return r['words'] * r['recall']


def worse_on(base, new, tolerance, scope=None):
    """What `new` lost against `base`, outside `scope`. Dot errors, reversed
    and glued words count per word found, not as totals: a document that went
    from no text to most of it gains errors with its words (2022469, metric
    v1: "worse" at 0 → 96 %)."""
    out = []
    if scope != 'numbers' and new['numbersMissing'] > base['numbersMissing']:
        out.append('numbers')
    if scope != 'words':
        if new['recall'] < base['recall'] - tolerance:
            out.append('recall')
        for k in ('dots', 'reversed', 'glued'):
            more = new[k] > (base[k] * 1.1 + 2 if k == 'glued' else base[k])
            if more and hits(base) >= 1 and new[k] / max(1, hits(new)) > base[k] / hits(base):
                out.append(k)
    return out


def pct(values, q):
    v = sorted(values)
    return v[min(len(v) - 1, int(q * len(v)))] if v else None


def runtime(rows):
    ms = [r['ms'] for r in rows.values() if isinstance(r.get('ms'), (int, float))]
    return (pct(ms, 0.5), pct(ms, 0.95), max(ms)) if ms else None


def compare(base_path, new_path, tolerance=0.005, known_path=KNOWN, migrate=False):
    """Markdown: aggregates long/short, and every document worse than the
    baseline by more than `tolerance` recall, or with more dot errors,
    reversed or glued words. A report for a human, not a verdict.
    migrate: the same outputs scored by two metric versions — what the new
    metric moves, for the owner to approve with the new baseline."""
    hb, base = load(base_path)
    hn, new = load(new_path)
    lines = ['## Arabic-script PDF→Word ' + ('metric change: old vs new metric, same outputs' if migrate else 'vs baseline'), '',
             f'metric v{hn.get("metric")} (schema {hn.get("schema")}), readers {hn.get("oracle")}, corpus {hn.get("corpus")} — '
             f'{hn.get("docs", len(new))} docs (baseline: metric v{hb.get("metric")} (schema {hb.get("schema")}), readers {hb.get("oracle")}, '
             f'corpus {hb.get("corpus")} — {hb.get("docs", len(base))} docs)', '']
    if migrate:
        if hb.get('corpus') != hn.get('corpus'):
            return '\n'.join(lines + ['**✗ not the same documents: a metric change is measured on the same outputs.**']), -1
    elif hb.get('metric') != hn.get('metric') or hb.get('schema') != hn.get('schema'):
        return '\n'.join(lines + ['**✗ different metric versions: not comparable.** A new metric needs a new, approved baseline '
                                  '(--migrate shows what it moves).']), -1
    if hb.get('oracle') != hn.get('oracle'):
        lines += ['⚠ the readers\' versions differ from the baseline\'s: a change may be theirs, not PDFree\'s', '']
    if hb.get('corpus') != hn.get('corpus'):
        lines += ['⚠ not the same documents as the baseline: only the ones in both are compared', '']
    changed = [d for d in new if d in base and base[d].get('sha') and new[d].get('sha') and base[d]['sha'] != new[d]['sha']]
    if changed:
        lines += [f'⚠ same name, other content than the baseline\'s (not compared): {", ".join(sorted(changed))}', '']
    known = load_known(known_path)
    ocr = sorted(d for d in new if (new[d].get('ocrPages') or 0) > 0 or (base.get(d, {}).get('ocrPages') or 0) > 0)
    scored = [d for d in new if d in base and 'recall' in new[d] and 'recall' in base[d] and d not in changed]
    both = [d for d in scored if d not in known and d not in ocr]
    partly = [d for d in scored if d in known and d not in ocr and known[d]['scope'] != 'all']
    for label, sel in (('long (≥ 50 words)', [d for d in both if not new[d]['short']]),
                       ('short (< 50 words)', [d for d in both if new[d]['short']])):
        if not sel:
            continue
        agg = lambda rows, k: sum(r.get(k) or 0 for r in rows)
        b, n = [base[d] for d in sel], [new[d] for d in sel]
        lines.append(f'**{label}: {len(sel)} docs** — recall {agg(b, "recall") / len(sel) * 100:.2f} → {agg(n, "recall") / len(sel) * 100:.2f} %, '
                     f'missing words {agg(b, "missing")} → {agg(n, "missing")}, dots {agg(b, "dots")} → {agg(n, "dots")}, '
                     f'reversed {agg(b, "reversed")} → {agg(n, "reversed")}, glued {agg(b, "glued")} → {agg(n, "glued")}, '
                     f'numbers missing {agg(b, "numbersMissing")} → {agg(n, "numbersMissing")}'
                     + (f' of {agg(n, "numbersAgreed")} agreed' if agg(n, 'numbersAgreed') else ''))
        if label.startswith('short'):
            lines.append(f'  short documents with a serious error (≥ 3 words or any number, dot or reversal lost; or < 90 %): '
                         f'{sum(map(serious, b))} → {sum(map(serious, n))} of {len(sel)}; worst now: '
                         + ', '.join(f'{d} {new[d]["recall"]:.2f} ({new[d]["missing"]} missing)' for d in sorted(sel, key=lambda d: new[d]['recall'])[:8]))
    causes = collections.Counter()
    for d in both:
        causes.update(new[d].get('numberCauses') or {})
    if causes:
        lines.append('  lost numbers, by what the output has instead: ' + ', '.join(f'{k} {v}' for k, v in causes.most_common()))
    worse = [d for d in both + partly if worse_on(base[d], new[d], tolerance, known.get(d, {}).get('scope'))]
    lines += ['', f'**{"moved by the new metric" if migrate else "worse than baseline"}: {len(worse)}**']
    for d in sorted(worse, key=lambda d: new[d]['recall'] - base[d]['recall']):
        b, n = base[d], new[d]
        lines.append(f'- {d} ({n["producer"]}) recall {b["recall"]:.3f} → {n["recall"]:.3f}, dots {b["dots"]} → {n["dots"]}, '
                     f'reversed {b["reversed"]} → {n["reversed"]}, glued {b["glued"]} → {n["glued"]}, numbers missing {b["numbersMissing"]} → {n["numbersMissing"]}')
    # a document scored in the baseline and not now: red when it failed, a
    # warning when it ran out of time (CI speed varies; slow stays visible)
    gone = [d for d in base if 'recall' in base[d] and d not in changed and (d not in new or 'recall' not in new[d])]
    timed_out = [d for d in gone if new.get(d, {}).get('skip') == 'timeout']
    failed = [d for d in gone if d not in timed_out]
    if failed:
        lines += ['', f'**scored in the baseline, failed now: {len(failed)}** — '
                  + ', '.join(f'{d} ({new.get(d, {}).get("skip", "absent")})' for d in sorted(failed)[:20])]
    if timed_out:
        lines += ['', f'⚠ scored in the baseline, timed out now: {len(timed_out)} — ' + ', '.join(sorted(timed_out))]
    if ocr:
        lines += ['', f'read partly with OCR — its words are OCR\'s, not judged as text-layer quality: {len(ocr)} — '
                  + ', '.join(f'{d} ({new[d].get("ocrPages")} p., recall {new[d]["recall"]:.2f})' if 'recall' in new[d] else d for d in ocr)]
    held = sorted(d for d in new if d in known)
    if held:
        lines += ['', f'set aside by a human (tests/corpus/cloud/arabic-known.json) — not in the totals; judged only outside its scope: {len(held)}']
        for d in held:
            e = known[d]
            lines.append(f'- {d}: {e["kind"]}, scope {e["scope"]}, {e["status"]} — {e.get("issue", "")}'
                         + (f' — recall {new[d]["recall"]:.2f}' if 'recall' in new[d] else '')
                         + (' ⚠ content differs from the entry\'s sha' if e.get('sha') and new[d].get('sha') and e['sha'] != new[d]['sha'] else ''))
    not_eval = {d: r['skip'] for d, r in sorted(new.items()) if 'recall' not in r and 'skip' in r}
    if not_eval:
        lines += ['', f'not evaluated: {len(not_eval)} — ' + ', '.join(f'{d} ({why})' for d, why in not_eval.items())]
    rt_b, rt_n = runtime(base), runtime(new)
    if rt_n:
        lines += ['', 'PDF→Word time per document p50 / p95 / max: '
                  + (f'{rt_b[0] / 1000:.1f} / {rt_b[1] / 1000:.1f} / {rt_b[2] / 1000:.1f} s → ' if rt_b else '')
                  + f'{rt_n[0] / 1000:.1f} / {rt_n[1] / 1000:.1f} / {rt_n[2] / 1000:.1f} s']
        timeouts = sorted(d for d in new if new[d].get('outcome') == 'timeout')
        if timeouts:
            lines.append(f'  timed out: {len(timeouts)} — ' + ', '.join(timeouts))
        slower = sorted(d for d in new if d in base and isinstance(new[d].get('ms'), (int, float)) and isinstance(base[d].get('ms'), (int, float))
                        and new[d]['ms'] > 2 * base[d]['ms'] and new[d]['ms'] - base[d]['ms'] > 30_000)
        if slower or (rt_b and rt_n[1] > 1.5 * rt_b[1]):
            # a warning, never red: CI machines vary in speed
            lines.append('  ⚠ slower than the baseline: '
                         + (f'p95 {rt_b[1] / 1000:.1f} → {rt_n[1] / 1000:.1f} s; ' if rt_b and rt_n[1] > 1.5 * rt_b[1] else '')
                         + ', '.join(f'{d} {base[d]["ms"] / 1000:.0f} → {new[d]["ms"] / 1000:.0f} s' for d in slower))
    return '\n'.join(lines), len(worse) + len(failed)


if __name__ == '__main__':
    if sys.argv[1] in ('--compare', '--migrate'):
        text, worse = compare(sys.argv[2], sys.argv[3], migrate=sys.argv[1] == '--migrate')
        print(text)
        # --fail-on-worse: a red night when a document got worse or failed, or
        # the results can't be compared — a signal, not a deploy gate
        if '--fail-on-worse' in sys.argv and worse != 0:
            sys.exit(1)
    elif sys.argv[1] == '--merge':
        merge(sys.argv[2], sys.argv[3:])
    else:
        args = sys.argv[1:]
        results = None
        if '--results' in args:
            i = args.index('--results')
            results = args[i + 1]
            del args[i:i + 2]
        run(args[0], args[1], args[2], results)
