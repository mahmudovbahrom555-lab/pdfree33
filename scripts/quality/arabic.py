#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Arabic-script PDF->Word quality, strict, per pain (2026-10-17).

  python3 scripts/quality/arabic.py <docs_dir> <files_dir> <out.jsonl>
      (files_dir holds <doc>.pdf2word.docx, as robust.mjs --save writes them)
  python3 scripts/quality/arabic.py --compare <baseline.jsonl> <new.jsonl>

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
what OCR made of them is not measured by this file.
"""
import collections, hashlib, json, os, re, subprocess, sys, unicodedata, zipfile

import fitz

AR = re.compile(r'[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]')
MARKS = re.compile(r'[ً-ْٰ]')
SHORT = 50
METRIC_VERSION = 1
SCHEMA = 1
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
    no = collections.Counter(numbers(out))
    return {**row, 'short': n < SHORT,
            'recall': round(sum(hit.values()) / n, 4),
            'missing': sum(missing.values()), 'extra': sum(extra.values()),
            'dots': dots, 'reversed': reversed_, 'glued': glued, 'split': split,
            'numbers': round(sum((nt & no).values()) / sum(nt.values()), 4) if nt else None,
            'numbersMissing': sum((nt - no).values()),
            'numbersAgree': round(sum(nt.values()) / (max(sum(nm.values()), sum(np_.values())) or 1), 3)}


def corpus_hash(docs):
    h = hashlib.sha256()
    for name in sorted(n for n in os.listdir(docs) if n.lower().endswith('.pdf')):
        h.update(name.encode() + b'\0' + hashlib.sha256(open(os.path.join(docs, name), 'rb').read()).digest())
    return h.hexdigest()[:16]


def run(docs, files, out_path):
    with open(out_path, 'w') as out:
        out.write(json.dumps({'schema': SCHEMA, 'metric': METRIC_VERSION, 'oracle': versions(), 'corpus': corpus_hash(docs)}) + '\n')
        for name in sorted(os.listdir(docs)):
            if not name.lower().endswith('.pdf'):
                continue
            docx = os.path.join(files, name + '.pdf2word.docx')
            row = {'doc': name}
            if not os.path.exists(docx):
                row['skip'] = 'no output'
            else:
                try:
                    row.update(score(os.path.join(docs, name), docx))
                except Exception as e:  # one unreadable file must not end the night
                    row['skip'] = f'error: {str(e)[:120]}'
            out.write(json.dumps(row, ensure_ascii=False) + '\n')


def load(path):
    lines = [json.loads(l) for l in open(path)]
    head = lines[0] if lines and 'doc' not in lines[0] else {}
    return head, {r['doc']: r for r in lines if 'doc' in r}


def serious(r):
    # a short document is judged by its errors, not a share: one lost word in
    # twelve, one wrong number on an invoice
    return r['missing'] >= 3 or r['numbersMissing'] >= 1 or r['dots'] >= 1 or r['reversed'] >= 1 or r['recall'] < 0.9


def compare(base_path, new_path, tolerance=0.005):
    """Markdown: aggregates long/short, and every document worse than the
    baseline by more than `tolerance` recall, or with more dot errors,
    reversed or glued words. A report for a human, not a verdict."""
    hb, base = load(base_path)
    hn, new = load(new_path)
    lines = ['## Arabic-script PDF→Word vs baseline', '',
             f'metric v{hn.get("metric")}, readers {hn.get("oracle")}, corpus {hn.get("corpus")} '
             f'(baseline: metric v{hb.get("metric")}, readers {hb.get("oracle")}, corpus {hb.get("corpus")})', '']
    if hb.get('metric') != hn.get('metric') or hb.get('schema') != hn.get('schema'):
        return '\n'.join(lines + ['**✗ different metric versions: not comparable.** A new metric needs a new, approved baseline.']), -1
    if hb.get('oracle') != hn.get('oracle'):
        lines += ['⚠ the readers\' versions differ from the baseline\'s: a change may be theirs, not PDFree\'s', '']
    if hb.get('corpus') != hn.get('corpus'):
        lines += ['⚠ not the same documents as the baseline: only the ones in both are compared', '']
    both = [d for d in new if d in base and 'recall' in new[d] and 'recall' in base[d]]
    for label, sel in (('long (≥ 50 words)', [d for d in both if not new[d]['short']]),
                       ('short (< 50 words)', [d for d in both if new[d]['short']])):
        if not sel:
            continue
        agg = lambda rows, k: sum(r[k] for r in rows)
        b, n = [base[d] for d in sel], [new[d] for d in sel]
        lines.append(f'**{label}: {len(sel)} docs** — recall {agg(b, "recall") / len(sel) * 100:.2f} → {agg(n, "recall") / len(sel) * 100:.2f} %, '
                     f'missing words {agg(b, "missing")} → {agg(n, "missing")}, dots {agg(b, "dots")} → {agg(n, "dots")}, '
                     f'reversed {agg(b, "reversed")} → {agg(n, "reversed")}, glued {agg(b, "glued")} → {agg(n, "glued")}, '
                     f'numbers missing {agg(b, "numbersMissing")} → {agg(n, "numbersMissing")}')
        if label.startswith('short'):
            lines.append(f'  short documents with a serious error (≥ 3 words or any number, dot or reversal lost; or < 90 %): '
                         f'{sum(map(serious, b))} → {sum(map(serious, n))} of {len(sel)}; worst now: '
                         + ', '.join(f'{d} {new[d]["recall"]:.2f} ({new[d]["missing"]} missing)' for d in sorted(sel, key=lambda d: new[d]['recall'])[:8]))
    worse = [d for d in both if new[d]['recall'] < base[d]['recall'] - tolerance
             or any(new[d][k] > base[d][k] for k in ('dots', 'reversed', 'numbersMissing'))
             or new[d]['glued'] > base[d]['glued'] * 1.1 + 2]
    lines += ['', f'**worse than baseline: {len(worse)}**']
    for d in sorted(worse, key=lambda d: new[d]['recall'] - base[d]['recall']):
        b, n = base[d], new[d]
        lines.append(f'- {d} ({n["producer"]}) recall {b["recall"]:.3f} → {n["recall"]:.3f}, dots {b["dots"]} → {n["dots"]}, '
                     f'reversed {b["reversed"]} → {n["reversed"]}, glued {b["glued"]} → {n["glued"]}, numbers missing {b["numbersMissing"]} → {n["numbersMissing"]}')
    gone = [d for d in base if 'recall' in base[d] and (d not in new or 'recall' not in new[d])]
    if gone:
        lines += ['', f'**scored in the baseline, not now: {len(gone)}** — ' + ', '.join(sorted(gone)[:20])]
    return '\n'.join(lines), len(worse)


if __name__ == '__main__':
    if sys.argv[1] == '--compare':
        text, worse = compare(sys.argv[2], sys.argv[3])
        print(text)
        # --fail-on-worse: a red night when a document got worse, or the
        # results can't be compared — a signal, not a deploy gate
        if '--fail-on-worse' in sys.argv and worse != 0:
            sys.exit(1)
    else:
        run(sys.argv[1], sys.argv[2], sys.argv[3])
