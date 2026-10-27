#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Control cases for scripts/quality/chinese.py (2026-10-27).

The metric must see each pain it claims to see: an output with one character
lost, spaces between Han, a radical left in, a private-use character, a number
lost, two paragraphs swapped, must score worse than the right output — on that
pain's own counter. A Kangxi radical in the PDF's text layer is the character
it stands for. And what it can't see is written down here: text a converter
puts in the Word header is not read.

Fixtures: tests/fixtures/quality/{zh-prose,zh-radicals,ja-prose}.pdf, our own
text (chinese-metric.json), printed by Chromium. Outputs are built here as
minimal .docx files. Needs pymupdf and poppler's pdftotext.

Run: python3 tests/quality/test_chinese_metric.py
"""
import json, os, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'quality'))
import chinese  # noqa: E402

FIX = os.path.join(ROOT, 'tests', 'fixtures', 'quality')
TEXT = json.load(open(os.path.join(FIX, 'chinese-metric.json')))
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


def docx(paragraphs, header=None):
    body = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{p}</w:t></w:r></w:p>' for p in paragraphs)
    path = tempfile.mktemp(suffix='.docx')
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('word/document.xml', f'<?xml version="1.0"?><w:document xmlns:w="w"><w:body>{body}</w:body></w:document>')
        if header:
            z.writestr('word/header1.xml', f'<?xml version="1.0"?><w:hdr xmlns:w="w"><w:p><w:r><w:t>{header}</w:t></w:r></w:p></w:hdr>')
    return path


def score(name, paragraphs, **kw):
    return chinese.score(os.path.join(FIX, name + '.pdf'), docx(paragraphs, **kw))


prose = TEXT['zh-prose']
right = score('zh-prose', prose)

print('the right output')
test('scores full on every share', lambda: [assert_eq(right[k], 1.0) for k in ('recall', 'bigrams', 'numbers', 'order')])
test('nothing extra, no radicals, no private use, no Han spaces',
     lambda: [assert_eq(right[k], 0) for k in ('extra', 'radicals', 'pua', 'hanSpaces', 'missing', 'numbersMissing')])
test('Chinese, readers trusted', lambda: (assert_eq(right['lang'], 'zh'), assert_true('readersSuspect' not in right)))
test('enough anchors to judge the order', lambda: assert_true(right['anchors'] >= chinese.MIN_ANCHORS, right['anchors']))

print('each pain on its own counter')


def lost_char():
    r = score('zh-prose', [prose[0].replace('质量', '质', 1)] + prose[1:])
    assert_eq(r['missing'], 1)
    assert_true(r['recall'] < 1.0)
    assert_eq(r['numbersMissing'], 0)
test('one character lost: missing 1, recall down', lost_char)


def spaces():
    r = score('zh-prose', [' '.join(prose[0])] + prose[1:])
    assert_true(r['hanSpaces'] > 20, r['hanSpaces'])
    assert_true(r['bigrams'] < right['bigrams'], (r['bigrams'], right['bigrams']))
    assert_eq(r['recall'], 1.0)
test('letters spaced apart: Han spaces up, bigrams down, recall unchanged', spaces)


def radical_left():
    r = score('zh-prose', [prose[0].replace('一', '⼀', 1)] + prose[1:])
    assert_eq(r['radicals'], 1)
    assert_eq(r['missing'], 1)
test('a Kangxi radical left in the output: radicals 1, the character missing', radical_left)


def pua_left():
    r = score('zh-prose', [prose[0] + ''] + prose[1:])
    assert_eq(r['pua'], 1)
test('a private-use character left in the output: pua 1', pua_left)


def number_lost():
    r = score('zh-prose', prose[:2] + [prose[2].replace('12500', '')] + prose[3:])
    assert_eq(r['numbersMissing'], 1)
    assert_true(r['numbers'] < 1.0)
    assert_eq(r['recall'], 1.0)
test('one number lost: numbers missing 1, recall unchanged', number_lost)


def swapped():
    r = score('zh-prose', [prose[4]] + prose[:4] + prose[5:])
    assert_true(r['order'] < 1.0 - 0.03, r['order'])
    assert_eq(r['recall'], 1.0)
test('a paragraph moved: order down beyond the tolerance, recall unchanged', swapped)


def lines_as_paragraphs():
    cut = [p[i:i + 12] for p in prose for i in range(0, len(p), 12)]
    r = score('zh-prose', cut)
    assert_true(r['brokenParas'] > right['brokenParas'], (r['brokenParas'], right['brokenParas']))
test('lines left as paragraphs: brokenParas up (reported, not judged)', lines_as_paragraphs)


def duplicated():
    r = score('zh-prose', prose + prose[:1])
    assert_true(r['extra'] > 20, r['extra'])
test('a paragraph written twice: extra up', duplicated)

print('reader normalisation')


def radicals_in_pdf():
    line = TEXT['zh-radicals'][0]
    r = score('zh-radicals', [line.replace('⼀', '一').replace('⼈', '人')])
    assert_eq(r['recall'], 1.0)
    assert_eq(r['radicals'], 0)
    r2 = score('zh-radicals', [line])
    assert_eq(r2['radicals'], 2)
    assert_eq(r2['missing'], 2)
test('a radical in the PDF text layer is the character it stands for', radicals_in_pdf)


def japanese():
    r = score('ja-prose', TEXT['ja-prose'])
    assert_eq(r['lang'], 'ja')
    assert_eq(r['recall'], 1.0)
test('kana make it Japanese', japanese)

print('compare')


def write(rows, path):
    with open(path, 'w') as f:
        f.write(json.dumps({'schema': chinese.SCHEMA, 'metric': chinese.METRIC_VERSION, 'oracle': {'x': 1}, 'corpus': 'c'}) + '\n')
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    return path


base = write([{'doc': 'a.pdf', **right}, {'doc': 'b.pdf', **right}, {'doc': 'c.pdf', **right}], tempfile.mktemp())
worse_b = {'doc': 'b.pdf', **{**right, 'recall': 0.9}}
mixed_c = {'doc': 'c.pdf', **{**right, 'numbers': 0.5}}   # numbers worse, radicals 5 → 0 better
mixed_base = write([{'doc': 'a.pdf', **right}, {'doc': 'b.pdf', **right}, {'doc': 'c.pdf', **{**right, 'radicals': 5}}], tempfile.mktemp())
new = write([{'doc': 'a.pdf', **right}, worse_b, mixed_c], tempfile.mktemp())


def compare_counts():
    text, failures = chinese.compare(mixed_base, new)
    assert_eq(failures, 2)
    assert_true('WORSE b.pdf' in text and 'MIXED c.pdf' in text, text)
test('worse and mixed both fail; better never makes up for them', compare_counts)


def compare_private():
    text, failures = chinese.compare(mixed_base, new, private=True)
    assert_eq(failures, 2)
    assert_true('b.pdf' not in text and 'c.pdf' not in text, text)
test('--private: the same verdict, no document names', compare_private)


def compare_same():
    text, failures = chinese.compare(base, base)
    assert_eq(failures, 0)
test('a result against itself: nothing fails', compare_same)


def other_version():
    other = write([{'doc': 'a.pdf', **right}], tempfile.mktemp())
    rows = open(other).read().split('\n', 1)
    open(other, 'w').write(json.dumps({'schema': chinese.SCHEMA, 'metric': chinese.METRIC_VERSION + 1, 'oracle': {'x': 1}}) + '\n' + rows[1])
    try:
        chinese.compare(base, other)
    except SystemExit:
        return
    raise AssertionError('two metric versions were compared')
test('two metric versions are not compared', other_version)

def exact_mode():
    tiny = write([{'doc': 'a.pdf', **{**right, 'hanSpaces': right['hanSpaces'] + 1}}], tempfile.mktemp())
    _, loose = chinese.compare(base, tiny)
    _, strict = chinese.compare(base, tiny, exact_mode=True)
    assert_eq((loose, strict), (0, 1))
test('--exact: one more Han space fails; with the tolerance it passes', exact_mode)

print('written-down limits (what it cannot see)')


def header_not_read():
    r = score('zh-prose', prose[1:], header=prose[0])
    assert_true(r['missing'] > 0, r['missing'])
test('text moved into the Word header scores as missing (docx_text reads document.xml only)', header_not_read)

print(f'\n{"─" * 40}\nTests: {passed + failed} | ✓ {passed} | {failed} failed')
sys.exit(1 if failed else 0)
