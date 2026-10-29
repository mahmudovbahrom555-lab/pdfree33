import { chromium } from 'playwright';
import { execSync } from 'child_process';
const procs = () => execSync("ps -axo pid=,rss=,command= | grep -i 'chrom' | grep -v grep").toString().trim().split('\n').map(l => { const [pid, rss, ...c] = l.trim().split(/\s+/); const cmd = c.join(' '); return { pid, mb: Math.round(rss / 1024), type: (cmd.match(/--type=([\w-]+)/) || [, 'browser'])[1] }; });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:8993/index.html?threads=1');
const show = tag => { const p = procs().filter(x => x.mb > 50); console.log(tag, p.map(x => `${x.type}:${x.mb}`).join(' ')); };
show('before init   ');
await page.evaluate(() => window.ppocr.ready); show('after init    ');
for (const p of ['pages/dev-clean/4939526_0.png', 'pages/dev-clean/0048931_0.png', 'pages/pool-clean/1547795_0.png']) {
  let peak = 0; const iv = setInterval(() => { for (const x of procs()) if (x.type === 'renderer') peak = Math.max(peak, x.mb); }, 300);
  const r = await page.evaluate(u => window.ppocr.page(u), p); clearInterval(iv);
  show(`after ${p.split('/').pop()} (renderer peak ${peak} MB, ${r.boxes} boxes)`);
}
await browser.close();
