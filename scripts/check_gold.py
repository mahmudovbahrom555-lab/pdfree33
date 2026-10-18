#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""The measuring sticks change only on their own, with a written reason.

The gold pages (tests/corpus/gold/), the frozen Arabic baseline
(tests/corpus/cloud/arabic-baseline.jsonl), the metric that reads them
(scripts/quality/arabic.py), its control cases (tests/quality/,
tests/fixtures/quality/) and this guard decide whether a change is an
improvement. A fix that also edits them can pass by moving the target
(owner rule, 2026-10-17). So a commit that touches them:
  - touches nothing else that converts documents (js/) — and a converter
    commit touches none of them;
  - says why, in a `Gold-Change-Approved: <who, why>` trailer;
  - adds an entry to tests/corpus/GOLD_CHANGELOG.md.

What this is, and is not: an audit trail and a speed bump, not authorization.
Anyone who can push — an agent working under the owner's account included —
can write the trailer and the entry. It makes such a change impossible to make
quietly, alone or by accident; the owner's approval itself is given outside
the repository (the changelog entry names it).

  python3 scripts/check_gold.py                 pre-commit: the staged change
  python3 scripts/check_gold.py --ci <from> <to>   CI: every commit pushed
"""
import os, subprocess, sys

GUARDED = ('tests/corpus/gold/', 'tests/corpus/cloud/arabic-baseline.jsonl', 'scripts/quality/arabic.py',
           'tests/quality/', 'tests/fixtures/quality/', 'scripts/check_gold.py')
CHANGELOG = 'tests/corpus/GOLD_CHANGELOG.md'
TRAILER = 'Gold-Change-Approved:'


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=True).stdout


def problems(files, message):
    guarded = [f for f in files if f.startswith(GUARDED)]
    if not guarded:
        return []
    out = []
    code = [f for f in files if f.startswith('js/')]
    if code:
        out.append('a measuring-stick change and a converter change in one commit — split them: ' + ', '.join(code))
    if message is not None and TRAILER not in message:
        out.append(f'no "{TRAILER} <who, why>" trailer in the commit message')
    if CHANGELOG not in files:
        out.append(f'no entry in {CHANGELOG}')
    return [f'{p}  [{", ".join(guarded)}]' for p in out]


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--ci':
        start, end = sys.argv[2], sys.argv[3]
        if set(start) == {'0'}:          # a new branch: nothing to compare with
            return 0
        bad = 0
        for sha in git('rev-list', '--no-merges', f'{start}..{end}').split():
            files = git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).split()
            msg = git('log', '-1', '--format=%B', sha)
            for p in problems(files, msg):
                print(f'[check_gold] ✗ {sha[:8]}: {p}')
                bad += 1
        print('[check_gold] OK' if not bad else f'[check_gold] {bad} problem(s) — see scripts/check_gold.py')
        return 1 if bad else 0
    staged = git('diff', '--cached', '--name-only').split()
    if not any(f.startswith(GUARDED) for f in staged):
        return 0
    # the message isn't written yet at pre-commit: CI checks the trailer
    found = problems(staged, None)
    if os.environ.get('GOLD_CHANGE_APPROVED') != '1':
        found.insert(0, 'measuring sticks change only with the owner\'s OK — commit with GOLD_CHANGE_APPROVED=1 once given')
    for p in found:
        print(f'[check_gold] ✗ {p}')
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())
