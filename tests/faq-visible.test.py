# SPDX-License-Identifier: AGPL-3.0-only
# Every question in a page's FAQPage JSON-LD is also on the page people read
# (2026-11-14). Tool pages kept two FAQs — <tool>-faq.json for the markup and a
# hand-written block in <tool>.html — and they drifted: 586 questions were in the
# markup only, some answers said different things. Search engines' structured-data
# rules ask for marked-up content to be visible. Checks the sources, not dist/.
# Run: python3 tests/faq-visible.test.py
import glob, html, json, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SKIP = ('dist/', 'node_modules/', 'tests/', 'embed/', '.claude/')


def norm(s):
    s = re.sub(r'</?(a|strong|em|b|i|span|code|mark)\b[^>]*>', '', s)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s))).strip()


def body(s):
    return norm(re.sub(r'<script.*?</script>', '', s, flags=re.S))


def faq_items(s):
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', s, re.S):
        if '"FAQPage"' not in m.group(1):
            continue
        d = json.loads(m.group(1))
        for x in (d if isinstance(d, list) else d.get('@graph', [d])):
            if isinstance(x, dict) and x.get('@type') == 'FAQPage':
                return x['mainEntity']
    return []


failures, checked = [], 0

# Tool pages: data/content/<lang>/<tool>-faq.json is the markup of <tool>.html
for j in sorted(glob.glob(os.path.join(ROOT, 'data/content/*/*-faq.json'))):
    h = j[:-len('-faq.json')] + '.html'
    if not os.path.exists(h):
        continue
    text = body(open(h, encoding='utf-8').read())
    for it in json.load(open(j, encoding='utf-8')):
        checked += 1
        if norm(it['name']) not in text:
            failures.append(f"{os.path.relpath(h, ROOT)}: {it['name']}")

# Static pages (homepages, landings, blog posts): markup and FAQ in one file
for f in sorted(glob.glob(os.path.join(ROOT, '**/index.html'), recursive=True)):
    rel = os.path.relpath(f, ROOT)
    if rel.startswith(SKIP):
        continue
    s = open(f, encoding='utf-8').read()
    items = faq_items(s)
    if not items:
        continue
    text = body(s)
    for it in items:
        checked += 1
        if norm(it['name']) not in text:
            failures.append(f"{rel}: {it['name']}")

for f in failures[:40]:
    print(f'  ✗ not on the page — {f}')
print(f'\nFAQ questions checked: {checked} | {len(failures)} only in the markup')
sys.exit(1 if failures else 0)
