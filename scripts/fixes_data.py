# SPDX-License-Identifier: AGPL-3.0-only
"""data/fixes.json — the /fixes/ page's data and the rules that keep it honest (used by
scripts/build.py and tests/fixes-data.test.py; no dependencies, so the test runs anywhere).

"fixed" / "partly" only with a live check on pdfree.io, at most two in progress, no document IDs.
A wrong entry fails the build. Competitor names are caught by scripts/check_claims.py, which scans
this file too (one list, not two)."""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXES_JSON = os.path.join(ROOT, 'data', 'fixes.json')
FIXES_TOOLS = {   # section order on the page
    'compress': 'Compress PDF', 'pdf-to-word': 'PDF to Word', 'ocr': 'OCR (scanned PDFs)',
    'clean-scan': 'Clean Scan', 'all': 'All tools',
}
FIXES_TOOL_IDS = {'compress': 'compress', 'pdf2word': 'pdf-to-word', 'ocr': 'ocr', 'cleanScan': 'clean-scan'}   # tools-config id → section


def load_fixes():
    with open(FIXES_JSON, encoding='utf-8') as f:
        data = json.load(f)
    statuses, items, problems = data['statuses'], data['items'], []
    for it in items:
        where = it.get('id', '?')
        for key in ('id', 'tool', 'status', 'date', 'title', 'summary'):
            if not it.get(key): problems.append(f'{where}: no {key}')
        if it.get('status') not in statuses: problems.append(f'{where}: unknown status {it.get("status")!r}')
        if it.get('tool') not in FIXES_TOOLS: problems.append(f'{where}: unknown tool {it.get("tool")!r}')
        if it.get('status') in ('fixed', 'partly') and not it.get('verified'):
            problems.append(f'{where}: "{it["status"]}" needs "verified" (a live check on pdfree.io)')
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', it.get('date', '')): problems.append(f'{where}: date not YYYY-MM-DD')
        text = f"{it.get('title', '')} {it.get('summary', '')}"
        if re.search(r'\b\d{7}\b', text): problems.append(f'{where}: looks like a document ID')
    if sum(it.get('status') == 'in_progress' for it in items) > 2:
        problems.append('more than two items in progress')
    if problems:
        raise SystemExit('data/fixes.json:\n  ' + '\n  '.join(problems))
    return statuses, items
