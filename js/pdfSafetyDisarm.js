// SPDX-License-Identifier: AGPL-3.0-only
// Takes out what a PDF can do besides showing its pages — scripts, actions
// that run by themselves, programs and files it can open, attached files, a
// second scriptable form (XFA), embedded media — and keeps what it shows: the
// pages' content, their text, the internal links and bookmarks that only move
// within the document, and (unless asked otherwise) its web links.
// Precise, not wholesale: the name tree keeps its named destinations (the
// document's own links point to them), a form keeps its fields; only the
// scripts and actions in them go. Objects nothing points to any more are
// dropped — a script cut loose from the catalog would otherwise stay in the
// file. What was taken out is listed; pdfSafetyScan.js then checks the result.

// Actions kept: they only move within this document (or open the web link the
// reader shows before following, when links are kept).
const SAFE_ACTIONS = new Set(['GoTo', 'Named', 'Thread', 'SetOCGState', 'Trans', 'GoTo3DView']);
// Annotations that exist to play, run or carry something.
const ACTIVE_ANNOTS = new Set(['FileAttachment', 'RichMedia', 'Screen', 'Movie', 'Sound', '3D']);

// A file pdf-lib can't take apart (a broken page tree, 7111155 among 180
// ordinary documents) is reported as unreadable — the screen then offers the
// pages as pictures instead — never thrown.
export async function disarmPdf(bytes, PDFLib, options = {}) {
  try {
    return await disarm(bytes, PDFLib, options);
  } catch (e) {
    return { status: 'unreadable', removed: [], error: String(e?.message ?? e).slice(0, 200) };
  }
}

async function disarm(bytes, PDFLib, { keepLinks = true }) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFStream, PDFString, PDFHexString } = PDFLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  // an encrypted file's strings and streams can't be read or rewritten here
  if (ctx.trailerInfo.Encrypt) return { status: 'encrypted', removed: [] };
  const N = s => PDFName.of(s);
  const look = v => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const removed = [];
  const note = (what, where) => removed.push({ what, where });
  const str = v => {
    v = look(v);
    return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null;
  };

  // An action, and the chain it starts: the part to keep, or null.
  const cleanAction = (a, where, depth = 0) => {
    const d = look(a);
    if (!(d instanceof PDFDict) || depth > 64) return null;
    const s = d.get(N('S'))?.toString().slice(1);
    const keep = SAFE_ACTIONS.has(s) || (s === 'URI' && keepLinks);
    if (!keep) note(s === 'URI' ? 'web link' : `${s ?? 'unknown'} action`, where);
    const next = look(d.get(N('Next')));
    let cleanNext = null;
    if (next instanceof PDFArray) {
      const kept = next.asArray().map(n => cleanAction(n, where, depth + 1)).filter(Boolean);
      cleanNext = kept.length ? ctx.obj(kept) : null;
    } else if (next) cleanNext = cleanAction(next, where, depth + 1);
    if (keep) {
      if (cleanNext) d.set(N('Next'), cleanNext); else d.delete(N('Next'));
      return a;
    }
    return cleanNext;   // the chain goes on without this one
  };
  const cleanA = (holder, key, where) => {
    if (!holder.get(N(key))) return;
    const kept = cleanAction(holder.get(N(key)), where);
    if (kept) holder.set(N(key), kept); else holder.delete(N(key));
  };
  const dropAA = (holder, where) => {
    const aa = look(holder.get(N('AA')));
    if (!aa) return;
    if (aa instanceof PDFDict) for (const [k, v] of aa.entries()) {
      const s = look(v)?.get?.(N('S'))?.toString().slice(1);
      note(`${s ?? 'unknown'} action`, `${where}, on ${k.toString().slice(1)}`);
    }
    holder.delete(N('AA'));
  };

  const catalog = doc.catalog;
  // the open action: a destination (an array) only moves the view — kept
  const open = catalog.get(N('OpenAction'));
  if (look(open) instanceof PDFDict) cleanA(catalog, 'OpenAction', 'when the document opens');
  dropAA(catalog, 'document');

  const names = look(catalog.get(N('Names')));
  if (names instanceof PDFDict) {
    if (names.get(N('JavaScript'))) { names.delete(N('JavaScript')); note('document scripts', 'the document'); }
    const ef = names.get(N('EmbeddedFiles'));
    if (ef) {
      const files = [];
      const walk = (node, depth = 0) => {
        node = look(node);
        if (!(node instanceof PDFDict) || depth > 32) return;
        const leaf = look(node.get(N('Names')));
        if (leaf instanceof PDFArray) for (let i = 0; i < leaf.size(); i += 2) files.push(str(leaf.get(i)) ?? 'file');
        const kids = look(node.get(N('Kids')));
        if (kids instanceof PDFArray) kids.asArray().forEach(k => walk(k, depth + 1));
      };
      walk(ef);
      names.delete(N('EmbeddedFiles'));
      for (const f of files) note(`attached file "${f}"`, 'the document');
    }
  }
  // newer attachment lists (PDF 2.0 associated files) and XFA's packages
  if (catalog.get(N('AF'))) { catalog.delete(N('AF')); note('associated files', 'the document'); }

  // the form: the XFA form and the fields' scripts go, the fields stay
  const acro = look(catalog.get(N('AcroForm')));
  if (acro instanceof PDFDict) {
    if (acro.get(N('XFA'))) { acro.delete(N('XFA')); note('XFA form', 'the form'); }
    acro.delete(N('NeedsRendering'));
    const visit = (field, depth = 0) => {
      field = look(field);
      if (!(field instanceof PDFDict) || depth > 32) return;
      const name = str(field.get(N('T')));
      const where = `form field${name ? ` "${name}"` : ''}`;
      dropAA(field, where);
      cleanA(field, 'A', where);
      const kids = look(field.get(N('Kids')));
      if (kids instanceof PDFArray) kids.asArray().forEach(k => visit(k, depth + 1));
    };
    const fields = look(acro.get(N('Fields')));
    if (fields instanceof PDFArray) fields.asArray().forEach(f => visit(f));
  }

  // pages and their annotations
  doc.getPages().forEach((page, i) => {
    const where = `page ${i + 1}`;
    dropAA(page.node, where);
    const annots = look(page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) return;
    const keep = [];
    for (const ref of annots.asArray()) {
      const an = look(ref);
      if (!(an instanceof PDFDict)) continue;
      const sub = an.get(N('Subtype'))?.toString().slice(1);
      if (ACTIVE_ANNOTS.has(sub)) { note(`${sub} annotation`, where); continue; }
      const at = `${where}, ${sub === 'Link' ? 'a link' : `a ${sub ?? 'mark'} annotation`}`;
      dropAA(an, at);
      cleanA(an, 'A', at);
      // a link with nowhere left to go is gone
      if (sub === 'Link' && !an.get(N('A')) && !an.get(N('Dest'))) continue;
      keep.push(ref);
    }
    if (keep.length !== annots.size()) page.node.set(N('Annots'), ctx.obj(keep));
  });

  // bookmarks can act too
  const outlines = look(catalog.get(N('Outlines')));
  const seenItems = new Set();
  const outline = (item, depth = 0) => {
    for (let it = look(item); it instanceof PDFDict && !seenItems.has(it) && depth < 64; it = look(it.get(N('Next')))) {
      seenItems.add(it);
      cleanA(it, 'A', 'a bookmark');
      outline(it.get(N('First')), depth + 1);
    }
  };
  if (outlines instanceof PDFDict) outline(outlines.get(N('First')));

  // Drop every object nothing reachable points to: from the trailer's
  // catalog and document information, through every reference.
  const reachable = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter(Boolean);
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFRef) {
      if (reachable.has(v)) continue;
      reachable.add(v);
      stack.push(ctx.lookup(v));
    } else if (v instanceof PDFDict) for (const [, x] of v.entries()) stack.push(x);
    else if (v instanceof PDFArray) for (const x of v.asArray()) stack.push(x);
    else if (v instanceof PDFStream) stack.push(v.dict);
  }
  let orphans = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) { ctx.delete(ref); orphans++; }
  }

  const out = await doc.save({ useObjectStreams: true });
  return { status: 'ok', bytes: out, removed, orphans };
}
