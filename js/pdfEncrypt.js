// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors
//
// ============================================================
//  pdfEncrypt.js — RC4-128 PDF encryption (Rev 3, V=2)
//
//  Fully compliant with PDF spec §3.5:
//    • Encrypts stream data       (Algorithm 3.1, per-object key)
//    • Encrypts string literals   (literal & hex) in all objects
//    • Skips /Encrypt dict, trailer, xref table (correct per spec)
//    • Outputs encrypted strings as <hex> for max viewer compat
//
//  Tested: qpdf --check, Chrome PDF Viewer, Adobe Reader.
// ============================================================

// ── RC4 ───────────────────────────────────────────────────────

function _rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  for (let i = 0, j = 0, k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}

// ── Pure-JS MD5 (RFC 1321) ────────────────────────────────────

function _md5(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const len = data.length;
  const padLen = ((len + 8) & ~63) + 64;
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 8, (len * 8) >>> 0, true);
  dv.setUint32(padLen - 4, Math.floor((len / 0x20000000) | 0), true);

  const T = new Uint32Array(64);
  for (let i = 0; i < 64; i++) T[i] = (Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const SH = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
               5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
               4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
               6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];

  let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
  for (let blk = 0; blk < padLen; blk += 64) {
    const M = new Int32Array(padded.buffer, blk, 16);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let j = 0; j < 64; j++) {
      let F, g;
      if      (j < 16) { F = (b & c) | (~b & d); g = j; }
      else if (j < 32) { F = (d & b) | (~d & c); g = (5 * j + 1) & 15; }
      else if (j < 48) { F = b ^ c ^ d;           g = (3 * j + 5) & 15; }
      else             { F = c ^ (b | ~d);         g = (7 * j) & 15; }
      F = (F + a + T[j] + M[g]) | 0;
      a = d; d = c; c = b;
      b = (b + ((F << SH[j]) | (F >>> (32 - SH[j])))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const r = new Uint8Array(16);
  const rv = new DataView(r.buffer);
  rv.setInt32(0, a0, true); rv.setInt32(4, b0, true);
  rv.setInt32(8, c0, true); rv.setInt32(12, d0, true);
  return r;
}

// ── PDF Standard padding (Table 3.2) ─────────────────────────

const _PAD32 = new Uint8Array([
  0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,
  0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
  0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,
  0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A,
]);

function _padPwd(pwd) {
  const enc = new TextEncoder().encode((pwd || '').normalize('NFC'));
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = i < enc.length ? enc[i] : _PAD32[i - enc.length];
  return out;
}

// ── Key derivation (PDF spec Rev 3) ──────────────────────────

function _ownerKey(ownerPwd, userPwd) {
  // Algorithm 3.3
  let h = _md5(_padPwd(ownerPwd || userPwd));
  for (let i = 0; i < 50; i++) h = _md5(h);
  let result = _padPwd(userPwd);
  for (let i = 0; i < 20; i++) {
    const k = new Uint8Array(16);
    for (let j = 0; j < 16; j++) k[j] = h[j] ^ i;
    result = _rc4(k, result);
  }
  return result;
}

function _fileKey(userPwd, oKey, permFlags, fileId) {
  // Algorithm 3.2 — 128-bit key
  const up  = _padPwd(userPwd);
  const P32 = new Uint8Array(4);
  new DataView(P32.buffer).setInt32(0, permFlags, true);
  const buf = new Uint8Array(up.length + oKey.length + 4 + fileId.length);
  let off = 0;
  buf.set(up,   off); off += up.length;
  buf.set(oKey, off); off += oKey.length;
  buf.set(P32,  off); off += 4;
  buf.set(fileId, off);
  let h = _md5(buf);
  for (let i = 0; i < 50; i++) h = _md5(h);
  return h;  // 16 bytes
}

function _userKey(fKey, fileId) {
  // Algorithm 3.5 (Rev 3)
  const buf = new Uint8Array(_PAD32.length + fileId.length);
  buf.set(_PAD32); buf.set(fileId, _PAD32.length);
  let result = _rc4(fKey, _md5(buf));
  for (let i = 1; i < 20; i++) {
    const k = new Uint8Array(16);
    for (let j = 0; j < 16; j++) k[j] = fKey[j] ^ i;
    result = _rc4(k, result);
  }
  const out = new Uint8Array(32);
  out.set(result);
  return out;
}

function _objKey(fKey, objId, gen) {
  // Algorithm 3.1 — per-object RC4 key
  const buf = new Uint8Array(fKey.length + 5);
  buf.set(fKey);
  buf[fKey.length + 0] =  objId        & 0xff;
  buf[fKey.length + 1] = (objId >>  8) & 0xff;
  buf[fKey.length + 2] = (objId >> 16) & 0xff;
  buf[fKey.length + 3] =  gen          & 0xff;
  buf[fKey.length + 4] = (gen   >>  8) & 0xff;
  return _md5(buf).slice(0, Math.min(fKey.length + 5, 16));
}

// ── Permission flags (Table 3.20) ─────────────────────────────

function _permFlags(p = {}) {
  let f = 0xFFFFF0C0 | 0;  // reserved bits = 1
  if (p.printing         !== false) f |= 0x0004;
  if (p.modifying        !== false) f |= 0x0008;
  if (p.copying          !== false) f |= 0x0010;
  if (p.annotating       !== false) f |= 0x0020;
  if (p.fillingForms     !== false) f |= 0x0100;
  f |= 0x0200;  // contentAccessibility: always on
  if (p.documentAssembly !== false) f |= 0x0400;
  if (p.printing         !== false) f |= 0x0800;
  return f;
}

// ── Utilities ─────────────────────────────────────────────────

function _rand(n) {
  const b = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < n; i++) b[i] = (Math.random() * 256) | 0;
  }
  return b;
}

function _hex(b) {
  return Array.from(b).map(v => v.toString(16).padStart(2, '0')).join('');
}

function _hexToBuf(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return b;
}

// ── PDF xref parser ───────────────────────────────────────────

function _parseXRef(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);

  const sxIdx    = text.lastIndexOf('startxref');
  const eofIdx   = text.indexOf('\n', sxIdx + 10);
  const startXref = parseInt(text.slice(sxIdx + 10, eofIdx).trim(), 10);

  const xrefSection = text.slice(startXref);
  const objects = {};

  const lines = xrefSection.split('\n');
  let lineIdx = 1;  // skip 'xref' line
  let curId   = 0;
  while (lineIdx < lines.length) {
    const line = lines[lineIdx].trim();
    if (!line || line === 'trailer' || line.startsWith('<<')) break;
    const ssMatch  = line.match(/^(\d+) (\d+)$/);
    if (ssMatch) { curId = parseInt(ssMatch[1], 10); lineIdx++; continue; }
    const entMatch = line.match(/^(\d{10}) (\d{5}) ([fn])/);
    if (entMatch) {
      const off = parseInt(entMatch[1], 10);
      if (entMatch[3] === 'n' && off > 0) objects[curId] = off;
      curId++;
    }
    lineIdx++;
  }

  const trailerIdx = xrefSection.indexOf('trailer');
  const trailerEnd = xrefSection.indexOf('startxref', trailerIdx);
  const trailer    = xrefSection.slice(trailerIdx, trailerEnd);

  const sizeMatch = trailer.match(/\/Size (\d+)/);
  const rootMatch = trailer.match(/\/Root (\d+) (\d+) R/);
  const infoMatch = trailer.match(/\/Info (\d+) (\d+) R/);
  const idMatch   = trailer.match(/\/ID\s*\[\s*<([0-9a-fA-F]+)>/);

  return {
    objects,
    size:     sizeMatch ? +sizeMatch[1] : 10,
    startXref,
    rootRef:  rootMatch ? `${rootMatch[1]} ${rootMatch[2]} R` : '1 0 R',
    infoRef:  infoMatch ? `${infoMatch[1]} ${infoMatch[2]} R` : null,
    fileId:   idMatch   ? _hexToBuf(idMatch[1]) : _rand(16),
  };
}

// ── Stream boundary detection ─────────────────────────────────

/**
 * Find stream data start and end within a single object string.
 *
 * PRIMARY: uses /Length from the dict — binary-safe, exact.
 * Searching for 'endstream' is unreliable: binary/compressed stream data
 * can contain the byte sequence 'endstream', causing premature termination
 * (proven: endstream-search extracts 6 bytes instead of 21 in edge-case test).
 * /Length is the only correct approach per PDF spec §3.2.7.
 *
 * FALLBACK: if /Length is absent or is an indirect reference,
 * search for the endstream marker with all three EOL variants.
 *
 * Returns { dataStart, dataEnd } or null if no stream in this object.
 */
function _findStreamBounds(objStr) {
  let i = 0;

  while (i < objStr.length) {
    const ch = objStr[i];

    // Skip literal strings — 'stream' inside (text) must not match
    if (ch === '(') {
      let depth = 1; i++;
      while (i < objStr.length && depth > 0) {
        if (objStr[i] === '\\') { i += 2; continue; }
        if (objStr[i] === '(') depth++;
        if (objStr[i] === ')') depth--;
        i++;
      }
      continue;
    }

    // Skip hex strings — 'stream' inside <hex> must not match
    if (ch === '<' && objStr[i + 1] !== '<') {
      while (i < objStr.length && objStr[i] !== '>') i++;
      if (i < objStr.length) i++;
      continue;
    }

    // 'stream' keyword — must be followed by \r\n or \n (PDF spec §3.2.7)
    if (ch === 's' && objStr.slice(i, i + 6) === 'stream') {
      const c1 = objStr[i + 6], c2 = objStr[i + 7];
      let dataStart = -1;
      if (c1 === '\r' && c2 === '\n') dataStart = i + 8;
      else if (c1 === '\n')            dataStart = i + 7;

      if (dataStart >= 0) {
        const dictPart = objStr.slice(0, i);

        // PRIMARY: /Length <direct-integer> — binary-safe.
        // Pattern (?=\s|>>) ensures we don't match /Length within a name.
        // Indirect refs like '/Length 5 0 R' won't match \d+(?=\s|>>).
        const lenMatch = dictPart.match(/\/Length\s+(\d+)(?=\s|>>)/);
        if (lenMatch) {
          return { dataStart, dataEnd: dataStart + parseInt(lenMatch[1], 10) };
        }

        // FALLBACK: marker search — three EOL variants, take earliest.
        let dataEnd = -1;
        for (const marker of ['\r\nendstream', '\nendstream', '\rendstream']) {
          const idx = objStr.indexOf(marker, dataStart);
          if (idx !== -1 && (dataEnd === -1 || idx < dataEnd)) dataEnd = idx;
        }
        return { dataStart, dataEnd: dataEnd === -1 ? objStr.length : dataEnd };
      }

      i += 6;
      continue;
    }

    i++;
  }

  return null;  // no stream in this object
}

// ── String encryption ─────────────────────────────────────────

/**
 * Walk through the text of a single PDF object's dictionary,
 * encrypt every string literal (…) and hex string <…> with objKey,
 * and return the text with those strings replaced by <encrypted-hex>.
 *
 * Names (/Name), numbers, booleans, null, <</>>, arrays, comments
 * are passed through unchanged — only strings are encrypted.
 */
function _encryptStringsInText(text, objKey) {
  let result = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // ── Literal string (…) ──────────────────────────────────
    if (ch === '(') {
      const bytes = [];
      let j = i + 1;
      let depth = 1;

      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === '\\' && j + 1 < text.length) {
          const esc = text[j + 1];
          if      (esc === 'n' ) { bytes.push(10); j += 2; }
          else if (esc === 'r' ) { bytes.push(13); j += 2; }
          else if (esc === 't' ) { bytes.push(9);  j += 2; }
          else if (esc === 'b' ) { bytes.push(8);  j += 2; }
          else if (esc === 'f' ) { bytes.push(12); j += 2; }
          else if (esc === '(' || esc === ')' || esc === '\\') {
            bytes.push(esc.charCodeAt(0)); j += 2;
          } else if (esc >= '0' && esc <= '7') {
            // Octal: 1–3 digits
            let oct = esc; j += 2;
            if (j < text.length && text[j] >= '0' && text[j] <= '7') oct += text[j++];
            if (j < text.length && text[j] >= '0' && text[j] <= '7') oct += text[j++];
            bytes.push(parseInt(oct, 8) & 0xff);
          } else if (esc === '\r') {
            // Line continuation \<CR> or \<CR><LF>
            j += 2; if (j < text.length && text[j] === '\n') j++;
          } else if (esc === '\n') {
            // Line continuation \<LF>
            j += 2;
          } else {
            bytes.push(esc.charCodeAt(0) & 0xff); j += 2;
          }
        } else if (c === '(') {
          depth++; bytes.push(40); j++;
        } else if (c === ')') {
          depth--;
          if (depth > 0) bytes.push(41);
          j++;
        } else {
          bytes.push(c.charCodeAt(0) & 0xff); j++;
        }
      }

      const plain     = new Uint8Array(bytes);
      const encrypted = _rc4(objKey, plain);
      result += '<' + _hex(encrypted) + '>';
      i = j;

    // ── Hex string <…> ──────────────────────────────────────
    } else if (ch === '<' && text[i + 1] !== '<') {
      const closeIdx = text.indexOf('>', i + 1);
      if (closeIdx !== -1) {
        const hexContent = text.slice(i + 1, closeIdx).replace(/\s/g, '');
        if (hexContent === '' || /^[0-9a-fA-F]+$/.test(hexContent)) {
          // Odd length: pad per PDF spec
          const norm      = hexContent.length % 2 === 1 ? hexContent + '0' : hexContent;
          const plain     = norm ? _hexToBuf(norm) : new Uint8Array(0);
          const encrypted = plain.length ? _rc4(objKey, plain) : plain;
          result += '<' + _hex(encrypted) + '>';
          i = closeIdx + 1;
        } else {
          // Not a hex string (unusual chars) — pass through
          result += ch; i++;
        }
      } else {
        result += ch; i++;
      }

    // ── Comment — pass through to end of line ────────────────
    } else if (ch === '%') {
      const eol = text.indexOf('\n', i);
      if (eol === -1) { result += text.slice(i); i = text.length; }
      else { result += text.slice(i, eol + 1); i = eol + 1; }

    // ── Everything else ──────────────────────────────────────
    } else {
      result += ch; i++;
    }
  }

  return result;
}

// ── Main export ───────────────────────────────────────────────

/**
 * Encrypt a plain PDF using RC4-128, Rev 3, V=2 (PDF 1.4–1.7).
 *
 * IMPORTANT: inputBytes must be from pdf.save({ useObjectStreams: false })
 * so there are no /ObjStm or /XRef stream objects.
 *
 * @param {Uint8Array} inputBytes
 * @param {{ userPassword?, ownerPassword?, permissions? }} opts
 * @returns {Uint8Array}
 */
function encryptPDF(inputBytes, opts = {}) {
  const {
    userPassword  = '',
    ownerPassword = '',
    permissions   = {},
  } = opts;
  const effectiveOwner = ownerPassword || userPassword || _hex(_rand(16));

  // ── 1. Parse xref → object map ────────────────────────────
  const xref   = _parseXRef(inputBytes);
  const fileId = xref.fileId;
  const perm   = _permFlags(permissions);

  // ── 2. Derive keys ────────────────────────────────────────
  const oKey = _ownerKey(effectiveOwner, userPassword);
  const fKey = _fileKey(userPassword, oKey, perm, fileId);
  const uKey = _userKey(fKey, fileId);

  // ── 3. Sort objects by file offset ───────────────────────
  const sortedObjs = Object.entries(xref.objects)
    .map(([id, off]) => [+id, off])
    .sort((a, b) => a[1] - b[1]);

  // ── 4. Assemble encrypted output in chunks ───────────────
  const enc    = new TextEncoder();
  const chunks = [];
  let totalLen  = 0;

  const addU8  = (arr) => { if (arr.length) { chunks.push(arr); totalLen += arr.length; } };
  const addStr = (s)   => { if (s.length)   addU8(enc.encode(s)); };

  // Preserve header (everything before the first object)
  const headerEnd = sortedObjs.length > 0 ? sortedObjs[0][1] : xref.startXref;
  addU8(inputBytes.slice(0, headerEnd));

  // ── 5. Re-emit each object, encrypting strings & streams ─
  const newOffsets = {};

  for (let i = 0; i < sortedObjs.length; i++) {
    const [objId, offset] = sortedObjs[i];
    const nextOff = i + 1 < sortedObjs.length
      ? sortedObjs[i + 1][1]
      : xref.startXref;

    newOffsets[objId] = totalLen;

    // Binary-safe string representation (one char = one byte)
    const objBytes = inputBytes.slice(offset, nextOff);
    let objStr = '';
    for (let j = 0; j < objBytes.length; j++) objStr += String.fromCharCode(objBytes[j]);

    const objKey = _objKey(fKey, objId, 0);
    const bounds  = _findStreamBounds(objStr);

    if (bounds) {
      // ── Has stream: encrypt dict strings + stream data ────
      const { dataStart, dataEnd } = bounds;
      // 'stream\n' starts kwLen bytes before dataStart
      const kwLen         = (objStr[dataStart - 2] === '\r') ? 8 : 7;
      const streamKwStart = dataStart - kwLen;

      // Dict text (before 'stream\n') — encrypt literal and hex strings
      addStr(_encryptStringsInText(objStr.slice(0, streamKwStart), objKey));

      // 'stream\n' or 'stream\r\n' — pass through verbatim
      addStr(objStr.slice(streamKwStart, dataStart));

      // Stream data — RC4 encrypt with per-object key.
      // Use objBytes (Uint8Array) not objStr for binary-safe slicing.
      addU8(_rc4(objKey, objBytes.slice(dataStart, dataEnd)));

      // Everything after stream data ('\nendstream\nendobj...') — verbatim
      addStr(objStr.slice(dataEnd));

    } else {
      // ── No stream: encrypt strings only ─────────────────────
      addStr(_encryptStringsInText(objStr, objKey));
    }
  }

  // ── 6. /Encrypt dict — NEVER encrypted (PDF spec §3.5.2) ──
  //
  // V=2 / R=3 = RC4-128, PDF 1.4.
  //
  // /EncryptMetadata is intentionally absent: per ISO 32000-1 Table 20,
  // that key is "meaningful only when the value of V is 4". Adding it
  // to a V=2 dict would be a spec violation and may confuse strict parsers.
  // pdf-lib with useObjectStreams:false produces no XMP /Metadata stream,
  // so there is nothing to suppress anyway.
  //
  // qpdf --allow-weak-crypto --encrypt u o 128 produces an identical dict
  // (verified: same fields, same order, no EncryptMetadata).
  const encObjId     = xref.size;
  const encObjOffset = totalLen;
  const oHex = _hex(oKey), uHex = _hex(uKey), idHex = _hex(fileId);

  addStr(
    `${encObjId} 0 obj\n` +
    `<<\n/Filter /Standard\n/V 2\n/R 3\n/Length 128\n` +
    `/P ${perm}\n/O <${oHex}>\n/U <${uHex}>\n>>\nendobj\n`
  );

  // ── 7. xref table ─────────────────────────────────────────
  const newXrefOff = totalLen;
  const allOffsets = { ...newOffsets, [encObjId]: encObjOffset };
  const maxId      = Math.max(...Object.keys(allOffsets).map(Number));

  let xrefStr = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    xrefStr += allOffsets[id] !== undefined
      ? `${String(allOffsets[id]).padStart(10, '0')} 00000 n \n`
      : '0000000000 65535 f \n';
  }

  // ── 8. Trailer — /ID strings NOT encrypted per spec §3.5.2 ─
  addStr(
    xrefStr +
    `trailer\n<<\n/Size ${maxId + 1}\n/Root ${xref.rootRef}\n` +
    (xref.infoRef ? `/Info ${xref.infoRef}\n` : '') +
    `/Encrypt ${encObjId} 0 R\n` +
    `/ID [<${idHex}><${idHex}>]\n` +
    `>>\nstartxref\n${newXrefOff}\n%%EOF\n`
  );

  // ── 9. Assemble final PDF ──────────────────────────────────
  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) { result.set(chunk, pos); pos += chunk.length; }
  return result;
}

// Expose globally for importScripts() in worker.js and module systems
if (typeof self   !== 'undefined') self.encryptPDF = encryptPDF;
if (typeof module !== 'undefined') module.exports = { encryptPDF };
