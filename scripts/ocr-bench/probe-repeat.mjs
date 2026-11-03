import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
const b = await chromium.launch();
const out = [];
for (let i = 0; i < 2; i++) {
  const ctx = await b.newContext({ locale: 'zh-CN', serviceWorkers: 'block' }), p = await ctx.newPage();
  await p.addInitScript(() => { const o = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { if (x instanceof Blob && /officedocument/.test(x.type)) window.__b = x; return o(x); }; });
  await p.goto('http://localhost:8962/zh/pdf-zhuan-word/', { waitUntil: 'load' });
  await p.setInputFiles('#fileInput', 'in/4939526.pdf'); await p.waitForTimeout(3000);
  const t0 = Date.now(); await p.click('#mergeBtn');
  await p.waitForFunction(() => window.__b, null, { timeout: 900000, polling: 1000 });
  const text = await p.evaluate(async () => { await (await import('/js/lazyLibs.js')).loadJSZip(); const z = await window.JSZip.loadAsync(await window.__b.arrayBuffer()); return (await z.file('word/document.xml').async('string')).replace(/<[^>]+>/g, ''); });
  out.push(text); console.log('run', i + 1, Math.round((Date.now() - t0) / 1000) + ' s', 'kana+han', [...text].filter(c => c >= '぀' && c <= '鿿').length);
  await ctx.close();
}
console.log(out[0] === out[1] ? 'IDENTICAL' : 'DIFFERENT');
await b.close();
