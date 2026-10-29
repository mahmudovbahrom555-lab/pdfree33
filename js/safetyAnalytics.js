// SPDX-License-Identifier: AGPL-3.0-only
// What the PDF safety check may tell analytics about a checked file — and
// nothing else. The file was given to the page in trust: its name, its links
// and their sites, its QR codes, its attachments' names, its scripts' code,
// its text never leave it. Only categories from fixed lists below go out, each
// value checked against its list; anything else becomes "other". Kept apart
// from js/analytics.js so a test can feed it a report full of a file's details
// and show none of them comes out (tests/safetyAnalytics.test.js).

const LEVELS = ['none', 'low', 'medium', 'high'];
const KINDS = ['scripts', 'programs', 'files', 'sending', 'forms', 'media', 'hiding', 'links', 'other'];
const MODES = ['clean', 'pictures'];
const ERRORS = ['encrypted', 'unreadable', 'not_pdf', 'clean_failed', 'pictures_failed', 'recheck_failed'];

const pick = (value, list) => (list.includes(value) ? value : 'other');
const yesNo = v => (v ? 'yes' : 'no');

export function pagesBand(n) {
  if (!Number.isFinite(n) || n < 1) return 'unknown';
  return n === 1 ? '1' : n <= 10 ? '2-10' : n <= 50 ? '11-50' : n <= 200 ? '51-200' : '>200';
}

export function countBand(n) {
  if (!Number.isFinite(n) || n < 1) return '0';
  return n === 1 ? '1' : n <= 5 ? '2-5' : n <= 20 ? '6-20' : '>20';
}

// report: buildReport()'s result; scan: scanPdf()'s; extra: { qr, mismatches }
export function safetyReportProps(report, scan, { qr = [], mismatches = [] } = {}) {
  const kinds = [...new Set((report?.groups ?? []).map(g => pick(g?.group, KINDS)))].sort();
  return {
    tool: 'safety',
    level: pick(report?.level, LEVELS),
    kinds: kinds.length ? kinds.join('+') : 'none',
    qr: yesNo(Array.isArray(qr) && qr.length),
    link_mismatch: yesNo(Array.isArray(mismatches) && mismatches.length),
    encrypted: yesNo(scan?.encrypted),
    signed: yesNo(scan?.signed),
    readable: scan?.error ? 'partly' : 'yes',
    pages: pagesBand(scan?.pages),
  };
}

export function safetyResultProps(mode, removedCount) {
  return { tool: 'safety', mode: pick(mode, MODES), removed: countBand(removedCount) };
}

export function safetyErrorType(kind) {
  return pick(kind, ERRORS);
}
