// SPDX-License-Identifier: AGPL-3.0-only
// Makes rotated-pages.pdf: four pages of our own text (rotated-pages.json, also
// the e2e's truth), printed by Chromium with Arial (macOS), then each page
// given /Rotate 0, 90, 180, 270 with its content turned the other way — the
// page looks upright, as a scanner or "rotate and save" leaves it, while its
// content stream is drawn turned (corpus class C1, 2026-10-18).
//   node tests/fixtures/pdf2word/make-rotated.mjs   (on macOS: needs Arial)
import { chromium } from 'playwright';
import { PDFDocument, degrees } from 'pdf-lib';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { pages, rotate } = JSON.parse(readFileSync(path.join(dir, 'rotated-pages.json'), 'utf8'));
const b = await chromium.launch();
const p = await b.newPage();
await p.setContent(`<html lang="ar"><body style="font-family:'Arial';font-size:14pt;margin:0">${pages.map((lines, i) =>
  `<div style="${i ? 'page-break-before:always' : ''}">${lines.map(l => `<p dir="auto">${l}</p>`).join('')}</div>`).join('')}</body></html>`);
const printed = await PDFDocument.load(await p.pdf({ format: 'A4', margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' } }));
await b.close();

const out = await PDFDocument.create();
const forms = await out.embedPages(printed.getPages());
forms.forEach((form, i) => {
  const r = rotate[i];
  const { width: w, height: h } = form;
  const turned = r % 180 !== 0;
  const page = out.addPage(turned ? [h, w] : [w, h]);
  page.setRotation(degrees(r));
  // drawn turned by r about the origin (the viewer turns it back), then moved
  // back into the box
  const at = { 0: [0, 0], 90: [h, 0], 180: [w, h], 270: [0, w] }[r];
  page.drawPage(form, { x: at[0], y: at[1], rotate: degrees(r) });
});
writeFileSync(path.join(dir, 'rotated-pages.pdf'), await out.save());
