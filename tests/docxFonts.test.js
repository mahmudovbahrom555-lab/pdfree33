// tests/docxFonts.test.js — the PDF's fonts in the Word file (js/docxFonts.js):
// the rebuilt cmap maps Unicode to the glyphs the PDF draws, the licence in
// the PDF decides, text a font lacks is left to Word, and the .docx carries
// the fonts the way Word reads them. The whole path, in the browser:
// tests/e2e/pdf2word-fonts.e2e.mjs.
//
// Run: node tests/docxFonts.test.js

import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import JSZip from 'jszip';
import { sfntTables, cmapGlyphs, fontNames, blankGlyph, createFontSet, obfuscateFont, embedDocxFonts } from '../js/docxFonts.js';

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
  })());
}

const SANS = new Uint8Array(readFileSync(new URL('../js/vendor/liberation-fonts/LiberationSans-Regular.ttf', import.meta.url)));
const sansGlyphs = cmapGlyphs(sfntTables(SANS).get('cmap'));

// a pdf.js font object as commonObjs gives it with fontExtraProperties:
// code → the font's own char (here the font's Unicode cmap) and code → Unicode
function pdfjsFont(loadedName, name, codes, extra = {}) {
  const toFontChar = {}, map = [];
  for (const [code, ch] of codes) { toFontChar[code] = ch.codePointAt(0); map[code] = ch; }
  return { loadedName, name, data: SANS, toFontChar, toUnicode: { _map: map }, widths: { 3: 278 }, ...extra };
}
const ABC = [[36, 'A'], [37, 'B'], [38, 'C'], [70, 'c']];

test('the rebuilt font maps each Unicode character to the glyph the PDF draws', () => {
  const set = createFontSet(new Map([['LiberationSans', 0]]));
  assert.deepEqual(set.faceOf(pdfjsFont('g1', 'ABCDEF+LiberationSans', ABC), 'ABC'), { face: 'Liberation Sans', bold: false, italic: false });
  const [fam] = set.files();
  const out = cmapGlyphs(sfntTables(fam.regular).get('cmap'));
  for (const ch of 'ABCc') assert.equal(out.get(ch.codePointAt(0)), sansGlyphs.get(ch.codePointAt(0)), ch);
  assert.equal(out.get('D'.codePointAt(0)), undefined, 'only what the PDF uses');
  assert.deepEqual(fontNames(sfntTables(fam.regular).get('name')), { family: 'Liberation Sans', style: 'Regular' });
});

test('text with a character the font lacks is left to Word', () => {
  const set = createFontSet(new Map([['LiberationSans', 0]]));
  const f = pdfjsFont('g1', 'LiberationSans', ABC);
  assert.equal(set.faceOf(f, 'AB D'), undefined);
  assert.ok(set.faceOf(f, 'A B'), 'spaces do not count');
});

test('the licence in the PDF decides: preview & print, restricted or unknown → not embedded', () => {
  for (const fsType of [2, 4, 0x200]) {
    const set = createFontSet(new Map([['LiberationSans', fsType]]));
    assert.equal(set.faceOf(pdfjsFont('g1', 'LiberationSans', ABC), 'A'), undefined, `fsType ${fsType}`);
  }
  assert.equal(createFontSet(new Map()).faceOf(pdfjsFont('g1', 'LiberationSans', ABC), 'A'), undefined, 'no licence found');
  const editable = createFontSet(new Map([['LiberationSans', 8 | 0x100]]));
  assert.ok(editable.faceOf(pdfjsFont('g1', 'LiberationSans', ABC), 'A'));
  const os2 = sfntTables(editable.files()[0].regular).get('OS/2');
  assert.equal((os2[8] << 8) | os2[9], 8, 'the copy says editable, as the original — pdf.js wrote 0');
});

test('a CFF font is not embedded', () => {
  const otto = SANS.slice(); otto.set([0x4F, 0x54, 0x54, 0x4F], 0);
  assert.equal(createFontSet(new Map([['LiberationSans', 0]])).faceOf({ ...pdfjsFont('g1', 'LiberationSans', ABC), data: otto }, 'A'), undefined);
});

test('the space pdf.js leaves out of its cmap comes back: the blank glyph as wide as the PDF\'s space', () => {
  const t = sfntTables(SANS);
  const hmtx = t.get('hmtx'), loca = t.get('loca');
  const g = blankGlyph(t, 278);
  assert.ok(g > 0);
  assert.equal((hmtx[4 * g] << 8) | hmtx[4 * g + 1], 569, '278/1000 of 2048 units');
  const head = t.get('head'), long = ((head[50] << 8) | head[51]) === 1;
  const at = i => (long ? new DataView(loca.buffer, loca.byteOffset).getUint32(4 * i) : 2 * ((loca[2 * i] << 8) | loca[2 * i + 1]));
  assert.equal(at(g), at(g + 1), 'no outline');
  assert.equal(blankGlyph(t, 600), 0, 'no blank glyph that wide');
  const set = createFontSet(new Map([['LiberationSans', 0]]));
  set.faceOf(pdfjsFont('g1', 'LiberationSans', [...ABC, [3, ' ']], { toFontChar: Object.fromEntries(ABC.map(([c, ch]) => [c, ch.codePointAt(0)])) }), 'A');
  assert.ok(cmapGlyphs(sfntTables(set.files()[0].regular).get('cmap')).get(32));
});

test('one font file the PDF holds twice is one font, its characters joined; a bold one is the family\'s bold', () => {
  const set = createFontSet(new Map([['LiberationSans', 0], ['LiberationSans-Bold', 0]]));
  set.faceOf(pdfjsFont('g1', 'LiberationSans', [[36, 'A']]), 'A');
  set.faceOf(pdfjsFont('g2', 'LiberationSans', [[37, 'B']]), 'B');
  assert.deepEqual(set.faceOf(pdfjsFont('g3', 'LiberationSans-Bold', [[38, 'C']], { bold: true }), 'C'), { face: 'Liberation Sans', bold: true, italic: false });
  const files = set.files();
  assert.equal(files.length, 1);
  const reg = cmapGlyphs(sfntTables(files[0].regular).get('cmap'));
  assert.ok(reg.get(65) && reg.get(66));
  assert.ok(files[0].bold);
});

test('obfuscation is its own inverse and touches only the first 32 bytes', () => {
  const guid = '01234567-89AB-CDEF-0123-456789ABCDEF';
  const once = obfuscateFont(SANS, guid);
  assert.notDeepEqual(once.subarray(0, 32), SANS.subarray(0, 32));
  assert.deepEqual(once.subarray(32, 64), SANS.subarray(32, 64));
  assert.deepEqual(obfuscateFont(once, guid), SANS);
});

test('the .docx: fonts, their entries in fontTable (self-closing as docx writes it) and fontTable linked, settings in schema order', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('word/fontTable.xml', '<?xml version="1.0"?><w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>');
  zip.file('word/_rels/fontTable.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  zip.file('word/settings.xml', '<?xml version="1.0"?><w:settings xmlns:w="w"><w:displayBackgroundShape/><w:evenAndOddHeaders w:val="false"/></w:settings>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>');
  const blob = new Blob([await zip.generateAsync({ type: 'uint8array' })]);
  const set = createFontSet(new Map([['LiberationSans', 0]]));
  set.faceOf(pdfjsFont('g1', 'LiberationSans', ABC), 'A');
  // JSZip in Node reads no Blob: the browser's way in, through its bytes
  const Zip = { loadAsync: b => JSZip.loadAsync(b.arrayBuffer()) };
  const out = await JSZip.loadAsync(await (await embedDocxFonts(blob, Zip, set.files())).arrayBuffer());
  const table = await out.file('word/fontTable.xml').async('string');
  const key = table.match(/<w:font w:name="Liberation Sans">.*<w:embedRegular r:id="(rIdFont1)" w:fontKey="\{([0-9A-F-]{36})\}"\/><\/w:font><\/w:fonts>$/);
  assert.ok(key, table);
  const rels = await out.file('word/_rels/fontTable.xml.rels').async('string');
  assert.match(rels, /Id="rIdFont1" Type="[^"]+\/font" Target="fonts\/font1\.odttf"/);
  const font = obfuscateFont(await out.file('word/fonts/font1.odttf').async('uint8array'), key[2]);
  assert.ok(sfntTables(font), 'the file reads back as the font');
  assert.match(await out.file('[Content_Types].xml').async('string'), /Extension="odttf" ContentType="application\/vnd\.openxmlformats-officedocument\.obfuscatedFont"/);
  assert.match(await out.file('word/settings.xml').async('string'), /<w:displayBackgroundShape\/><w:embedTrueTypeFonts\/><w:evenAndOddHeaders/);
  // docx leaves fontTable.xml unlinked: without the link no reader opens it
  assert.match(await out.file('word/_rels/document.xml.rels').async('string'), /Type="[^"]+\/fontTable" Target="fontTable\.xml"/);
  assert.match(await out.file('[Content_Types].xml').async('string'), /PartName="\/word\/fontTable\.xml"/);
  assert.equal(await embedDocxFonts(blob, Zip, []), blob, 'no fonts: the same file');
});

await Promise.all(pending);
console.log(`\n${'─'.repeat(40)}\nTests: ${passed + failed} | ✓ ${passed} | ${failed} failed`);
if (failed) process.exit(1);
