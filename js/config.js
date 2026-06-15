// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  config.js — App constants & tool definitions
//  Чтобы добавить новый инструмент — добавь запись сюда
// ============================================================

/** Build version — used to detect stale SW cache in console */
export const APP_VERSION = '6.2';

/** Compress PDF: hard limit — files above this are rejected before processing */
export const MAX_COMPRESS_MB = 150;

/** Compress PDF: pre-scan is skipped above this to protect main-thread memory */
export const SCAN_LIMIT_MB = 25;

/**
 * Maximum image dimension (px on the longest side) when compressing
 * images in the JPG→PDF converter.
 *
 * This is a product decision balancing quality, file size, and RAM:
 *   HIGH   (3200px) — near-original quality, large PDFs, more RAM
 *   MEDIUM (2400px) — good quality for screen/print, reasonable size
 *   LOW    (1200px) — small files, noticeable quality loss on large prints
 *
 * The default is MEDIUM. Users with compress=false get the original size.
 * Change this when making quality/size tradeoff decisions, not randomly.
 */
export const IMAGE_DIM_PRESETS = {
  high:   3200,
  medium: 2400,   // ← default used in handleJpg2Pdf
  low:    1200,
};

/**
 * Допустимые MIME-типы для каждого формата файла.
 * Используется в files.js для валидации при drag-and-drop
 * (атрибут accept на инпуте не защищает от D&D сторонних файлов).
 */
export const ACCEPTED_MIME = {
  '.pdf': ['application/pdf'],
  '.jpg,.jpeg,.png': ['image/jpeg', 'image/png'],
};

/**
 * Читает текущий язык страницы из атрибута <html lang="fr">.
 * SSG проставляет его при сборке — JS просто читает готовое значение.
 * Если атрибута нет (локальная разработка без SSG) — возвращает 'en'.
 */
export function getLang() {
  return document.documentElement.lang || 'en';
}

/**
 * Возвращает локализованную копию объекта инструмента для текущего языка.
 * Если перевода нет — используется английский fallback.
 * @param {{ titles?, descs?, btns?, title, desc, btn }} tool
 */
export function getLocalizedTool(tool) {
  const lang  = getLang();
  const title = tool.titles?.[lang] ?? tool.titles?.en ?? tool.title;
  const desc  = tool.descs?.[lang]  ?? tool.descs?.en  ?? tool.desc;
  const btn   = tool.btns?.[lang]   ?? tool.btns?.en   ?? tool.btn;
  return { ...tool, title, desc, btn };
}

/**
 * Определения всех инструментов.
 * Чтобы добавить новый — просто добавь запись.
 * titles/descs/btns — словари переводов; title/desc/btn — EN-fallback (совместимость).
 * @type {Record<string, {icon, title, desc, btn, titles, descs, btns, multi, accept, implemented}>}
 */
export const TOOLS = {
  merge: {
    icon:   '🔗',
    title:  'Merge PDF',
    desc:   'Combine unlimited PDF files — no restrictions',
    tags:   ['combine', 'join', 'unite', 'concat', 'merge files', 'multiple pdfs', 'join pdfs',
             'zusammenfügen', 'zusammenführen', 'unir', 'juntar', 'fusionner'],
    btn:    '🔗 Merge PDF files',
    titles: { en: 'Merge PDF files',   es: 'Unir PDF',        pt: 'Juntar PDF',       de: 'PDF Zusammenfügen',    fr: 'Fusionner PDF' },
    descs:  { en: 'Combine unlimited PDF files — no restrictions', es: 'Combina archivos PDF ilimitados — sin restricciones', pt: 'Combine arquivos PDF ilimitados — sem restrições', de: 'Beliebig viele PDF-Dateien zusammenfügen — keine Einschränkungen', fr: 'Fusionner un nombre illimité de fichiers PDF — sans restrictions' },
    btns:   { en: '🔗 Merge PDF files', es: '🔗 Unir PDF',     pt: '🔗 Juntar PDF',    de: '🔗 PDF zusammenführen', fr: '🔗 Fusionner les PDF' },
    multi:       true,
    accept:      '.pdf',
    implemented: true,
  },
  split: {
    icon:   '✂️',
    title:  'Split PDF',
    desc:   'Extract pages or split into separate files',
    tags:   ['split', 'divide', 'separate', 'cut', 'remove pages', 'delete pages',
             'aufteilen', 'dividir', 'diviser'],
    btn:    '✂️ Split PDF',
    titles: { en: 'Split PDF',    es: 'Dividir PDF',    pt: 'Dividir PDF',    de: 'PDF Aufteilen',    fr: 'Diviser PDF' },
    descs:  { en: 'Extract pages or split into separate files', es: 'Extrae páginas o divide en archivos separados', pt: 'Extraia páginas ou divida em arquivos separados', de: 'Seiten extrahieren oder in einzelne Dateien aufteilen', fr: 'Extraire des pages ou diviser en fichiers séparés' },
    btns:   { en: '✂️ Split PDF', es: '✂️ Dividir PDF', pt: '✂️ Dividir PDF', de: '✂️ PDF aufteilen', fr: '✂️ Diviser le PDF' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  compress: {
    icon:   '🗜️',
    title:  'Compress PDF',
    desc:   'Reduce file size while preserving text and vector quality',
    tags:   ['compress', 'reduce', 'smaller', 'shrink', 'optimize', 'file size', 'too big',
             'reduce size', 'komprimieren', 'comprimir', 'compresser'],
    btn:    '🗜️ Compress PDF',
    titles: { en: 'Compress PDF',    es: 'Comprimir PDF',    pt: 'Comprimir PDF',    de: 'PDF Komprimieren',    fr: 'Compresser PDF' },
    descs:  { en: 'Reduce file size without losing quality', es: 'Reduce el tamaño sin perder calidad', pt: 'Reduza o tamanho sem perder qualidade', de: 'Dateigröße ohne Qualitätsverlust reduzieren', fr: 'Réduire la taille sans perte de qualité' },
    btns:   { en: '🗜️ Compress PDF', es: '🗜️ Comprimir PDF', pt: '🗜️ Comprimir PDF', de: '🗜️ PDF komprimieren', fr: '🗜️ Compresser le PDF' },
    multi:         false,
    accept:        '.pdf',
    implemented:   true,
    defaultPreset: 'medium',
  },
  jpg2pdf: {
    icon:   '🖼️',
    title:  'JPG to PDF',
    desc:   'Convert images to PDF — EXIF rotation corrected automatically',
    tags:   ['image to pdf', 'photo to pdf', 'png to pdf', 'picture to pdf',
             'jpg', 'jpeg', 'png', 'image', 'photo', 'scan to pdf', 'convert image'],
    btn:    '🖼️ Convert to PDF',
    titles: { en: 'JPG to PDF',         es: 'JPG a PDF',          pt: 'JPG para PDF',       de: 'JPG zu PDF',         fr: 'JPG en PDF' },
    descs:  { en: 'Convert images to PDF instantly', es: 'Convierte imágenes a PDF al instante', pt: 'Converta imagens em PDF instantaneamente', de: 'Bilder sofort in PDF umwandeln', fr: 'Convertir des images en PDF instantanément' },
    btns:   { en: '🖼️ Convert to PDF',  es: '🖼️ Convertir a PDF', pt: '🖼️ Converter para PDF', de: '🖼️ In PDF konvertieren', fr: '🖼️ Convertir en PDF' },
    multi:       true,
    accept:      '.jpg,.jpeg,.png',
    implemented: true,
  },
  pdf2jpg: {
    icon:   '📸',
    title:  'PDF to JPG',
    desc:   'Extract pages as high-quality JPG or PNG images',
    tags:   ['pdf to image', 'export pages', 'convert to jpg', 'extract images',
             'screenshot', 'render pdf', 'jpg', 'png', 'images from pdf'],
    btn:    '📸 Export images',
    titles: { en: 'PDF to JPG',       es: 'PDF a JPG',           pt: 'PDF para JPG',       de: 'PDF zu JPG',         fr: 'PDF en JPG' },
    descs:  { en: 'Extract pages as high-quality images', es: 'Extrae páginas como imágenes de alta calidad', pt: 'Extraia páginas como imagens de alta qualidade', de: 'Seiten als hochwertige Bilder exportieren', fr: 'Exporter les pages en images haute qualité' },
    btns:   { en: '📸 Export images', es: '📸 Exportar imágenes', pt: '📸 Exportar imagens', de: '📸 Bilder exportieren', fr: '📸 Exporter les images' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  redact: {
    icon:   '🖌️',
    title:  'Cover Area',
    desc:   'Hide watermarks, signatures or sensitive data with an opaque cover',
    tags:   ['redact', 'hide', 'cover', 'black out', 'censor', 'mask', 'blur',
             'remove watermark', 'sensitive data', 'signature'],
    btn:    '🖌️ Cover Area',
    titles: { en: 'Cover Area',    es: 'Ocultar Área',    pt: 'Ocultar Área',    de: 'Bereich Abdecken', fr: 'Caviarder Zone' },
    descs:  { en: 'Hide watermarks, signatures or sensitive data locally', es: 'Ocultar marcas de agua, firmas o datos sensibles localmente', pt: "Ocultar marcas d'água, assinaturas ou dados sensíveis localmente", de: 'Wasserzeichen, Unterschriften oder sensible Daten lokal ausblenden', fr: 'Masquer filigranes, signatures ou données sensibles localement' },
    btns:   { en: '🖌️ Cover Area', es: '🖌️ Ocultar área', pt: '🖌️ Ocultar área', de: '🖌️ Bereich abdecken', fr: '🖌️ Caviarder la zone' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  rotate: {
    icon:   '🔄',
    title:  'Rotate PDF',
    desc:   'Fix page orientation in any PDF',
    tags:   ['rotate', 'flip', 'orientation', 'turn', 'landscape', 'portrait',
             'fix rotation', 'upside down', 'drehen', 'rotar', 'faire pivoter'],
    btn:    '🔄 Rotate PDF',
    titles: { en: 'Rotate PDF',    es: 'Rotar PDF',    pt: 'Girar PDF',    de: 'PDF Drehen',    fr: 'Rotation PDF' },
    descs:  { en: 'Fix page orientation in any PDF', es: 'Arregla la orientación de páginas en cualquier PDF', pt: 'Corrija a orientação das páginas em qualquer PDF', de: 'Seitenausrichtung in beliebigen PDFs korrigieren', fr: "Corriger l'orientation des pages dans n'importe quel PDF" },
    btns:   { en: '🔄 Rotate PDF', es: '🔄 Rotar PDF', pt: '🔄 Girar PDF', de: '🔄 PDF drehen', fr: '🔄 Faire pivoter' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  extract: {
    icon:   '📑',
    title:  'Extract Pages',
    desc:   'Pull selected pages into a new PDF — with smart presets',
    tags:   ['extract', 'take pages', 'select pages', 'get pages', 'pick pages',
             'subset', 'copy pages', 'save pages'],
    btn:    '📑 Extract Pages',
    titles: { en: 'Extract Pages',    es: 'Extraer Páginas',    pt: 'Extrair Páginas',    de: 'Seiten Extrahieren',    fr: 'Extraire Pages' },
    descs:  { en: 'Pull selected pages into a new PDF', es: 'Extrae páginas seleccionadas a un nuevo PDF', pt: 'Extraia páginas selecionadas para um novo PDF', de: 'Ausgewählte Seiten in ein neues PDF extrahieren', fr: 'Extraire des pages sélectionnées dans un nouveau PDF' },
    btns:   { en: '📑 Extract Pages', es: '📑 Extraer páginas', pt: '📑 Extrair páginas', de: '📑 Seiten extrahieren', fr: '📑 Extraire les pages' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  watermark: {
    title:  'Watermark PDF',
    desc:   'Add text watermark to every page — diagonal, tiled or positioned',
    tags:   ['watermark', 'stamp', 'text overlay', 'brand', 'diagonal', 'add text',
             'wasserzeichen', 'marca de agua', 'filigrane'],
    btn:    '💧 Apply Watermark',
    titles: { en: 'Watermark PDF',      es: 'Marca de agua',          pt: "Marca d'água",           de: 'Wasserzeichen PDF',          fr: 'Filigrane PDF' },
    descs:  { en: 'Stamp text on every page — diagonal or tiled', es: 'Estampa texto en cada página — diagonal o en mosaico', pt: 'Estampe texto em cada página — diagonal ou em mosaico', de: 'Text auf jeder Seite stempeln — diagonal oder gekachelt', fr: 'Tamponner du texte sur chaque page — diagonal ou en mosaïque' },
    btns:   { en: '💧 Apply Watermark', es: '💧 Aplicar marca de agua', pt: "💧 Aplicar marca d'água", de: '💧 Wasserzeichen einfügen', fr: '💧 Appliquer le filigrane' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  pagenum: {
    icon:   '🔢',
    title:  'Add Page Numbers',
    desc:   'Number pages — Arabic, Roman or alphabetic, any position',
    tags:   ['page numbers', 'numbering', 'pagination', 'footer', 'number pages',
             'add numbers', 'page count', 'roman numerals'],
    btn:    '🔢 Add Numbers',
    titles: { en: 'Page Numbers',  es: 'Números de página',  pt: 'Números de página',  de: 'Seitenzahlen',           fr: 'Numérotation PDF' },
    descs:  { en: 'Add numbered footers — Arabic, Roman or ABC', es: 'Añade números de página en el pie — Arábigos, Romanos o ABC', pt: 'Adicione números de página no rodapé — Arábicos, Romanos ou ABC', de: 'Nummerierte Fußzeilen hinzufügen — Arabisch, Römisch oder ABC', fr: 'Ajouter des pieds de page numérotés — arabe, romain ou alphabétique' },
    btns:   { en: '🔢 Add Numbers', es: '🔢 Añadir números', pt: '🔢 Adicionar números', de: '🔢 Nummern hinzufügen', fr: '🔢 Ajouter la numérotation' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  meta: {
    icon:   '🏷️',
    title:  'Edit Metadata',
    desc:   'View and edit PDF title, author, subject and other fields',
    tags:   ['metadata', 'title', 'author', 'subject', 'properties', 'info',
             'document info', 'edit info', 'keywords'],
    btn:    '🏷️ Save Metadata',
    titles: { en: 'Edit Metadata',    es: 'Editar Metadatos',    pt: 'Editar Metadados',    de: 'Metadaten Bearbeiten', fr: 'Métadonnées PDF' },
    descs:  { en: 'View and edit title, author, keywords', es: 'Ver y editar título, autor, palabras clave', pt: 'Ver e editar título, autor, palavras-chave', de: 'Titel, Autor, Schlüsselwörter anzeigen und bearbeiten', fr: 'Afficher et modifier titre, auteur, mots-clés' },
    btns:   { en: '🏷️ Save Metadata', es: '🏷️ Guardar metadatos', pt: '🏷️ Salvar metadados', de: '🏷️ Metadaten speichern', fr: '🏷️ Enregistrer les métadonnées' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  protect: {
    icon:   '🔒',
    title:  'Protect PDF',
    desc:   'Add open password & restrict permissions — AES-256, fully client-side',
    tags:   ['protect', 'password', 'lock', 'encrypt', 'secure', 'restrict',
             'passwort', 'contraseña', 'mot de passe', 'add password'],
    btn:    '🔒 Protect PDF',
    titles: { en: 'Protect PDF',    es: 'Proteger PDF',    pt: 'Proteger PDF',    de: 'PDF Schützen',    fr: 'Protéger PDF' },
    descs:  { en: 'AES-256 password & permissions — 100% private', es: 'Contraseña AES-256 y permisos — 100% privado', pt: 'Senha AES-256 e permissões — 100% privado', de: 'AES-256-Passwort und Berechtigungen — 100 % privat', fr: 'Mot de passe AES-256 et permissions — 100 % privé' },
    btns:   { en: '🔒 Protect PDF', es: '🔒 Proteger PDF', pt: '🔒 Proteger PDF', de: '🔒 PDF schützen', fr: '🔒 Protéger le PDF' },
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  fill: {
    icon:        '✏️',
    title:       'Fill PDF Form',
    desc:        'Fill any PDF form — text fields, checkboxes, dropdowns. No upload.',
    tags:        ['fill', 'form', 'checkbox', 'dropdown', 'text field', 'fill form',
                  'fill out', 'complete form', 'input', 'sign form'],
    btn:         '✏️ Fill & Download PDF',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  'compress-email': {
    icon:        '📧',
    title:       'Compress PDF for Email',
    desc:        'Maximum compression — 96 DPI — optimized to fit Gmail and Outlook limits',
    tags:        ['email', 'gmail', 'outlook', 'send pdf', 'attach', 'small file',
                  'compress for email', 'email pdf', 'too large for email'],
    btn:         '📧 Compress for Email',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  'draw-pdf': {
    icon:        '✏️',
    title:       'Draw on PDF',
    desc:        'Annotate PDFs with arrows, text and shapes — private, no upload',
    tags:        ['draw', 'annotate', 'annotation', 'mark up', 'markup', 'arrow', 'shape',
                  'text box', 'freehand', 'highlight', 'doodle', 'write on pdf'],
    btn:         '✏️ Save PDF',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  ocr: {
    icon:        '🔍',
    title:       'OCR PDF',
    desc:        'Extract text from scanned PDFs — runs in your browser, no upload',
    tags:        ['ocr', 'extract text', 'scanned', 'scan to text', 'text recognition',
                  'searchable', 'make searchable', 'image to text', 'recognize text'],
    btn:         'Extract Text',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  'pdf2word': {
    icon:        '📝',
    title:       'PDF to Word',
    desc:        'Convert PDF to editable .docx — runs in your browser, no upload',
    tags:        ['word', 'docx', 'convert to word', 'pdf to docx', 'editable',
                  'pdf to doc', 'open in word', 'export to word'],
    btn:         '📝 Convert to Word',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
  flatten: {
    icon:        '🔒',
    title:       'Flatten PDF',
    desc:        'Bake form fields into the page — make PDF non-editable',
    tags:        ['flatten', 'lock form', 'non-editable', 'bake fields', 'lock pdf',
                  'freeze form', 'lock fields', 'make non editable', 'remove form fields'],
    btn:         '🔒 Lock PDF Form',
    multi:       false,
    accept:      '.pdf',
    implemented: true,
  },
};
