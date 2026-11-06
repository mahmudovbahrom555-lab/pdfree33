import { readFileSync } from 'fs'; import { createRequire } from 'module';
const require = createRequire('/Users/murodjon/pdfree33/pdfree33/package.json');
const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict, decodePDFRawStream } = require('pdf-lib');
for (const f of process.argv.slice(2)) {
  const pdf = await PDFDocument.load(readFileSync(f), { ignoreEncryption: true, updateMetadata: false });
  const c = {}; const add = k => c[k] = (c[k] || 0) + 1; let bytes = {};
  for (const [, o] of pdf.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream) || o.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    if (pdf.context.lookup(o.dict.get(PDFName.of('ColorSpace')))?.toString() !== '/DeviceCMYK') continue;
    let fl = pdf.context.lookup(o.dict.get(PDFName.of('Filter'))); if (fl instanceof PDFArray && fl.size() === 1) fl = fl.get(0);
    if (fl?.toString() !== '/FlateDecode') { add('notflate:' + fl); continue; }
    if (o.dict.has(PDFName.of('SMask')) || o.dict.has(PDFName.of('Mask'))) { add('mask'); bytes.mask = (bytes.mask || 0) + o.contents.length; continue; }
    if (o.contents.length < 2048) { add('small'); continue; }
    const dp = o.dict.get(PDFName.of('DecodeParms')); if (dp) add('parms:' + String(pdf.context.lookup(dp)).replace(/\s+/g, ' ').slice(0, 60));
    let d; try { d = decodePDFRawStream(o).decode(); } catch (e) { add('decodeErr'); continue; }
    const w = pdf.context.lookup(o.dict.get(PDFName.of('Width')))?.asNumber(), h = pdf.context.lookup(o.dict.get(PDFName.of('Height')))?.asNumber();
    if (!dp && d.length !== w * h * 4) { add(`len ${d.length} vs ${w * h * 4}`); continue; }
    const z = pdf.context.flateStream(d).contents;
    if (z.length >= o.contents.length) { add('notSmaller'); bytes.notSmaller = (bytes.notSmaller || 0) + o.contents.length; continue; }
    add('ok'); bytes.ok = (bytes.ok || 0) + o.contents.length - z.length;
  }
  console.log(f.split('/').pop(), JSON.stringify(c), JSON.stringify(bytes));
}
