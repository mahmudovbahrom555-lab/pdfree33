// SPDX-License-Identifier: AGPL-3.0-only
// Builds freetext.pdf for tests/e2e/pdf2word-forms.e2e.mjs: a page with one
// line of its own text and a FreeText annotation (typewriter text) below it.
// Run: node tests/fixtures/pdf2word/make-freetext.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

const dir = path.dirname(fileURLToPath(import.meta.url));
const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
page.drawText('Delivery instructions', { x: 50, y: 780, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
const annot = doc.context.obj({
  Type: 'Annot', Subtype: 'FreeText', Rect: [50, 700, 400, 730],
  Contents: PDFString.of('Leave the parcel at the back door'),
  DA: PDFString.of('/Helv 12 Tf 0 g'), F: 4,
});
page.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(annot)]));
fs.writeFileSync(path.join(dir, 'freetext.pdf'), await doc.save());
console.log('wrote', path.join(dir, 'freetext.pdf'));
