"""Structure ground truth from a tagged PDF (poppler: pdfinfo -struct-text).
blocks(pdf) -> [(role, level, text)] in tag order; role in heading/para/item/cell/caption."""
import re, subprocess, unicodedata
ROLE = {'P': 'para', 'LBody': 'item', 'LI': 'item', 'TD': 'cell', 'TH': 'cell', 'Caption': 'caption', 'H': 'heading', 'Title': 'heading'}
def tree(pdf):
    out = subprocess.run(['pdfinfo', '-struct-text', pdf], capture_output=True, timeout=300).stdout.decode('utf8', 'replace')
    nodes, stack = [], []
    for line in out.split('\n'):
        if not line.strip(): continue
        ind = len(line) - len(line.lstrip(' '))
        s = line.strip()
        if s.startswith('"'):
            txt = s[1:-1] if s.endswith('"') else s[1:]
            for st in reversed(stack):
                st['text'] += txt
                break
            continue
        tag = re.match(r'(\S+)', s).group(1)
        while stack and stack[-1]['ind'] >= ind: stack.pop()
        n = {'tag': tag, 'ind': ind, 'text': '', 'parent': stack[-1] if stack else None, 'kids': []}
        if stack: stack[-1]['kids'].append(n)
        nodes.append(n); stack.append(n)
    return nodes
def gather(n):
    return n['text'] + ''.join(gather(k) for k in n['kids'])
def norm(t):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', t)).strip()
def blocks(pdf):
    out = []
    for n in tree(pdf):
        tag = n['tag']; m = re.fullmatch(r'H(\d)', tag)
        role = 'heading' if m else ROLE.get(tag)
        if not role: continue
        # an element inside another block element of ours is part of it (Span, Link…); LBody inside LI: take LI once
        # inside another block element of ours (a Span in a P, a list in a cell): part of that one
        p, inside = n['parent'], False
        while p:
            if (p['tag'] in ROLE or re.fullmatch(r'H\d', p['tag'])) and not (tag == 'LBody' and p['tag'] == 'LI'):
                inside = True; break
            p = p['parent']
        if inside: continue
        if tag == 'LI' and any(k['tag'] == 'LBody' for k in n['kids']): continue
        level = int(m.group(1)) if m else 0
        if role == 'item':
            d = 0; q = n['parent']
            while q:
                d += q['tag'] == 'L'; q = q['parent']
            level = d
        t = norm(gather(n))
        if t: out.append((role, level, t))
    return out
if __name__ == '__main__':
    import sys, collections
    b = blocks(sys.argv[1])
    print(collections.Counter(r for r, _, _ in b))
    for r, l, t in b[:int(sys.argv[2]) if len(sys.argv) > 2 else 40]: print(f'{r:8} {l} | {t[:90]}')
