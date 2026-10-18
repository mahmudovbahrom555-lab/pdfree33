#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Control cases for scripts/quality/arabic.py (2026-10-17).

The metric must see each pain it claims to see: an output with one dot wrong,
one word reversed, two words glued, one number lost, must score worse than
the right output — on that pain's own counter. And what it can't see is
written down here rather than hidden: two readers agreeing is not truth
(both read Chrome's lam-alef ligature backwards: "خالل" for "خلال").

Fixtures: tests/fixtures/quality/ar-{prose,digits,short}.pdf, our own text
(arabic-metric.json), printed by Chromium. Outputs are built here as minimal
.docx files. Needs pymupdf and poppler's pdftotext.

Run: python3 tests/quality/test_arabic_metric.py
"""
import json, os, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'quality'))
import arabic  # noqa: E402

FIX = os.path.join(ROOT, 'tests', 'fixtures', 'quality')
TEXT = json.load(open(os.path.join(FIX, 'arabic-metric.json')))
passed = failed = 0


def test(name, fn):
    global passed, failed
    try:
        fn()
        print(f'  ✓ {name}')
        passed += 1
    except AssertionError as e:
        print(f'  ✗ {name}\n    {e}')
        failed += 1


def assert_eq(a, b):
    assert a == b, f'{a!r} != {b!r}'


def assert_true(cond, ctx=''):
    assert cond, ctx


def docx(paragraphs):
    body = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{p}</w:t></w:r></w:p>' for p in paragraphs)
    path = tempfile.mktemp(suffix='.docx')
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('word/document.xml', f'<?xml version="1.0"?><w:document xmlns:w="w"><w:body>{body}</w:body></w:document>')
    return path


def score(name, paragraphs):
    return arabic.score(os.path.join(FIX, name + '.pdf'), docx(paragraphs))


prose = TEXT['ar-prose']
right = score('ar-prose', prose)


def changed(old, new):
    return [p.replace(old, new, 1) for p in prose]


print('\nscripts/quality/arabic.py — control cases:')

test('the right text: nothing reversed, glued, dotted wrong or lost among the words both readers agree on',
     lambda: (assert_eq(right['dots'], 0), assert_eq(right['reversed'], 0), assert_eq(right['glued'], 0),
              assert_true(right['recall'] >= 0.85, right)))

test('known limit: both readers read Chrome\'s lam-alef backwards ("خالل" for "خلال") — agreement is not truth',
     lambda: assert_true(right['recall'] < 1 and right['missing'] >= 1, right))


def one_dot():
    r = score('ar-prose', changed('التقرير', 'التقریر'))      # ي → Persian ی
    assert_eq(r['dots'], right['dots'] + 1)
    assert_true(r['recall'] < right['recall'], r)


test('one letter with other dots (ي → ی) is one dot error', one_dot)


def one_reversed():
    r = score('ar-prose', changed('المبيعات', 'تاعيبملا'))
    assert_eq(r['reversed'], right['reversed'] + 1)


test('one word letter-reversed is one reversed word', one_reversed)


def one_glued():
    r = score('ar-prose', changed('المنطقة الشرقية', 'المنطقةالشرقية'))
    assert_eq(r['glued'], right['glued'] + 1)


test('two words glued are one glued word', one_glued)


digits = TEXT['ar-digits']
right_d = score('ar-digits', digits)


def numbers_coverage():
    # MuPDF reads ٢٠٢٦/١٠/١٧ and the Persian number backwards: only what both
    # readers agree on is scored, and numbersAgree says how much that is
    assert_true(right_d['numbersMissing'] == 0, right_d)
    assert_true(0 < right_d['numbersAgree'] < 1, right_d)


test('numbers: the right text loses none; the readers\' agreement on numbers is reported', numbers_coverage)


def number_lost():
    r = score('ar-digits', [p.replace('10:30', '10:3', 1).replace('45', '4', 1) for p in digits])
    assert_true(r['numbersMissing'] >= right_d['numbersMissing'] + 2, r)


test('a lost or cut number counts — western digits, a time, a room number', number_lost)


def digit_script_blind():
    # Known limit, written down: MuPDF reads every Arabic-Indic number of this
    # Chrome print backwards, so none is agreed, and ١٢٥٠٠ turned into western
    # 12500 goes unseen — numbersAgree (< 1) is what warns of it; the
    # hand-checked gold pages are what will see it
    mu, pp = arabic.readers(os.path.join(FIX, 'ar-digits.pdf'))[:2]
    assert_true('١٢٥٠٠' in arabic.numbers(pp) and '١٢٥٠٠' not in arabic.numbers(mu))
    r = score('ar-digits', [p.replace('١٢٥٠٠', '12500', 1) for p in digits])
    assert_eq(r['numbersMissing'], right_d['numbersMissing'])


test('known limit: an Arabic-Indic number MuPDF reads backwards is not scored (١٢٥٠٠ → 12500 unseen)', digit_script_blind)


short = TEXT['ar-short']
right_s = score('ar-short', short)


def short_doc():
    assert_true(right_s['short'], right_s)
    assert_true(not arabic.serious(right_s), right_s)
    r = score('ar-short', [short[0].replace('أحمد علي ', '', 1)])
    assert_true(arabic.serious(r) or r['missing'] >= right_s['missing'] + 2, r)
    r2 = score('ar-short', [short[0].replace('2026', '2025', 1)])
    assert_true(arabic.serious(r2), r2)


test('a short document: scored as short; two lost words or one wrong year are serious', short_doc)


def compare_versions():
    head = {'schema': arabic.SCHEMA, 'metric': arabic.METRIC_VERSION, 'oracle': {}, 'corpus': 'x'}
    def write(rows, metric):
        path = tempfile.mktemp(suffix='.jsonl')
        with open(path, 'w') as f:
            f.write(json.dumps({**head, 'metric': metric}) + '\n')
            for r in rows:
                f.write(json.dumps(r) + '\n')
        return path
    row = {'doc': 'a.pdf', 'producer': 'p', **right}
    worse = {**row, 'recall': row['recall'] - 0.1, 'dots': row['dots'] + 1}
    _, n = arabic.compare(write([row], arabic.METRIC_VERSION), write([worse], arabic.METRIC_VERSION))
    assert_eq(n, 1)
    _, n = arabic.compare(write([row], arabic.METRIC_VERSION), write([row], arabic.METRIC_VERSION))
    assert_eq(n, 0)
    text, n = arabic.compare(write([row], arabic.METRIC_VERSION), write([row], arabic.METRIC_VERSION + 1))
    assert_eq(n, -1)
    assert_true('not comparable' in text, text)


test('compare: a worse document is reported; two metric versions are not compared', compare_versions)




# ── schema 2 (2026-10-18): corpus hash, shards, runtime, number causes, sets aside

def jsonl(head, rows):
    path = tempfile.mktemp(suffix='.jsonl')
    with open(path, 'w') as f:
        f.write(json.dumps(head) + '\n')
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    return path


HEAD = {'schema': arabic.SCHEMA, 'metric': arabic.METRIC_VERSION, 'oracle': {'pymupdf': 'x', 'poppler': 'y'}}


def shard(rows):
    return jsonl({**HEAD, 'corpus': arabic.corpus_hash(rows)}, rows)


def merged(paths):
    out = tempfile.mktemp(suffix='.jsonl')
    arabic.merge(out, paths)
    return arabic.load(out)


def corpus_over_shards():
    s1 = [{'doc': 'a.pdf', 'sha': '1'}, {'doc': 'b.pdf', 'sha': '2'}]
    s2 = [{'doc': 'c.pdf', 'sha': '3'}, {'doc': 'd.pdf', 'sha': '4'}]
    head, rows = merged([shard(s1), shard(s2)])
    assert_eq(head['corpus'], arabic.corpus_hash(s1 + s2))
    assert_true(head['corpus'] != arabic.corpus_hash(s1), 'the hash of shard 1 alone (the night\'s old bug)')
    assert_eq((head['docs'], head['shards'], sorted(rows)), (4, 2, ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']))
    # one document of the SECOND shard changed: the night's hash changes
    s2b = [s2[0], {'doc': 'd.pdf', 'sha': '5'}]
    assert_true(merged([shard(s1), shard(s2b)])[0]['corpus'] != head['corpus'])
    # shards in another order, rows in another order: the same hash
    assert_eq(merged([shard(s2[::-1]), shard(s1[::-1])])[0]['corpus'], head['corpus'])
    # a document dropped or added: another hash
    assert_true(arabic.corpus_hash(s1 + s2[:1]) != head['corpus'])


test('the corpus hash covers every shard\'s documents, by content, in any order', corpus_over_shards)


def merge_refuses():
    a = shard([{'doc': 'a.pdf', 'sha': '1'}])
    for other in (jsonl({**HEAD, 'oracle': {'pymupdf': 'x', 'poppler': 'z'}}, [{'doc': 'b.pdf', 'sha': '2'}]),
                  jsonl({**HEAD, 'metric': arabic.METRIC_VERSION + 1}, [{'doc': 'b.pdf', 'sha': '2'}]),
                  shard([{'doc': 'a.pdf', 'sha': '1'}])):
        try:
            merged([a, other])
            raise AssertionError('merged')
        except SystemExit:
            pass


test('merge refuses shards from other readers or metric versions, and a document in two shards', merge_refuses)


def file_sha_by_content():
    pdf = os.path.join(FIX, 'ar-short.pdf')
    copy = tempfile.mktemp(suffix='.pdf')
    data = open(pdf, 'rb').read()
    open(copy, 'wb').write(data[:-1] + bytes([data[-1] ^ 1]))
    assert_true(arabic.file_sha(pdf) != arabic.file_sha(copy))
    assert_eq(arabic.file_sha(pdf), arabic.file_sha(pdf))


test('a document\'s sha is its content: one byte changed is another document', file_sha_by_content)


def causes():
    trusted = __import__('collections').Counter(['2018', '١٢٥', '345', '9876', '4410', '777'])
    out = ['12', '8102', '125', '١٢٥', '34', '5', '19876', '4410']   # 2018 reversed, ١٢٥ kept, 125 is
    lost = trusted - __import__('collections').Counter(out)
    c = arabic.number_causes(lost, out, trusted)
    assert_eq(c, {'reversed': 1, 'split': 1, 'inside': 1, 'unexplained': 1})
    c = arabic.number_causes(__import__('collections').Counter(['٢٠١٨']), ['2018'], __import__('collections').Counter(['٢٠١٨']))
    assert_eq(c, {'script': 1})
    # one output number explains one loss: two lost 2018s, one 8102
    two = __import__('collections').Counter({'2018': 2})
    assert_eq(arabic.number_causes(two, ['8102'], two), {'reversed': 1, 'unexplained': 1})


test('a lost number\'s cause: other digit script, reversed, split, inside a longer one, unexplained', causes)


def page_furniture():
    C = __import__('collections').Counter
    def body(p):
        return [f'نص الصفحة {"ا" * p} فيه 2024 و 350 دينارا', f'سطر {"ب" * p}', f'سطر {"ت" * p}', f'سطر {"ث" * p}']
    # pages printed 12..16 (page index + 12) under a running header; page 3
    # ends on a body number that doesn't run with the pages
    pages = [['مجلة الأدب — العدد 19', *body(p), f'- {p + 12} -'] for p in range(5)]
    pages[2].append('المجموع 4410')
    f = arabic.furniture('\f'.join('\n'.join(pg) for pg in pages))
    assert_eq((f['19'], f['12'], f['16'], f['2024'], f['350'], f['4410']), (5, 1, 1, 0, 0, 0))
    # a running header whose own page number changes is still one header
    pages = [[f'مجلة الأدب — العدد 19 — ص {p + 300}', *body(p)] for p in range(5)]
    f = arabic.furniture('\f'.join('\n'.join(pg) for pg in pages))
    assert_eq((f['19'], f['300'], f['304']), (5, 1, 1))
    lost = C({'19': 4, '304': 1, '2024': 1})
    trusted = C({'19': 5, '304': 1, '2024': 5, '350': 5})
    assert_eq(arabic.number_causes(lost, [], trusted, f & trusted), {'furniture': 5, 'unexplained': 1})


test('page furniture: a running header\'s numbers and page numbers running with the pages are named, a body number is not', page_furniture)


def list_numbers():
    pp = '\n'.join(['مقدمة الدليل للمستخدمين', ')11لعمل قص للشريحة اضغط بالزر', '12) لعمل لصق للشريحة اضغط',
                    'في سنة 2019 كان العدد 350'])
    plain = docx(['مقدمة'])
    assert_eq(arabic.list_marks(pp, plain), {})            # no Word list in the output: nothing to name
    listed = tempfile.mktemp(suffix='.docx')
    with zipfile.ZipFile(listed, 'w') as z:
        z.writestr('word/document.xml', '<w:document><w:body>' + '<w:p><w:pPr><w:numPr/></w:pPr></w:p>'.replace('<w:numPr/>', '<w:numPr></w:numPr>') * 2
                   + '</w:body></w:document>')
    assert_eq(arabic.list_marks(pp, listed), {'11': 1, '12': 1})   # not 2019, not 350


test('a list item\'s number Word now numbers itself is named, as many as the output has list paragraphs', list_numbers)


def run_statuses():
    docs, files = tempfile.mkdtemp(), tempfile.mkdtemp()
    for name in ('slow.pdf', 'ok.pdf'):
        open(os.path.join(docs, name), 'wb').write(open(os.path.join(FIX, 'ar-short.pdf'), 'rb').read())
    with zipfile.ZipFile(docx(short), 'r') as z, zipfile.ZipFile(os.path.join(files, 'ok.pdf.pdf2word.docx'), 'w') as o:
        o.writestr('word/document.xml', z.read('word/document.xml'))
    results = tempfile.mktemp(suffix='.jsonl')
    with open(results, 'w') as f:
        f.write(json.dumps({'doc': 'slow.pdf', 'tool': 'pdf2word', 'outcome': 'timeout', 'ms': 300000}) + '\n')
        f.write(json.dumps({'doc': 'ok.pdf', 'tool': 'pdf2word', 'outcome': 'ok', 'ms': 4000, 'ocrPages': 0}) + '\n')
    out = tempfile.mktemp(suffix='.jsonl')
    arabic.run(docs, files, out, results)
    head, rows = arabic.load(out)
    assert_eq((rows['slow.pdf']['skip'], rows['slow.pdf']['ms']), ('timeout', 300000))
    assert_eq((rows['ok.pdf']['outcome'], rows['ok.pdf']['ms'], rows['ok.pdf']['ocrPages']), ('ok', 4000, 0))
    assert_true('recall' in rows['ok.pdf'] and rows['ok.pdf']['numbersAgreed'] >= 1, rows['ok.pdf'])
    assert_eq(head['corpus'], arabic.corpus_hash(rows.values()))


test('run: a timeout is its own status; time and OCR pages come from robust.mjs\'s results', run_statuses)


def compare_sets_aside():
    row = {'producer': 'p', 'sha': 's', 'ms': 4000, **right}
    worse = {**row, 'recall': row['recall'] - 0.1, 'dots': row['dots'] + 1}
    base = [{'doc': d, **row} for d in ('known.pdf', 'ocr.pdf', 'slow.pdf', 'broke.pdf', 'fine.pdf')]
    new = [{'doc': 'known.pdf', **worse}, {'doc': 'ocr.pdf', **worse, 'ocrPages': 2},
           {'doc': 'slow.pdf', 'sha': 's', 'skip': 'timeout', 'outcome': 'timeout', 'ms': 300000},
           {'doc': 'broke.pdf', 'sha': 's', 'skip': 'error: x', 'outcome': 'error'}, {'doc': 'fine.pdf', **row, 'ms': 90000}]
    known = tempfile.mktemp(suffix='.json')
    json.dump({'bothWrong': {'known.pdf': 'both read the lam-alef backwards'}, 'unverifiable': {}}, open(known, 'w'))
    text, n = arabic.compare(shard(base), shard(new), known_path=known)
    assert_eq(n, 1)                       # broke.pdf only: failed now
    for s in ('known.pdf: both readers wrong', 'ocr.pdf (2 p.', 'timed out now: 1 — slow.pdf', 'failed now: 1',
              'timed out: 1 — slow.pdf', 'slower than the baseline', 'fine.pdf 4 → 90 s'):
        assert_true(s in text, f'{s!r} not in\n{text}')
    # without the known list the same document is judged worse
    _, n = arabic.compare(shard(base), shard(new), known_path=None)
    assert_eq(n, 2)


test('compare: set-aside and OCR documents are reported, not judged; a timeout warns, a failure is red', compare_sets_aside)


def compare_other_content():
    row = {'producer': 'p', **right}
    text, n = arabic.compare(shard([{'doc': 'a.pdf', 'sha': '1', **row}]),
                             shard([{'doc': 'a.pdf', 'sha': '2', **row, 'recall': 0}]), known_path=None)
    assert_eq(n, 0)
    assert_true('other content' in text, text)


test('compare: a document whose content changed under the same name is not compared', compare_other_content)


def migrate():
    row = {'doc': 'a.pdf', 'sha': '1', 'producer': 'p', **right}
    old = jsonl({**HEAD, 'corpus': 'c'}, [row])
    new = jsonl({**HEAD, 'metric': arabic.METRIC_VERSION + 1, 'corpus': 'c'}, [{**row, 'dots': row['dots'] + 1}])
    text, n = arabic.compare(old, new, migrate=True, known_path=None)
    assert_eq(n, 1)
    assert_true('moved by the new metric: 1' in text, text)
    other = jsonl({**HEAD, 'metric': arabic.METRIC_VERSION + 1, 'corpus': 'd'}, [row])
    assert_eq(arabic.compare(old, other, migrate=True, known_path=None)[1], -1)


test('--migrate: the same outputs under two metric versions — what the new one moves', migrate)


print(f"\n{'─' * 50}\nTests: {passed + failed} | ✓ {passed} | {failed} failed")
sys.exit(1 if failed else 0)
