#!/usr/bin/env python3
"""Approved privacy/legal wording into translated Secure (363-line) and
Merge-without-upload (554-line) pages, by line, each line checked for the
element it must hold first. Usage: python3 apply_l10n.py <lang> <secure.html> <merge.html>"""
import json, re, sys

T = {
'es': dict(
 PP='Política de privacidad',
 GDPR_Q='¿Qué hace PDFree con mis datos según el RGPD?',
 GDPR_A='Tus archivos PDF se procesan en tu navegador y no se suben a nuestros servidores, así que no tenemos su contenido. El sitio recoge información técnica limitada de uso y errores sin cookies ni identificadores persistentes, como describe nuestra Política de privacidad. No certificamos el cumplimiento: si un flujo de trabajo cumple tus obligaciones del RGPD lo debe evaluar tu organización.',
 MED_A='Tus archivos PDF se procesan en tu navegador y no se suben a nuestros servidores. No certificamos el cumplimiento de HIPAA ni firmamos BAA; si usar PDFree para historiales de pacientes encaja con tus obligaciones lo decide tu organización.',
 NET='Verás los archivos que el sitio necesita para funcionar (scripts, estilos, fuentes y, en algunas herramientas, bibliotecas o modelos de idioma) y pequeños eventos técnicos de uso y errores descritos en nuestra Política de privacidad — nunca tu archivo PDF ni su contenido.',
 DEVTOOLS='Abre las DevTools de tu navegador (F12), ve a la pestaña Red y usa cualquier herramienta de PDFree. No verás ninguna solicitud con tu archivo PDF.',
 OG='Herramientas PDF que procesan tus archivos en el navegador — sin subirlos ni guardarlos en nuestros servidores.',
 NO_COPIES='Sin copias de tus archivos en nuestros servidores',
 HERO='Sin subidas · Sin copias en nuestros servidores · Sin cuenta',
 B1='✓ Sin cookies ni identificador persistente', B2='✓ No requiere cuenta', B3='🚫 Sin rastreo publicitario ni venta de datos',
 CARD='Los datos de pacientes deben protegerse. PDFree procesa los historiales médicos en tu dispositivo — los archivos no se suben.',
 ONLY='Las únicas',
 FEAT='Archivos procesados en tu dispositivo, sin subirlos',
 ROW='El archivo se queda en tu dispositivo', YES='✓ Sí', NO='No (se sube)',
 NET_P='Tus archivos PDF nunca aparecen en el registro de red porque no se suben.',
 NOTE='Los historiales de pacientes requieren protección estricta. Con PDFree los archivos se procesan en tu dispositivo y no se suben; si eso encaja con tus obligaciones lo decide tu organización.'),
'fr': dict(
 PP='Politique de confidentialité',
 GDPR_Q='Que fait PDFree de mes données au regard du RGPD ?',
 GDPR_A="Vos fichiers PDF sont traités dans votre navigateur et ne sont pas envoyés sur nos serveurs : nous n'en détenons donc jamais le contenu. Le site collecte des informations techniques limitées d'utilisation et d'erreurs, sans cookies ni identifiant persistant, comme le décrit notre Politique de confidentialité. Nous ne certifions pas la conformité : c'est à votre organisation d'évaluer si un usage respecte ses obligations RGPD.",
 MED_A="Vos fichiers PDF sont traités dans votre navigateur et ne sont pas envoyés sur nos serveurs. Nous ne certifions pas la conformité HIPAA et ne signons pas de BAA ; c'est à votre organisation de décider si l'utilisation de PDFree pour des dossiers patients correspond à ses obligations.",
 NET="Vous verrez les fichiers dont le site a besoin pour fonctionner (scripts, styles, polices et, pour certains outils, des bibliothèques ou des modèles de langue) et de petits événements techniques d'utilisation et d'erreurs décrits dans notre Politique de confidentialité — jamais votre fichier PDF ni son contenu.",
 DEVTOOLS="Ouvrez les DevTools de votre navigateur (F12), allez dans l'onglet Réseau et utilisez n'importe quel outil PDFree. Vous ne verrez aucune requête contenant votre fichier PDF.",
 OG='Des outils PDF qui traitent vos fichiers dans le navigateur — sans les envoyer ni les stocker sur nos serveurs.',
 NO_COPIES='Aucune copie de vos fichiers sur nos serveurs',
 HERO='Aucun envoi · Aucune copie sur nos serveurs · Aucun compte',
 B1='✓ Sans cookies ni identifiant persistant', B2='✓ Aucun compte requis', B3='🚫 Aucun pistage publicitaire, aucune vente de données',
 CARD='Les données des patients doivent être protégées. PDFree traite les dossiers médicaux sur votre appareil — les fichiers ne sont pas envoyés.',
 ONLY='Les seules',
 FEAT='Fichiers traités sur votre appareil, sans envoi',
 ROW='Le fichier reste sur votre appareil', YES='✓ Oui', NO='Non (envoyé)',
 NET_P="Vos fichiers PDF n'apparaissent jamais dans le journal réseau car ils ne sont pas envoyés.",
 NOTE="Les dossiers patients exigent une protection stricte. Avec PDFree, les fichiers sont traités sur votre appareil et ne sont pas envoyés ; c'est à votre organisation de décider si cela correspond à ses obligations."),
'pt': dict(
 PP='Política de Privacidade',
 GDPR_Q='O que o PDFree faz com meus dados segundo a LGPD?',
 GDPR_A='Seus arquivos PDF são processados no seu navegador e não são enviados aos nossos servidores, portanto nunca temos o conteúdo deles. O site coleta informações técnicas limitadas de uso e erros, sem cookies nem identificadores persistentes, como descreve nossa Política de Privacidade. Não certificamos conformidade: se um fluxo de trabalho atende às suas obrigações da LGPD cabe à sua organização avaliar.',
 MED_A='Seus arquivos PDF são processados no seu navegador e não são enviados aos nossos servidores. Não certificamos conformidade com a HIPAA nem assinamos BAA; se usar o PDFree para registros de pacientes atende às suas obrigações, quem decide é a sua organização.',
 NET='Você verá os arquivos de que o site precisa para funcionar (scripts, estilos, fontes e, em algumas ferramentas, bibliotecas ou modelos de idioma) e pequenos eventos técnicos de uso e erros descritos na nossa Política de Privacidade — nunca o seu arquivo PDF nem o conteúdo dele.',
 DEVTOOLS='Abra as DevTools do seu navegador (F12), vá até a aba Rede e use qualquer ferramenta do PDFree. Você não verá nenhuma requisição com o seu arquivo PDF.',
 OG='Ferramentas PDF que processam seus arquivos no navegador — sem enviá-los nem guardá-los em nossos servidores.',
 NO_COPIES='Nenhuma cópia dos seus arquivos em nossos servidores',
 HERO='Sem upload · Sem cópias em nossos servidores · Sem conta',
 B1='✓ Sem cookies nem identificador persistente', B2='✓ Não precisa de conta', B3='🚫 Sem rastreamento publicitário nem venda de dados',
 CARD='Os dados de pacientes precisam ser protegidos. O PDFree processa registros médicos no seu dispositivo — os arquivos não são enviados.',
 ONLY='As únicas',
 FEAT='Arquivos processados no seu dispositivo, sem upload',
 ROW='O arquivo fica no seu dispositivo', YES='✓ Sim', NO='Não (enviado)',
 NET_P='Seus arquivos PDF nunca aparecem no log de rede porque não são enviados.',
 NOTE='Registros de pacientes exigem proteção rigorosa. Com o PDFree os arquivos são processados no seu dispositivo e não são enviados; se isso atende às suas obrigações, quem decide é a sua organização.'),
}

def json_val(line, key, new):
    return re.sub(r'("%s":\s*")((?:[^"\\]|\\.)*)(")' % key, lambda m: m.group(1) + new.replace('"', '\\"') + m.group(3), line, count=1)

def inner(line, new):          # the text between the element's first '>' and its last '</'
    a = line.index('>') + 1; b = line.rindex('</')
    return line[:a] + new + line[b:]

def apply(path, edits, report):
    lines = open(path, encoding='utf-8').read().split('\n')
    for n, must, fn in edits:
        l = lines[n - 1]
        if not re.search(must, l):
            report.append(f'{path}:{n} skipped — expected /{must}/, got: {l.strip()[:90]}'); continue
        lines[n - 1] = fn(l)
    s = '\n'.join(lines)
    for m in re.findall(r'<script type="application/ld\+json">(.*?)</script>', s, re.S): json.loads(m)
    open(path, 'w', encoding='utf-8').write(s)

def main(lang, secure, merge):
    t = T[lang]; pp = f'<a href="/privacy/" style="color:var(--green-text);">{t["PP"]}</a>'
    link = lambda x: x.replace(t['PP'], pp)
    report = []
    apply(secure, [
        (28, 'og:description', lambda l: re.sub(r'content="[^"]*"', 'content="%s"' % t['OG'], l)),
        (40, 'twitter:description', lambda l: re.sub(r'content="[^"]*"', 'content="%s"' % t['OG'], l)),
        (103, r'^\s*"', lambda l: re.sub(r'"[^"]*"', '"%s"' % t['NO_COPIES'], l, count=1)),
        (149, 'DevTools', lambda l: json_val(l, 'text', t['DEVTOOLS'] + ' ' + t['NET'])),
        (153, '"name"', lambda l: json_val(l, 'name', t['GDPR_Q'])),
        (154, '"text"', lambda l: json_val(l, 'text', t['GDPR_A'])),
        (159, '"text"', lambda l: json_val(l, 'text', t['MED_A'])),
        (206, '·', lambda l: re.sub(r'\S.*\S', t['HERO'], l, count=1)),
        (219, '<span', lambda l: inner(l, t['B1'])), (220, '<span', lambda l: inner(l, t['B2'])), (221, '<span', lambda l: inner(l, t['B3'])),
        (287, 'XHR', lambda l: l[:l.index(t['ONLY'])] + link(t['NET']) + '</p>'),
        (299, '<p', lambda l: inner(l, t['CARD'])),
        (319, '<h3', lambda l: inner(l, t['GDPR_Q'])), (320, '<p', lambda l: inner(l, link(t['GDPR_A']))),
        (324, '<p', lambda l: inner(l, t['MED_A'])),
    ], report)
    apply(merge, [
        (98, r'^\s*"', lambda l: re.sub(r'"[^"]*"', '"%s"' % t['FEAT'], l, count=1)),
        (204, '"text"', lambda l: json_val(l, 'text', t['MED_A'])),
        (425, '<td', lambda l: inner(l, t['ROW'])), (426, '<td', lambda l: inner(l, t['YES'])),
        (427, '<td', lambda l: inner(l, t['NO'])), (428, '<td', lambda l: inner(l, t['NO'])),
        (444, '<p', lambda l: inner(l, t['NET_P'] + ' ' + link(t['NET']))),
        (458, '<p', lambda l: inner(l, t['NOTE'])),
        (498, '<p', lambda l: inner(l, t['MED_A'])),
    ], report)
    print('\n'.join(report) or f'{lang}: all lines replaced')

if __name__ == '__main__': main(*sys.argv[1:4])
