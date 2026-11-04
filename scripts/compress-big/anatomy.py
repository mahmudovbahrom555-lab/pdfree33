#!/usr/bin/env python3
"""Step 2: what a PDF's bytes are. One JSON line per document.
  python3 anatomy.py <pdf>…
"""
import json, os, sys, collections
import fitz

def stream_len(doc, x):
    try: return len(doc.xref_stream_raw(x) or b'')
    except Exception: return 0

def analyse(path):
    doc = fitz.open(path)
    size = os.path.getsize(path)
    kinds = collections.Counter(); imgs = {}
    for x in range(1, doc.xref_length()):
        try: t = doc.xref_get_key(x, 'Subtype')[1]; ty = doc.xref_get_key(x, 'Type')[1]
        except Exception: continue
        n = stream_len(doc, x) if doc.xref_is_stream(x) else 0
        if t == '/Image':
            f = doc.xref_get_key(x, 'Filter')[1]
            w = int(doc.xref_get_key(x, 'Width')[1] or 0); h = int(doc.xref_get_key(x, 'Height')[1] or 0)
            imgs[x] = {'bytes': n, 'filter': f.replace('/', '') or 'none', 'w': w, 'h': h,
                       'cs': doc.xref_get_key(x, 'ColorSpace')[1][:20], 'bpc': doc.xref_get_key(x, 'BitsPerComponent')[1],
                       'smask': doc.xref_get_key(x, 'SMask')[0] != 'null'}
            kinds['images'] += n
        elif t in ('/Type1C', '/CIDFontType0C', '/OpenType') or doc.xref_get_key(x, 'Length1')[0] != 'null' or doc.xref_get_key(x, 'Length2')[0] != 'null':
            kinds['fonts'] += n
        elif n:
            filt = doc.xref_get_key(x, 'Filter')[1]
            raw = 'raw' if filt in ('null', '') else 'filtered'
            if t == '/Form': k = 'forms'
            elif ty == '/XRef' or ty == '/ObjStm': k = 'xref_objstm'
            elif ty == '/Metadata': k = 'metadata'
            elif doc.xref_get_key(x, 'N')[0] != 'null' and doc.xref_get_key(x, 'Alternate')[0] != 'null' or doc.xref_get_key(x, 'N')[0] != 'null' and not ty: k = 'icc'
            elif ty in ('/EmbeddedFile',): k = 'attachments'
            elif ty == '/Pattern' or doc.xref_get_key(x, 'PatternType')[0] != 'null': k = 'patterns'
            else: k = 'content_other'
            kinds[k] += n; kinds['unfiltered'] += n if raw == 'raw' else 0
    # effective dpi per image use (largest use on any page)
    dpi = {}
    for p in doc:
        for info in p.get_image_info(xrefs=True):
            x = info.get('xref')
            if not x or x not in imgs: continue
            bw = (info['bbox'][2] - info['bbox'][0]) / 72; bh = (info['bbox'][3] - info['bbox'][1]) / 72
            if bw > 0.2 and bh > 0.2:
                d = max(imgs[x]['w'] / bw, imgs[x]['h'] / bh)
                dpi[x] = max(dpi.get(x, 0), d)
    for x, d in dpi.items(): imgs[x]['dpi'] = round(d)
    by_filter = collections.Counter(); by_filter_n = collections.Counter()
    for i in imgs.values(): by_filter[i['filter']] += i['bytes']; by_filter_n[i['filter']] += 1
    big = sorted(imgs.values(), key=lambda i: -i['bytes'])[:5]
    pcont = set()
    for p in doc:
        for c in p.get_contents(): pcont.add(c)
    kinds['page_content'] = sum(stream_len(doc, c) for c in pcont)
    text_chars = sum(len(p.get_text()) for p in doc)
    return {'doc': os.path.basename(path), 'MB': round(size / 2**20, 1), 'pages': doc.page_count,
            'producer': (doc.metadata.get('producer') or '')[:40], 'creator': (doc.metadata.get('creator') or '')[:40],
            'share': {k: round(v / size, 3) for k, v in kinds.items()},
            'images': len(imgs), 'img_filters_MB': {k: round(v / 2**20, 1) for k, v in by_filter.most_common()},
            'img_filters_n': dict(by_filter_n), 'text_chars_per_page': round(text_chars / max(1, doc.page_count)),
            'top_images': big}

if __name__ == '__main__':
    for p in sys.argv[1:]:
        try: print(json.dumps(analyse(p), ensure_ascii=False), flush=True)
        except Exception as e: print(json.dumps({'doc': os.path.basename(p), 'error': str(e)[:100]}), flush=True)
