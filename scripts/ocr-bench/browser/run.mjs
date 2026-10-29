import { chromium } from 'playwright';
import fs from 'fs'; import { execSync } from 'child_process';
const [,, port, set, outDir, threads = '1', throttle = '1', limit = '999'] = process.argv;
const man = JSON.parse(fs.readFileSync('pages/manifest.json', 'utf8'))[set];
const browser = await chromium.launch();
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
if (+throttle > 1) { const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: +throttle }); }
await page.goto(`http://127.0.0.1:${port}/index.html?threads=${threads}`);
const t0 = Date.now(); const r0 = await page.evaluate(() => window.ppocr.ready); console.log('init', r0, Date.now() - t0, 'ms');
const rss = () => { try { return Math.max(...execSync("ps -axo rss=,command= | grep -i 'chrom' | grep -v grep | awk '{print $1}'").toString().trim().split('\n').map(Number)) / 1024; } catch { return 0; } };
fs.mkdirSync(outDir + '/files', { recursive: true });
const times = {}; let peak = 0, k = 0;
for (const [doc, pages] of Object.entries(man)) {
  if (k++ >= +limit) break;
  const lines = []; let ms = 0;
  for (const p of pages) {
    const r = await page.evaluate(u => window.ppocr.page(u), p);
    if (r.type !== 'done') { console.log('ERR', p, r.msg); continue; }
    lines.push(...r.lines); ms += r.detMs + r.recMs; peak = Math.max(peak, rss());
    times[p] = { det: Math.round(r.detMs), rec: Math.round(r.recMs), boxes: r.boxes };
  }
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const xml = `<w:document xmlns:w="x"><w:body>${lines.map(l => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
  fs.writeFileSync(`${outDir}/doc.xml`, xml);
  execSync(`cd ${outDir} && rm -rf z && mkdir -p z/word && cp doc.xml z/word/document.xml && cd z && zip -q -r ../files/${doc}.pdf2word.docx word && cd .. && rm -rf z doc.xml`);
  console.log(doc, Math.round(ms), 'ms', lines.length, 'lines');
}
fs.writeFileSync(`${outDir}/times.json`, JSON.stringify({ times, peakRssMB: Math.round(peak), errs }, null, 1));
console.log('peak RSS MB', Math.round(peak), 'errors', errs.length, errs.slice(0, 3));
await browser.close();
