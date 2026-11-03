import fs from 'fs';
import { execFileSync } from 'child_process';
let src = fs.readFileSync('/Users/murodjon/pdfree33/pdfree33/js/cleanScanWorker.js', 'utf8').replace(/importScripts\([^)]+\);?/g, 'void 0;').replace(/self\.onmessage\s*=[\s\S]*?^};/m, '');
const INJ = `{ let mt = 0, dk = 0; const MM = new Uint8Array(RW * RH);
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const p = y * w + x, b = blockOf(p);
        if (!inComp[b] || around(x, y) >= _DARK_AREA) continue; dk++; const v = lum[p] - med[b];
        if (v > 20 && v <= _DARK_LIFT) { mt++; MM[(y - Y0) * RW + x - X0] = 1; } }
      const wide = [2, 4, 7].map(k => +(_erodedShare(MM, RW, RH, k) * mt / Math.max(1, dk)).toFixed(4));
      globalThis.__R.push({ mid: +(mt / Math.max(1, dk)).toFixed(4), wide, share: +(lit / Math.max(1, total)).toFixed(4) }); }
    if (lit < _DARK_LIGHT_MIN`;
src = src.replace('if (lit < _DARK_LIGHT_MIN', INJ);
const AF = Object.getPrototypeOf(async function () {}).constructor;
const { _darkRegionMask } = await new AF(src + '\nreturn { _darkRegionMask };')();
for (const f of process.argv.slice(2)) {
  globalThis.__R = [];
  const raw = execFileSync('python3', ['-c', `import fitz,sys;p=fitz.open(sys.argv[1])[0].get_pixmap(matrix=fitz.Matrix(2,2),alpha=True);sys.stdout.buffer.write(p.width.to_bytes(4,'little')+p.height.to_bytes(4,'little')+p.samples)`, f], { maxBuffer: 1 << 30 });
  const w = raw.readUInt32LE(0), h = raw.readUInt32LE(4), d = new Uint8ClampedArray(raw.buffer, raw.byteOffset + 8, w * h * 4);
  const m = _darkRegionMask(d, w, h);
  console.log(f.split('/').pop(), 'mask', m ? (m.reduce((a, b) => a + b, 0) / (w * h)).toFixed(3) : 'null', JSON.stringify(globalThis.__R));
}
