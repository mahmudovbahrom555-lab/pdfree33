// Runs js/compressPrepWorker.js's real pass (Standard: stripXmp + cmykFlate) in Node on each PDF,
// writes <out>/<name>, prints bytes and time. Usage: node flate_l_node.mjs <out-dir> <pdf>...
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';
import { createRequire } from 'module';
const REPO = '/Users/murodjon/pdfree33/pdfree33';
const require = createRequire(REPO + '/package.json');
globalThis.PDFLib = require('pdf-lib');
const src = readFileSync(REPO + '/js/compressPrepWorker.js', 'utf8')
  .replace(/importScripts\([^)]+\);?/g, 'void 0;').replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');
const { _encodeRawImages } = await new (Object.getPrototypeOf(async function () {}).constructor)(src + '\nreturn { _encodeRawImages };')();
const [out, ...files] = process.argv.slice(2);
for (const f of files) {
  const buf = readFileSync(f); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  for (const [tag, cmyk] of [['base', false], ['L', true]]) {
    const t = Date.now();
    const r = await _encodeRawImages(ab.slice(0), true, cmyk);
    writeFileSync(`${out}/${tag}-${basename(f)}`, Buffer.from(r.result));
    console.log(JSON.stringify({ file: basename(f), tag, bytes: r.result.byteLength, cmyk: r.cmyk, ms: Date.now() - t }));
  }
}
