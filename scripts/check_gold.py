#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""The measuring sticks change only on their own, approved by the owner.

The gold pages (tests/corpus/gold/), the frozen Arabic baseline
(tests/corpus/cloud/arabic-baseline.jsonl) and its set-aside list
(arabic-known.json), the holdout's reserve set (reserve-v1.json), the metrics
that read them (scripts/quality/: Arabic, Chinese, English, the holdout report),
its control cases (tests/quality/, tests/fixtures/quality/) and this guard
decide whether a change is an improvement. A fix that also edits them can
pass by moving the target (owner rule, 2026-10-17). So a commit that touches
them:
  - touches nothing else that converts documents (js/) — and a converter
    commit touches none of them;
  - adds an entry to tests/corpus/GOLD_CHANGELOG.md and removes nothing from
    it: the changelog is append-only;
  - came to main through a pull request the repository owner approved — an
    APPROVED review by an OWNER on that pull request's last commit, from
    someone other than whoever opened it or wrote the commit, and the commit
    on main holds exactly the approved tree (squash merge of an up-to-date
    branch).

Why a review and not a comment (owner, 2026-10-18): a review is tied to one
commit and can't be moved to another; a new push dismisses it (branch
protection: "dismiss stale approvals"); and with the agent on an account of
its own, an OWNER's approval is one the agent cannot give itself. The guard
checks what branch protection enforces, after the fact, and blocks the
deploy if anything got past it.

  python3 scripts/check_gold.py                 pre-commit: the staged change
  python3 scripts/check_gold.py --pr <base> <head> a pull request: the rules, before the review
  python3 scripts/check_gold.py --ci <from> <to>   CI on main: the rules and the owner's approval
"""
import json, os, subprocess, sys, urllib.request

# scripts/quality/ whole, not arabic.py alone (2026-10-27): the Chinese and
# English metrics, the holdout's report and what arabic.py reads its digits and
# glyphs with live there too — CODEOWNERS already covered the folder, this guard
# didn't. The reserve set is where a holdout failure is diagnosed.
GUARDED = ('tests/corpus/gold/', 'tests/corpus/cloud/arabic-baseline.jsonl', 'tests/corpus/cloud/arabic-known.json',
           'tests/corpus/cloud/reserve-v1.json',
           'scripts/quality/', 'tests/quality/', 'tests/fixtures/quality/', 'scripts/check_gold.py')
CHANGELOG = 'tests/corpus/GOLD_CHANGELOG.md'


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=True).stdout


def problems(files):
    guarded = [f for f in files if f.startswith(GUARDED)]
    if not guarded:
        return []
    out = []
    code = [f for f in files if f.startswith('js/')]
    if code:
        out.append('a measuring-stick change and a converter change in one commit — split them: ' + ', '.join(code))
    if CHANGELOG not in files:
        out.append(f'no entry in {CHANGELOG}')
    return [f'{p}  [{", ".join(guarded)}]' for p in out]


def removed_lines(diff):
    """Lines a unified diff of the changelog takes out (it is append-only)."""
    return [l for l in diff.splitlines() if l.startswith('-') and not l.startswith('---')]


def github(repo, token):
    """GET a repository API path, as JSON."""
    def get(path):
        req = urllib.request.Request(f'https://api.github.com/repos/{repo}{path}',
                                     headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'})
        return json.load(urllib.request.urlopen(req, timeout=20))
    return get


def approval_problems(sha, tree, api):
    """What is missing for commit `sha` (tree `tree`) on main to count as
    owner-approved. `api(path)` reads the repository's GitHub API."""
    pulls = [p for p in api(f'/commits/{sha}/pulls') if p.get('merged_at') and p['base']['ref'] == 'main']
    if not pulls:
        return ['came to main without a merged pull request']
    pr = pulls[0]
    head = pr['head']['sha']
    latest = {}
    for r in api(f'/pulls/{pr["number"]}/reviews'):     # in order: a later review overrides an earlier one
        if r['state'] in ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'):
            latest[r['user']['login']] = r
    owners = [r for r in latest.values() if r['state'] == 'APPROVED' and r.get('author_association') == 'OWNER']
    out = []
    on_head = [r for r in owners if r['commit_id'] == head]
    if not owners:
        out.append(f'pull request #{pr["number"]} has no approving review by the owner')
    elif not on_head:
        out.append(f'pull request #{pr["number"]}: the owner approved an earlier commit, not its last one {head[:8]}')
    authors = {pr['user']['login'], (api(f'/commits/{sha}').get('author') or {}).get('login')}
    if on_head and all(r['user']['login'] in authors for r in on_head):
        out.append(f'pull request #{pr["number"]} is approved only by whoever opened it or wrote the commit — the agent and the owner are one account')
    if api(f'/git/commits/{head}')['tree']['sha'] != tree:
        out.append(f'the commit on main is not the approved content of pull request #{pr["number"]} (tree differs from {head[:8]}\'s)')
    return out


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ('--ci', '--pr'):
        start, end = sys.argv[2], sys.argv[3]
        if set(start) == {'0'}:          # a new branch: nothing to compare with
            return 0
        on_main = sys.argv[1] == '--ci'   # a pull request is checked again once merged, with its review
        repo, token = os.environ.get('GITHUB_REPOSITORY'), os.environ.get('GITHUB_TOKEN')
        api = github(repo, token) if repo and token else None
        bad = 0
        for sha in git('rev-list', '--no-merges', f'{start}..{end}').split():
            files = git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).split()
            found = problems(files)
            if CHANGELOG in files:
                cut = removed_lines(git('diff', f'{sha}^', sha, '--', CHANGELOG))
                if cut:
                    found.append(f'{CHANGELOG} is append-only — this commit removes or rewrites {len(cut)} line(s): {cut[0][:80]}')
            if on_main and any(f.startswith(GUARDED) for f in files):
                if api is None:
                    found.append('no GITHUB_REPOSITORY/GITHUB_TOKEN — the owner\'s approval can\'t be checked')
                else:
                    try:
                        found += approval_problems(sha, git('rev-parse', f'{sha}^{{tree}}').strip(), api)
                    except Exception as e:
                        found.append(f'the approval could not be read from GitHub ({e})')
            for p in found:
                print(f'[check_gold] ✗ {sha[:8]}: {p}')
                bad += 1
        print('[check_gold] OK' if not bad else f'[check_gold] {bad} problem(s) — see scripts/check_gold.py')
        return 1 if bad else 0
    staged = git('diff', '--cached', '--name-only').split()
    if not any(f.startswith(GUARDED) for f in staged):
        return 0
    found = problems(staged)
    if CHANGELOG in staged and removed_lines(git('diff', '--cached', '--', CHANGELOG)):
        found.append(f'{CHANGELOG} is append-only — add an entry, change none')
    if git('rev-parse', '--abbrev-ref', 'HEAD').strip() == 'main':
        found.append('measuring sticks change on a branch, through a pull request the owner approves — not on main')
    for p in found:
        print(f'[check_gold] ✗ {p}')
    return 1 if found else 0


if __name__ == '__main__':
    sys.exit(main())
