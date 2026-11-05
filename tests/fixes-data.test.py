#!/usr/bin/env python3
"""data/fixes.json — the /fixes/ page's rules hold (scripts/fixes_data.py), checked both
ways: the real file passes; each broken copy is refused.  Run: python3 tests/fixes-data.test.py"""
import copy, json, os, sys, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
import fixes_data  # noqa: E402  (dependency-free: runs before jinja2 is installed)

real = json.load(open(fixes_data.FIXES_JSON, encoding='utf-8'))
passed = failed = 0


def check(name, mutate, ok):
    global passed, failed
    data = copy.deepcopy(real); mutate(data)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as f:
        json.dump(data, f)
    fixes_data.FIXES_JSON = f.name
    try: fixes_data.load_fixes(); accepted = True
    except SystemExit: accepted = False
    finally: os.unlink(f.name)
    good = accepted == ok
    passed += good; failed += not good
    print(f"  {'✓' if good else '✗'} {name}")


def first(data, status): return next(it for it in data['items'] if it['status'] == status)


check('the real file passes', lambda d: None, True)
check('"fixed" without a live check is refused', lambda d: first(d, 'fixed').pop('verified'), False)
check('"partly" without a live check is refused', lambda d: first(d, 'partly').pop('verified'), False)
check('a document ID in a title is refused', lambda d: first(d, 'fixed').update(title='Fixed on 1369728'), False)
check('a third item in progress is refused', lambda d: [it.update(status='in_progress') for it in d['items'][:3]], False)
check('an unknown status is refused', lambda d: first(d, 'released').update(status='done'), False)
check('an unknown tool is refused', lambda d: first(d, 'released').update(tool='merge-tool'), False)
check('a date not YYYY-MM-DD is refused', lambda d: first(d, 'released').update(date='5 Nov'), False)

print(f'\nTests: {passed + failed} | ✓ {passed} | {failed} failed')
sys.exit(1 if failed else 0)
