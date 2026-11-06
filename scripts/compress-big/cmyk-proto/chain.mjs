// Stage 2 chain (PROTO-PREREG.md): pdf.js decoder → area-average downsample → the site's qpdf WASM
// as the JPEG encoder. Measurement only — the JS a browser worker would run, driven from Node.
//
//   node chain.mjs <jobs.json> <out-dir>
//   jobs.json: [{ id, kind: 'dct'|'raw', src: <file>, w, h, nc: 4|1, invert: bool, nw, nh }]
//   → <out-dir>/<id>.jpg + <out-dir>/results.json (per job: ok/skip reason, sizes, guard stats)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PDFJS = process.env.PDFJS_DECODERS || path.join(HERE, 'node_modules/pdfjs-dist/image_decoders/pdf.image_decoders.mjs');
const QPDF_DIR = process.env.QPDF_DIR;   // a copy of js/vendor/qpdf/lib with qpdf.js renamed qpdf.cjs (Node treats .js there as ESM)
const QUALITY = Number(process.env.Q || 75);
const PURE_K_MAX_SHARE = 0.001;

const { JpegImage } = await import(PDFJS);
const qpdf = await require(path.join(QPDF_DIR, 'qpdf.cjs'))({ locateFile: f => path.join(QPDF_DIR, f), noInitialRun: true, print: () => {}, printErr: () => {} });

/** Stored samples (= ink for CMYK in a PDF, = grey level for DeviceGray), or null when the JPEG is out of scope. */
function decodeJpeg(bytes, nc) {
  const j = new JpegImage({ decodeTransform: null, colorTransform: -1 });
  j.parse(bytes);
  if (j.numComponents !== nc) return { skip: `components ${j.numComponents} != ${nc}` };
  if (nc === 4 && !j.adobe) return { skip: 'non-Adobe 4-channel JPEG' };
  const data = j.getData({ width: j.width, height: j.height, forceRGB: false, isSourcePDF: true });
  return { data, w: j.width, h: j.height };
}

/** Area-average (box) downsample, separable, exact fractional weights. */
function downsample(src, w, h, nc, nw, nh) {
  const sx = w / nw, sy = h / nh;
  const tmp = new Float32Array(nw * h * nc);
  for (let x = 0; x < nw; x++) {
    const x0 = x * sx, x1 = x0 + sx;
    for (let xs = Math.floor(x0); xs < Math.min(w, Math.ceil(x1)); xs++) {
      const wt = (Math.min(x1, xs + 1) - Math.max(x0, xs)) / sx;
      for (let y = 0; y < h; y++) {
        const si = (y * w + xs) * nc, di = (y * nw + x) * nc;
        for (let c = 0; c < nc; c++) tmp[di + c] += src[si + c] * wt;
      }
    }
  }
  const out = new Uint8Array(nw * nh * nc);
  const acc = new Float32Array(nw * nc);
  for (let y = 0; y < nh; y++) {
    acc.fill(0);
    const y0 = y * sy, y1 = y0 + sy;
    for (let ys = Math.floor(y0); ys < Math.min(h, Math.ceil(y1)); ys++) {
      const wt = (Math.min(y1, ys + 1) - Math.max(y0, ys)) / sy;
      const row = ys * nw * nc;
      for (let i = 0; i < nw * nc; i++) acc[i] += tmp[row + i] * wt;
    }
    for (let i = 0; i < nw * nc; i++) out[y * nw * nc + i] = Math.min(255, Math.max(0, Math.round(acc[i])));
  }
  return out;
}

/** One-image PDF, image stored uncompressed (so qpdf's DCT is always smaller), with a correct xref. */
function tempPdf(samples, w, h, nc) {
  const enc = s => Buffer.from(s, 'latin1');
  const parts = [], offs = [];
  let len = 0;
  const push = b => { parts.push(b); len += b.length; };
  push(enc('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'));
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  ];
  objs.forEach((o, i) => { offs.push(len); push(enc(`${i + 1} 0 obj\n${o}\nendobj\n`)); });
  offs.push(len);
  push(enc(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${nc === 4 ? 'DeviceCMYK' : 'DeviceGray'} /BitsPerComponent 8 /Length ${samples.length} >>\nstream\n`));
  push(Buffer.from(samples.buffer, samples.byteOffset, samples.length));
  push(enc('\nendstream\nendobj\n'));
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  offs.push(len); push(enc(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`));
  const xref = len;
  push(enc(`xref\n0 6\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** qpdf --optimize-images → the JPEG bytes it wrote, or null. */
function qpdfEncode(samples, w, h, nc) {
  qpdf.FS.writeFile('/in.pdf', tempPdf(samples, w, h, nc));
  const rc = qpdf.callMain(['--optimize-images', '--oi-min-width=0', '--oi-min-height=0', '--oi-min-area=0',
    `--jpeg-quality=${QUALITY}`, '--object-streams=disable', '--decode-level=none', '/in.pdf', '/out.pdf']);
  if (rc !== 0 && rc !== 3) return null;
  const out = Buffer.from(qpdf.FS.readFile("/out.pdf"));
  if (process.env.DUMP) fs.writeFileSync(path.join(process.argv[3], "last-qpdf.pdf"), out);
  const s = out.toString('latin1');
  const at = s.indexOf('/DCTDecode');
  if (at < 0) return null;
  const dictStart = s.indexOf('<<', s.lastIndexOf(' obj', at));   // the dictionary of the object holding /DCTDecode
  const dictEnd = s.indexOf('stream', at);
  const len = /\/Length (\d+)(?! \d+ R)/.exec(s.slice(dictStart, dictEnd));   // the image dictionary's own direct /Length
  if (!len) return null;
  const start = dictEnd + (s[dictEnd + 6] === '\r' ? 8 : 7);
  const jpg = out.subarray(start, start + Number(len[1]));
  return jpg[0] === 0xFF && jpg[1] === 0xD8 ? jpg : null;
}

/** Per-image guard (criteria v0.2 §6): pure-K pixels of the source must not gain C/M/Y > 2. Same decoder before/after. */
function guard(src, outJpeg, nc) {
  const back = decodeJpeg(outJpeg, nc);
  if (back.skip) return { ok: false, why: 're-decode: ' + back.skip };
  let maxBlock = 0;   // recorded for Stage 3 calibration only (8×8 block mean |Δ|, worst channel)
  const { data: b, w, h } = back;
  for (let by = 0; by + 8 <= h; by += 8) for (let bx = 0; bx + 8 <= w; bx += 8) for (let c = 0; c < nc; c++) {
    let s = 0;
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) { const i = (y * w + x) * nc + c; s += Math.abs(src[i] - b[i]); }
    if (s / 64 > maxBlock) maxBlock = s / 64;
  }
  if (nc === 1) return { ok: true, maxBlock };
  let pure = 0, bad = 0;
  for (let i = 0; i < src.length; i += 4) {
    if (src[i] === 0 && src[i + 1] === 0 && src[i + 2] === 0 && src[i + 3] > 0) {
      pure++;
      if (b[i] > 2 || b[i + 1] > 2 || b[i + 2] > 2) bad++;
    }
  }
  const ok = pure < 50 || bad / pure <= PURE_K_MAX_SHARE;
  return { ok, why: ok ? '' : `pure K ${bad}/${pure}`, pure, bad, maxBlock };
}

const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outDir = process.argv[3];
const results = [];
for (const job of jobs) {
  const r = { id: job.id };
  try {
    const bytes = new Uint8Array(fs.readFileSync(job.src));
    let samples, w = job.w, h = job.h;
    if (job.kind === 'dct') {
      const d = decodeJpeg(bytes, job.nc);
      if (d.skip) { results.push({ ...r, skip: d.skip }); continue; }
      if (d.w !== w || d.h !== h) { results.push({ ...r, skip: `size ${d.w}x${d.h} != dict ${w}x${h}` }); continue; }
      samples = d.data;
    } else {
      if (bytes.length !== w * h * job.nc) { results.push({ ...r, skip: 'raw length' }); continue; }
      samples = bytes;
    }
    if (job.invert) samples = samples.map(v => 255 - v);   // /Decode [1 0 …]: write what readers show
    if (job.nw < w || job.nh < h) { samples = downsample(samples, w, h, job.nc, job.nw, job.nh); w = job.nw; h = job.nh; }
    if (process.env.DUMP) fs.writeFileSync(path.join(outDir, `${job.id}.ds.raw`), samples);   // stage A check
    const jpg = qpdfEncode(samples, w, h, job.nc);
    if (!jpg) { results.push({ ...r, skip: 'qpdf gave no DCT' }); continue; }
    const g = guard(samples, jpg, job.nc);
    fs.writeFileSync(path.join(outDir, `${job.id}.jpg`), jpg);
    results.push({ ...r, ok: g.ok, why: g.why, w, h, bytes: jpg.length, pure: g.pure, bad: g.bad, maxBlock: g.maxBlock });
  } catch (e) {
    results.push({ ...r, skip: 'error: ' + e.message });
  }
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results));
console.log(`${results.filter(x => x.ok).length} encoded+guarded, ${results.filter(x => x.ok === false).length} guard-rejected, ${results.filter(x => x.skip).length} skipped`);
