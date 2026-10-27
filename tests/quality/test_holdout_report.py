#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Control cases for scripts/quality/holdout_report.py (2026-10-27).

The holdout's report must count what got worse, mixed, better or stopped being
scored, per language, exit 1 when anything got worse, and never name a
document — not in the table, not in the notes.

Run: python3 tests/quality/test_holdout_report.py
"""
import contextlib, io, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'scripts', 'quality'))
import holdout_report  # noqa: E402

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


ZH = {'han': 1000, 'lang': 'zh', 'recall': 1.0, 'bigrams': 1.0, 'order': 1.0, 'numbers': 1.0, 'anchors': 50,
      'extra': 0, 'radicals': 0, 'pua': 0, 'hanSpaces': 0, 'readerHanSpaces': 0, 'missing': 0,
      'numbersMissing': 0, 'numbersAgreed': 10}
EN = {'words': 1000, 'recall': 1.0, 'pairs': 1.0, 'order': 1.0, 'numbers': 1.0, 'anchors': 50, 'extra': 0,
      'glued': 0, 'split': 0, 'spaced': 0, 'missing': 0, 'numbersMissing': 0, 'numbersAgreed': 10}
AR = {'words': 1000, 'recall': 1.0, 'order': 1.0, 'dots': 0, 'reversed': 0, 'glued': 0, 'numbersMissing': 0}


def write(measure, rows):
    path = tempfile.mktemp(prefix='secretname-')
    with open(path, 'w') as f:
        f.write(json.dumps({'measure': measure, 'schema': 1, 'metric': 1 if measure != 'arabic' else 6, 'oracle': {}}) + '\n')
        for doc, r in rows:
            f.write(json.dumps({'doc': doc, **r}) + '\n')
    return path


def run(args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = holdout_report.main(args)
    return code, out.getvalue()


zh_base = write('chinese', [('9990001.pdf', ZH), ('9990002.pdf', ZH), ('9990003.pdf', ZH)])
zh_cand = write('chinese', [('9990001.pdf', {**ZH, 'hanSpaces': 1}),          # worse: one Han space (exact)
                            ('9990002.pdf', {**ZH, 'recall': 0.99, 'pua': 0}),
                            ('9990003.pdf', {'han': 1000, 'skip': 'timeout'})])  # no longer scored
en_base = write('latin', [('9990004.pdf', EN)])
en_cand = write('latin', [('9990004.pdf', {**EN, 'glued': 1})])
ar_base = write('arabic', [('9990005.pdf', AR)])
ar_same = write('arabic', [('9990005.pdf', AR)])


def counts():
    code, text = run(['zh', zh_base, zh_cand, 'ar', ar_base, ar_same, 'en', en_base, en_cand])
    assert code == 1, code
    assert '| zh | 3 | 2 | 0 | 1 | 0 | 0 |' in text, text
    assert '| en | 1 | 1 | 0 | 0 | 0 | 0 |' in text, text
    assert '| ar | 1 | 0 | 0 | 0 | 0 | 0 |' in text, text
test('counts per language; one Han space or one glued word is worse (exact); exit 1', counts)


def no_names():
    _, text = run(['zh', zh_base, zh_cand, 'ar', ar_base, ar_same, 'en', en_base, en_cand])
    assert '999000' not in text and 'secretname' not in text, text
test('no document name and no file path in the report', no_names)


def nothing_worse():
    code, text = run(['zh', zh_base, zh_base, 'ar', ar_base, ar_same, 'en', en_base, en_base])
    assert code == 0, code
    assert 'Nothing got worse' in text, text
test('the same results on both sides: exit 0', nothing_worse)

print(f'\n{"─" * 40}\nTests: {passed + failed} | ✓ {passed} | {failed} failed')
sys.exit(1 if failed else 0)
