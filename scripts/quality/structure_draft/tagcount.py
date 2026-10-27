import fitz, sys, glob, collections, re, json, os
rows=[]; stats=collections.Counter(); prod=collections.Counter()
for d in sys.argv[2:]:
  for f in sorted(glob.glob(os.path.expanduser(d)+'/*.pdf')):
    try: doc=fitz.open(f)
    except Exception: stats['open_fail']+=1; continue
    stats['docs']+=1
    try:
        if not doc.is_pdf or doc.xref_get_key(doc.pdf_catalog(),'StructTreeRoot')[0]=='null': continue
    except Exception: stats['unreadable']+=1; continue
    types=collections.Counter()
    for x in range(1, min(doc.xref_length(), 300000)):
        try:
            k=doc.xref_get_key(x,'S')
            if k[0]=='name' and doc.xref_get_key(x,'P')[0]=='xref': types[k[1].lstrip('/')]+=1
        except Exception: pass
    h=sum(v for k,v in types.items() if re.fullmatch(r'H\d?',k)); L=types['LI']; T=types['Table']; P=types['P']
    stats['tagged']+=1; stats['tagged_with_P']+= P>0; stats['with_headings']+= h>0; stats['with_lists']+= L>0; stats['with_tables']+= T>0
    p=(doc.metadata or {}).get('producer','') or '?'
    prod[re.split(r'[\s;/(]',p.strip())[0] or '?']+=1
    rows.append({'f':os.path.basename(f),'dir':d,'pages':doc.page_count,'producer':p[:50],'H':h,'LI':L,'Table':T,'P':P,'types':dict(types.most_common(12))})
json.dump(rows,open(sys.argv[1],'w'),ensure_ascii=False,indent=0)
print(dict(stats)); print(prod.most_common(12))
