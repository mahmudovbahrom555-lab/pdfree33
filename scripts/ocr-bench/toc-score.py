# OCR quality on synthetic scans: Han/kana recall (multiset), bigram recall,
# extra share, against the source PDF's own text (truth.json). Prints per doc + totals.
import json, zipfile, re, sys, os, collections, unicodedata
sys.path.insert(0,'/tmp/claude-501/pipdl/lib')
from opencc import OpenCC
_t2s=OpenCC('t2s')
H=re.compile(r'[぀-ヿ㐀-鿿]')
truth=json.load(open('/tmp/claude-501/toc/truth.json'))
def han(s): return H.findall(unicodedata.normalize('NFKC',s))
def docx(p):
    z=zipfile.ZipFile(p); return ''.join(''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>',z.read(n).decode('utf8','replace'))) for n in z.namelist() if re.match(r'word/(document|header\d*|footer\d*)\.xml',n))
files=sys.argv[1]; T=collections.Counter(); rows=[]
for doc,v in sorted(truth.items()):
    t=han(v['text']); p=os.path.join(files,doc+'.pdf2word.docx')
    w=han(docx(p)) if os.path.exists(p) else []
    ct,cw=collections.Counter(t),collections.Counter(w)
    hit=sum((ct&cw).values()); fold=sum((collections.Counter(_t2s.convert(''.join(t)))&collections.Counter(_t2s.convert(''.join(w)))).values()); bt=collections.Counter(zip(t,t[1:])); bw=collections.Counter(zip(w,w[1:]))
    bh=sum((bt&bw).values())
    rows.append((doc,v['lang'],len(t),hit/len(t) if t else 0,bh/max(1,len(t)-1),sum((cw-ct).values())/max(1,len(t)),os.path.exists(p),fold/max(1,len(t))))
    T['t']+=len(t);T['hit']+=hit;T['bt']+=max(0,len(t)-1);T['bh']+=bh;T['extra']+=sum((cw-ct).values());T['missing']+=not os.path.exists(p)
def trad(x):
    x=''.join(x); c=_t2s.convert(x); return sum(a!=b for a,b in zip(x,c))/max(1,len(x))
script_ok=collections.Counter()
for doc,v in sorted(truth.items()):
    if v['lang']!='zh': continue
    t=han(v['text']); p=os.path.join(files,doc+'.pdf2word.docx')
    w=han(docx(p)) if os.path.exists(p) else []
    tt,tw=trad(t)>0.05,trad(w)>0.05
    script_ok['right' if tt==tw else 'WRONG']+=1
    if tt!=tw: print('SCRIPT', doc, 'truth', 'trad' if tt else 'simp', 'ours', 'trad' if tw else 'simp')
print('zh script', dict(script_ok))
for r in rows: print(f'{r[0]} {r[1]} han {r[2]:5d} recall {r[3]:.3f} bigrams {r[4]:.3f} extra {r[5]:.3f}{"" if r[6] else " NO OUTPUT"}')
for lang in ('zh','ja'):
    rs=[r for r in rows if r[1]==lang]; n=sum(r[2] for r in rs)
    print(lang,len(rs),'docs  folded',round(sum(r[7]*r[2] for r in rs)/n,4),'recall',round(sum(r[3]*r[2] for r in rs)/n,4),'bigrams',round(sum(r[4]*r[2] for r in rs)/n,4),'extra',round(sum(r[5]*r[2] for r in rs)/n,4), 'docs<0.9:',sum(r[3]<0.9 for r in rs))
print('ALL recall',round(T['hit']/T['t'],4),'bigrams',round(T['bh']/T['bt'],4),'extra',round(T['extra']/T['t'],4),'no output',T['missing'])
