#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# scripts/corpus-cloud/cache.py — documents from a lasting cache, checked
# against pinned SHA-256s (2026-10-25: a cleared temporary folder turned a
# 60-document control run into 60 harness failures). A fake source stands in
# for the archive: no network.
import hashlib, os, sys, tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'scripts', 'corpus-cloud'))
import cache as C

passed = failed = 0
def test(name, fn):
    global passed, failed
    try:
        fn(); print(f'  ✓ {name}'); passed += 1
    except Exception as e:
        print(f'  ✗ {name}\n    {type(e).__name__}: {e}'); failed += 1

H = lambda b: hashlib.sha256(b).hexdigest()
DOCS = {'a.pdf': b'%PDF-1.4 a', 'b.pdf': b'%PDF-1.4 b'}

def source(docs, calls=None, down=False):
    def fetch(out_dir, names):
        if calls is not None: calls.extend(names)
        if down: raise OSError('connection refused')
        got = []
        for n in names:
            if n in docs:
                open(os.path.join(out_dir, n), 'wb').write(docs[n]); got.append(n)
        return got
    return fetch

def run(fn):
    with tempfile.TemporaryDirectory() as d:
        fn(os.path.join(d, 'cache'), os.path.join(d, 'out'))

print('\ncorpus cache (SHA-256 pinned):')

def first_fetch(cache, out):
    pins = {n: H(b) for n, b in DOCS.items()}
    C.materialize(out, list(DOCS), pins=pins, cache=cache, fetcher=source(DOCS))
    for n, b in DOCS.items():
        p = os.path.join(out, n)
        assert not os.path.islink(p) and open(p, 'rb').read() == b, n
test('documents come checked into the run folder as real files, not links', lambda: run(first_fetch))

def cached_no_fetch(cache, out):
    pins = {n: H(b) for n, b in DOCS.items()}
    C.materialize(out, list(DOCS), pins=pins, cache=cache, fetcher=source(DOCS))
    calls = []
    C.materialize(out + '2', list(DOCS), pins=pins, cache=cache, fetcher=source(DOCS, calls))
    assert calls == [], calls
test('a cached document with the pinned bytes is not fetched again', lambda: run(cached_no_fetch))

def deleted(cache, out):
    pins = {n: H(b) for n, b in DOCS.items()}
    C.materialize(out, list(DOCS), pins=pins, cache=cache, fetcher=source(DOCS))
    os.remove(os.path.join(cache, 'a.pdf'))
    calls = []
    C.materialize(out + '2', list(DOCS), pins=pins, cache=cache, fetcher=source(DOCS, calls))
    assert calls == ['a.pdf'], calls
    assert open(os.path.join(out + '2', 'a.pdf'), 'rb').read() == DOCS['a.pdf']
test('a document deleted from the cache is fetched again', lambda: run(deleted))

def corrupted(cache, out):
    pins = {n: H(b) for n, b in DOCS.items()}
    C.materialize(out, list(DOCS), pins=pins, cache=cache, fetcher=source(DOCS))
    open(os.path.join(cache, 'b.pdf'), 'wb').write(b'garbage')
    C.materialize(out + '2', list(DOCS), pins=pins, cache=cache, fetcher=source(DOCS))
    assert open(os.path.join(cache, 'b.pdf'), 'rb').read() == DOCS['b.pdf']
    assert open(os.path.join(out + '2', 'b.pdf'), 'rb').read() == DOCS['b.pdf']
test('a corrupted cached document is fetched again', lambda: run(corrupted))

def unavailable(cache, out):
    pins = {n: H(b) for n, b in DOCS.items()}
    try:
        C.materialize(out, list(DOCS), pins=pins, cache=cache, fetcher=source(DOCS, down=True))
    except C.SourceUnavailable: return
    raise AssertionError('no SourceUnavailable')
test('an unreachable source is an explicit error', lambda: run(unavailable))

def lacking(cache, out):
    pins = {n: H(b) for n, b in DOCS.items()}
    try:
        C.materialize(out, list(DOCS), pins=pins, cache=cache, fetcher=source({'a.pdf': DOCS['a.pdf']}))
    except C.SourceUnavailable as e:
        assert 'b.pdf' in str(e); return
    raise AssertionError('no SourceUnavailable')
test('a document the source lacks is an explicit error', lambda: run(lacking))

def changed(cache, out):
    pins = {n: H(b) for n, b in DOCS.items()}
    other = dict(DOCS, **{'a.pdf': b'%PDF-1.4 a, edited'})
    try:
        C.materialize(out, list(DOCS), pins=pins, cache=cache, fetcher=source(other))
    except C.SourceChanged as e:
        assert 'a.pdf' in str(e)
        assert not os.path.exists(os.path.join(cache, 'a.pdf')), 'the changed bytes were cached'
        assert pins['a.pdf'] == H(DOCS['a.pdf']), 'the pin moved'
        return
    raise AssertionError('no SourceChanged')
test('other bytes at the source: SourceChanged — never cached, the pin never moves', lambda: run(changed))

def unpinned(cache, out):
    try:
        C.materialize(out, ['a.pdf'], pins={}, cache=cache, fetcher=source(DOCS))
    except C.Unpinned: pass
    else: raise AssertionError('unpinned document taken silently')
    pins = {}
    newly = C.materialize(out, ['a.pdf'], pins=pins, pin_new=True, cache=cache, fetcher=source(DOCS))
    assert newly == {'a.pdf': H(DOCS['a.pdf'])} and pins == newly, (newly, pins)
test('a document with no pin: refused, pinned only with --pin-new', lambda: run(unpinned))

print(f"\n{'─' * 40}\nTests: {passed + failed} | ✓ {passed} | {failed} failed")
sys.exit(1 if failed else 0)
