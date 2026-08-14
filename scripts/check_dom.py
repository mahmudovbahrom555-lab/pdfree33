#!/usr/bin/env python3
"""
check_dom.py — Pre-deploy DOM compatibility validator.

Scans every HTML page that loads app.js and verifies required element IDs
are present. Run before every deploy: python3 scripts/check_dom.py

Exit code 0 = all good. Exit code 1 = missing IDs found.
"""

import sys
import re
import json
from pathlib import Path

ROOT = Path(__file__).parent.parent

# Every slug tools-config.json actually generates a Jinja tool page for, across
# all locales — e.g. 'pdf-zeichnen' (draw's DE slug), 'merge-pdf' (merge's EN
# slug). A "<code>/<slug>/index.html" path is only safe to skip as "generated,
# already covered by the template" if <slug> is genuinely one of these —
# otherwise it's a hand-written specialty page that only HAPPENS to live at a
# path shaped like a generated one (see _is_generated_tool_page's docstring).
def _real_tool_slugs() -> set[str]:
    config_path = ROOT / 'data' / 'tools-config.json'
    with open(config_path, encoding='utf-8') as f:
        config = json.load(f)
    slugs = set()
    for tool in config['tools']:
        for slug in tool.get('slugs', {}).values():
            if slug:
                slugs.add(slug)
    return slugs

REAL_TOOL_SLUGS = _real_tool_slugs()

# IDs every page that loads app.js must have.
# Home-page sections (hero, trustAlert, etc.) are NOT required — tool pages
# legitimately omit them, and show()/hide() are now null-safe.
# ↓ When adding a new element to index.html that app.js depends on, add it here too.
REQUIRED_IDS = [
    'logo',
    'toolArea',
    'dropZone',
    'fileInput',
    'chooseFilesBtn',
    'mergeBtn',
    'cancelBtn',
    'fileList',
    'fileCount',
    'progressBar',
    'progressFill',
    'progressLabel',
    'successCard',
    'downloadBtn',
    'toast',
]

# Tool pages must declare PDFREE_INITIAL_TOOL.
# Excludes: root index.html, language homepages (de/index.html etc.),
# and placeholder pages for unimplemented tools.
LANG_CODES = {'de', 'es', 'fr', 'pt', 'id'}
PLACEHOLDER_DIRS = {'annotate-pdf', 'highlight-pdf', 'sign', 'annotate'}

def _is_tool_page(path: Path) -> bool:
    rel   = path.relative_to(ROOT)
    parts = rel.parts
    if len(parts) < 2 or rel.name != 'index.html':
        return False
    parent = parts[0]
    # Language homepage: de/index.html — not a tool page
    if parent in LANG_CODES and len(parts) == 2:
        return False
    # Placeholder / unimplemented tool pages
    slug = parts[-2]
    if slug in PLACEHOLDER_DIRS:
        return False
    return True

def _check_div_tool_cards(text: str) -> list[str]:
    """Tool cards must be <a href>, never <div data-tool>.
    A <div data-tool> card stops working silently when app.js fails to init
    (SW cache miss, CSP error, etc.). <a href> cards work unconditionally.
    Rule: any <div ...data-tool=...class="tool-card"...> or vice versa is an error.
    """
    import re
    # Match <div ...> tags that contain both data-tool= and class="tool-card"
    div_tags = re.findall(r'<div\b[^>]+>', text)
    bad = []
    for tag in div_tags:
        if 'data-tool=' in tag and 'tool-card' in tag:
            bad.append(f'<div> tool card found — use <a href> instead: {tag[:80]}')
    return bad


def check_file(html_path: Path) -> tuple[list[str], list[str]]:
    text = html_path.read_text(encoding='utf-8', errors='replace')
    if 'app.js' not in text:
        return [], []
    missing_ids    = [rid for rid in REQUIRED_IDS if f'id="{rid}"' not in text]
    missing_tool   = []
    if _is_tool_page(html_path) and 'data-tool=' not in text and 'PDFREE_INITIAL_TOOL' not in text:
        missing_tool = ['data-tool attribute not set on <body>']
    bad_cards = _check_div_tool_cards(text)
    missing_theme = []
    if 'theme.js' not in text:
        missing_theme = ['theme.js missing — page will always render with default (dark) theme, ignoring user preference']
    # Hand-written specialty pages (compare-pdf, draw-on-pdf's locale variants,
    # merge-scanned-pdf, etc.) live outside the Jinja tool-page.html template
    # and don't automatically inherit nav updates the way generated tool pages
    # do. This exact gap shipped for real (compare-pdf, draw-on-pdf's DE/ES/
    # FR/PT variants, and 33 more _lang_specialty pages had no way for a user
    # to switch language — some were missing dark mode entirely too, having
    # never included theme.js at all) — caught only by a live user report,
    # not CI, because these paths were being silently skipped below (see
    # the `len(rel_parts) == 3` exclusion in main() — it used to assume ANY
    # "<code>/<slug>/index.html" was Jinja-generated, which was wrong for
    # slugs that aren't real tools-config.json entries).
    # noindex pages are deliberately excluded from this specific check: embed/
    # widgets (embed/compress) have no <nav> at all by design (meant to be
    # embedded inside someone else's page), and 404/doorway-placeholder pages
    # (highlight-pdf) aren't meant to be discovered/browsed the normal way —
    # adding nav chrome to them doesn't serve the thing this check protects
    # against (a real, linked-to page silently losing its language switcher).
    missing_nav = []
    if 'noindex' not in text:
        if 'lang-switch' not in text:
            missing_nav.append('lang-switch missing — language switcher disappears on this page (see js/priorityNav.js\'s sibling .nav-more for the matching "More tools" overflow menu, likely missing too)')
        if 'nav-more' not in text:
            missing_nav.append('nav-more missing — tools beyond the hardcoded nav-links list are unreachable from this page without going back to the homepage')
    return missing_ids, missing_tool + bad_cards + missing_theme + missing_nav


# ── Homepage tool-options-container parity ─────────────────────
#
# Unlike dedicated tool pages (built from scripts/templates/tool-page.html),
# these homepage files are hand-maintained and embed the #toolArea inline —
# reachable via the search widget's file-first flow or any other client-side
# tool switch, WITHOUT a full page load. If a tool's own "#<tool>Options"
# container div isn't physically present here, initToolOptions() hits its
# `if (!container) return` guard and silently no-ops: no options panel, no
# loading, the submit button never gets managed, and the tool looks
# permanently "stuck" — with zero error, because nothing actually threw.
#
# This has bitten three times for real: Clean Scan shipped without its
# container on ANY homepage (root included); Organize/Resize were added to
# root index.html but never back-ported to de/es/fr/pt/id; and then all
# three were missing on ru/ja/ko/it/nl/pl/tr/vi — locales with a genuine,
# fully-functional homepage that CLAUDE.md's "6 languages" summary and an
# earlier hardcoded fix-list both failed to account for. Every one of these
# was only caught by a live user report, not CI.
#
# To make sure a 14th (or 20th) locale homepage can't silently repeat this,
# HOMEPAGE_FILES is discovered rather than hand-maintained: any top-level
# "<code>/index.html" whose content actually embeds the inline tool area
# (id="toolArea" — the same marker check_file() already relies on) counts,
# no matter what locale list any comment or doc happens to mention.
def _discover_homepage_files() -> list[str]:
    files = ['index.html']
    for entry in sorted(ROOT.iterdir()):
        if not entry.is_dir() or entry.name.startswith('.'):
            continue
        if entry.name in ('node_modules', 'dist', 'data', 'blog'):
            continue
        candidate = entry / 'index.html'
        if not candidate.exists():
            continue
        text = candidate.read_text(encoding='utf-8', errors='replace')
        # id="toolSearch" (the hero search widget) only exists on real
        # homepages — every dedicated tool page also has id="toolArea" and
        # id="mergeBtn" (same shared template), so those two alone would
        # wrongly match every one of the ~300 tool-page directories too.
        if 'id="toolSearch"' in text:
            files.append(f'{entry.name}/index.html')
    return files

HOMEPAGE_FILES = _discover_homepage_files()

# Containers that ARE referenced in JS but must NOT be required on homepages:
#   fillOptions     — 'fill' is inline:false in config.js (dedicated page
#                      only, per its own comment: "requires dedicated page
#                      HTML"). js/app.js routes homepage/search uploads for
#                      inline:false tools through a real navigation + IndexedDB
#                      handoff (saveHandoff/restoreHandoff) instead of trying
#                      to render inline — so no homepage container is needed.
#   pdf2pdfaOptions — js/pdf2pdfaUI.js's _ensureContainer() creates this div
#                      dynamically (insertAdjacentElement) if it isn't already
#                      in the DOM, by design (see its own top-of-file comment).
# If you add a new inline:false tool that also has its own JS-referenced
# "#<tool>Options" id, add it here with the same kind of explanation —
# otherwise this check will (correctly) demand it exist on every homepage.
HOMEPAGE_OPTIONS_EXCLUDE = {'fillOptions', 'pdf2pdfaOptions'}

_OPTIONS_ID_REF_RE = re.compile(r"(?:id\(|getElementById\()['\"]([a-zA-Z0-9_-]*Options)['\"]\)")
_OPTIONS_ID_DIV_RE = re.compile(r'id="([a-zA-Z0-9_-]*Options)"')

def _required_options_ids() -> set[str]:
    """Every '#XOptions' container id actually looked up somewhere in js/*.js."""
    ids = set()
    for js_path in sorted((ROOT / 'js').glob('*.js')):
        text = js_path.read_text(encoding='utf-8', errors='replace')
        ids.update(_OPTIONS_ID_REF_RE.findall(text))
    return ids - HOMEPAGE_OPTIONS_EXCLUDE

def check_homepage_options_parity() -> list[tuple[str, list[str]]]:
    required = _required_options_ids()
    errors = []
    for rel in HOMEPAGE_FILES:
        path = ROOT / rel
        if not path.exists():
            continue
        text = path.read_text(encoding='utf-8', errors='replace')
        present = set(_OPTIONS_ID_DIV_RE.findall(text))
        missing = sorted(required - present)
        if missing:
            errors.append((rel, [
                f'missing <div id="{mid}"> — tool is unreachable (silently no-ops) '
                f'via search / SPA navigation on this homepage'
                for mid in missing
            ]))
    return errors


def main():
    errors = []
    html_files = sorted(ROOT.rglob('*.html'))
    checked = 0

    for path in html_files:
        rel_parts = path.relative_to(ROOT).parts
        # Only inspect path segments *inside* the repo — checking out the repo
        # under a dot-prefixed directory (e.g. a .claude/worktrees/* worktree)
        # must not cause every file to be skipped.
        if any(p.startswith('.') or p in ('node_modules', 'dist', 'data') for p in rel_parts):
            continue
        if path.name.endswith('.template.html'):
            continue
        # Skip genuinely Jinja-generated localized tool
        # pages (de/pdf-zusammenfuehren/, es/pdf-a-word/, etc.) — anything whose
        # middle path segment is a real tools-config.json slug, regardless of
        # locale code. NOT just "any <code>/<slug>/index.html shape starting
        # with one of 5 hardcoded codes" — that used to silently wave through
        # hand-written specialty pages (draw-on-pdf's DE/ES/FR/PT variants,
        # merge-scanned-pdf, compress-pdf-for-email, etc.) that only happen to
        # live at a path shaped like a generated one, letting them drift out of
        # sync with the template with zero build-time signal. See check_file()'s
        # lang-switch/nav-more checks for what this exact gap let ship for real.
        if len(rel_parts) == 3 and rel_parts[1] in REAL_TOOL_SLUGS:
            continue
        missing_ids, missing_tool = check_file(path)
        issues = missing_ids + missing_tool
        if issues:
            rel = path.relative_to(ROOT)
            errors.append((str(rel), issues))
        checked += 1

    errors.extend(check_homepage_options_parity())

    if errors:
        print(f'\n[check_dom] FAIL — {len(errors)} page(s) with issues:\n')
        for rel, issues in errors:
            print(f'  {rel}')
            for issue in issues:
                print(f'    ✗  {issue}')
        print(f'\nFix these pages before deploying. ({checked} pages scanned)')
        sys.exit(1)
    else:
        print(f'[check_dom] OK — all {checked} pages pass required-ID check.')
        sys.exit(0)

if __name__ == '__main__':
    main()
