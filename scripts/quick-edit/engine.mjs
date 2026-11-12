// Quick Edit step 2 — the in-place ENGINE measured directly (no UI yet): for each PDF, the first line on page 1
// holding a word of ≥ 3 letters gets " PDFREE" appended through js/quickEditOriginal.js (MuPDF glyph redaction +
// insert + verification), the same criteria as run.mjs (compare.py reads the outputs).
//   node engine.mjs <base-url> <out-dir> <pdf>…
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs'; import path from 'path';
const [base, out, ...files] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + '/quick-edit-pdf/', { waitUntil: 'load' });
for (const f of files) {
  const doc = path.basename(f, '.pdf');
  const t0 = Date.now();
  const r = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const m = await import('/js/quickEditOriginal.js');
    const file = { arrayBuffer: async () => bytes.slice().buffer };
    let original;
    try { original = await m.openOriginalPdf(file); } catch (e) { return { open: 'refused: ' + e.message.slice(0, 120) }; }
    try {
      const pg = await original.pdf.getPage(1);
      const width = pg.view[2];
      const lines = m.originalLines((await pg.getTextContent()).items);
      const line = lines.find(l => /\p{L}{3}/u.test(l.text) && !l.mixed);
      if (!line) return { open: 'opened', save: 'no editable line on page 1' };
      const next = lines.find(o => o.y === line.y && o.x > line.right);
      line.page = 0;
      line.maxRight = next ? Math.max(line.right, next.x - 12) : Math.max(line.right, width - 36);
      const text = line.text + ' PDFREE';
      const prepared = await m.prepareOriginalCopy(original, [line]);
      const planned = await m.planOriginalCopies(prepared, [{ recipientIndex: 0, changes: [{ line, text, parts: null, appearance: null }] }], true, () => false);
      const blob = await m.writeOriginalCopy(prepared, planned[0]);
      const u = new Uint8Array(await blob.arrayBuffer()); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return { open: 'opened', save: 'saved', line: line.text.slice(0, 60), out: btoa(s) };
    } catch (e) { return { open: 'opened', save: 'error: ' + String(e.message).slice(0, 160), debug: window.__qeDebug }; }
    finally { await original.pdf.destroy().catch(() => {}); }
  }, fs.readFileSync(f).toString('base64')).catch(e => ({ open: 'crash: ' + e.message.slice(0, 120) }));
  const row = { doc, open: r.open, save: r.save, line: r.line, ms: Date.now() - t0, debug: r.debug };
  if (r.out) fs.writeFileSync(path.join(out, doc + '.pdf'), Buffer.from(r.out, 'base64'));
  fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}
await browser.close();
