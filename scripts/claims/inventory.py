#!/usr/bin/env python3
"""Every public claim that can drift, on every built page: counts (OCR languages, tools) in the
14 languages, and absolute promises (privacy, limits, legal, network, offline). Visible text,
<title>/<meta> and JSON-LD. Writes claims.jsonl + prints a summary.
  python3 inventory.py <dist> <out.jsonl>
"""
import html, json, os, re, sys, collections
SKIP = ('corpus-diff', 'benchmark_corpus', 'embed/', 'docs/', 'atlas')
LANG_WORDS = r"(?:languages?|langues|idiomas|Sprachen|lingue|talen|języków|języki|dil(?:i|de)?|ngôn ngữ|bahasa|языков|языка|言語|개\s*언어|개 국어|种语言|種語言|种|لغة|لغات|زبان)"
TOOL_WORDS = r"(?:tools?|outils|herramientas|ferramentas|Werkzeuge|Tools|strumenti|tools|narzędzi|araç|công cụ|alat|инструмент\w*|ツール|개\s*도구|가지\s*도구|款工具|个工具|種工具|أداة|أدوات|ابزار)"
COUNT = re.compile(r'(?<![\d.,])(\d{1,3})\s*\+?\s*(?:[A-Za-zЀ-ӿ]+\s+){0,2}?(' + LANG_WORDS + '|' + TOOL_WORDS + r')', re.I)
ABS = {
  'privacy': r"no data collection|zero data|no tracking|no analytics|we (?:don't|do not|never) collect|collect(?:s)? no data|nothing is (?:sent|collected|tracked)|no cookies",
  'limits': r"no (?:file )?(?:size )?limits?|unlimited|any number of|no restrictions",
  'legal': r"hipaa|gdpr|baa\b|complian(?:t|ce)|structurally guaranteed|no compliance risk|ccpa|soc ?2",
  'network': r"only network requests|(?:the )?only (?:requests?|traffic)|network tab (?:will )?show",
  'offline': r"works? (?:fully |completely )?offline|offline after|no internet (?:needed|required)",
}
def text_of(path):
    s = open(path, encoding='utf-8', errors='ignore').read()
    ld = ' '.join(re.findall(r'<script type="application/ld\+json">(.*?)</script>', s, re.S))
    meta = ' '.join(re.findall(r'<(?:title|meta[^>]+content=")([^<"]*)', s))
    body = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', s, flags=re.S)
    body = html.unescape(re.sub(r'<[^>]+>', ' ', body))
    return {'body': re.sub(r'\s+', ' ', body), 'meta': html.unescape(meta), 'ld': ld}

def main(dist, out):
    rows = []
    for root, _, files in os.walk(dist):
        rel_root = os.path.relpath(root, dist)
        if any(k in rel_root + '/' for k in SKIP): continue
        for f in files:
            if not f.endswith('.html'): continue
            path = os.path.join(root, f); page = '/' + os.path.relpath(path, dist).replace('index.html', '')
            t = text_of(path)
            for where, txt in t.items():
                for m in COUNT.finditer(txt):
                    kind = 'lang_count' if re.match(LANG_WORDS, m.group(2), re.I) else 'tool_count'
                    rows.append({'page': page, 'where': where, 'kind': kind, 'n': int(m.group(1)), 'ctx': txt[max(0, m.start()-50):m.end()+30]})
                for kind, rx in ABS.items():
                    for m in re.finditer(rx, txt, re.I):
                        rows.append({'page': page, 'where': where, 'kind': kind, 'phrase': m.group(0).lower(), 'ctx': txt[max(0, m.start()-70):m.end()+70]})
    with open(out, 'w') as fo:
        for r in rows: fo.write(json.dumps(r, ensure_ascii=False) + '\n')
    c = collections.Counter((r['kind'], r.get('n', r.get('phrase'))) for r in rows)
    pages = collections.defaultdict(set)
    for r in rows: pages[(r['kind'], r.get('n', r.get('phrase')))].add(r['page'])
    for (k, v), n in sorted(c.items(), key=lambda kv: (kv[0][0], -len(pages[kv[0]]))):
        if k in ('lang_count', 'tool_count') or len(pages[(k, v)]) >= 1:
            print(f'{k:11} {str(v)[:40]:40} pages {len(pages[(k, v)]):4}  hits {n}')

if __name__ == '__main__': main(sys.argv[1], sys.argv[2])
