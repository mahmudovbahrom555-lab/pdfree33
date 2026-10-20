import pickle, collections
import shape
L = ('1,4,2,2,1,1,3,?,9,1,2,8,1,?,1,1,2,0,5,0,2,0,4,5,2,?,?,0,2,5,'
     '2,1,1,0,2,7,?,1,1,4,6,4,2,8,6,2,3,3,7,5,9,6,6,9,2,9,7,?,3,3,'
     '?,?,3,6,2,2,6,4,3,2,3,2,0,1,2,3,0,2,1,2,2,8,8,0,5,5,0,9,4,6,'
     '1,3,3,0,6,7,5,9,8,3,4,4,0,4,4,0,5,1,1,3,2,2,9,2,2,6,2,5,2,?').split(',')
items = pickle.load(open('../c4crops/calib.pkl', 'rb'))[:120]
who = collections.Counter(); res = {'calib': [0, 0], 'holdout': [0, 0]}; wrong = []
for i, (it, lab) in enumerate(zip(items, L)):
    if lab == '?': continue
    lab = int(lab)
    who['text' if lab == it['text'] else 'font' if lab == it['fontcmap'] else 'neither'] += 1
    if lab not in (it['text'], it['fontcmap']): continue
    st, sf = shape.score(it['img'], it['rel_h'], it['text']), shape.score(it['img'], it['rel_h'], it['fontcmap'])
    pick = it['text'] if st > sf else it['fontcmap']
    part = 'calib' if i < 60 else 'holdout'           # first half to look at, second half untouched
    res[part][0] += pick == lab; res[part][1] += 1
    if pick != lab: wrong.append((i + 1, it['doc'], it['font'][:16], 'truth', lab, 'text', it['text'], 'font', it['fontcmap'], round(st, 2), round(sf, 2)))
print('who was right:', dict(who))
print('shape picks the right hypothesis:', {k: f'{a}/{b}' for k, (a, b) in res.items()})
for w in wrong: print(' ', w)
by = collections.defaultdict(lambda: collections.Counter())
for it, lab in zip(items, L):
    if lab == '?': continue
    lab = int(lab); by[it['doc']]['text' if lab == it['text'] else 'font' if lab == it['fontcmap'] else 'neither'] += 1
print('per doc:', {d: dict(c) for d, c in by.items()})
