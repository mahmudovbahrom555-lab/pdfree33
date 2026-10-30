import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs';
const RTL = new Set(['he', 'ar']);
const files = fs.readdirSync('.').filter(f => f.endsWith('.txt'));
const b = await chromium.launch(), page = await b.newPage();
fs.mkdirSync('src', { recursive: true });
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
for (const f of files) {
  const lang = f.slice(0, 2), raw = fs.readFileSync(f, 'utf8').replace(/=+[^=\n]*=+/g, '').replace(/\n+/g, '\n').trim();
  const words = raw.split(/\s+/).filter(w => w.length > 1 && !/\d/.test(w));
  const lines = raw.split('\n').filter(l => l.length > 30);
  const latin = lang === 'en' || lang === 'de';
  const body = {
    prose1: lines.slice(0, 8).map(l => `<p>${esc(l.slice(0, 600))}</p>`).join(''),
    prose2: lines.slice(8, 16).map(l => `<p>${esc(l.slice(0, 600))}</p>`).join(''),
    table: `<table>${Array.from({ length: 28 }, (_, i) => `<tr><td>${i + 1}</td><td>${esc(words[i * 3] || '')}</td><td>${esc(words[i * 3 + 1] || '')} ${esc(words[i * 3 + 2] || '')}</td><td>${(i * 37 % 900) + 100}.${i % 10}0</td><td>${2019 + i % 6}-0${1 + i % 9}</td></tr>`).join('')}</table>`,
    list: `<ol>${Array.from({ length: 30 }, (_, i) => `<li>${esc(words.slice(100 + i * 4, 104 + i * 4).join(' '))} — ${i * 13 % 97}</li>`).join('')}</ol>`,
    form: `<dl>${Array.from({ length: 16 }, (_, i) => `<dt>${esc(words[200 + i * 2] || '')}:</dt><dd>${esc(words[201 + i * 2] || '')} ${(i * 7919) % 100000}</dd>`).join('')}</dl>`,
  };
  const kinds = latin ? ['table', 'list', 'form'] : Object.keys(body);
  for (const k of kinds) {
    const html = `<html lang="${lang}" dir="${RTL.has(lang) ? 'rtl' : 'ltr'}"><style>body{font-size:13pt;margin:2cm}td{border:1px solid #000;padding:4px 8px}table{border-collapse:collapse}dt{font-weight:bold;float:${RTL.has(lang) ? 'right' : 'left'};width:40%}dd{margin:0 0 8px 0}</style><body>${body[k]}</body></html>`;
    await page.setContent(html);
    fs.writeFileSync(`src/${f.replace('.txt', '')}-${k}.pdf`, await page.pdf({ format: 'A4', pageRanges: '1' }));
  }
}
await b.close();
