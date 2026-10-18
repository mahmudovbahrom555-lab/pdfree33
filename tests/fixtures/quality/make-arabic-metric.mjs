// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures for tests/quality/test_arabic_metric.py: our own Arabic text,
// printed by Chromium (macOS Arial). arabic-metric.json holds the text.
//   node tests/fixtures/quality/make-arabic-metric.mjs
import { chromium } from 'playwright';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const texts = JSON.parse(readFileSync(path.join(dir, 'arabic-metric.json'), 'utf8'));
const b = await chromium.launch();
const p = await b.newPage();
for (const [name, lines] of Object.entries(texts)) {
  await p.setContent(`<html lang="ar" dir="rtl"><body style="font-family:Arial;font-size:14pt;margin:0">${lines.map(l => `<p>${l}</p>`).join('')}</body></html>`);
  await p.pdf({ path: path.join(dir, `${name}.pdf`), format: 'A4', margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' } });
}
await b.close();
