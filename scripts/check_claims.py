#!/usr/bin/env python3
"""check_claims.py — public promises the site can't prove must not come back.

An audit (2026-11-04) found the site promising more than the code does:
"HIPAA-safe by architecture", "no BAA required", "GDPR compliance is
structurally guaranteed", "no data collection", "no tracking", "the only
network requests are JavaScript and CSS" — while the privacy policy (#81)
says, truthfully, that the site counts anonymous technical events and loads
libraries and models from CDNs. The site now states only what the code
proves: your files are processed on your device and are not uploaded; we do
not certify HIPAA/GDPR compliance or sign BAAs.

This check fails when a removed phrase comes back in any page source,
content file, template or translation. Link targets and URLs are ignored
(an old blog address still says "hipaa-safe"). Phrases translated into the
other languages are added here as their pages are rewritten.

Run: python3 scripts/check_claims.py      (exit 1 on a finding)
"""
import re
import subprocess
import sys

BLOCK = [
    (r'hipaa[- ]safe', 'a HIPAA safety promise'),
    (r'(?:safe|compliant|compliance)\s+by\s+(?:design|architecture)', 'compliance "by design"'),
    (r'structurally\s+(?:guaranteed|impossible)', 'a structural guarantee'),
    (r'no compliance risk', 'a "no risk" promise'),
    (r'not a business associate', 'a legal conclusion about BAAs'),
    (r'no baa (?:is )?(?:required|needed|necessary)', 'a legal conclusion about BAAs'),
    (r'no data collection', 'contradicts the privacy policy (technical events are counted)'),
    (r'(?:zero|no) tracking', 'contradicts the privacy policy (technical events are counted)'),
    (r'no analytics\b(?! on document)', 'contradicts the privacy policy (technical events are counted)'),
    (r'only network requests', 'false: models, fonts and events are requested too'),
    (r'nothing is sent', 'too broad: say the FILE is not uploaded'),
    (r'the only pdf toolkit', 'an unprovable superlative'),
]
# where the site's public words live (tracked files only)
PATHS = ['*.html', '**/*.html', 'data/content/**', 'js/i18n.js', 'js/locales/*.js', 'scripts/templates/**']
EXCLUDE = (':!tests', ':!docs', ':!research', ':!packages', ':!seo-content.html', ':!dist')
URL = re.compile(r'(?:href|src|content|action)="[^"]*/[^"]*"|https?://\S+|"(?:url|item|@id)":\s*"[^"]*"')


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
            for rx, why in BLOCK:
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
