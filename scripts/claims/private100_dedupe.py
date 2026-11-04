#!/usr/bin/env python3
"""After private100.py: 'Files stay on your device — files never leave your device' says it twice.
<strong>NEW</strong> — <leave clause>  -> the clause becomes 'not uploaded to any server';
NEW — <leave clause> (headings, sentences) -> NEW dropped;  <leave clause> — NEW -> NEW dropped."""
import re, subprocess, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from private100 import NEW, lang_of, cap
LEAVE = r'leave your|verlass|salen|quittent|saem|lasciano|verlaten|opuszcza|покида|出ません|Rời|rời|Meninggalkan|meninggalkan|벗어나|出ず|出る|离开'
NOTUP = {'en': 'not uploaded to any server', 'de': 'kein Upload auf einen Server', 'es': 'no se suben a ningún servidor',
 'fr': 'aucun envoi vers un serveur', 'pt': 'não são enviados a nenhum servidor', 'it': 'nessun caricamento su un server',
 'nl': 'geen upload naar een server', 'pl': 'bez przesyłania na serwer', 'ru': 'без загрузки на сервер',
 'ja': 'サーバーにアップロードされません', 'vi': 'không tải lên máy chủ', 'id': 'tidak diunggah ke server', 'ko': '서버에 업로드되지 않음', 'tr': 'sunucuya yüklenmez', 'zh-CN': '不上传到服务器'}
def main():
    files = subprocess.run(['git', 'diff', '--name-only'], capture_output=True, text=True).stdout.split()
    for p in files:
        lang = lang_of(p)
        if lang not in NEW: continue
        t = open(p, encoding='utf-8').read(); lines = t.split('\n')
        alts = [re.escape(NEW[lang]), re.escape(cap(NEW[lang]))] + (['Files Stay on Your Device'] if lang == 'en' else [])
        N = '(?:' + '|'.join(alts) + ')'
        for i, l in enumerate(lines):
            if not re.search(N, l) or not re.search(LEAVE, l, re.I): continue
            o = l
            l = re.sub(r'(<strong>' + N + r'</strong>\s*—\s*)([^,.<]*(?:' + LEAVE + r')[^,.<]*)', lambda m: m.group(1) + NOTUP[lang], l, flags=re.I)
            if l == o:
                l = re.sub(N + r'\s*—\s*(\S)', lambda m: m.group(1).upper(), l, count=1)
            if l == o:
                l = re.sub(r'\s*—\s*' + N, '', l, count=1)
            print(f'{p}\n  - {o.strip()[:200]}\n  + {l.strip()[:200]}'); lines[i] = l
        open(p, 'w', encoding='utf-8').write('\n'.join(lines))


if __name__ == '__main__': main()
