import fitz, glob, os, json
B = os.path.dirname(os.path.abspath(__file__))
def imgs(p):
    d = fitz.open(p); return [d.extract_image(x[0])['image'] for pg in d for x in pg.get_images(full=True)]
same, diff = 0, []
for f in sorted(glob.glob(f'{B}/main-C/*.pdf')):
    g = f.replace('/main-C/', '/new-C/')
    if not os.path.exists(g): diff.append(os.path.basename(f) + ' (missing)'); continue
    if imgs(f) == imgs(g): same += 1
    else: diff.append(os.path.basename(f))
tm, tn = json.load(open(f'{B}/main-C/times.json')), json.load(open(f'{B}/new-C/times.json'))
ks = [k for k in tm if isinstance(tm[k], int) and isinstance(tn.get(k), int)]
print('controls identical', same, 'of', same + len(diff), 'changed', diff)
print('time main', sum(tm[k] for k in ks) / 1000, 's  new', sum(tn[k] for k in ks) / 1000, 's  ratio', round(sum(tn[k] for k in ks) / sum(tm[k] for k in ks), 3))
