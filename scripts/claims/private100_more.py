#!/usr/bin/env python3
"""private100 for zh-CN, fa, he, ur, bn (not ar: its SEO re-check runs until 2026-11-16), and the homepage
FAQ 'we have no servers ..., which guarantees 100% privacy' rewritten in every language but ar.
Usage: python3 private100_more.py [--write]"""
import json, re, subprocess, sys
NEW = {'zh-CN': '文件留在您的设备上', 'fa': 'فایل‌ها روی دستگاه شما می‌مانند', 'he': 'הקבצים נשארים במכשיר שלכם',
       'ur': 'فائلیں آپ کے آلے پر رہتی ہیں', 'bn': 'ফাইল আপনার ডিভাইসেই থাকে'}
RX = {'zh-CN': r'(?:从设计上做到 ?)?100\s?%\s?(?:的)?隐私(?:保护|安全)?',
      'fa': r'حریم خصوصی 100٪(?: از طراحی)?', 'he': r'פרטיות של 100%(?: מעצם התכנון)?',
      'ur': r'(?:مکمل )?100% رازداری(?: کے ساتھ)?', 'bn': r'(?:ডিজাইন অনুযায়ী |সম্পূর্ণ )?১০০%\s?গোপনীয়\S*?(?: সাথে)?(?=[\s,।<"—·]|$)'}
PRE = [(r'ופרטיות של 100%', 'והקבצים נשארים במכשיר שלכם'), (r'এবং ১০০% গোপনীয়তার সাথে', 'এবং ফাইল আপনার ডিভাইসেই থাকে'),
       (r'اور 100% رازداری کے ساتھ', 'اور فائلیں آپ کے آلے پر رہتی ہیں')]
SAME = r'离开|יוצאים|خارج نمی|باہر|বাইরে'
FAQ = {
 'en': "No. PDFree processes your PDF files on your device (client-side); they are not uploaded to our servers, so we never store them. The site counts limited technical events without cookies, as described in our Privacy Policy.",
 'es': "No. PDFree procesa tus archivos PDF en tu dispositivo (del lado del cliente); no se suben a nuestros servidores, así que nunca los guardamos. El sitio cuenta eventos técnicos limitados sin cookies, como describe nuestra Política de privacidad.",
 'pt': "Não. O PDFree processa seus arquivos PDF no seu dispositivo (no lado do cliente); eles não são enviados aos nossos servidores, então nunca os armazenamos. O site conta eventos técnicos limitados sem cookies, como descreve nossa Política de Privacidade.",
 'de': "Nein. PDFree verarbeitet deine PDF-Dateien auf deinem Gerät (clientseitig); sie werden nicht auf unsere Server hochgeladen, daher speichern wir sie nie. Die Website zählt begrenzte technische Ereignisse ohne Cookies, wie in unserer Datenschutzerklärung beschrieben.",
 'fr': "Non. PDFree traite vos fichiers PDF sur votre appareil (côté client) ; ils ne sont pas envoyés sur nos serveurs, nous ne les stockons donc jamais. Le site compte des événements techniques limités, sans cookies, comme le décrit notre Politique de confidentialité.",
 'id': "Tidak. PDFree memproses file PDF Anda di perangkat Anda (sisi klien); file tidak diunggah ke server kami, jadi kami tidak pernah menyimpannya. Situs menghitung peristiwa teknis terbatas tanpa cookie, seperti dijelaskan dalam Kebijakan Privasi kami.",
 'vi': "Không. PDFree xử lý file PDF ngay trên thiết bị của bạn (phía client); file không được tải lên server của chúng tôi, nên chúng tôi không bao giờ lưu trữ chúng. Trang web chỉ đếm một số sự kiện kỹ thuật hạn chế, không dùng cookie, như mô tả trong Chính sách quyền riêng tư.",
 'ru': "Нет. PDFree обрабатывает ваши PDF-файлы на вашем устройстве (на стороне клиента); они не загружаются на наши серверы, поэтому мы их никогда не храним. Сайт считает ограниченные технические события без cookies, как описано в нашей Политике конфиденциальности.",
 'ja': "いいえ。PDFreeはPDFファイルをお使いのデバイス上（クライアントサイド）で処理します。ファイルはサーバーにアップロードされないため、当社が保存することはありません。サイトはプライバシーポリシーに記載のとおり、Cookieを使わずに限られた技術的イベントのみを集計します。",
 'it': "No. PDFree elabora i tuoi file PDF sul tuo dispositivo (lato client); non vengono caricati sui nostri server, quindi non li conserviamo mai. Il sito conta eventi tecnici limitati senza cookie, come descritto nella nostra Informativa sulla privacy.",
 'ko': "아니요. PDFree는 PDF 파일을 사용자의 기기(클라이언트 측)에서 처리합니다. 파일은 서버에 업로드되지 않으므로 저희가 저장하는 일은 없습니다. 사이트는 개인정보 처리방침에 설명된 대로 쿠키 없이 제한된 기술 이벤트만 집계합니다.",
 'nl': "Nee. PDFree verwerkt je PDF-bestanden op je apparaat (client-side); ze worden niet naar onze servers geüpload, dus we slaan ze nooit op. De site telt beperkte technische gebeurtenissen zonder cookies, zoals beschreven in ons privacybeleid.",
 'pl': "Nie. PDFree przetwarza Twoje pliki PDF na Twoim urządzeniu (po stronie klienta); nie są przesyłane na nasze serwery, więc nigdy ich nie przechowujemy. Strona zlicza ograniczone zdarzenia techniczne bez plików cookie, jak opisano w naszej Polityce prywatności.",
 'tr': "Hayır. PDFree PDF dosyalarınızı cihazınızda (istemci tarafında) işler; dosyalar sunucularımıza yüklenmez, bu yüzden onları hiçbir zaman saklamayız. Site, Gizlilik Politikamızda açıklandığı gibi çerez kullanmadan sınırlı teknik olayları sayar.",
 'zh-CN': "不会。PDFree 在您的设备上（客户端）处理 PDF 文件；文件不会上传到我们的服务器，因此我们从不存储它们。网站仅统计有限的技术事件，不使用 Cookie，详见我们的隐私政策。",
 'fa': "خیر. PDFree فایل‌های PDF شما را روی دستگاه خودتان (سمت کاربر) پردازش می‌کند؛ فایل‌ها روی سرورهای ما آپلود نمی‌شوند، بنابراین هرگز آن‌ها را ذخیره نمی‌کنیم. سایت همان‌طور که در سیاست حریم خصوصی آمده، بدون کوکی فقط رویدادهای فنی محدودی را می‌شمارد.",
 'he': "לא. PDFree מעבד את קובצי ה-PDF שלכם במכשיר שלכם (בצד הלקוח); הקבצים לא מועלים לשרתים שלנו, ולכן אנחנו אף פעם לא שומרים אותם. האתר סופר אירועים טכניים מוגבלים ללא קובצי Cookie, כמתואר במדיניות הפרטיות שלנו.",
 'ur': "نہیں۔ PDFree آپ کی PDF فائلوں کو آپ کے آلے پر (کلائنٹ سائیڈ) پروسیس کرتا ہے؛ فائلیں ہمارے سرورز پر اپلوڈ نہیں ہوتیں، اس لیے ہم انہیں کبھی محفوظ نہیں کرتے۔ سائٹ ہماری رازداری کی پالیسی کے مطابق کوکیز کے بغیر محدود تکنیکی واقعات شمار کرتی ہے۔",
 'bn': "না। PDFree আপনার PDF ফাইল আপনার ডিভাইসেই (ক্লায়েন্ট-সাইডে) প্রক্রিয়া করে; ফাইল আমাদের সার্ভারে আপলোড হয় না, তাই আমরা কখনো সেগুলো সংরক্ষণ করি না। সাইটটি আমাদের গোপনীয়তা নীতিতে বর্ণিত অনুযায়ী কুকি ছাড়াই সীমিত প্রযুক্তিগত ইভেন্ট গণনা করে।",
}
def fix(s, lang):
    if lang not in NEW: return s
    new = NEW[lang]
    for a, b in PRE: s = re.sub(a, b, s)
    s = re.sub(RX[lang], new, s)
    if new in s and re.search(SAME, s.replace(new, '')):
        o = s
        s = re.sub(r'(<strong>' + re.escape(new) + r'</strong>\s*——?\s*)', r'\1', s)
        s = re.sub(re.escape(new) + r'\s*——?\s*(?=\S)', '', s, count=1) if not s.count('<strong>' + new) else s
        if s == o: s = re.sub(r'\s*——?\s*' + re.escape(new) + r'[。.]?', '。' if lang == 'zh-CN' else '', s, count=1)
    return s
def lang_of(p):
    s = p.split('/')
    l = s[2] if s[0] == 'data' and len(s) > 2 else s[0]
    return 'zh-CN' if l in ('zh', 'zh-CN') else l
def main(write):
    log = []
    files = subprocess.run(['git', 'ls-files', '--', '*.html', '**/*.html', 'data/content/**', ':!dist', ':!tests'], capture_output=True, text=True).stdout.split()
    for p in sorted(set(files)):
        lang = lang_of(p)
        if lang not in NEW: continue
        t = open(p, encoding='utf-8').read(); out = '\n'.join(fix(l, lang) for l in t.split('\n'))
        if out != t:
            for a, b in zip(t.split('\n'), out.split('\n')):
                if a != b: log.append(f'{p} [{lang}]\n  - {a.strip()[:160]}\n  + {b.strip()[:160]}')
            if write: open(p, 'w', encoding='utf-8').write(out)
    p = 'data/tools-config.json'; d = json.load(open(p, encoding='utf-8'))
    def walk(o, lang):
        if isinstance(o, dict): return {k: walk(v, k if k in NEW or k in FAQ or k == 'ar' else lang) for k, v in o.items()}
        if isinstance(o, list): return [walk(v, lang) for v in o]
        if isinstance(o, str):
            n = fix(o, lang)
            if n != o: log.append(f'tools-config [{lang}]\n  - {o[:160]}\n  + {n[:160]}')
            return n
        return o
    d = walk(d, 'en')
    for lang, a in FAQ.items():
        if lang in d['ui']: log.append(f'faqA1 [{lang}]\n  - {d["ui"][lang]["faqA1"][:160]}\n  + {a[:160]}'); d['ui'][lang]['faqA1'] = a
    if write: open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2) + '\n')
    p = 'js/config.js'; t = open(p, encoding='utf-8').read()
    t2 = re.sub(r"""(["']?)(zh-CN|fa|he|ur|bn)\1:\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3""",
                lambda m: m.group(0)[:m.start(4) - m.start(0)] + fix(m.group(4), m.group(2)) + m.group(0)[m.end(4) - m.start(0):], t)
    if t2 != t: log.append('js/config.js: zh-CN/fa/he/ur/bn strings')
    if write: open(p, 'w', encoding='utf-8').write(t2)
    print('\n'.join(log))
if __name__ == '__main__': main('--write' in sys.argv)
