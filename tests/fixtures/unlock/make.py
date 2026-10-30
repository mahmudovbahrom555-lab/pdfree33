# Builds the Unicode-password Unlock fixtures (tests/e2e/unlock-unicode.e2e.mjs).
# Each PDF says "Unlock fixture <name>" on page 1. Needs qpdf 12+, LibreOffice,
# PyMuPDF. Our own Protect is covered by the e2e round trip, not a fixture.
# Run: python3 tests/fixtures/unlock/make.py
import json, os, subprocess, tempfile
import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORDS = {'ru': 'пароль123', 'zh': '密码测试', 'ja': 'パスワード', 'tr': 'şifre-café', 'mix': 'Pass密码1', 'ascii': 'secret-42'}
CODEPAGE = {'ru': 'cp1251', 'zh': 'cp936', 'ja': 'cp932'}
cases = []

def plain(name):
    d = fitz.open(); d.new_page().insert_text((72, 72), f'Unlock fixture {name}'); p = os.path.join(tempfile.mkdtemp(), 'p.pdf'); d.save(p); return p

def qpdf(args):
    r = subprocess.run(['qpdf', *args], capture_output=True)
    if r.returncode not in (0, 3): raise SystemExit(r.stderr.decode())

for key, pw in PASSWORDS.items():
    # qpdf as Acrobat-like writers do it: UTF-8 for AES-256, PDFDoc where possible for AES-128
    for bits, rev in ((256, 'r6'), (128, 'r4')):
        name = f'qpdf-{rev}-{key}'
        qpdf(['--encrypt', f'--user-password={pw}', f'--owner-password={pw}x', f'--bits={bits}', *(['--use-aes=y'] if bits == 128 else []), '--', plain(name), f'{HERE}/{name}.pdf'])
        cases.append({'file': f'{name}.pdf', 'password': pw})
    # an old Windows / WPS-style writer: the password in the system code page, raw bytes
    if key in CODEPAGE:
        hexpw = pw.encode(CODEPAGE[key]).hex()
        for bits, rev in ((128, 'r4'), (40, 'r2')):
            name = f'codepage-{rev}-{key}'
            qpdf(['--password-mode=hex-bytes', '--allow-weak-crypto', '--encrypt', f'--user-password={hexpw}', f'--owner-password={hexpw}00', f'--bits={bits}', *(['--use-aes=y'] if bits == 128 else []), '--', plain(name), f'{HERE}/{name}.pdf'])
            cases.append({'file': f'{name}.pdf', 'password': pw})
    # LibreOffice's own PDF export with an open password
    name = f'libreoffice-{key}'
    tmp = tempfile.mkdtemp(); open(f'{tmp}/{name}.txt', 'w').write(f'Unlock fixture {name}\n')
    opts = json.dumps({'EncryptFile': {'type': 'boolean', 'value': 'true'}, 'DocumentOpenPassword': {'type': 'string', 'value': pw}})
    subprocess.run(['soffice', '--headless', '--convert-to', f'pdf:writer_pdf_Export:{opts}', '--outdir', HERE, f'{tmp}/{name}.txt'], capture_output=True, check=True)
    cases.append({'file': f'{name}.pdf', 'password': pw})

json.dump(cases, open(f'{HERE}/cases.json', 'w'), ensure_ascii=False, indent=1)
print(len(cases), 'fixtures')
