// SPDX-License-Identifier: AGPL-3.0-only
// What a PDF can do besides showing its pages — read only, nothing is run or
// changed. Two passes:
//  1. rawScan: the file's bytes, as PDFiD counts them (Didier Stevens): the
//     names of the parts that act (/JavaScript, /OpenAction, /Launch…), with
//     "#xx" escapes decoded first — "/Jav#61Script" is /JavaScript to a
//     reader, and a name written that way is itself a sign of hiding.
//  2. structuralScan: the parsed objects (pdf-lib), which also sees what the
//     bytes can't — objects packed into compressed object streams — and says
//     where each thing sits (the document's open action, a page's or a field's
//     own actions, a link) and what it holds (a script's size, a link's
//     address, an attached file's name).
// The report says what was found, never that a file is safe: a reader's own
// bugs (fonts, images) aren't found this way.

// Name tokens worth counting (PDFiD's list, plus the newer media types).
const RAW_KEYS = ['JS', 'JavaScript', 'AA', 'OpenAction', 'Launch', 'EmbeddedFile', 'EmbeddedFiles',
  'RichMedia', 'XFA', 'AcroForm', 'URI', 'SubmitForm', 'ImportData', 'GoToR', 'GoToE',
  'JBIG2Decode', 'ObjStm', 'Encrypt', 'ByteRange'];

// A PDF name: "/" then regular characters, "#xx" escapes allowed (ISO 32000-2 §7.3.5).
const NAME_RE = /\/((?:[^\s()<>[\]{}/%#]|#[0-9A-Fa-f]{2})+)/g;

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

export function rawScan(bytes) {
  const all = latin1(bytes);
  // stream bodies are data — compressed fonts and images hold "/…#…" by
  // chance (38 of 180 ordinary documents read as hiding names, 2026-10-28)
  const text = all.replace(/stream\r?\n[\s\S]*?endstream/g, 'stream endstream');
  const counts = Object.fromEntries(RAW_KEYS.map(k => [k, 0]));
  let escaped = 0;
  const escapedNames = new Set();
  for (const m of text.matchAll(NAME_RE)) {
    let name = m[1];
    if (name.includes('#')) {
      const decoded = name.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      // "#20" and the like are legitimate for spaces in font names; a name
      // that acts, written with an escaped letter, has no reason but to hide
      if (decoded in counts && /#(?:[46][1-9A-Fa-f]|[57][0-9Aa]|3[0-9])/.test(name)) { escaped++; escapedNames.add(decoded); }
      name = decoded;
    }
    if (name in counts) counts[name]++;
  }
  return {
    header: all.slice(0, 1024).match(/%PDF-\d\.\d/)?.[0] ?? null,
    headerOffset: all.indexOf('%PDF-'),
    counts,
    escapedNames: [...escapedNames].slice(0, 20),
    escapedCount: escaped,
    eofCount: (all.match(/%%EOF/g) || []).length,   // > 1: incremental updates
  };
}

// ── structural pass ────────────────────────────────────────────────────────

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly',
  'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in', 'qrco.de', 's.id', 'v.gd']);

// What a link's address says about itself, before anyone follows it.
export function describeUri(uri) {
  const out = { uri, scheme: null, host: null, flags: [] };
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri.trim());
  out.scheme = m ? m[1].toLowerCase() : null;
  if (!out.scheme) out.flags.push('no-scheme');
  else if (out.scheme === 'javascript' || out.scheme === 'vbscript') out.flags.push('script-scheme');
  else if (out.scheme === 'file' || out.scheme === 'smb') out.flags.push('local-file');
  else if (out.scheme === 'data') out.flags.push('data-uri');
  else if (out.scheme === 'http') out.flags.push('not-https');
  if (out.scheme === 'http' || out.scheme === 'https') {
    try {
      const u = new URL(uri.trim());
      out.host = u.hostname.toLowerCase();
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(out.host) || out.host.startsWith('[')) out.flags.push('ip-address');
      if (out.host.split('.').some(l => l.startsWith('xn--'))) out.flags.push('punycode');
      if (SHORTENERS.has(out.host.replace(/^www\./, ''))) out.flags.push('shortener');
      if (u.username || u.password) out.flags.push('credentials-in-url');
    } catch { out.flags.push('unparsable'); }
  }
  return out;
}

// An attached file runs when someone opens it: programs, scripts, shortcuts,
// documents with macros and archives (which hide what they hold) are high.
const RUNNABLE_RE = /\.(?:exe|com|scr|pif|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|dll|cpl|jar|lnk|url|reg|sh|app|dmg|iso|img|docm|xlsm|pptm|dotm|xlam|ppam|zip|rar|7z|gz|cab|html?|svg)$/i;
export const fileRisk = name => (!name || RUNNABLE_RE.test(name.trim()) ? 'high' : 'medium');

const ACTION_RISK = {
  JavaScript: 'high', Launch: 'high', ImportData: 'high', SubmitForm: 'medium', GoToR: 'medium', GoToE: 'medium',
  URI: 'low', RichMediaExecute: 'high', Rendition: 'medium', Sound: 'low', Movie: 'low', ResetForm: 'low', Named: 'low',
  GoTo: 'none', Thread: 'none', Hide: 'low', SetOCGState: 'none', Trans: 'none', GoTo3DView: 'low',
};

export async function structuralScan(bytes, PDFLib) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFRef } = PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context;
  const N = s => PDFName.of(s);
  const look = v => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const str = v => {
    v = look(v);
    if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
    return v == null ? null : String(v);
  };
  // a file specification: a string, or a dictionary naming the file (§7.11)
  const fileName = v => {
    v = look(v);
    return v instanceof PDFDict ? str(v.get(N('UF'))) ?? str(v.get(N('F'))) : str(v);
  };
  const findings = [];
  const uris = [];
  const files = [];
  const seenActions = new Set();

  const streamText = (s) => {
    try {
      const raw = s instanceof PDFRawStream ? PDFLib.decodePDFRawStream(s).decode() : s.getContents?.();
      return raw ? latin1(raw) : '';
    } catch { return ''; }
  };
  const jsCode = (v) => {
    v = look(v);
    if (v instanceof PDFRawStream) return streamText(v);
    return str(v) ?? '';
  };

  // One action dictionary and the chain it starts (/Next), from a place.
  const action = (a, where, at = null) => {
    a = look(a);
    if (!(a instanceof PDFDict) || seenActions.has(a)) return;
    seenActions.add(a);
    const s = a.get(N('S'))?.toString().replace(/^\//, '');
    if (!s) return;
    const f = { kind: 'action', type: s, where, risk: ACTION_RISK[s] ?? 'medium' };
    if (s === 'JavaScript') {
      const code = jsCode(a.get(N('JS')));
      f.size = code.length;
      // what the script reaches for — reported, never run
      // Acrobat's own field formatting ("AFNumber_Format(2, 0, 0, 0, '$', true)")
      // is the commonest script in ordinary forms: said so, still a script
      if (code.trim() && code.replace(/AF\w+\s*\([^()]*\)\s*;?/g, '').trim() === '') { f.formatting = true; f.risk = 'medium'; }
      f.calls = [...new Set((code.match(/\b(?:app\.launchURL|this\.exportDataObject|this\.submitForm|util\.printf|Collab\.\w+|eval|unescape|getAnnots|getURL|launchURL|importDataObject|spell\.\w+|media\.newPlayer)\b/g) || []))].slice(0, 10);
    } else if (s === 'Launch') {
      f.target = fileName(a.get(N('F'))) ?? fileName(look(a.get(N('Win')))?.get?.(N('F')));
    } else if (s === 'URI') {
      const u = str(a.get(N('URI')));
      if (u != null) { f.target = u; uris.push({ ...describeUri(u), where, ...(at ?? {}) }); }
    } else if (s === 'SubmitForm' || s === 'GoToR' || s === 'GoToE' || s === 'ImportData') {
      f.target = fileName(a.get(N('F')));
    }
    if (f.risk !== 'none') findings.push(f);
    const next = look(a.get(N('Next')));
    if (next instanceof PDFArray) for (let i = 0; i < next.size(); i++) action(next.get(i), where, at);
    else if (next) action(next, where, at);
  };
  const additional = (holder, where) => {
    const aa = look(holder?.get?.(N('AA')));
    if (aa instanceof PDFDict) for (const [k, v] of aa.entries()) action(v, `${where}, on ${k.toString().slice(1)}`);
  };

  const catalog = doc.catalog;
  // the document's own: open action, additional actions, document-level scripts
  const open = look(catalog.get(N('OpenAction')));
  if (open instanceof PDFDict) action(open, 'when the document opens');
  additional(catalog, 'document');
  const names = look(catalog.get(N('Names')));
  const nameTree = (node, visit, depth = 0) => {
    node = look(node);
    if (!(node instanceof PDFDict) || depth > 32) return;
    const leaf = look(node.get(N('Names')));
    if (leaf instanceof PDFArray) for (let i = 0; i + 1 < leaf.size(); i += 2) visit(str(leaf.get(i)), look(leaf.get(i + 1)));
    const kids = look(node.get(N('Kids')));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) nameTree(kids.get(i), visit, depth + 1);
  };
  if (names instanceof PDFDict) {
    nameTree(names.get(N('JavaScript')), (name, a) => action(a, `document script${name ? ` "${name}"` : ''}`));
    nameTree(names.get(N('EmbeddedFiles')), (name, spec) => {
      const ef = look(spec?.get?.(N('EF')));
      const stream = look(ef?.get?.(N('F')) ?? ef?.get?.(N('UF')));
      const size = look(look(stream?.dict?.get?.(N('Params')))?.get?.(N('Size')));
      files.push({ name: str(spec?.get?.(N('UF'))) ?? str(spec?.get?.(N('F'))) ?? name, size: size ? Number(size.toString()) : (stream?.contents?.length ?? null) });
    });
  }

  // pages: their own actions, their annotations (links, file attachments, media)
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const where = `page ${i + 1}`;
    additional(page.node, where);
    const annots = look(page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) return;
    for (let k = 0; k < annots.size(); k++) {
      const an = look(annots.get(k));
      if (!(an instanceof PDFDict)) continue;
      const sub = an.get(N('Subtype'))?.toString().slice(1);
      const at = `${where}, ${sub === 'Link' ? 'a link' : `a ${sub ?? 'mark'} annotation`}`;
      // a link's page and rectangle: the report compares it with the text drawn under it
      const rect = look(an.get(N('Rect')));
      const box = rect instanceof PDFArray && rect.size() === 4 ? rect.asArray().map(v => Number(look(v)?.asNumber?.() ?? look(v))) : null;
      action(an.get(N('A')), at, box ? { page: i, rect: box } : null);
      additional(an, at);
      if (sub === 'FileAttachment') {
        const spec = look(an.get(N('FS')));
        files.push({ name: str(spec?.get?.(N('UF'))) ?? str(spec?.get?.(N('F'))) ?? 'attachment', size: null, where: at });
      }
      if (sub === 'RichMedia' || sub === 'Screen' || sub === 'Movie' || sub === '3D') findings.push({ kind: 'media', type: sub, where: at, risk: 'medium' });
    }
  });

  // form: fields' actions, XFA (a second, scriptable form), signatures
  const acro = look(catalog.get(N('AcroForm')));
  let signed = false;
  if (acro instanceof PDFDict) {
    if (acro.get(N('XFA'))) findings.push({ kind: 'xfa', type: 'XFA', where: 'the form', risk: 'high' });
    const walk = (field, depth = 0) => {
      field = look(field);
      if (!(field instanceof PDFDict) || depth > 32) return;
      const name = str(field.get(N('T')));
      additional(field, `form field${name ? ` "${name}"` : ''}`);
      action(field.get(N('A')), `form field${name ? ` "${name}"` : ''}`);
      if (field.get(N('FT'))?.toString() === '/Sig' && look(field.get(N('V')))) signed = true;
      const kids = look(field.get(N('Kids')));
      if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
    };
    const fields = look(acro.get(N('Fields')));
    if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) walk(fields.get(i));
  }

  // anything acting that sits outside the places above (unreferenced, or
  // reached only in ways a reader still follows): every object, once
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFDict ? obj : obj?.dict;
    if (!(d instanceof PDFDict)) continue;
    if (d.get(N('S')) && (d.get(N('JS')) || d.get(N('URI')) || d.get(N('F')))) action(d, 'an object no page points to');
  }
  for (const f of files) findings.push({ kind: 'file', type: 'EmbeddedFile', where: f.where ?? 'attached to the document', target: f.name, size: f.size, risk: fileRisk(f.name) });

  return {
    pages: pages.length,
    encrypted: !!ctx.trailerInfo.Encrypt,
    signed,
    findings,
    uris,
    files,
  };
}

const RANK = { high: 3, medium: 2, low: 1, none: 0 };

export async function scanPdf(bytes, PDFLib) {
  const raw = rawScan(bytes);
  let structure = null, error = null;
  try { structure = await structuralScan(bytes, PDFLib); } catch (e) { error = String(e?.message ?? e).slice(0, 200); }
  const findings = structure?.findings ?? [];
  if (raw.escapedCount) findings.push({ kind: 'hidden-names', type: 'name escapes', where: 'the file', risk: 'medium', detail: raw.escapedNames });
  if (raw.headerOffset > 0) findings.push({ kind: 'header', type: 'data before %PDF', where: 'the file', risk: 'low', detail: raw.headerOffset });
  // the bytes name something acting the parse didn't place: hidden or broken
  const placed = new Set(findings.map(f => f.type));
  for (const k of ['JavaScript', 'Launch', 'OpenAction', 'EmbeddedFile', 'XFA', 'RichMedia']) {
    const type = k === 'OpenAction' ? null : k;
    if (raw.counts[k] && type && !placed.has(type) && !(k === 'EmbeddedFile' && placed.has('EmbeddedFile'))) {
      findings.push({ kind: 'unplaced', type: k, where: 'the file\'s bytes, not in any object the reader opens', risk: 'medium', count: raw.counts[k] });
    }
  }
  findings.sort((a, b) => RANK[b.risk] - RANK[a.risk]);
  return {
    raw, ...(structure ?? {}), findings, error,
    level: findings.length ? findings[0].risk : 'none',
  };
}
