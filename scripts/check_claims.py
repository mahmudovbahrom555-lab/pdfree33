#!/usr/bin/env python3
"""check_claims.py — public promises the site can't prove must not come back.

An audit (2026-11-04) found the site promising more than the code does:
"HIPAA-safe by architecture", "no BAA required", "GDPR compliance is
structurally guaranteed", "no data collection", "no tracking", "the only
network requests are JavaScript and CSS" — while the privacy policy (#81)
says, truthfully, that the site counts anonymous technical events and loads
libraries and models from CDNs. The site now states only what the code
proves: your files are processed on your device and are not uploaded; we do
not certify HIPAA/GDPR compliance or sign BAAs. "100% private" became
"files stay on your device" in every language (owner, 2026-11-04).

This check fails when a removed phrase comes back in any page source,
content file, template or translation. Link targets and URLs are ignored
(an old blog address still says "hipaa-safe"). The translated pages carry
the same approved meanings; their removed phrases are checked too.

Run: python3 scripts/check_claims.py      (exit 1 on a finding)
"""
import re
import subprocess
import sys

BLOCK = [
    (r'hipaa[- ]safe', 'a HIPAA safety promise'),
    (r'(?:safe|compliant|compliance)\s+by\s+(?:design|architecture)', 'compliance "by design"'),
    (r'structurally\s+(?:guaranteed|impossible)', 'a structural guarantee'),
    (r'no (?:compliance|gdpr) risk', 'a "no risk" promise'),
    (r'no controller-processor relationship', 'a legal conclusion about GDPR roles'),
    (r'not a business associate', 'a legal conclusion about BAAs'),
    (r'no baa (?:is )?(?:required|needed|necessary)', 'a legal conclusion about BAAs'),
    (r'no data collection', 'contradicts the privacy policy (technical events are counted)'),
    (r'(?:zero|no) tracking', 'contradicts the privacy policy (technical events are counted)'),
    (r'no analytics\b(?! on document)', 'contradicts the privacy policy (technical events are counted)'),
    (r'only network requests', 'false: models, fonts and events are requested too'),
    (r'nothing is sent', 'too broad: say the FILE is not uploaded'),
    (r'the only pdf toolkit', 'an unprovable superlative'),
    (r'can safely (?:use|process|merge)', 'a safety promise for regulated data'),
    (r'(?:zero|no) phi (?:is )?(?:ever )?transmitted|no phi ever', 'say the FILE is not uploaded'),
    (r'100\s?%\s?(?:(?:private|privat|privé|privad|prywatn|gizli|pribadi|приватн|конфиденциальн)\w*|riêng tư|プライベート|비공개|私密)', 'an absolute promise: say the files stay on your device'),
    (r'private by design|safe for confidential docs', 'an absolute promise: say the files stay on your device'),
    (r'100\s?%\s?(?:de\s)?(?:privacy|privacidad|privacidade|confidentialité)|privacy by design|(?:privasi|quyền riêng tư) 100%|100\s?%\s?の?プライバシー|100% 개인정보|%100 gizli', 'an absolute promise: say the files stay on your device'),
    (r'100\s?%\s?(?:的\s?)?隐私|从设计上|حریم خصوصی 100٪|פרטיות של 100%|100% رازدار|১০০%\s?গোপনীয়', 'an absolute promise: say the files stay on your device'),
    # 96 dpi was promised to keep scans readable; measured 2026-11-05, small print and Chinese /
    # Japanese characters can become hard to read (removed with the Maximum scan note). Arabic waits
    # for its SEO re-check (2026-11-16), like the rules below.
    (r'(?:no loss of readability|без потери читабельности|不影响可读性|読みやすさを損なわずに|tanpa kehilangan keterbacaan|mà không mất khả năng đọc)', 'a promise the measurement disproved: 96 dpi can make small print and CJK hard to read', r'^(?:ar/|data/content/ar/|js/locales/ar\.js)'),
    # competitors are compared, never named (owner, 2026-11-04); a viewer named as a format fact
    # ("opens in Adobe Acrobat") stays. Arabic pages wait for their own PR (SEO re-check until 2026-11-16).
    (r'\b(?:iLovePDF|Smallpdf|PDF24|Sejda|DocuSign|HelloSign|SignNow|pymupdf4llm|Docling)\b', 'a competitor named: say cloud PDF tools / other tools', r'^(?:ar/|data/content/ar/|js/locales/ar\.js)'),
    (r'(?:without|ohne|sin|sans|sem|senza|zonder|bez|olmadan|không cần|tanpa|なしで|없이|без) (?:Adobe|Acrobat)|\bvs\.? Adobe|Adobe\'s (?:free )?Fill', 'a competitor named: say paid software / cloud tools', r'^(?:ar/|data/content/ar/|js/locales/ar\.js)'),
    # Arabic keeps "خصوصية 100%" until its SEO re-check ends (2026-11-16) — then the same change, and its pattern here
    # the same promises in the translations (removed 2026-11-04, PR 1b);
    # a user's question ("…conforme à HIPAA ?") stays — its answer says we don't certify
    (r'DSGVO-(?:konform|sicher)\b(?!e Weitergabe)|strukturell (?:garantiert|unmöglich)|kein(?:e)? (?:Tracking|Datenerfassung)|Null Tracking|einzigen Netzwerkanfragen|das einzige PDF-Toolkit', 'de: a promise the code can\'t prove'),
    (r'(?:cumple con|seguro para) (?:el )?(?:RGPD|HIPAA)(?!\s*\?)|garantizado estructuralmente|estructuralmente imposibles|sin rastreo\b(?! publicitario)|las únicas solicitudes de red', 'es: a promise the code can\'t prove'),
    (r'conformes? (?:au|à) (?:RGPD|HIPAA)(?!\s*\?)|sûr pour (?:le RGPD|HIPAA)|garantie structurellement|aucun suivi\b|les seules requêtes réseau|aucune collecte de données', 'fr: a promise the code can\'t prove'),
    (r'compatível com (?:a )?(?:LGPD|HIPAA)(?!\s*\?)|seguro para (?:LGPD|HIPAA)|garantida estruturalmente|sem rastreamento\b(?! publicitário)|as únicas requisições', 'pt: a promise the code can\'t prove'),
    (r'conform[ei] al GDPR|per progettazione|nessuna raccolta di dati', 'it: a promise the code can\'t prove'),
    (r'AVG-conform|door ontwerp|structureel gegarandeerd|geen tracking\b', 'nl: a promise the code can\'t prove'),
    (r'zgodn[eyia] z RODO|już w założeniu|zero śledzenia|jedyny zestaw', 'pl: a promise the code can\'t prove'),
    (r'(?:KVKK|GDPR) uyumlu(?!luğu?)|yapısal olarak garanti', 'tr: a promise the code can\'t prove'),
    (r'được đảm bảo về mặt cấu trúc|có tuân thủ GDPR', 'vi: a promise the code can\'t prove'),
    (r'terjamin secara struktural|mematuhi GDPR', 'id: a promise the code can\'t prove'),
    (r'구조적으로 불가능|GDPR을 준수', 'ko: a promise the code can\'t prove'),
    (r'(?:GDPR|HIPAA)に準拠', 'ja: a promise the code can\'t prove'),
    (r'структурно невозможн|никакие данные не передаются', 'ru: a promise the code can\'t prove'),
]
# where the site's public words live (tracked files only)
PATHS = ['*.html', '**/*.html', 'data/content/**', 'data/tools-config.json', 'data/fixes.json', 'js/config.js', 'js/i18n.js', 'js/locales/*.js', 'scripts/templates/**']
EXCLUDE = (':!tests', ':!docs', ':!research', ':!packages', ':!seo-content.html', ':!dist')
# a link or address, not words: href/src/action, and content="" only when it holds a URL or path —
# a meta description with "PDF/A" in it is words and is checked
URL = re.compile(r'(?:href|src|action)="[^"]*"|content="(?:https?:|/)[^"]*"|https?://\S+|"(?:url|item|@id)":\s*"[^"]*"')


def main():
    files = subprocess.run(['git', 'ls-files', '--', *PATHS, *EXCLUDE],
                           capture_output=True, text=True, check=True).stdout.split()
    found = []
    for path in sorted(set(files)):
        try:
            text = open(path, encoding='utf-8').read()
        except (OSError, UnicodeDecodeError):
            continue
        for n, line in enumerate(text.split('\n'), 1):
            plain = URL.sub(' ', line)
            for rx, why, *skip in BLOCK:
                if skip and re.match(skip[0], path):
                    continue
                m = re.search(rx, plain, re.I)
                if m:
                    found.append(f'{path}:{n}: "{m.group(0)}" — {why}')
    if found:
        print(f'[check_claims] {len(found)} promise(s) the site can\'t prove:')
        for f in found:
            print('  ' + f)
        return 1
    print(f'[check_claims] OK — {len(set(files))} files, no removed promise is back.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
