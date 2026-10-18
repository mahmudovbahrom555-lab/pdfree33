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


print(f"\n{'─' * 50}\nTests: {passed + failed} | ✓ {passed} | {failed} failed")
sys.exit(1 if failed else 0)
