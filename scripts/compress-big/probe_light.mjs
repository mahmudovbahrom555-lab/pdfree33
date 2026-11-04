import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
const [base, f] = process.argv.slice(2);
const b = await chromium.launch(); const ctx = await b.newContext({ serviceWorkers: 'block' }); const page = await ctx.newPage();
const logs = []; page.on('console', m => logs.push(m.type() + ': ' + m.text().slice(0, 160))); page.on('pageerror', e => logs.push('PAGEERROR ' + e.message.slice(0, 200)));
await page.addInitScript(() => { window.__blob = null; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { if (x instanceof Blob) window.__blob = x.type + ' ' + x.size; return o(x); }; });
await page.goto(base + '/compress-pdf/', { waitUntil: 'load' });
await page.setInputFiles('#fileInput', f);
await page.waitForTimeout(8000);
await page.click('label[data-preset="low"]'); await page.waitForTimeout(500);
await page.click('#mergeBtn');
for (const s of [5, 15, 40, 90]) {
  await page.waitForTimeout(s * 1000 - (s === 5 ? 0 : 0));
  const st = await page.evaluate(() => ({ blob: window.__blob, toast: (document.querySelector('#toast') && !document.querySelector('#toast').hidden) ? document.querySelector('#toast').innerText.slice(0, 200) : '', card: !!document.querySelector('#successCard:not([hidden])') && document.querySelector('#successCard').offsetParent !== null, cardText: document.querySelector('#successCard')?.innerText.slice(0, 200), btn: document.querySelector('#mergeBtn')?.innerText.slice(0, 60), prog: document.querySelector('#progressWrap, .progress')?.innerText?.slice(0, 80) }));
  console.log(s, JSON.stringify(st));
}
console.log(logs.filter(l => !/favicon/.test(l)).slice(-15).join('\n'));
await b.close();
