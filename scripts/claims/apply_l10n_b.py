#!/usr/bin/env python3
"""Approved privacy/legal wording into the newer translated Secure pages
(nl ru tr vi id ja ko), found by content, not line number:
og/twitter description, the FAQ answers about DevTools / data law / medical
records (JSON-LD and the visible copy), the hero line, the badge bar, the
medical card, and the "zero data retention" feature.
Usage: python3 apply_l10n_b.py <lang> <secure.html>"""
import json, re, sys

T = {
'nl': dict(PP='privacybeleid', LAW='AVG',
 GDPR_Q='Wat doet PDFree met mijn gegevens onder de AVG?',
 GDPR_A='Je pdf-bestanden worden in je browser verwerkt en niet naar onze servers geüpload, dus wij hebben de inhoud nooit. De site verzamelt beperkte technische gebruiks- en foutgegevens zonder cookies of blijvende identificatie, zoals ons privacybeleid beschrijft. Wij certificeren geen naleving: of een werkwijze aan je AVG-verplichtingen voldoet, beoordeelt je organisatie.',
 MED_A='Je pdf-bestanden worden in je browser verwerkt en niet naar onze servers geüpload. Wij certificeren geen HIPAA- of AVG-naleving en tekenen geen BAA; of PDFree voor patiëntdossiers past bij je verplichtingen, beslist je organisatie.',
 NET='Je ziet de bestanden die de site nodig heeft om te werken (scripts, stijlen, lettertypen en bij sommige tools bibliotheken of taalmodellen) en kleine technische gebruiks- en foutmeldingen die in ons privacybeleid staan beschreven — nooit je pdf-bestand of de inhoud ervan.',
 DEVTOOLS='Open de DevTools van je browser (F12), ga naar het tabblad Netwerk en gebruik een willekeurige PDFree-tool. Je ziet geen verzoek met je pdf-bestand.',
 OG='Pdf-tools die je bestanden in de browser verwerken — niet geüpload, niet op onze servers opgeslagen.',
 NO_COPIES='Geen kopieën van je bestanden op onze servers',
 HERO='Geen upload · Geen kopieën op onze servers · Geen account',
 B1='✓ Geen cookies, geen blijvende identificatie', B2='✓ Geen account nodig', B3='🚫 Geen advertentietracking, geen verkoop van gegevens',
 CARD='Patiëntgegevens moeten goed beschermd worden. PDFree verwerkt medische dossiers op je apparaat — de bestanden worden niet geüpload.'),
'ru': dict(PP='политике конфиденциальности', LAW='GDPR',
 GDPR_Q='Что PDFree делает с моими данными с точки зрения GDPR?',
 GDPR_A='Ваши PDF-файлы обрабатываются в браузере и не загружаются на наши серверы, поэтому их содержимого у нас нет. Сайт собирает ограниченные технические сведения об использовании и ошибках — без cookie и постоянных идентификаторов, как описано в нашей политике конфиденциальности. Мы не сертифицируем соответствие: отвечает ли такой порядок работы вашим обязательствам по GDPR, оценивает ваша организация.',
 MED_A='Ваши PDF-файлы обрабатываются в браузере и не загружаются на наши серверы. Мы не сертифицируем соответствие HIPAA и не подписываем BAA; подходит ли PDFree для медицинских документов с учётом ваших обязательств, решает ваша организация.',
 NET='Вы увидите файлы, нужные сайту для работы (скрипты, стили, шрифты, а для некоторых инструментов — библиотеки или языковые модели), и небольшие технические события об использовании и ошибках, описанные в нашей политике конфиденциальности, — но никогда ваш PDF-файл или его содержимое.',
 DEVTOOLS='Откройте DevTools браузера (F12), перейдите на вкладку «Сеть» и воспользуйтесь любым инструментом PDFree. Вы не увидите ни одного запроса с вашим PDF-файлом.',
 OG='PDF-инструменты, которые обрабатывают файлы в браузере — без загрузки и хранения на наших серверах.',
 NO_COPIES='Никаких копий ваших файлов на наших серверах',
 HERO='Без загрузки · Без копий на наших серверах · Без аккаунта',
 B1='✓ Без cookie и постоянного идентификатора', B2='✓ Аккаунт не нужен', B3='🚫 Без рекламного трекинга и продажи данных',
 CARD='Данные пациентов требуют строгой защиты. PDFree обрабатывает медицинские документы на вашем устройстве — файлы не загружаются.'),
'tr': dict(PP='Gizlilik Politikamızda', LAW='KVKK/GDPR',
 GDPR_Q='PDFree, KVKK/GDPR açısından verilerimle ne yapıyor?',
 GDPR_A='PDF dosyalarınız tarayıcınızda işlenir ve sunucularımıza yüklenmez; bu yüzden içerikleri hiçbir zaman bizde olmaz. Site, Gizlilik Politikamızda anlatıldığı gibi çerez veya kalıcı tanımlayıcı olmadan sınırlı teknik kullanım ve hata bilgisi toplar. Uyumluluk belgesi vermiyoruz: bir iş akışının KVKK/GDPR yükümlülüklerinizi karşılayıp karşılamadığını kuruluşunuz değerlendirmelidir.',
 MED_A='PDF dosyalarınız tarayıcınızda işlenir ve sunucularımıza yüklenmez. HIPAA uyumluluğu belgelemiyor ve BAA imzalamıyoruz; PDFree\'yi hasta kayıtları için kullanmanın yükümlülüklerinize uyup uymadığına kuruluşunuz karar verir.',
 NET='Sitenin çalışması için gereken dosyaları (betikler, stiller, yazı tipleri ve bazı araçlarda kütüphaneler veya dil modelleri) ve Gizlilik Politikamızda anlatılan küçük teknik kullanım ve hata olaylarını görürsünüz — PDF dosyanızı veya içeriğini asla.',
 DEVTOOLS='Tarayıcınızın DevTools\'unu açın (F12), Ağ sekmesine gidin ve herhangi bir PDFree aracını kullanın. PDF dosyanızı taşıyan hiçbir istek görmezsiniz.',
 OG='Dosyalarınızı tarayıcıda işleyen PDF araçları — yüklenmez, sunucularımızda saklanmaz.',
 NO_COPIES='Dosyalarınızın sunucularımızda kopyası yok',
 HERO='Yükleme yok · Sunucularımızda kopya yok · Hesap yok',
 B1='✓ Çerez yok, kalıcı tanımlayıcı yok', B2='✓ Hesap gerekmez', B3='🚫 Reklam takibi yok, veri satışı yok',
 CARD='Hasta verilerinin sıkı korunması gerekir. PDFree tıbbi kayıtları cihazınızda işler — dosyalar yüklenmez.'),
'vi': dict(PP='Chính sách quyền riêng tư', LAW='GDPR',
 GDPR_Q='PDFree làm gì với dữ liệu của tôi theo GDPR?',
 GDPR_A='Các tệp PDF của bạn được xử lý trong trình duyệt và không được tải lên máy chủ của chúng tôi, nên chúng tôi không bao giờ có nội dung của chúng. Trang web thu thập một ít thông tin kỹ thuật về việc sử dụng và lỗi, không dùng cookie hay mã định danh lâu dài, như mô tả trong Chính sách quyền riêng tư. Chúng tôi không chứng nhận tuân thủ: việc một quy trình có đáp ứng nghĩa vụ GDPR của bạn hay không là do tổ chức của bạn đánh giá.',
 MED_A='Các tệp PDF của bạn được xử lý trong trình duyệt và không được tải lên máy chủ của chúng tôi. Chúng tôi không chứng nhận tuân thủ HIPAA và không ký BAA; việc dùng PDFree cho hồ sơ bệnh nhân có phù hợp với nghĩa vụ của bạn hay không là do tổ chức của bạn quyết định.',
 NET='Bạn sẽ thấy các tệp trang web cần để chạy (script, kiểu, phông chữ và với một số công cụ là thư viện hoặc mô hình ngôn ngữ) cùng các sự kiện kỹ thuật nhỏ về việc sử dụng và lỗi được mô tả trong Chính sách quyền riêng tư — không bao giờ có tệp PDF hay nội dung của nó.',
 DEVTOOLS='Mở DevTools của trình duyệt (F12), vào tab Network rồi dùng bất kỳ công cụ PDFree nào. Bạn sẽ không thấy yêu cầu nào mang tệp PDF của bạn.',
 OG='Công cụ PDF xử lý tệp ngay trong trình duyệt — không tải lên, không lưu trên máy chủ của chúng tôi.',
 NO_COPIES='Không có bản sao tệp của bạn trên máy chủ của chúng tôi',
 HERO='Không tải lên · Không có bản sao trên máy chủ · Không cần tài khoản',
 B1='✓ Không cookie, không mã định danh lâu dài', B2='✓ Không cần tài khoản', B3='🚫 Không theo dõi quảng cáo, không bán dữ liệu',
 CARD='Dữ liệu bệnh nhân cần được bảo vệ chặt chẽ. PDFree xử lý hồ sơ y tế trên thiết bị của bạn — tệp không được tải lên.'),
'id': dict(PP='Kebijakan Privasi', LAW='GDPR',
 GDPR_Q='Apa yang dilakukan PDFree terhadap data saya menurut GDPR?',
 GDPR_A='File PDF Anda diproses di browser dan tidak diunggah ke server kami, jadi kami tidak pernah memiliki isinya. Situs mengumpulkan informasi teknis terbatas tentang penggunaan dan error tanpa cookie atau pengenal permanen, seperti dijelaskan di Kebijakan Privasi kami. Kami tidak memberikan sertifikasi kepatuhan: apakah suatu alur kerja memenuhi kewajiban GDPR Anda dinilai oleh organisasi Anda.',
 MED_A='File PDF Anda diproses di browser dan tidak diunggah ke server kami. Kami tidak memberikan sertifikasi kepatuhan HIPAA dan tidak menandatangani BAA; apakah PDFree cocok untuk rekam medis sesuai kewajiban Anda diputuskan oleh organisasi Anda.',
 NET='Anda akan melihat file yang dibutuhkan situs untuk berjalan (skrip, gaya, font, dan untuk beberapa alat pustaka atau model bahasa) serta peristiwa teknis kecil tentang penggunaan dan error yang dijelaskan di Kebijakan Privasi kami — tidak pernah file PDF Anda atau isinya.',
 DEVTOOLS='Buka DevTools browser Anda (F12), masuk ke tab Network, lalu gunakan alat PDFree mana pun. Anda tidak akan melihat permintaan yang membawa file PDF Anda.',
 OG='Alat PDF yang memproses file di browser — tidak diunggah, tidak disimpan di server kami.',
 NO_COPIES='Tidak ada salinan file Anda di server kami',
 HERO='Tanpa unggah · Tanpa salinan di server kami · Tanpa akun',
 B1='✓ Tanpa cookie, tanpa pengenal permanen', B2='✓ Tidak perlu akun', B3='🚫 Tanpa pelacakan iklan, tanpa penjualan data',
 CARD='Data pasien harus dilindungi ketat. PDFree memproses rekam medis di perangkat Anda — file tidak diunggah.'),
'ja': dict(PP='プライバシーポリシー', LAW='GDPR',
 GDPR_Q='GDPRの観点で、PDFreeは私のデータをどう扱いますか？',
 GDPR_A='PDFファイルはブラウザ内で処理され、当社のサーバーにはアップロードされないため、その内容を当社が持つことはありません。サイトは、プライバシーポリシーに記載のとおり、Cookieや永続的な識別子を使わずに、利用状況とエラーに関する限られた技術情報を収集します。当社は適合性を認証しません。ある作業方法がGDPR上の義務を満たすかどうかは、貴組織が判断してください。',
 MED_A='PDFファイルはブラウザ内で処理され、当社のサーバーにはアップロードされません。当社はHIPAA適合を認証せず、BAAも締結しません。患者記録にPDFreeを使うことが貴組織の義務に合うかどうかは、貴組織が判断します。',
 NET='サイトの動作に必要なファイル（スクリプト、スタイル、フォント、一部のツールではライブラリや言語モデル）と、プライバシーポリシーに記載の小さな利用・エラーの技術イベントが表示されます。PDFファイルやその内容が送られることはありません。',
 DEVTOOLS='ブラウザのDevTools（F12）を開き、［ネットワーク］タブでPDFreeのツールを使ってみてください。PDFファイルを運ぶリクエストは表示されません。',
 OG='ファイルをブラウザ内で処理するPDFツール — アップロードせず、当社サーバーにも保存しません。',
 NO_COPIES='当社サーバーにファイルのコピーなし',
 HERO='アップロードなし · サーバーにコピーなし · アカウント不要',
 B1='✓ Cookieなし・永続的な識別子なし', B2='✓ アカウント不要', B3='🚫 広告トラッキングなし・データ販売なし',
 CARD='患者データは厳重な保護が必要です。PDFreeは医療記録をお使いの端末上で処理します — ファイルはアップロードされません。'),
'ko': dict(PP='개인정보 처리방침', LAW='GDPR',
 GDPR_Q='GDPR 관점에서 PDFree는 내 데이터를 어떻게 다루나요?',
 GDPR_A='PDF 파일은 브라우저에서 처리되며 당사 서버에 업로드되지 않으므로 당사는 그 내용을 갖지 않습니다. 사이트는 개인정보 처리방침에 설명된 대로 쿠키나 영구 식별자 없이 사용 및 오류에 관한 제한된 기술 정보를 수집합니다. 당사는 준수를 인증하지 않습니다. 어떤 작업 방식이 GDPR 의무를 충족하는지는 귀하의 조직이 판단해야 합니다.',
 MED_A='PDF 파일은 브라우저에서 처리되며 당사 서버에 업로드되지 않습니다. 당사는 HIPAA 준수를 인증하지 않으며 BAA를 체결하지 않습니다. 환자 기록에 PDFree를 쓰는 것이 의무에 맞는지는 귀하의 조직이 결정합니다.',
 NET='사이트 실행에 필요한 파일(스크립트, 스타일, 글꼴, 일부 도구의 라이브러리나 언어 모델)과 개인정보 처리방침에 설명된 작은 사용·오류 기술 이벤트가 보입니다. PDF 파일이나 그 내용은 절대 보이지 않습니다.',
 DEVTOOLS='브라우저 DevTools(F12)를 열고 네트워크 탭에서 PDFree 도구를 사용해 보세요. PDF 파일을 담은 요청은 보이지 않습니다.',
 OG='파일을 브라우저에서 처리하는 PDF 도구 — 업로드하지 않고 당사 서버에 저장하지 않습니다.',
 NO_COPIES='당사 서버에 파일 사본 없음',
 HERO='업로드 없음 · 서버에 사본 없음 · 계정 없음',
 B1='✓ 쿠키·영구 식별자 없음', B2='✓ 계정 불필요', B3='🚫 광고 추적·데이터 판매 없음',
 CARD='환자 데이터는 엄격하게 보호되어야 합니다. PDFree는 의료 기록을 사용자 기기에서 처리합니다 — 파일은 업로드되지 않습니다.'),
'it': dict(PP='Informativa sulla privacy', LAW='GDPR',
 GDPR_Q='Cosa fa PDFree con i miei dati ai sensi del GDPR?',
 GDPR_A="I tuoi file PDF vengono elaborati nel browser e non vengono caricati sui nostri server, quindi non ne abbiamo mai il contenuto. Il sito raccoglie informazioni tecniche limitate su utilizzo ed errori, senza cookie né identificatori persistenti, come descritto nella nostra Informativa sulla privacy. Non certifichiamo la conformità: se un flusso di lavoro soddisfa i tuoi obblighi GDPR lo valuta la tua organizzazione.",
 MED_A="I tuoi file PDF vengono elaborati nel browser e non vengono caricati sui nostri server. Non certifichiamo la conformità HIPAA e non firmiamo BAA; se usare PDFree per le cartelle cliniche è compatibile con i tuoi obblighi lo decide la tua organizzazione.",
 NET="Vedrai i file di cui il sito ha bisogno per funzionare (script, stili, font e, per alcuni strumenti, librerie o modelli linguistici) e piccoli eventi tecnici di utilizzo ed errore descritti nella nostra Informativa sulla privacy — mai il tuo file PDF né il suo contenuto.",
 DEVTOOLS="Apri gli strumenti per sviluppatori del browser (F12), vai alla scheda Rete e usa un qualsiasi strumento PDFree. Non vedrai alcuna richiesta con il tuo file PDF.",
 OG='Strumenti PDF che elaborano i tuoi file nel browser — senza caricarli né salvarli sui nostri server.',
 NO_COPIES='Nessuna copia dei tuoi file sui nostri server',
 HERO='Nessun caricamento · Nessuna copia sui nostri server · Nessun account',
 B1='✓ Nessun cookie, nessun identificatore persistente', B2='✓ Nessun account necessario', B3='🚫 Nessun tracciamento pubblicitario, nessuna vendita di dati',
 CARD='I dati dei pazienti vanno protetti con rigore. PDFree elabora le cartelle cliniche sul tuo dispositivo — i file non vengono caricati.'),
'pl': dict(PP='Polityce prywatności', LAW='RODO',
 GDPR_Q='Co PDFree robi z moimi danymi w świetle RODO?',
 GDPR_A='Twoje pliki PDF są przetwarzane w przeglądarce i nie trafiają na nasze serwery, więc nigdy nie mamy ich treści. Serwis zbiera ograniczone informacje techniczne o użyciu i błędach, bez plików cookie i stałych identyfikatorów, jak opisano w Polityce prywatności. Nie certyfikujemy zgodności: czy dany sposób pracy spełnia Twoje obowiązki wynikające z RODO, ocenia Twoja organizacja.',
 MED_A='Twoje pliki PDF są przetwarzane w przeglądarce i nie trafiają na nasze serwery. Nie certyfikujemy zgodności z HIPAA i nie podpisujemy umów BAA; czy używanie PDFree do dokumentacji pacjentów pasuje do Twoich obowiązków, decyduje Twoja organizacja.',
 NET='Zobaczysz pliki potrzebne do działania serwisu (skrypty, style, czcionki, a w niektórych narzędziach biblioteki lub modele językowe) oraz drobne zdarzenia techniczne o użyciu i błędach opisane w Polityce prywatności — nigdy Twojego pliku PDF ani jego treści.',
 DEVTOOLS='Otwórz DevTools przeglądarki (F12), przejdź do karty Sieć i użyj dowolnego narzędzia PDFree. Nie zobaczysz żadnego żądania z Twoim plikiem PDF.',
 OG='Narzędzia PDF, które przetwarzają pliki w przeglądarce — bez przesyłania i bez przechowywania na naszych serwerach.',
 NO_COPIES='Brak kopii Twoich plików na naszych serwerach',
 HERO='Bez przesyłania · Bez kopii na naszych serwerach · Bez konta',
 B1='✓ Bez plików cookie i stałego identyfikatora', B2='✓ Konto niepotrzebne', B3='🚫 Bez śledzenia reklamowego i sprzedaży danych',
 CARD='Dane pacjentów wymagają ścisłej ochrony. PDFree przetwarza dokumentację medyczną na Twoim urządzeniu — pliki nie są przesyłane.'),
}
LAWS = r'GDPR|AVG|KVKK|RODO|DSGVO'
MED = r'HIPAA|PHI|保健|医療|의료|y tế|medis|tıbbi|sağlık|медицин|здоров|gezondheid|medisch'

def main(lang, path):
    t = T[lang]; pp = f'<a href="/privacy/" style="color:var(--green-text);">{t["PP"]}</a>'
    s = open(path, encoding='utf-8').read(); log = []
    s = re.sub(r'(<meta (?:property="og:description"|name="twitter:description")\s+content=")[^"]*(")', lambda m: m.group(1) + t['OG'] + m.group(2), s)
    # FAQ JSON-LD: answers by subject; the visible copy follows each question as <h3>…</h3> then <p>…</p>
    for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', s, re.S):
        data = json.loads(block)
        for q in data.get('mainEntity', []) if isinstance(data, dict) else []:
            name, ans = q.get('name', ''), q.get('acceptedAnswer', {}).get('text', '')
            if 'DevTools' in ans: new_q, new_a = name, t['DEVTOOLS'] + ' ' + t['NET']
            elif re.search(LAWS, name + ans) and not re.search(r'HIPAA|PHI', name): new_q, new_a = t['GDPR_Q'], t['GDPR_A']
            elif re.search(MED, name + ans) and re.search(r'PHI|HIPAA|safe|veilig|安全|안전|sicher|seguro|güvenli|an toàn|aman|безопас', ans, re.I): new_q, new_a = name, t['MED_A']
            else: continue
            s = s.replace(json.dumps(name, ensure_ascii=False)[1:-1], new_q.replace('"', '\\"'), 1) if new_q != name else s
            s = s.replace(json.dumps(ans, ensure_ascii=False)[1:-1], new_a.replace('"', '\\"'), 1)
            log.append(f'FAQ: {name[:40]}')
            # the visible pair
            m = re.search(r'(<h3[^>]*>)' + re.escape(name) + r'(</h3>\s*<p[^>]*>)(.*?)(</p>)', s, re.S)
            if m: s = s[:m.start()] + m.group(1) + new_q + m.group(2) + (new_a if new_a.startswith(t['DEVTOOLS']) else new_a).replace(t['PP'], pp) + m.group(4) + s[m.end():]
    # the DevTools paragraph in the article (has an XHR filter tip)
    s = re.sub(r'(<p>)([^\n]*?XHR[^\n]*?)(</p>)', lambda m: m.group(1) + t['DEVTOOLS'] + ' ' + t['NET'].replace(t['PP'], pp) + m.group(3), s, count=1)
    # hero line: the "x · y · z" line just after the green dot
    s = re.sub(r'(border-radius:50%;display:inline-block;"></span>\s*\n\s*)([^\n<]*·[^\n<]*·[^\n<]*)', lambda m: m.group(1) + t['HERO'], s, count=1)
    # badge bar: items 3–5 of the five spans
    bar = re.search(r'((?:\s*<span style="font-size:13px;color:var\(--text2\);display:flex;align-items:center;gap:6px;">[^<]*</span>){5})', s)
    if bar:
        spans = re.findall(r'<span[^>]*>[^<]*</span>', bar.group(1))
        new = spans[:2] + [re.sub(r'>[^<]*<', '>' + b + '<', sp) for sp, b in zip(spans[2:], (t['B1'], t['B2'], t['B3']))]
        rebuilt = bar.group(1)
        for old, nw in zip(spans, new): rebuilt = rebuilt.replace(old, nw, 1)
        s = s.replace(bar.group(1), rebuilt, 1); log.append('badges')
    # medical card: the <p> after the 🏥 heading
    s = re.sub(r'(🏥[^\n]*\n\s*<p[^>]*>)[^<]*(</p>)', lambda m: m.group(1) + t['CARD'] + m.group(2), s, count=1)
    # featureList: the last item ("zero data retention")
    s = re.sub(r'("featureList":\s*\[[^\]]*?,\s*\n\s*)"[^"]*"(\s*\n\s*\])', lambda m: m.group(1) + '"' + t['NO_COPIES'] + '"' + m.group(2), s, count=1)
    for b in re.findall(r'<script type="application/ld\+json">(.*?)</script>', s, re.S): json.loads(b)
    open(path, 'w', encoding='utf-8').write(s)
    print(lang, '|', ', '.join(log))

if __name__ == '__main__': main(*sys.argv[1:3])
