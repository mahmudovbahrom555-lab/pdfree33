// Page count of a PDF by pdf.js (legacy Node build) — Stage 4 "opens in pdf.js" check.
import fs from 'fs';
const pdfjs = await import(new URL('./node_modules/pdfjs-dist/legacy/build/pdf.mjs', import.meta.url).href);
try {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(process.argv[2])), isEvalSupported: false, verbosity: 0 }).promise;
  console.log(doc.numPages);
} catch (e) { console.log('ERR ' + e.message); }
