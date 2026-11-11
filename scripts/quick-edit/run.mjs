// Quick Edit step 0 (QUICKEDIT-PREREG.md): each PDF through the site's own Quick Edit UI —
// open, type " PDFREE" at the end of the first run holding a word of ≥ 3 letters, Save.
//   node run.mjs <base-url> <out-dir> <pdf>…   → <out>/<doc>.pdf + <out>/results.jsonl
import { chromium } from '/Users/murodjon/pdfree33/pdfree33/node_modules/playwright/index.mjs';
import fs from 'fs'; import path from 'path';

const [base, out, ...files] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

for (const f of files) {
  const doc = path.basename(f, '.pdf');
  const row = { doc, inBytes: fs.statSync(f).size };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 120)));
  try {
    await page.addInitScript(() => {
      window.__pdf = null;
      const o = URL.createObjectURL.bind(URL);
      URL.createObjectURL = x => { if (x instanceof Blob && x.type === 'application/pdf') window.__pdf = x; return o(x); };
    });
    await page.goto(base + '/quick-edit-pdf/', { waitUntil: 'load', timeout: 60000 });
    const t0 = Date.now();
    await page.setInputFiles('#fileInput', f);
    // opened, refused by the gate, or an error toast
    const state = await page.waitForFunction(() => {
      if (document.querySelector('.qe-modal--open .qe-editable-run')) return 'opened';
      const opts = document.querySelector('#quickEditOptions');
      const toast = document.querySelector('#toast');
      const txt = (opts?.innerText || '') + ' ' + (toast && !toast.hidden ? toast.innerText : '');
      if (/can't|cannot|couldn|not supported|scanned|no text|refus|isn't|unusual|damaged/i.test(txt)) return 'refused: ' + txt.replace(/\s+/g, ' ').trim().slice(0, 160);
      return false;
    }, null, { timeout: 120000 }).then(h => h.jsonValue()).catch(() => 'timeout');
    row.openMs = Date.now() - t0;
    row.open = state;
    if (state === 'opened') {
      const runs = await page.locator('.qe-editable-run').count();
      row.runs = runs;
      const idx = await page.evaluate(() => [...document.querySelectorAll('.qe-editable-run')].findIndex(s => /\p{L}{3}/u.test(s.textContent)));
      row.editedRun = idx;
      if (idx >= 0) {
        const target = page.locator('.qe-editable-run').nth(idx);
        row.editedText = (await target.innerText()).slice(0, 80);
        await target.click();
        await page.waitForTimeout(150);
        await page.keyboard.press('End');
        await page.keyboard.type(' PDFREE');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        const t1 = Date.now();
        await page.click('#qeModalSaveBtn');
        const saved = await page.waitForFunction(() => {
          if (window.__pdf) return 'saved';
          const toast = document.querySelector('#toast');
          const txt = toast && !toast.hidden ? toast.innerText : '';
          const warn = document.querySelector('.qe-modal [role="alert"], .qe-modal .qe-warning');
          if (/error|fail|couldn|cannot|can't|unsupported|not supported/i.test(txt)) return 'error: ' + txt.slice(0, 160);
          if (warn && /unsupported|cannot|can't/i.test(warn.innerText)) return 'warning: ' + warn.innerText.slice(0, 160);
          return false;
        }, null, { timeout: 180000 }).then(h => h.jsonValue()).catch(() => 'timeout');
        row.saveMs = Date.now() - t1;
        row.save = saved;
        if (saved === 'saved') {
          const b64 = await page.evaluate(async () => { const u = new Uint8Array(await window.__pdf.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
          const buf = Buffer.from(b64, 'base64');
          fs.writeFileSync(path.join(out, doc + '.pdf'), buf);
          row.outBytes = buf.length;
        }
      }
    }
  } catch (e) { row.err = e.message.split('\n')[0].slice(0, 160); }
  if (errors.length) row.pageErrors = errors.slice(0, 3);
  await ctx.close();
  fs.appendFileSync(path.join(out, 'results.jsonl'), JSON.stringify(row) + '\n');
  console.log(JSON.stringify(row));
}
await browser.close();
