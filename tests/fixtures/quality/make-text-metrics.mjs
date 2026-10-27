// SPDX-License-Identifier: AGPL-3.0-only
// Fixtures for tests/quality/test_chinese_metric.py and test_latin_metric.py:
// our own text, printed by Chromium (macOS PingFang SC / Hiragino Sans /
// Arial). chinese-metric.json and latin-metric.json hold the text; en-hyphen
// is set in a narrow column with hyphenation, so its words break at line ends.
//   node tests/fixtures/quality/make-text-metrics.mjs
import { chromium } from 'playwright';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const texts = {
  ...JSON.parse(readFileSync(path.join(dir, 'chinese-metric.json'), 'utf8')),
  ...JSON.parse(readFileSync(path.join(dir, 'latin-metric.json'), 'utf8')),
};
const LANG = { zh: ['zh-CN', '"PingFang SC"'], ja: ['ja', '"Hiragino Sans"'], en: ['en', 'Arial'] };
const b = await chromium.launch();
const p = await b.newPage();
for (const [name, lines] of Object.entries(texts)) {
  const [lang, font] = LANG[name.split('-')[0]];
  const narrow = name === 'en-hyphen' ? 'width:6cm;hyphens:auto;-webkit-hyphens:auto;' : '';
  await p.setContent(`<html lang="${lang}"><body style="font-family:${font};font-size:12pt;margin:0"><div style="${narrow}">${lines.map(l => `<p>${l}</p>`).join('')}</div></body></html>`);
  await p.pdf({ path: path.join(dir, `${name}.pdf`), format: 'A4', margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' } });
}
await b.close();
