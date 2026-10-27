#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""scripts/check_gold.py — what a measuring-stick commit must carry (2026-10-18).

The owner's approval is an APPROVED review on the pull request's last commit,
by someone other than its author, holding exactly the tree on main. The
GitHub API is faked here.

Run: python3 tests/quality/test_check_gold.py
"""
import copy, os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'scripts'))
import check_gold as g  # noqa: E402

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


METRIC = ['scripts/quality/arabic.py', g.CHANGELOG]
SHA, HEAD, TREE = 'c0ffee' * 6 + 'c0ff', 'feed' * 10, 'a' * 40
REPO = {
    f'/commits/{SHA}/pulls': [{'number': 31, 'merged_at': '2026-10-19', 'base': {'ref': 'main'},
                               'head': {'sha': HEAD}, 'user': {'login': 'pdfree-bot'}}],
    '/pulls/31/reviews': [{'state': 'APPROVED', 'commit_id': HEAD, 'author_association': 'OWNER',
                           'user': {'login': 'owner'}}],
    f'/commits/{SHA}': {'author': {'login': 'pdfree-bot'}},
    f'/git/commits/{HEAD}': {'tree': {'sha': TREE}},
}


def api(repo):
    return lambda path: copy.deepcopy(repo[path])


def check(repo, tree=TREE):
    return g.approval_problems(SHA, tree, api(repo))


def approved():
    assert check(REPO) == [], check(REPO)


test('a bot\'s pull request the owner approved on its last commit, squash-merged as is: passes', approved)


def new_metric_guarded():
    for f in ('scripts/quality/chinese.py', 'scripts/quality/latin.py', 'scripts/quality/digits.py',
              'tests/corpus/cloud/reserve-v1.json'):
        assert g.problems([f]), f'{f} changed without a changelog entry passed'
        assert g.problems([f, g.CHANGELOG, 'js/processor.js']), f'{f} changed together with js/ passed'
        assert g.problems([f, g.CHANGELOG]) == [], f'{f} with its changelog entry alone was refused'


test('every metric in scripts/quality/ and the reserve set are guarded, not arabic.py alone', new_metric_guarded)


def no_pr():
    r = {**REPO, f'/commits/{SHA}/pulls': []}
    assert any('without a merged pull request' in p for p in check(r))


test('pushed to main without a pull request: refused', no_pr)


def stale():
    r = {**REPO, '/pulls/31/reviews': [{**REPO['/pulls/31/reviews'][0], 'commit_id': 'beef' * 10}]}
    assert any('earlier commit' in p for p in check(r))


test('the owner approved an earlier commit and more was pushed after: refused', stale)


def overridden():
    later = {**REPO['/pulls/31/reviews'][0], 'state': 'CHANGES_REQUESTED'}
    r = {**REPO, '/pulls/31/reviews': REPO['/pulls/31/reviews'] + [later]}
    assert any('no approving review' in p for p in check(r))


test('an approval the owner later replaced by "changes requested": refused', overridden)


def not_owner():
    r = {**REPO, '/pulls/31/reviews': [{**REPO['/pulls/31/reviews'][0], 'author_association': 'COLLABORATOR'}]}
    assert any('no approving review by the owner' in p for p in check(r))


test('approved by a collaborator, not the owner: refused', not_owner)


def self_approved():
    r = {**REPO, f'/commits/{SHA}/pulls': [{**REPO[f'/commits/{SHA}/pulls'][0], 'user': {'login': 'owner'}}],
         f'/commits/{SHA}': {'author': {'login': 'owner'}}}
    assert any('one account' in p for p in check(r))


test('the owner\'s account opened the pull request and approved it itself (agent = owner): refused', self_approved)


def other_tree():
    assert any('not the approved content' in p for p in check(REPO, tree='b' * 40))


test('main holds other content than the approved commit: refused', other_tree)


def other_rules_stay():
    assert g.problems(['js/processor.js']) == []
    assert any('split them' in p for p in g.problems(METRIC + ['js/processor.js']))
    assert any('no entry' in p for p in g.problems(['tests/quality/x.py']))
    assert g.problems(['tests/corpus/cloud/arabic-known.json'])      # the set-aside list is guarded


test('a converter change and a measuring-stick change stay apart; the set-aside list is guarded', other_rules_stay)


def append_only():
    added = '--- a/x\n+++ b/x\n@@ -1,2 +1,4 @@\n # log\n entry\n+\n+new entry\n'
    rewritten = '--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n # log\n-entry\n+entry, reworded\n'
    assert g.removed_lines(added) == []
    assert g.removed_lines(rewritten) == ['-entry']


test('the changelog is append-only: an added entry passes, a reworded one does not', append_only)

print(f"\n{'─' * 50}\nTests: {passed + failed} | ✓ {passed} | {failed} failed")
sys.exit(1 if failed else 0)
