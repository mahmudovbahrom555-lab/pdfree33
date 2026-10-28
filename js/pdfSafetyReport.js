// SPDX-License-Identifier: AGPL-3.0-only
// The scan (pdfSafetyScan.js) as a person reads it: what was found, where,
// how much it matters, in plain words — grouped, most serious first. It never
// says a file is safe: "nothing found" is the strongest it says, with what a
// scan like this can't see.

const LEVEL = { high: 3, medium: 2, low: 1, none: 0 };

// What each kind of finding is, said once.
const KIND = {
  JavaScript: { group: 'scripts', title: 'A script', why: 'A PDF reader that runs scripts would run it.' },
  Launch: { group: 'programs', title: 'Opens a program or another file', why: 'It asks the reader to open something outside this document.' },
  ImportData: { group: 'programs', title: 'Loads data from another file', why: 'It reads a file from your computer into this form.' },
  SubmitForm: { group: 'sending', title: 'Sends the form somewhere', why: 'Filled-in fields can be sent to an address.' },
  GoToR: { group: 'programs', title: 'Opens another document', why: 'It points the reader to another file.' },
  GoToE: { group: 'programs', title: 'Opens an attached document', why: 'It opens a file carried inside this one.' },
  RichMediaExecute: { group: 'media', title: 'Runs embedded media', why: 'It starts content embedded in the document.' },
  Rendition: { group: 'media', title: 'Plays media', why: 'It plays sound or video.' },
  EmbeddedFile: { group: 'files', title: 'An attached file', why: 'Opening it runs whatever it is.' },
  XFA: { group: 'forms', title: 'A second, scriptable form (XFA)', why: 'An older form format that can carry scripts.' },
  RichMedia: { group: 'media', title: 'Embedded media', why: 'Media players have had their own security bugs.' },
  Screen: { group: 'media', title: 'Embedded media', why: 'Media players have had their own security bugs.' },
  Movie: { group: 'media', title: 'Embedded media', why: 'Media players have had their own security bugs.' },
  '3D': { group: 'media', title: 'An embedded 3D model', why: '3D viewers have had their own security bugs.' },
  'name escapes': { group: 'hiding', title: 'Hidden names', why: 'Parts of the file that act are spelled in a way meant to slip past simple checks.' },
  'data before %PDF': { group: 'hiding', title: 'Something before the PDF starts', why: 'The file begins with other data, which can make it two kinds of file at once.' },
};

const GROUP_ORDER = ['scripts', 'programs', 'files', 'sending', 'forms', 'media', 'hiding', 'links', 'other'];
export const GROUP_TITLE = {
  scripts: 'Scripts', programs: 'Opening programs or other files', files: 'Attached files', sending: 'Sending data',
  forms: 'Forms', media: 'Media', hiding: 'Signs of hiding', links: 'Links', other: 'Other',
};

// What a link's flags mean to a person.
const LINK_FLAG = {
  'script-scheme': ['high', 'runs a script instead of opening a page'],
  'local-file': ['high', 'opens a file on your computer or network'],
  'data-uri': ['medium', 'carries its own content instead of an address'],
  'credentials-in-url': ['medium', 'has a user name or password written into the address'],
  'text-mismatch': ['high', 'shows one address but leads to another'],
  'ip-address': ['medium', 'goes to a bare IP address, not a named site'],
  punycode: ['medium', 'uses look-alike letters in the site name'],
  shortener: ['low', 'is shortened — where it really leads is hidden'],
  'not-https': ['low', 'is not encrypted (http)'],
  'no-scheme': ['low', 'has no usual address form'],
  unparsable: ['low', 'can\'t be read as an address'],
};

export function buildReport(scan, { linkMismatches = [] } = {}) {
  const items = [];
  for (const f of scan.findings ?? []) {
    if (f.type === 'URI') continue;   // links are listed on their own, below
    const k = KIND[f.type] ?? { group: 'other', title: `${f.type}`, why: '' };
    let detail = '';
    if (f.type === 'JavaScript') {
      detail = f.formatting ? 'It only formats a form field\'s value (Acrobat\'s own formatting).' : '';
      if (f.calls?.length) detail += `${detail ? ' ' : ''}It calls: ${f.calls.join(', ')}.`;
    } else if (f.target) detail = `${f.kind === 'file' ? 'File' : 'Target'}: ${f.target}`;
    else if (f.detail && Array.isArray(f.detail)) detail = `Names: ${f.detail.join(', ')}`;
    items.push({ group: k.group, level: f.risk, title: k.title, where: f.where, why: k.why, detail });
  }
  // links: one item per address, its worst flag sets the level
  const byUri = new Map();
  const mismatch = new Map(linkMismatches.map(m => [m.uri, m.shown]));
  for (const u of scan.uris ?? []) {
    const flags = [...u.flags, ...(mismatch.has(u.uri) ? ['text-mismatch'] : [])];
    const prev = byUri.get(u.uri);
    if (prev) { prev.count++; continue; }
    const said = flags.map(fl => LINK_FLAG[fl]).filter(Boolean);
    const level = said.reduce((a, [l]) => (LEVEL[l] > LEVEL[a] ? l : a), 'none');
    byUri.set(u.uri, {
      group: 'links', level, title: u.host ?? u.uri, where: u.where, count: 1,
      why: said.map(([, w]) => `It ${w}.`).join(' '),
      detail: [u.uri, mismatch.has(u.uri) ? `The page shows: ${mismatch.get(u.uri)}` : null].filter(Boolean).join(' — '),
    });
  }
  items.push(...byUri.values());

  items.sort((a, b) => LEVEL[b.level] - LEVEL[a.level] || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  const worst = items.reduce((a, i) => (LEVEL[i.level] > LEVEL[a] ? i.level : a), 'none');
  const groups = GROUP_ORDER.map(g => ({ group: g, title: GROUP_TITLE[g], items: items.filter(i => i.group === g) })).filter(g => g.items.length);
  const notes = [];
  if (scan.encrypted) notes.push('The file is encrypted: what it holds could not all be read.');
  if (scan.signed) notes.push('The file carries a digital signature: any change, including cleaning, makes the signature invalid.');
  if (scan.error) notes.push('Part of the file could not be read; the report may be incomplete.');
  return {
    level: worst,
    headline: worst === 'high' ? 'This PDF can do more than show pages' :
      worst === 'medium' ? 'This PDF has parts worth a look' :
      worst === 'low' ? 'Only links found' : 'Nothing that acts was found',
    groups,
    notes,
    // what no scan of this kind can promise, said every time
    limits: 'This check looks at what the file can do (scripts, actions, attachments, links). It can\'t rule out bugs in a PDF reader that a crafted font or image could trigger.',
  };
}

// ── links whose text names another site ────────────────────────────────────

// Domain endings common enough to read "name.ending" as a site; endings that
// are also file extensions (.md, .sh, .py, .rs, .ai…) are left out.
const COMMON_TLD = new Set(['com', 'org', 'net', 'gov', 'edu', 'mil', 'int', 'info', 'biz', 'io', 'co', 'app', 'dev', 'me', 'us',
  'uk', 'de', 'fr', 'it', 'es', 'nl', 'pl', 'ru', 'ua', 'uz', 'kz', 'tr', 'cn', 'jp', 'kr', 'in', 'br', 'au', 'ca', 'sa', 'ae', 'eg', 'ir', 'pk']);

// A text that names a web address: "www.bank.com", "https://bank.com/x", "bank.com".
const SHOWN_HOST_RE = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,24})(?:[/:?#][^\s]*)?/i;

// The part of a host a person recognises the site by: "login.bank.co.uk" → "bank.co.uk".
const TWO_LEVEL = /\.(?:co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/i;
export function siteOf(host) {
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const parts = h.split('.');
  return parts.slice(TWO_LEVEL.test(h) ? -3 : -2).join('.');
}

// The text drawn under a link's rectangle: text items (pdf.js: str, x, y,
// width, height in page space) whose middle falls inside it.
export function textUnder(items, rect) {
  const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  return items
    .filter(it => {
      const cx = it.x + it.width / 2, cy = it.y + (it.height || 0) / 2;
      return cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 2 && cy <= y1 + 2;
    })
    .map(it => it.str).join('').trim();
}

// A link that shows one site and leads to another — the commonest phishing
// trick. Only when the shown text itself names a site: "click here" leading
// anywhere is normal.
export function linkMismatch(shown, uri) {
  // the site the link leads to: a web address's host, an e-mail link's domain
  let target;
  const mail = /^mailto:([^?]*)/i.exec(uri.trim());
  if (mail) target = decodeURIComponent(mail[1]).split(',')[0].split('@')[1]?.trim();
  else { try { target = new URL(uri).hostname; } catch { return null; } }
  // "http:https://…" reads as the site "https": a broken address, not another site
  if (!target || !target.includes('.')) return null;
  // the site the text names: an e-mail address's domain, or a web address
  const email = /[\w.+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,24})/i.exec(shown || '');
  const m = email ? null : SHOWN_HOST_RE.exec(shown || '');
  const written = email ? email[1] : m?.[1];
  if (!written) return null;
  const shownHost = written.replace(/^https?:\/\//i, '');
  // a site, not a file name ("annual-report.pdf", "README.md"): an e-mail
  // domain, written with http(s):// or www., or ending in a common domain ending
  if (!email && !/^(?:https?:\/\/|www\.)/i.test(written) && !COMMON_TLD.has(shownHost.split('.').pop().toLowerCase())) return null;
  // text cut off by the link's box ("https://www.lo" for www.lobsangrampa.org) is part of the address
  if (uri.toLowerCase().includes(shownHost.toLowerCase().replace(/\.$/, ''))) return null;
  return siteOf(shownHost) === siteOf(target) ? null : { shown: email ? email[0] : m[0], uri, shownSite: siteOf(shownHost), targetSite: siteOf(target) };
}
