// Plan §8.1: the SITE's js/cmykD.js (in Node: pdf-lib, the pdf.js decoder devDependency, the site's qpdf
// WASM) on a PDF → the output, and the SHA-1 of every image it replaced (multiset compared later with the
// prototype's output).   node site_d300.mjs <repo> <in.pdf> <out.pdf> <quality>
import fs from 'fs'; import path from 'path'; import os from 'os'; import crypto from 'crypto';
import { createRequire } from 'module'; import { pathToFileURL } from 'url';
const [repo, inp, outp, q] = process.argv.slice(2);
const require = createRequire(path.join(repo, 'package.json'));
const PDFLib = require('pdf-lib');
globalThis.PDFLib = PDFLib; globalThis.self = globalThis; globalThis.importScripts = () => {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd3-')); fs.writeFileSync(path.join(tmp, 'qpdf.cjs'), fs.readFileSync(path.join(repo, 'js/vendor/qpdf/lib/qpdf.js')));
globalThis.Module = createRequire(import.meta.url)(path.join(tmp, 'qpdf.cjs'));
const src = fs.readFileSync(path.join(repo, 'js/cmykD.js'), 'utf8').replace(/^\(\(\) => \{$/m, '').replace(/^\}\)\(\);\s*$/m, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const { cmykD } = await new AsyncFunction(src + '\nreturn { cmykD };')();
const pdf = await PDFLib.PDFDocument.load(fs.readFileSync(inp), { ignoreEncryption: true, updateMetadata: false });
const before = new Map(); for (const [ref, o] of pdf.context.enumerateIndirectObjects()) if (o instanceof PDFLib.PDFRawStream) before.set(ref.tag, o.contents);
const r = await cmykD(pdf, { target: 300, quality: Number(q), maxMegapixels: 1e9, urls: {
  decoders: pathToFileURL(path.join(repo, 'node_modules/pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs')).href, qpdfJs: '', qpdfWasm: path.join(repo, 'js/vendor/qpdf/lib/qpdf.wasm') } });
const shas = [];
for (const [ref, o] of pdf.context.enumerateIndirectObjects()) if (o instanceof PDFLib.PDFRawStream && before.get(ref.tag) !== o.contents) shas.push(crypto.createHash('sha1').update(o.contents).digest('hex'));
fs.writeFileSync(outp, await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: Infinity }));
console.log(JSON.stringify({ doc: path.basename(inp), replaced: r.replaced, skipped: r.skipped, shas: shas.sort() }));
