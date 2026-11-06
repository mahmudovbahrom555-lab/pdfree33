// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { resolveToolPageTitle } from '../js/toolPageTitle.js';

const page = { title: 'Organize PDF Pages Free — No Daily Limit | PDFree', toolKey: 'organize', lang: 'en' };
assert.equal(resolveToolPageTitle('Organize PDF', 'organize', page), page.title);
assert.equal(resolveToolPageTitle('Split PDF', 'split', page), 'Split PDF — PDFree');
// Back to the original tool restores its SEO title, not the last tool title.
assert.equal(resolveToolPageTitle('Organize PDF', 'organize', page), page.title);
assert.equal(resolveToolPageTitle('Split PDF', 'split', { title: 'Home', lang: 'en' }), 'Split PDF — PDFree');
assert.equal(resolveToolPageTitle('ضغط PDF', 'compress', { title: 'Frozen SEO title', toolKey: 'compress', lang: 'ar' }), 'ضغط PDF — PDFree');
assert.equal(resolveToolPageTitle('دمج PDF', 'merge', { title: 'Arabic merge SEO', toolKey: 'merge', lang: 'ar' }), 'Arabic merge SEO');
assert.equal(resolveToolPageTitle('Split PDF', 'split', { title: '', toolKey: 'split', lang: 'en' }), 'Split PDF — PDFree');
console.log('Tool page title: 7 assertions passed');
