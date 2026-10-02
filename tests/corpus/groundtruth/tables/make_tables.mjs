// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// Ground-truth TABLE PDFs for PDF→Excel: an invoice rendered from known cells, so
// every cell's true text, position and numeric value is exact. Content is the
// project's own (an office-supplies invoice), never user data. Each document: a
// title line, a 5-column table (header, 8 items — one long enough to wrap in its
// cell —, a bold total row with empty cells), a note line under the table.
//   ruled   every cell bordered (drawn rules)
//   plain   no cell borders, only a rule under the header (report style)
// Arabic and Persian also come with their own digits (٠١٢٣ / ۰۱۲۳, ٬ thousands,
// ٫ decimal) as well as Western ones — both are common in real invoices.
// Output: <lang>-<layout>[-<digits>].pdf + .json ({ lang, dir, layout, digits,
// oracleRecall, title, note, rows, values }); rows[0] is the header, values holds
// each cell's number (or null). Regenerate: node tests/corpus/groundtruth/tables/make_tables.mjs
// (fonts as for the prose set, see ../gtShared.mjs). The PDFs are committed.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FONTS, fontFaces, oracleRecall, ORACLE_MIN } from '../gtShared.mjs';

const OUT = new URL('./', import.meta.url);

// quantity, unit price per item; totals are computed
const ITEMS = [[12, 18.5], [10, 145], [40, 2.75], [5, 32], [24, 1.25], [2, 89.9], [18, 4.4], [100, 0.85]];
const DATES = [14, 14, 15, 15, 18, 21, 21, 22];
const LANGS = {
  en: {
    dir: 'ltr', font: FONTS.latin, title: 'Invoice No. 1042', note: 'All amounts in USD.',
    header: ['Item', 'Qty', 'Unit price', 'Total', 'Date'], total: 'Total',
    names: ['A4 printing paper', 'Black printer ink', 'Plastic folders', 'Desk stapler', 'Blue ballpoint pens',
      'Scientific calculator', 'Clear adhesive tape', 'Large A4 mailing envelopes with an adhesive strip'],
    date: d => `2026-09-${d}`,
  },
  ar: {
    dir: 'rtl', font: FONTS.ar, title: 'فاتورة رقم 1042', note: 'جميع المبالغ بالريال السعودي.',
    header: ['البند', 'الكمية', 'سعر الوحدة', 'الإجمالي', 'التاريخ'], total: 'المجموع',
    names: ['ورق طباعة A4', 'حبر طابعة أسود', 'ملفات بلاستيكية', 'دباسة مكتبية', 'أقلام حبر زرقاء',
      'آلة حاسبة علمية', 'شريط لاصق شفاف', 'مغلفات بريدية كبيرة مقاس A4 مع شريط لاصق'],
    date: d => `2026/09/${d}`, digits: { arab: '٠١٢٣٤٥٦٧٨٩' },
  },
  fa: {
    dir: 'rtl', font: FONTS.fa, title: 'فاکتور شماره 1042', note: 'همه مبالغ به هزار ریال است.',
    header: ['شرح کالا', 'تعداد', 'قیمت واحد', 'مبلغ کل', 'تاریخ'], total: 'جمع کل',
    names: ['کاغذ چاپ A4', 'جوهر چاپگر مشکی', 'پوشه پلاستیکی', 'منگنه رومیزی', 'خودکار آبی',
      'ماشین\u200Cحساب مهندسی', 'چسب نواری شفاف', 'پاکت نامه بزرگ اندازه A4 با نوار چسب'],
    date: d => `1405/06/${d + 9}`, digits: { arabext: '۰۱۲۳۴۵۶۷۸۹' },
  },
  he: {
    dir: 'rtl', font: FONTS.he, title: 'חשבונית מס׳ 1042', note: 'כל הסכומים בשקלים.',
    header: ['פריט', 'כמות', 'מחיר ליחידה', 'סה״כ', 'תאריך'], total: 'סה״כ לתשלום',
    names: ['נייר הדפסה A4', 'דיו למדפסת שחור', 'תיקיות פלסטיק', 'מכונת שדכן', 'עטים כחולים',
      'מחשבון מדעי', 'סרט הדבקה שקוף', 'מעטפות דואר גדולות בגודל A4 עם פס הדבקה'],
    date: d => `2026-09-${d}`,
  },
};
const LAYOUTS = {
  ruled: 'table { border-collapse: collapse; } td, th { border: 0.75pt solid #000; padding: 3pt 6pt; }',
  plain: 'table { border-collapse: collapse; } td, th { padding: 3pt 10pt; } thead th { border-bottom: 0.75pt solid #000; }',
};

const money = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Western digits → a native set; "," → ٬ and "." → ٫ inside numbers only. A
// number glued to Latin letters ("A4", a paper size) stays as it is.
const nativeDigits = (s, set) => s.replace(/(?<![A-Za-z])\d[\d,.]*/g, num =>
  num.replace(/[\d,.]/g, c => (c === ',' ? '٬' : c === '.' ? '٫' : set[c])));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [lang, L] of Object.entries(LANGS)) {
  const sum = ITEMS.reduce((s, [q, p]) => s + q * p, 0);
  const rows = [L.header,
    ...ITEMS.map(([q, p], i) => [L.names[i], String(q), money(p), money(q * p), L.date(DATES[i])]),
    [L.total, '', '', money(sum), '']];
  const values = [L.header.map(() => null),
    ...ITEMS.map(([q, p]) => [null, q, p, Math.round(q * p * 100) / 100, null]),
    [null, null, null, Math.round(sum * 100) / 100, null]];
  for (const [digits, set] of [['latn', null], ...Object.entries(L.digits || {})]) {
    const d = s => (set ? nativeDigits(s, set) : s);
    const cells = rows.map(r => r.map(d));
    for (const [layout, css] of Object.entries(LAYOUTS)) {
      const html = `<!doctype html><html lang="${lang}" dir="${L.dir}"><head><meta charset="utf-8">
<style>${fontFaces('GT', L.font)}
${L.font === FONTS.latin ? '' : fontFaces('GTLatin', FONTS.latin)}
body { font-family: 'GT', 'GTLatin'; font-size: 11pt; margin: 0; }
h2 { font-size: 15pt; font-weight: 700; margin: 0 0 12pt; } p { margin: 12pt 0 0; }
td:first-child { width: 150pt; } td.n { text-align: end; } tr.total td { font-weight: 700; } ${css}</style></head>
<body><h2>${esc(d(L.title))}</h2><table>
<thead><tr>${cells[0].map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
<tbody>${cells.slice(1).map((r, i) => `<tr${i === cells.length - 2 ? ' class="total"' : ''}>${r.map((c, ci) =>
  `<td${ci > 0 && ci < 4 ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('\n')}</tbody>
</table><p>${esc(d(L.note))}</p></body></html>`;
      await page.setContent(html);
      await page.evaluate(() => document.fonts.ready);
      const name = `${lang}-${layout}${digits === 'latn' ? '' : `-${digits}`}`;
      const pdfPath = fileURLToPath(new URL(`${name}.pdf`, OUT));
      writeFileSync(pdfPath, await page.pdf({
        format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
      }));
      const oracle = oracleRecall(pdfPath, cells.flat().filter(Boolean).map(text => ({ text })), { digitsAnyOrder: !!set });
      if (oracle < ORACLE_MIN) throw new Error(`${name}: MuPDF recovers only ${oracle.toFixed(3)} of the words — broken text layer`);
      writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify({
        lang, dir: L.dir, layout, digits, oracleRecall: +oracle.toFixed(3),
        title: d(L.title), note: d(L.note), rows: cells, values,
      }, null, 1) + '\n');
      console.log(name, 'oracle recall', oracle.toFixed(3));
    }
  }
}
await browser.close();
