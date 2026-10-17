// SPDX-License-Identifier: AGPL-3.0-only
// Makes ar-chrome-arial.pdf and ar-chrome-harakat.pdf: Arabic printed by
// Chromium with the system's Arial and Tahoma (macOS), the way Google Docs and
// a browser's "Save as PDF" write it. Their Arabic needs /ActualText: Arial's
// initial/medial yeh and heh glyphs map (ToUnicode) to the Persian/Urdu
// letters ی U+06CC and ھ U+06BE, and Tahoma's letters under vowel marks come
// apart from their marks — the real text is in /ActualText only (2026-10-17).
// The text is our own (arabic-actualtext.json, also the e2e's truth).
//   node tests/fixtures/pdf2word/make-arabic-actualtext.mjs   (on macOS: needs Arial and Tahoma)
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const { prose, harakat } = JSON.parse(readFileSync(path.join(dir, 'arabic-actualtext.json'), 'utf8'));
const b = await chromium.launch();
const p = await b.newPage();
for (const [file, font, lines, align] of [['ar-chrome-arial.pdf', 'Arial', prose, 'justify'], ['ar-chrome-harakat.pdf', 'Tahoma', harakat, 'right']]) {
  await p.setContent(`<html lang="ar" dir="rtl"><body style="font-family:'${font}';font-size:14pt;margin:0">${lines.map(l => `<p style="text-align:${align}">${l}</p>`).join('')}</body></html>`);
  await p.pdf({ path: path.join(dir, file), format: 'A4', margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' } });
}
await b.close();
