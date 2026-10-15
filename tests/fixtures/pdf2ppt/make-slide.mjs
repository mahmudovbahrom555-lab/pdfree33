// SPDX-License-Identifier: AGPL-3.0-only
// Builds slide.pdf for tests/e2e/pdf2ppt-layered.e2e.mjs — one 720×540 slide:
// a white bold title on a dark band, a 3-line paragraph, a red Chinese line,
// a ruled 3×3 table and an orange disc (vector art the slide picture keeps).
// Run: node tests/fixtures/pdf2ppt/make-slide.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const dir = path.dirname(fileURLToPath(import.meta.url));
const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const page = doc.addPage([720, 540]);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const regular = await doc.embedFont(StandardFonts.Helvetica);
const sc = await doc.embedFont(fs.readFileSync(path.join(dir, '..', '..', 'corpus', 'groundtruth', '.fonts', 'NotoSansSC-400.ttf')), { subset: true });

page.drawRectangle({ x: 0, y: 440, width: 720, height: 100, color: rgb(0.12, 0.22, 0.39) });
page.drawText('Quarterly Results', { x: 40, y: 475, size: 28, font: bold, color: rgb(1, 1, 1) });
['Revenue grew in every region this quarter,', 'led by the North, while costs stayed flat', 'against the same quarter last year.']
  .forEach((t, i) => page.drawText(t, { x: 40, y: 400 - i * 18, size: 14, font: regular, color: rgb(0, 0, 0) }));
page.drawText('用户管理：身份证由个人拥有', { x: 40, y: 330, size: 16, font: sc, color: rgb(0.8, 0, 0) });
page.drawCircle({ x: 600, y: 360, size: 50, color: rgb(1, 0.55, 0) });

const cols = [40, 200, 320, 440], rows = [270, 230, 190, 150];
for (const y of rows) page.drawLine({ start: { x: cols[0], y }, end: { x: cols[3], y }, thickness: 1 });
for (const x of cols) page.drawLine({ start: { x, y: rows[0] }, end: { x, y: rows[3] }, thickness: 1 });
[['Region', 'Q1', 'Q2'], ['North', '17,722', '20,813'], ['South', '5,850', '6,273']].forEach((row, r) =>
  row.forEach((t, c) => page.drawText(t, { x: cols[c] + 8, y: rows[r] - 26, size: 14, font: r === 0 ? bold : regular })));

fs.writeFileSync(path.join(dir, 'slide.pdf'), await doc.save());
console.log('wrote', path.join(dir, 'slide.pdf'));
