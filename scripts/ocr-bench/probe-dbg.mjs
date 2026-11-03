import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs';
const b = await chromium.launch();
for (const f of process.argv.slice(2)) {
  const ctx = await b.newContext({ locale: 'zh-CN' }), p = await ctx.newPage();
  await p.goto('http://localhost:8962/zh/pdf-zhuan-word/', { waitUntil: 'load' });
  const data = fs.readFileSync(f).toString('base64');
  const r = await p.evaluate(async data => {
    await (await import('/js/pdf2jpgUI.js')).loadPdfJs();
    const eng = await import('/js/ocrEngine.js'), pp = await import('/js/ppocrEngine.js');
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    const probes = [];
    const paddle = async cvs => {
      const res = await pp.paddleRecognize(cvs);
      const w = res.data.words, sure = w.filter(x => x.confidence >= 85);
      const cjk = sure.filter(x => /[ぁ-ゖァ-ヺ㐀-鿿豈-﫿]/.test(x.text));
      probes.push({ size: cvs.width + 'x' + cvs.height, words: w.length, sure: sure.length, cjk: cjk.length,
        letters: w.reduce((n, x) => n + [...x.text].filter(c => /\p{L}/u.test(c)).length, 0), sample: res.data.text.slice(0, 80) });
      return res;
    };
    await eng.loadTesseract(); const worker = await eng.createOcrWorker('eng');
    const d = await eng.detectOcrLanguage(doc, worker, { ignoreTextLayer: true, hint: 'chi_sim', prefer: ['chi_sim'], paddle });
    await worker.terminate();
    return { lang: d.lang, confident: d.confident, source: d.metrics?.source, probes };
  }, data);
  console.log(f.split('/').pop(), JSON.stringify(r));
  await ctx.close();
}
await b.close();
