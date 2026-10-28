// Generator B: the HTML LibreOffice wrote from each DOCX, printed to PDF by
// Chromium — a second layout engine (tagged, as Chrome prints by default).
//   node print_b.mjs <html-dir> <out-dir>
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [htmlDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const f of fs.readdirSync(htmlDir).filter(f => f.endsWith('.html')).sort()) {
  const out = path.join(outDir, f.replace(/\.html$/, '.pdf'));
  if (fs.existsSync(out)) continue;
  try {
    await page.goto(pathToFileURL(path.join(htmlDir, f)).href, { waitUntil: 'load', timeout: 60000 });
    await page.pdf({ path: out, format: 'Letter', margin: { top: '1in', bottom: '1in', left: '1in', right: '1in' }, printBackground: true, tagged: true });
  } catch (e) { console.log('fail', f, e.message.slice(0, 80)); }
}
await browser.close();
