// SPDX-License-Identifier: AGPL-3.0-only
// Makes ocr_scan_ar_rot270.pdf: the synthetic Arabic scan
// pdf2word_scan_ar_no_text.pdf (ar-web ground truth) on a page with
// /Rotate 270, its content drawn turned the other way — upright on screen,
// sideways in the page's own space, as a scanner leaves it (corpus class C1,
// 2026-10-18).   node tests/fixtures/make-ocr-rotated.mjs
import { PDFDocument, degrees } from 'pdf-lib';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = await PDFDocument.load(readFileSync(path.join(dir, 'pdf2word_scan_ar_no_text.pdf')));
const out = await PDFDocument.create();
const [form] = await out.embedPages([src.getPage(0)]);
const page = out.addPage([form.height, form.width]);
page.setRotation(degrees(270));
page.drawPage(form, { x: 0, y: form.width, rotate: degrees(270) });
writeFileSync(path.join(dir, 'ocr_scan_ar_rot270.pdf'), await out.save());
