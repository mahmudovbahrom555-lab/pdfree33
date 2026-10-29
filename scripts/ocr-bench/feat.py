import re,os,sys,fitz,numpy as np
def load(p):
    d={}
    if not os.path.exists(p): return d
    for l in open(p):
        m=re.match(r'(\S+)\.pdf (\w+) han\s+(\d+) recall ([\d.]+)',l)
        if m: d[m.group(1)]=float(m.group(4))
    return d
def feats(pdf):
    d=fitz.open(pdf); out=[]
    for i in range(min(2,d.page_count)):
        pm=d[i].get_pixmap(dpi=300,colorspace=fitz.csGRAY)
        g=np.frombuffer(pm.samples,np.uint8).reshape(pm.height,pm.width).astype(np.int16)
        # otsu
        h=np.bincount(g.ravel(),minlength=256).astype(float); p=h/h.sum(); w=np.cumsum(p); mu=np.cumsum(p*np.arange(256)); mt=mu[-1]
        sb=(mt*w-mu)**2/(w*(1-w)+1e-12); t=int(np.argmax(sb))
        ink=g<=t
        if ink.sum()<100: continue
        inner=ink[1:-1,1:-1]&ink[:-2,1:-1]&ink[2:,1:-1]&ink[1:-1,:-2]&ink[1:-1,2:]
        edge=ink[1:-1,1:-1].sum()-inner.sum()
        sw=2*ink.sum()/max(edge,1)
        out.append((sw, float(np.median(g[ink])), float(ink.mean()), float(np.median(g[~ink]))))
    a=np.array(out); return a.mean(0) if len(a) else None
rows=[]
for base,a,b,sets in (('zhocr','F','H2',('clean','rough')),('zhocr2','F','H2r',('clean','rough')),('toc','F','H2r',('clean','rough'))):
    for s in sets:
        A=load(f'{base}/{a}-{s}.score'); B=load(f'{base}/{b}-{s}.score')
        for k in A:
            if k not in B: continue
            pdf=f'{base}/{s}/{k}.pdf'
            if not os.path.exists(pdf): continue
            f=feats(pdf)
            if f is None: continue
            rows.append((base,s,k,B[k]-A[k],*f))
rows.sort(key=lambda r:r[3])
print('base   set   doc        delta  strokeW inkMed inkFrac bgMed')
for r in rows: print('%-6s %-5s %-10s %+.3f  %5.2f  %5.0f  %.3f  %5.0f'%r)
