#!/usr/bin/env python3
"""'100% private (by design)' -> 'files stay on your device' in every language (owner 2026-11-04, option a).
Usage: python3 private100.py [--write]  (run from the repo root; prints every changed line)"""
import re, subprocess, sys
NEW = {
 'en': 'files stay on your device', 'de': 'Dateien bleiben auf deinem Gerät', 'es': 'los archivos se quedan en tu dispositivo',
 'fr': 'les fichiers restent sur votre appareil', 'pt': 'os arquivos ficam no seu dispositivo', 'it': 'i file restano sul tuo dispositivo',
 'nl': 'bestanden blijven op je apparaat', 'pl': 'pliki zostają na Twoim urządzeniu', 'tr': 'dosyalar cihazınızda kalır',
 'vi': 'tệp ở lại trên thiết bị của bạn', 'id': 'file tetap di perangkat Anda', 'ja': 'ファイルは端末内で処理',
 'ko': '파일은 기기에서 처리', 'ru': 'файлы остаются на вашем устройстве', 'zh-CN': '文件留在您的设备上',
}
WORD = r'(?:(?:private|privat|privé|privad|prywatn|gizli|pribadi|приватн|конфиденциальн)\w*|riêng tư|プライベート|비공개|私密)'
# where the phrase is a predicate or part of a sentence, the whole sentence part is rewritten first
PRE = [
 (r'Your documents stay 100\s?% private', 'Your documents stay on your device'),
 (r'Deine Dokumente bleiben 100\s?% privat', 'Deine Dokumente bleiben auf deinem Gerät'),
 (r'Je documenten blijven 100\s?% privé', 'Je documenten blijven op je apparaat'),
 (r'dokumenty pozostają w 100\s?% prywatne', 'dokumenty pozostają na Twoim urządzeniu'),
 (r'documenti restano al 100\s?% privati', 'documenti restano sul tuo dispositivo'),
 (r'остаются на 100\s?% конфиденциальн\w*', 'остаются на вашем устройстве'),
 (r'文書は100\s?%プライベートに保たれます', '文書はサーバーにアップロードされません'),
 (r'문서는 100\s?% 비공개로 유지됩니다', '문서는 서버에 업로드되지 않습니다'),
 (r'您的文档保持 ?100\s?% ?私密', '您的文档不会上传到服务器'),
 (r'20以上の無料PDFツールを、いつまでも、100\s?%プライベートに。', '20以上の無料PDFツール。ファイルは端末内で処理。'),
 (r'20개 이상의 무료 PDF 도구를 영원히, 100\s?% 비공개로\.', '20개 이상의 무료 PDF 도구. 파일은 기기에서 처리.'),
 (r'100\s?%プライベート、(ブラウザ内で処理|ファイルはブラウザから出ません)', r'\1'),
 (r'100\s?% 비공개, 브라우저에서 처리', '브라우저에서 처리'),
 (r'設計上(100\s?%プライベート)', r'\1'), (r'설계부터 (100\s?% 비공개)', r'\1'),
]
RX = re.compile(r'100\s?%\s?' + WORD + r'(?:\s+by\s+design)?', re.I)
LANGS = set(NEW)
def lang_of(p):
    s = p.split('/')
    if s[0] == 'data' and len(s) > 2: return s[2]
    if s[0] == 'js' and len(s) > 2: return s[2].split('.')[0]
    return s[0] if s[0] in LANGS else 'en'
def cap(s): return s[0].upper() + s[1:]
def title_en(s): return 'Files Stay on Your Device'
def main(write):
    files = subprocess.run(['git', 'ls-files', '--', '*.html', '**/*.html', 'data/content/**', 'js/i18n.js', 'js/locales/*.js',
                            'scripts/templates/**', ':!tests', ':!docs', ':!research', ':!packages', ':!dist', ':!seo-content.html'],
                           capture_output=True, text=True).stdout.split()
    n = 0
    for p in sorted(set(files)):
        try: t = open(p, encoding='utf-8').read()
        except (OSError, UnicodeDecodeError): continue
        lang = lang_of(p)
        if lang not in NEW: continue
        new = NEW[lang]
        def rep(m):
            g = m.group(0); before = t[:m.start()].rstrip()
            if lang == 'en' and re.match(r'100\s?%\s?Private', g) and not g.endswith('design'): return title_en(new)
            start = (not before) or before[-1] in '>"\'.:!?·|(' or before.endswith('🔒')
            return cap(new) if start else new
        t0 = t
        for a, b in PRE: t = re.sub(a, b, t)
        out = RX.sub(rep, t)
        if out != t0:
            for a, b in zip(t0.split('\n'), out.split('\n')):
                if a != b: n += 1; print(f'{p} [{lang}]\n  - {a.strip()[:230]}\n  + {b.strip()[:230]}')
            if write: open(p, 'w', encoding='utf-8').write(out)
    print(n, 'lines', file=sys.stderr)
if __name__ == '__main__': main('--write' in sys.argv)
