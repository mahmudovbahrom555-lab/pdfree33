#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Corpus documents from a lasting cache, checked against pinned SHA-256s.

A run's documents used to be links into a temporary folder: cleared to free
disk space, all 60 documents of an Arabic control run went missing and the
runner reported 60 harness failures, not one result (2026-10-25). Here every
document comes from a cache outside temporary folders, is checked against the
SHA-256 pinned for it in tests/corpus/cloud/sha256.json, and is copied — not
linked — into the run's folder.

- missing from the cache, or cached with other bytes: fetched again;
- fetched and still not the pinned bytes: SourceChanged — the source holds
  another document now; it is never taken in its place;
- the source can't be reached, or lacks the document: SourceUnavailable;
- no pin yet: pinned only with --pin-new, and listed; never silently.

  python3 scripts/corpus-cloud/cache.py materialize <out-dir> [--pin-new] 0000123.pdf …
  python3 scripts/corpus-cloud/cache.py materialize <out-dir> --list names.txt

The cache is $PDFREE_CORPUS_CACHE, else ~/.cache/pdfree-corpus. Documents are
never committed (see tests/corpus/README.md); only their names and hashes are.
"""
import hashlib, json, os, shutil, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PINS = os.path.join(HERE, '..', '..', 'tests', 'corpus', 'cloud', 'sha256.json')


class SourceChanged(Exception):
    """The source's document isn't the pinned one."""


class SourceUnavailable(Exception):
    """The source couldn't give the document."""


class Unpinned(Exception):
    """A document with no pinned hash, and --pin-new not given."""


def cache_dir():
    return os.environ.get('PDFREE_CORPUS_CACHE') or os.path.join(os.path.expanduser('~'), '.cache', 'pdfree-corpus')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def load_pins(path=PINS):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_pins(pins, path=PINS):
    with open(path, 'w') as f:
        json.dump(dict(sorted(pins.items())), f, indent=1)
        f.write('\n')


def _default_fetcher(out_dir, names):
    sys.path.insert(0, HERE)
    from fetch import fetch
    return fetch(out_dir, names)


def ensure(names, pins, *, pin_new=False, cache=None, fetcher=_default_fetcher):
    """Paths of `names` in the cache, each the pinned bytes. `pins` gains the
    new ones when `pin_new`. Returns (paths, newly_pinned)."""
    cache = cache or cache_dir()
    os.makedirs(cache, exist_ok=True)
    unpinned = [n for n in names if n not in pins]
    if unpinned and not pin_new:
        raise Unpinned(f'{len(unpinned)} documents have no pinned SHA-256 (run with --pin-new to pin them): {unpinned[:10]}')
    good = lambda n: os.path.exists(os.path.join(cache, n)) and (n not in pins or sha256(os.path.join(cache, n)) == pins[n])
    want = [n for n in names if n in pins and not good(n)] + [n for n in unpinned if not os.path.exists(os.path.join(cache, n))]
    if want:
        # fetched into a scratch folder: a bad fetch never replaces a cached file
        with tempfile.TemporaryDirectory(dir=cache) as tmp:
            try:
                fetcher(tmp, want)
            except Exception as e:
                raise SourceUnavailable(f'source unavailable for {len(want)} documents ({e})') from e
            missing = [n for n in want if not os.path.exists(os.path.join(tmp, n))]
            if missing:
                raise SourceUnavailable(f'the source lacks {len(missing)} documents: {missing[:10]}')
            changed = [n for n in want if n in pins and sha256(os.path.join(tmp, n)) != pins[n]]
            if changed:
                raise SourceChanged(f'{len(changed)} documents differ from their pinned SHA-256 at the source: {changed[:10]}')
            for n in want:
                os.replace(os.path.join(tmp, n), os.path.join(cache, n))
    newly = {}
    for n in unpinned:
        newly[n] = pins[n] = sha256(os.path.join(cache, n))
    return {n: os.path.join(cache, n) for n in names}, newly


def materialize(out_dir, names, **kw):
    """Copies of `names`, checked, in `out_dir` — real files, no links."""
    paths, newly = ensure(names, kw.pop('pins'), **kw)
    os.makedirs(out_dir, exist_ok=True)
    for n, p in paths.items():
        dst = os.path.join(out_dir, n)
        if os.path.islink(dst) or (os.path.exists(dst) and sha256(dst) != sha256(p)):
            os.remove(dst)
        if not os.path.exists(dst):
            shutil.copyfile(p, dst)
    return newly


def main(argv):
    if len(argv) < 3 or argv[1] != 'materialize':
        print(__doc__); return 2
    args = argv[2:]
    pin_new = '--pin-new' in args
    args = [a for a in args if a != '--pin-new']
    if '--list' in args:
        i = args.index('--list')
        with open(args[i + 1]) as f:
            names = [l.strip() for l in f if l.strip()]
        del args[i:i + 2]
    else:
        names = []
    out_dir, names = args[0], names + args[1:]
    pins = load_pins()
    try:
        newly = materialize(out_dir, names, pins=pins, pin_new=pin_new)
    except (SourceChanged, SourceUnavailable, Unpinned) as e:
        print(f'{type(e).__name__}: {e}', file=sys.stderr); return 1
    if newly:
        save_pins(pins)
        print(f'pinned {len(newly)} new documents in {os.path.relpath(PINS)}')
    print(f'{len(names)} documents checked → {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
