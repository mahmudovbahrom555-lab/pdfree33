#!/usr/bin/env python3
"""Fixtures for the signed-PDF warning (C28): real CMS signatures made with pyHanko and a
throw-away self-signed certificate (created here, never saved). Run from the repo root:
  python3 -m venv /tmp/sigenv && /tmp/sigenv/bin/pip install pyhanko pymupdf
  /tmp/sigenv/bin/python tests/fixtures/signed/make.py
Writes tests/fixtures/signed/:
  signed-one.pdf        one approval signature
  signed-two.pdf        two approval signatures (incremental)
  signed-certified.pdf  a certification signature (DocMDP, changes: form filling)
  field-empty.pdf       an empty signature field — not signed
  image-signature.pdf   a picture of a handwritten signature — not a digital signature
"""
import os, subprocess, tempfile
import fitz
from pyhanko.sign import signers, fields
from pyhanko.sign.fields import SigFieldSpec, MDPPerm
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, '..', 'normal-3page.pdf')

def cert(tmp):
    key, crt = os.path.join(tmp, 'k.pem'), os.path.join(tmp, 'c.pem')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
                    '-subj', '/CN=PDFree test signer', '-keyout', key, '-out', crt], check=True, capture_output=True)
    return signers.SimpleSigner.load(key, crt)

def sign(src, dst, signer, field, certify=False):
    with open(src, 'rb') as f:
        w = IncrementalPdfFileWriter(f)
        fields.append_signature_field(w, SigFieldSpec(sig_field_name=field, box=(40, 40, 200, 80)))
        meta = signers.PdfSignatureMetadata(field_name=field, certify=certify,
                                            docmdp_permissions=MDPPerm.FILL_FORMS if certify else None)
        with open(dst, 'wb') as out:
            signers.PdfSigner(meta, signer=signer).sign_pdf(w, output=out)

def main():
    with tempfile.TemporaryDirectory() as tmp:
        s = cert(tmp)
        sign(BASE, os.path.join(HERE, 'signed-one.pdf'), s, 'Signature1')
        sign(os.path.join(HERE, 'signed-one.pdf'), os.path.join(HERE, 'signed-two.pdf'), s, 'Signature2')
        sign(BASE, os.path.join(HERE, 'signed-certified.pdf'), s, 'Certification', certify=True)
        with open(BASE, 'rb') as f:
            w = IncrementalPdfFileWriter(f)
            fields.append_signature_field(w, SigFieldSpec(sig_field_name='SignHere', box=(40, 40, 200, 80)))
            with open(os.path.join(HERE, 'field-empty.pdf'), 'wb') as out: w.write(out)
    doc = fitz.open(BASE)   # a drawn "signature": strokes on the page, no signature dictionary
    page = doc[0]
    pts = [(60 + i * 6, 70 + (8 if i % 2 else -6)) for i in range(20)]
    page.draw_polyline(pts, color=(0.1, 0.1, 0.5), width=1.5)
    page.insert_text((60, 95), 'signed by hand (picture)', fontsize=8)
    doc.save(os.path.join(HERE, 'image-signature.pdf'))
    for n in sorted(os.listdir(HERE)):
        if n.endswith('.pdf'): print(n, os.path.getsize(os.path.join(HERE, n)))

if __name__ == '__main__':
    main()
