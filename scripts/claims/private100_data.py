#!/usr/bin/env python3
"""private100 for the build's data: data/tools-config.json (per-language strings), js/config.js
(lang:"…" pairs) and scripts/build.py. Same wording and the same no-repeat rules as the pages.
Usage: python3 private100_data.py [--write]"""
import json, re, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from private100 import NEW, PRE, RX, cap
from private100_dedupe import NOTUP
BD = r' (?:by design|por diseño|par conception|berdasarkan desain|per design|по дизайну|theo thiết kế|por design|tasarım gereği)'
SAME = (r'leave your|never leave|verlass|salen|quittent|saem|lasciano|verlaten|opuszcza|покида|出ません|出ず|rời|meninggalkan|벗어나'
        r'|rimangono|blijven in|pozostają na|remain|stay in|bleiben in|restent dans|quedan en|ficam no|остаются в|kalır|tetap di|남아|留まり|留在|ayrılmaz|terk etmez|çıkmaz|cihazınızda kalır')
LANGS = set(NEW)
def fix(s, lang):
    if lang not in NEW: return s
    new = NEW[lang]
    for a, b in PRE: s = re.sub(a, b, s)
    def rep(m):
        before = s[:m.start()].rstrip()
        if lang == 'en' and re.match(r'100\s?%\s?Private', m.group(0)) and not m.group(0).endswith('design'): return 'Files Stay on Your Device'
        return cap(new) if (not before or before[-1] in '>"\'.:!?·|(。' or before.endswith('🔒')) else new
    s = RX.sub(rep, s)
    alts = [new, cap(new)] + (['Files Stay on Your Device'] if lang == 'en' else [])
    N = '(?:' + '|'.join(map(re.escape, alts)) + ')'
    s = re.sub(N + '(' + BD + ')', lambda m: m.group(0)[:-len(m.group(1))], s)
    if re.search(N, s) and re.search(SAME, re.sub(N, '', s), re.I):
        o = s
        s = re.sub(r'(<strong>' + N + r'</strong>\s*—\s*)[^,.<]*', lambda m: m.group(1) + NOTUP.get(lang, ''), s)
        if s == o: s = re.sub(N + r'\s*—\s*(\S)', lambda m: m.group(1).upper(), s, count=1)
        if s == o: s = re.sub(r'\s*—\s*' + N, '', s, count=1)
    return s
def walk(o, lang, log):
    if isinstance(o, dict): return {k: walk(v, k if k in LANGS else lang, log) for k, v in o.items()}
    if isinstance(o, list): return [walk(v, lang, log) for v in o]
    if isinstance(o, str):
        n = fix(o, lang)
        if n != o: log.append(f'[{lang}] {o[:150]}\n     -> {n[:150]}')
        return n
    return o
def main(write):
    log = []
    p = 'data/tools-config.json'; d = json.load(open(p, encoding='utf-8'))
    # the ui block is keyed by language one level up (ui/<lang>/heroBadge)
    out = walk(d, 'en', log)
    if write: open(p, 'w', encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
    # js/config.js: { en: '…', es: '…' } and the English default desc: '…'
    p = 'js/config.js'; t = open(p, encoding='utf-8').read()
    def r(m):
        lang = m.group(2) if m.group(2) in LANGS else 'en'
        body = m.group(4); n = fix(body, lang)
        if n != body: log.append(f'[{lang}] {body[:150]}\n     -> {n[:150]}')
        return m.group(0)[:m.start(4) - m.start(0)] + n + m.group(0)[m.end(4) - m.start(0):]
    t2 = re.sub(r"""(?<![\w-])(["']?)([a-z]{2}(?:-CN)?|desc)\1:\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3""", r, t)
    if write: open(p, 'w', encoding='utf-8').write(t2)
    p = 'scripts/build.py'; t = open(p, encoding='utf-8').read()
    t2 = t.replace('"100% private — files never leave your device"', '"Files never leave your device"')
    if t2 != t: log.append('[en] build.py: "100% private — files never leave your device" -> "Files never leave your device"')
    if write: open(p, 'w', encoding='utf-8').write(t2)
    print('\n'.join(log)); print(len(log), 'strings', file=sys.stderr)
if __name__ == '__main__': main('--write' in sys.argv)
