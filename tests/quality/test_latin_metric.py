#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Control cases for scripts/quality/latin.py (2026-10-27).

The metric must see each pain it claims to see: one word lost, two words
glued, one word split, letters spaced apart, a number lost, a paragraph moved,
a paragraph written twice — each on its own counter. A word hyphenated at a
line end in the PDF is the same word as the joined one in the output.

Fixtures: tests/fixtures/quality/en-{prose,hyphen}.pdf, our own text
(latin-metric.json), printed by Chromium. Needs pymupdf and pdftotext.

Run: python3 tests/quality/test_latin_metric.py
"""
import json, os, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'quality'))
import latin  # noqa: E402
import chinese  # noqa: E402

FIX = os.path.join(ROOT, 'tests', 'fixtures', 'quality')
TEXT = json.load(open(os.path.join(FIX, 'latin-metric.json')))
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
    return latin.score(os.path.join(FIX, name + '.pdf'), docx(paragraphs))


prose = TEXT['en-prose']
right = score('en-prose', prose)

print('the right output')
test('scores full on every share', lambda: [assert_eq(right[k], 1.0) for k in ('recall', 'pairs', 'numbers', 'order')])
test('nothing extra, glued, split or spaced',
     lambda: [assert_eq(right[k], 0) for k in ('extra', 'glued', 'split', 'spaced', 'missing', 'numbersMissing')])
test('readers trusted, enough anchors', lambda: (assert_true('readersSuspect' not in right), assert_true(right['anchors'] >= chinese.MIN_ANCHORS)))

print('each pain on its own counter')


def lost():
    r = score('en-prose', [prose[0].replace(' quality', '', 1)] + prose[1:])
    assert_eq(r['missing'], 1)
    assert_true(r['recall'] < 1.0)
test('one word lost: missing 1, recall down', lost)


def glued():
    r = score('en-prose', [prose[0].replace('the quality', 'thequality', 1)] + prose[1:])
    assert_eq(r['glued'], 1)
    assert_true(r['pairs'] < 1.0)
test('two words glued: glued 1, pairs down', glued)


def split():
    r = score('en-prose', [prose[0].replace('document', 'docu ment', 1)] + prose[1:])
    assert_eq(r['split'], 1)
test('one word split: split 1', split)


def spaced():
    r = score('en-prose', [prose[0].replace('This', 'T h i s', 1)] + prose[1:])
    assert_true(r['spaced'] >= 4, r['spaced'])
test('letters spaced apart: spaced up', spaced)


def number():
    r = score('en-prose', prose[:2] + [prose[2].replace('12500 ', '')] + prose[3:])
    assert_eq(r['numbersMissing'], 1)
    assert_eq(r['recall'], 1.0)
test('one number lost: numbers missing 1, recall unchanged', number)


def moved():
    r = score('en-prose', [prose[4]] + prose[:4] + prose[5:])
    assert_true(r['order'] < 1.0 - 0.03, r['order'])
    assert_eq(r['recall'], 1.0)
test('a paragraph moved: order down beyond the tolerance', moved)


def dup():
    r = score('en-prose', prose + prose[:1])
    assert_true(r['extra'] > 15, r['extra'])
test('a paragraph written twice: extra up', dup)

print('reader normalisation')


def hyphen():
    r = score('en-hyphen', TEXT['en-hyphen'])
    assert_eq(r['recall'], 1.0)
    assert_eq(r['split'], 0)
test('a word hyphenated at a line end in the PDF = the joined word in the output', hyphen)

print('compare')


def other_measure():
    base = tempfile.mktemp()
    with open(base, 'w') as f:
        f.write(json.dumps({'measure': 'latin', 'schema': 1, 'metric': 1, 'oracle': {}}) + '\n' + json.dumps({'doc': 'a.pdf', **right}) + '\n')
    zh = tempfile.mktemp()
    with open(zh, 'w') as f:
        f.write(json.dumps({'measure': 'chinese', 'schema': 1, 'metric': 1, 'oracle': {}}) + '\n' + json.dumps({'doc': 'a.pdf', **right}) + '\n')
    try:
        latin.compare(base, zh)
    except SystemExit:
        return
    raise AssertionError('a latin result was compared with a chinese one')
test('results of two different metrics are not compared', other_measure)


def worse_glued():
    base, new = tempfile.mktemp(), tempfile.mktemp()
    head = json.dumps({'measure': 'latin', 'schema': 1, 'metric': 1, 'oracle': {}})
    open(base, 'w').write(head + '\n' + json.dumps({'doc': 'a.pdf', **right}) + '\n')
    open(new, 'w').write(head + '\n' + json.dumps({'doc': 'a.pdf', **{**right, 'glued': right['glued'] + 5}}) + '\n')
    text, failures = latin.compare(base, new, private=True)
    assert_eq(failures, 1)
    assert_true('a.pdf' not in text, text)
test('more glued words than the tolerance: a failure, named nowhere with --private', worse_glued)

print(f'\n{"─" * 40}\nTests: {passed + failed} | ✓ {passed} | {failed} failed')
sys.exit(1 if failed else 0)
