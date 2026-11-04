#!/usr/bin/env python3
"""Fill FAQ 'How is this different from Adobe's free Fill & Sign?' in every language (not ar)."""
import re, json, glob
Q = {'de': ('Was unterscheidet das von Adobes kostenlosem Fill & Sign?', 'Was unterscheidet das von kostenlosen Cloud-Diensten zum Ausfüllen und Unterschreiben?'),
 'es': ('¿En qué se diferencia esto de Fill & Sign gratuito de Adobe?', '¿En qué se diferencia de los servicios gratuitos en la nube para rellenar y firmar?'),
 'fr': ("En quoi est-ce différent de l'outil gratuit Fill & Sign d'Adobe ?", 'En quoi est-ce différent des services cloud gratuits pour remplir et signer ?'),
 'id': ('Apa bedanya dengan Fill & Sign gratis dari Adobe?', 'Apa bedanya dengan layanan cloud gratis untuk mengisi dan menandatangani?'),
 'it': ('In cosa è diverso da Fill & Sign gratuito di Adobe?', 'In cosa è diverso dai servizi cloud gratuiti per compilare e firmare?'),
 'ja': ('Adobeの無料Fill & Signとは何が違いますか？', '無料のクラウド記入・署名サービスとは何が違いますか？'),
 'ko': ('Adobe의 무료 Fill & Sign과 무엇이 다른가요?', '무료 클라우드 작성·서명 서비스와 무엇이 다른가요?'),
 'nl': ("Wat is het verschil met Adobe's gratis Fill & Sign?", 'Wat is het verschil met gratis clouddiensten om in te vullen en te ondertekenen?'),
 'pl': ('Czym różni się to od darmowego Fill & Sign od Adobe?', 'Czym różni się to od darmowych usług w chmurze do wypełniania i podpisywania?'),
 'pt': ('Qual a diferença em relação ao Fill & Sign gratuito da Adobe?', 'Qual a diferença em relação aos serviços gratuitos na nuvem para preencher e assinar?'),
 'ru': ('Чем это отличается от бесплатного Fill & Sign от Adobe?', 'Чем это отличается от бесплатных облачных сервисов для заполнения и подписи?'),
 'tr': ("Bu, Adobe'nin ücretsiz Fill & Sign aracından ne bakımdan farklı?", 'Bu, ücretsiz bulut doldurma ve imzalama hizmetlerinden ne bakımdan farklı?'),
 'vi': ('Điều này khác gì so với Fill & Sign miễn phí của Adobe?', 'Điều này khác gì so với các dịch vụ điền và ký miễn phí trên đám mây?'),
 'zh-CN': ('这与 Adobe 的免费 Fill & Sign 有什么不同？', '这与免费的云端填写和签署服务有什么不同？')}
A = {'de': ('Adobes Fill & Sign ist kostenlos, um ein eigenes PDF auszufüllen und zu unterschreiben — erfordert dafür aber ein kostenloses Adobe-Konto und lädt die Datei auf Adobes Server hoch.', 'Kostenlose Cloud-Dienste zum Ausfüllen und Unterschreiben verlangen meist ein Konto und laden die Datei auf ihre Server hoch.'),
 'es': ('Fill & Sign de Adobe es gratis para rellenar y firmar tu propio PDF, pero requiere una cuenta gratuita de Adobe y sube tu archivo a los servidores de Adobe.', 'Los servicios gratuitos en la nube para rellenar y firmar suelen pedir una cuenta y suben tu archivo a sus servidores.'),
 'fr': ("Fill & Sign d'Adobe est gratuit pour remplir et signer votre propre PDF, mais nécessite un compte Adobe gratuit et envoie votre fichier sur les serveurs d'Adobe.", 'Les services cloud gratuits pour remplir et signer demandent en général un compte et envoient votre fichier sur leurs serveurs.'),
 'id': ('Fill & Sign dari Adobe gratis untuk mengisi dan menandatangani PDF Anda sendiri, tetapi mengharuskan akun Adobe gratis dan mengunggah file Anda ke server Adobe.', 'Layanan cloud gratis untuk mengisi dan menandatangani biasanya meminta akun dan mengunggah file Anda ke server mereka.'),
 'it': ('Fill & Sign di Adobe è gratuito per compilare e firmare il proprio PDF, ma richiede un account Adobe gratuito e carica il file sui server di Adobe.', 'I servizi cloud gratuiti per compilare e firmare di solito richiedono un account e caricano il file sui loro server.'),
 'ja': ('Adobe Fill & Signは自分のPDFに記入・署名するだけなら無料ですが、無料のAdobeアカウントが必要で、ファイルはAdobeのサーバーにアップロードされます。', '無料のクラウド記入・署名サービスは、多くの場合アカウントが必要で、ファイルはサービスのサーバーにアップロードされます。'),
 'ko': ('Adobe Fill & Sign은 본인의 PDF를 작성하고 서명하는 것은 무료지만, 무료 Adobe 계정이 필요하고 파일이 Adobe 서버로 업로드됩니다.', '무료 클라우드 작성·서명 서비스는 대개 계정이 필요하고 파일이 서비스의 서버로 업로드됩니다.'),
 'nl': ("Adobe's Fill & Sign is gratis om je eigen PDF in te vullen en te ondertekenen, maar vereist een gratis Adobe-account en uploadt je bestand naar Adobe's servers.", 'Gratis clouddiensten om in te vullen en te ondertekenen vragen meestal een account en uploaden je bestand naar hun servers.'),
 'pl': ('Fill & Sign od Adobe jest darmowy do wypełniania i podpisywania własnego pliku PDF, ale wymaga darmowego konta Adobe i przesyła plik na serwery Adobe.', 'Darmowe usługi w chmurze do wypełniania i podpisywania zwykle wymagają konta i przesyłają plik na swoje serwery.'),
 'pt': ('O Fill & Sign da Adobe é gratuito para preencher e assinar seu próprio PDF, mas exige uma conta Adobe gratuita e envia seu arquivo para os servidores da Adobe.', 'Os serviços gratuitos na nuvem para preencher e assinar costumam exigir uma conta e enviam seu arquivo para os servidores deles.'),
 'ru': ('Fill & Sign от Adobe бесплатен для заполнения и подписания собственного PDF, но требует бесплатный аккаунт Adobe и загружает файл на серверы Adobe.', 'Бесплатные облачные сервисы для заполнения и подписи обычно требуют аккаунт и загружают файл на свои серверы.'),
 'tr': ("Adobe'nin Fill & Sign aracı, kendi PDF'inizi doldurup imzalamak için ücretsizdir ama ücretsiz bir Adobe hesabı gerektirir ve dosyanızı Adobe'nin sunucularına yükler.", 'Ücretsiz bulut doldurma ve imzalama hizmetleri genellikle hesap ister ve dosyanızı kendi sunucularına yükler.'),
 'vi': ('Fill & Sign của Adobe miễn phí để điền và ký file PDF của chính bạn, nhưng yêu cầu tài khoản Adobe miễn phí và tải file của bạn lên máy chủ của Adobe.', 'Các dịch vụ điền và ký miễn phí trên đám mây thường yêu cầu tài khoản và tải file của bạn lên máy chủ của họ.'),
 'zh-CN': ('Adobe 的 Fill & Sign 免费用于填写和签署您自己的 PDF，但需要一个免费的 Adobe 账号，并会将文件上传到 Adobe 的服务器。', '免费的云端填写和签署服务通常需要账号，并会将文件上传到它们的服务器。')}
PAREN = r'\s*[（(][^()（）]*Adobe[^()（）]*[)）]'
def esc(s): return s.replace('&', '&amp;')
n = 0
for lang in Q:
    for f in glob.glob(f'data/content/{lang}/fill-faq.json') + glob.glob(f'data/content/{lang}/fill.html'):
        t = open(f, encoding='utf-8').read(); o = t
        for a, b in (Q[lang], A[lang]):
            for x, y in ((a, b), (esc(a), esc(b))):
                t = t.replace(x, y)
        t = re.sub(PAREN, '', t)
        if f.endswith('.json'): json.loads(t)
        if t != o: open(f, 'w', encoding='utf-8').write(t); n += 1
        if re.search(r'Adobe', t): print('left', f, [m for m in re.findall(r'[^.。"<>]{0,60}Adobe[^.。"<>]{0,60}', t)][:3])
print(n, 'files')
