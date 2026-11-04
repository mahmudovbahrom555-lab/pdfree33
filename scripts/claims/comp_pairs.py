#!/usr/bin/env python3
"""Per-language exact rewrites of comparison sentences (not ar). Applied to every tracked page/content file
of that language; '&' is also tried as '&amp;'. Usage: python3 comp_pairs.py [--write]"""
import re, json, subprocess, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from comp_tables import lang_of
P = {
'de': [('Wie teile ich ein PDF auf iPhone, iPad oder Mac ohne Adobe auf?', 'Wie teile ich ein PDF auf iPhone, iPad oder Mac ohne App auf?'),
       ('kein App-Download oder Adobe Acrobat erforderlich', 'kein App-Download und keine kostenpflichtige Software nötig'),
       ('Dieses Werkzeug ergänzt sie, ganz ohne Acrobat oder andere Desktop-Software.', 'Dieses Werkzeug ergänzt sie, ganz ohne Desktop-Software.')],
'es': [('¿Cómo divido un PDF en iPhone, iPad o Mac sin Adobe Acrobat?', '¿Cómo divido un PDF en iPhone, iPad o Mac sin instalar nada?'),
       ('no se necesita descargar ninguna app ni Adobe Acrobat', 'no se necesita descargar ninguna app ni programa de pago'),
       ('Esta herramienta se la añade, sin necesidad de Acrobat ni de ningún programa de escritorio.', 'Esta herramienta se la añade, sin necesidad de ningún programa de escritorio.')],
'fr': [('Comment diviser un PDF sur iPhone, iPad ou Mac sans Adobe Acrobat ?', 'Comment diviser un PDF sur iPhone, iPad ou Mac sans rien installer ?'),
       ("aucun téléchargement d'app ni Adobe Acrobat requis", "aucune app ni logiciel payant requis"),
       ("Cet outil l'ajoute, sans Acrobat ni logiciel de bureau.", "Cet outil l'ajoute, sans logiciel de bureau.")],
'id': [('Bisakah memisahkan PDF di iPhone atau Android tanpa Adobe?', 'Bisakah memisahkan PDF di iPhone atau Android tanpa aplikasi?'),
       ('tidak diperlukan unduhan aplikasi atau Adobe Acrobat', 'tidak perlu mengunduh aplikasi atau perangkat lunak berbayar'),
       ('Alat ini menambahkannya, tanpa perlu Acrobat atau perangkat lunak desktop apa pun.', 'Alat ini menambahkannya, tanpa perlu perangkat lunak desktop apa pun.')],
'it': [('Questo strumento lo aggiunge, senza bisogno di Acrobat né di alcun software desktop.', 'Questo strumento lo aggiunge, senza bisogno di alcun software desktop.')],
'nl': [('Deze tool voegt die toe, zonder Acrobat of andere desktopsoftware.', 'Deze tool voegt die toe, zonder desktopsoftware.')],
'pt': [('Como divido um PDF no iPhone, iPad ou Mac sem Adobe Acrobat?', 'Como divido um PDF no iPhone, iPad ou Mac sem instalar nada?'),
       ('não é necessário baixar nenhuma app nem o Adobe Acrobat', 'não é necessário baixar nenhuma app nem programa pago'),
       ('Esta ferramenta acrescenta-a, sem precisar do Acrobat nem de qualquer software de desktop.', 'Esta ferramenta acrescenta-a, sem precisar de qualquer software de desktop.')],
'ru': [('Этот инструмент добавляет его, и для этого не нужен ни Acrobat, ни любая другая настольная программа.', 'Этот инструмент добавляет его, и для этого не нужна настольная программа.')],
'tr': [("Bu araç o katmanı ekler; Acrobat'a ya da herhangi bir masaüstü yazılıma gerek yoktur.", 'Bu araç o katmanı ekler; herhangi bir masaüstü yazılıma gerek yoktur.')],
'vi': [('Có thể tách PDF trên iPhone hoặc Android không cần Adobe?', 'Có thể tách PDF trên iPhone hoặc Android không cần cài ứng dụng?'),
       ('không cần tải app hoặc Adobe Acrobat', 'không cần tải app hay phần mềm trả phí'),
       ('Công cụ này bổ sung lớp đó mà không cần Acrobat hay bất kỳ phần mềm máy tính nào.', 'Công cụ này bổ sung lớp đó mà không cần bất kỳ phần mềm máy tính nào.')],
}
# 'free competitors cap it — Sejda's tool, for example, is limited to …' -> keep the first clause only
RESIZE = re.compile(r'\s*(?:—|——)\s*[^.。<]*Sejda[^.。<]*([.。])')
def main(write):
    files = subprocess.run(['git', 'ls-files', '--', '*.html', '**/*.html', 'data/content/**', ':!dist', ':!tests', ':!docs'], capture_output=True, text=True).stdout.split()
    used = set(); n = 0
    for f in files:
        lang = lang_of(f)
        if lang == 'ar': continue
        t = open(f, encoding='utf-8').read(); o = t
        for a, b in P.get(lang, []):
            for x, y in ((a, b), (a.replace('&', '&amp;'), b.replace('&', '&amp;'))):
                if x in t: t = t.replace(x, y); used.add(a)
        if f.endswith('resize.html'): t = RESIZE.sub(lambda m: m.group(1), t)
        if t != o:
            if f.endswith('.json'): json.loads(t)
            for m in re.findall(r'<script type="application/ld\+json">(.*?)</script>', t, re.S): json.loads(m)
            n += 1
            if write: open(f, 'w', encoding='utf-8').write(t)
    print(n, 'files; unused:', [a[:60] for l in P for a, _ in P[l] if a not in used])
if __name__ == '__main__': main('--write' in sys.argv)
