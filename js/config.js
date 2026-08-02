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
  '.pdf,application/pdf': ['application/pdf'],
  '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp': ['image/jpeg', 'image/png', 'image/webp'],
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
             'combine pdf', 'combine pdfs', 'join pdf files', 'merge pdfs',
             'zusammenfügen', 'zusammenführen', 'unir', 'juntar', 'fusionner'],
    btn:    '🔗 Merge PDF files',
    titles: { en: 'Merge PDF files', es: 'Unir PDF', pt: 'Juntar PDF', de: 'PDF Zusammenfügen', fr: 'Fusionner PDF', id: 'Gabungkan PDF', vi: 'Ghép PDF', ru: 'Объединить PDF', ja: 'PDFを結合', it: 'Unisci PDF', ko: 'PDF 합치기', nl: 'PDF samenvoegen', pl: 'Połącz PDF', tr: 'PDF Birleştir' },
    descs:  { en: 'Combine unlimited PDF files — no restrictions', es: 'Combina archivos PDF ilimitados — sin restricciones', pt: 'Combine arquivos PDF ilimitados — sem restrições', de: 'Beliebig viele PDF-Dateien zusammenfügen — keine Einschränkungen', fr: 'Fusionner un nombre illimité de fichiers PDF — sans restrictions', id: 'Gabungkan file PDF tanpa batas — tanpa batasan', vi: 'Ghép không giới hạn file PDF — không hạn chế', ru: 'Объединяйте неограниченное количество PDF файлов — без ограничений', ja: '無制限のPDFファイルを結合 — 制限なし', it: 'Combina file PDF illimitati — senza restrizioni', ko: 'PDF 파일을 무제한으로 합치기 — 제한 없음', nl: 'Combineer onbeperkte PDF-bestanden — zonder beperkingen', pl: 'Łącz nieograniczone pliki PDF — bez ograniczeń', tr: 'Sınırsız PDF dosyasını birleştirin — limit yok' },
    btns:   { en: '🔗 Merge PDF files', es: '🔗 Unir PDF', pt: '🔗 Juntar PDF', de: '🔗 PDF zusammenführen', fr: '🔗 Fusionner les PDF', id: '🔗 Gabungkan PDF', vi: '🔗 Ghép PDF', ru: '🔗 Объединить PDF', ja: '🔗 PDFを結合', it: '🔗 Unisci PDF', ko: '🔗 PDF 합치기', nl: '🔗 PDF samenvoegen', pl: '🔗 Połącz PDF', tr: '🔗 PDF Birleştir' },
    multi:       true,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  split: {
    icon:   '✂️',
    title:  'Split PDF',
    desc:   'Extract pages or split into separate files',
    tags:   ['split', 'divide', 'separate', 'cut', 'remove pages', 'delete pages',
             'aufteilen', 'dividir', 'diviser'],
    btn:    '✂️ Split PDF',
    titles: { en: 'Split PDF', es: 'Dividir PDF', pt: 'Dividir PDF', de: 'PDF Aufteilen', fr: 'Diviser PDF', id: 'Pisahkan PDF', vi: 'Tách PDF', ru: 'Разделить PDF', ja: 'PDFを分割', it: 'Dividi PDF', ko: 'PDF 분할', nl: 'PDF splitsen', pl: 'Podziel PDF', tr: 'PDF Böl' },
    descs:  { en: 'Extract pages or split into separate files', es: 'Extrae páginas o divide en archivos separados', pt: 'Extraia páginas ou divida em arquivos separados', de: 'Seiten extrahieren oder in einzelne Dateien aufteilen', fr: 'Extraire des pages ou diviser en fichiers séparés', id: 'Ekstrak halaman atau pisahkan menjadi file terpisah', vi: 'Trích xuất trang hoặc chia thành các file riêng lẻ', ru: 'Извлекайте страницы или разделяйте на отдельные файлы', ja: 'ページを抽出するか個別ファイルに分割する', it: 'Dividi PDF o estrai pagine specifiche — senza restrizioni', ko: 'PDF 분할 또는 특정 페이지 추출 — 제한 없음', nl: "PDF splitsen of specifieke pagina's extraheren — zonder beperkingen", pl: 'Podziel PDF lub wyodrębnij strony — bez ograniczeń', tr: "PDF'i böl veya sayfa çıkar — limit yok" },
    btns:   { en: '✂️ Split PDF', es: '✂️ Dividir PDF', pt: '✂️ Dividir PDF', de: '✂️ PDF aufteilen', fr: '✂️ Diviser le PDF', id: '✂️ Pisahkan PDF', vi: '✂️ Tách PDF', ru: '✂️ Разделить PDF', ja: '✂️ PDFを分割', it: '✂️ Dividi PDF', ko: '✂️ PDF 분할', nl: '✂️ PDF splitsen', pl: '✂️ Podziel PDF', tr: '✂️ PDF Böl' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  compress: {
    icon:   '🗜️',
    title:  'Compress PDF',
    desc:   'Reduce file size while preserving text and vector quality',
    tags:   ['compress', 'reduce', 'smaller', 'shrink', 'optimize', 'file size', 'too big',
             'reduce size', 'shrink pdf', 'make pdf smaller', 'make smaller', 'reduce pdf',
             'komprimieren', 'comprimir', 'compresser'],
    btn:    '🗜️ Compress PDF',
    titles: { en: 'Compress PDF', es: 'Comprimir PDF', pt: 'Comprimir PDF', de: 'PDF Komprimieren', fr: 'Compresser PDF', id: 'Kompres PDF', vi: 'Nén PDF', ru: 'Сжать PDF', ja: 'PDF圧縮', it: 'Comprimi PDF', ko: 'PDF 압축', nl: 'PDF comprimeren', pl: 'Kompresuj PDF', tr: 'PDF Sıkıştır' },
    descs:  { en: 'Reduce file size without losing quality', es: 'Reduce el tamaño sin perder calidad', pt: 'Reduza o tamanho sem perder qualidade', de: 'Dateigröße ohne Qualitätsverlust reduzieren', fr: 'Réduire la taille sans perte de qualité', id: 'Perkecil ukuran file tanpa kehilangan kualitas', vi: 'Giảm dung lượng mà không mất chất lượng', ru: 'Уменьшайте размер файла без потери качества', ja: '品質を落とさずにファイルサイズを削減する', it: 'Riduci le dimensioni del PDF — senza perdita di qualità', ko: '품질 손실 없이 PDF 용량 줄이기 — 업로드 없음', nl: 'PDF comprimeren in je browser — geen upload', pl: 'Kompresuj PDF bez utraty jakości — bez przesyłania', tr: "PDF'i kalite kaybetmeden sıkıştır — yükleme yok" },
    btns:   { en: '🗜️ Compress PDF', es: '🗜️ Comprimir PDF', pt: '🗜️ Comprimir PDF', de: '🗜️ PDF komprimieren', fr: '🗜️ Compresser le PDF', id: '🗜️ Kompres PDF', vi: '🗜️ Nén PDF', ru: '🗜️ Сжать PDF', ja: '🗜️ PDF圧縮', it: '🗜️ Comprimi PDF', ko: '🗜️ PDF 압축', nl: '🗜️ PDF comprimeren', pl: '🗜️ Kompresuj PDF', tr: '🗜️ PDF Sıkıştır' },
    multi:         false,
    accept:        '.pdf,application/pdf',
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
    titles: { en: 'JPG to PDF', es: 'JPG a PDF', pt: 'JPG para PDF', de: 'JPG zu PDF', fr: 'JPG en PDF', id: 'JPG ke PDF', vi: 'JPG sang PDF', ru: 'JPG в PDF', ja: 'JPGをPDFに', it: 'JPG in PDF', ko: 'JPG를 PDF로', nl: 'JPG naar PDF', pl: 'JPG do PDF', tr: "JPG'den PDF'ye" },
    descs:  { en: 'Convert images to PDF instantly', es: 'Convierte imágenes a PDF al instante', pt: 'Converta imagens em PDF instantaneamente', de: 'Bilder sofort in PDF umwandeln', fr: 'Convertir des images en PDF instantanément', id: 'Konversi gambar ke PDF secara instan', vi: 'Chuyển đổi ảnh sang PDF tức thì', ru: 'Конвертируйте изображения в PDF мгновенно', ja: '画像を瞬時にPDFに変換する', it: 'Converti immagini in PDF — nessun upload', ko: '이미지를 PDF로 변환 — 업로드 없음', nl: 'Afbeeldingen naar PDF converteren — geen upload', pl: 'Konwertuj obrazy do PDF — bez przesyłania', tr: "Resimleri PDF'ye dönüştür — yükleme yok" },
    btns:   { en: '🖼️ Convert to PDF', es: '🖼️ Convertir a PDF', pt: '🖼️ Converter para PDF', de: '🖼️ In PDF konvertieren', fr: '🖼️ Convertir en PDF', id: '🖼️ JPG ke PDF', vi: '🖼️ JPG sang PDF', ru: '🖼️ JPG в PDF', ja: '🖼️ JPGをPDFに', it: '🖼️ JPG in PDF', ko: '🖼️ JPG를 PDF로', nl: '🖼️ JPG naar PDF', pl: '🖼️ JPG do PDF', tr: "🖼️ JPG'den PDF'ye" },
    multi:       true,
    accept:      '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp',
    implemented: true,
  },
  pdf2jpg: {
    icon:   '📸',
    title:  'PDF to JPG',
    desc:   'Extract pages as high-quality JPG or PNG images',
    tags:   ['pdf to image', 'export pages', 'convert to jpg', 'extract images',
             'screenshot', 'render pdf', 'jpg', 'png', 'images from pdf'],
    btn:    '📸 Export images',
    titles: { en: 'PDF to JPG', es: 'PDF a JPG', pt: 'PDF para JPG', de: 'PDF zu JPG', fr: 'PDF en JPG', id: 'PDF ke JPG', vi: 'PDF sang JPG', ru: 'PDF в JPG', ja: 'PDFをJPGに', it: 'PDF in JPG', ko: 'PDF를 JPG로', nl: 'PDF naar JPG', pl: 'PDF do JPG', tr: "PDF'den JPG'ye" },
    descs:  { en: 'Extract pages as high-quality images', es: 'Extrae páginas como imágenes de alta calidad', pt: 'Extraia páginas como imagens de alta qualidade', de: 'Seiten als hochwertige Bilder exportieren', fr: 'Exporter les pages en images haute qualité', id: 'Ekstrak halaman sebagai gambar berkualitas tinggi', vi: 'Trích xuất trang dưới dạng ảnh chất lượng cao', ru: 'Извлекайте страницы как высококачественные изображения', ja: 'ページを高品質な画像として書き出す', it: 'Converti pagine PDF in immagini JPG — nessun upload', ko: 'PDF 페이지를 JPG 이미지로 변환 — 업로드 없음', nl: "PDF-pagina's converteren naar JPG afbeeldingen — geen upload", pl: 'Konwertuj strony PDF do obrazów JPG — bez przesyłania', tr: 'PDF sayfalarını JPG resimlerine dönüştür — yükleme yok' },
    btns:   { en: '📸 Export images', es: '📸 Exportar imágenes', pt: '📸 Exportar imagens', de: '📸 Bilder exportieren', fr: '📸 Exporter les images', id: '📸 PDF ke JPG', vi: '📸 PDF sang JPG', ru: '📸 PDF в JPG', ja: '📸 PDFをJPGに', it: '📸 PDF in JPG', ko: '📸 PDF를 JPG로', nl: '📸 PDF naar JPG', pl: '📸 PDF do JPG', tr: "📸 PDF'den JPG'ye" },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  redact: {
    icon:   '🖌️',
    title:  'Cover Area',
    desc:   'Hide watermarks, signatures or sensitive data with an opaque cover',
    tags:   ['redact', 'hide', 'cover', 'black out', 'censor', 'mask', 'blur',
             'remove watermark', 'sensitive data', 'signature', 'hide text', 'cover text',
             'black out text', 'delete text'],
    btn:    '🖌️ Cover Area',
    titles: { en: 'Cover Area', es: 'Ocultar Área', pt: 'Ocultar Área', de: 'Bereich Abdecken', fr: 'Caviarder Zone', id: 'Hapus Area', vi: 'Xóa Vùng', ru: 'Скрыть область', ja: '領域を隠す', it: 'Copri Area', ko: '영역 가리기', nl: 'Gebied Afdekken', pl: 'Zakryj Obszar', tr: 'PDF Gizle' },
    descs:  { en: 'Hide watermarks, signatures or sensitive data locally', es: 'Ocultar marcas de agua, firmas o datos sensibles localmente', pt: "Ocultar marcas d'água, assinaturas ou dados sensíveis localmente", de: 'Wasserzeichen, Unterschriften oder sensible Daten lokal ausblenden', fr: 'Masquer filigranes, signatures ou données sensibles localement', id: 'Sembunyikan tanda air, tanda tangan atau data sensitif secara lokal', vi: 'Ẩn watermark, chữ ký hoặc dữ liệu nhạy cảm cục bộ', ru: 'Скрывайте водяные знаки, подписи или конфиденциальные данные локально', ja: '透かし、署名、機密データをローカルで隠す', it: 'Nascondi filigrane, firme o dati sensibili localmente', ko: '워터마크, 서명 또는 민감한 데이터를 로컬에서 가리기', nl: 'Verberg watermerken, handtekeningen of gevoelige gegevens lokaal', pl: 'Ukryj znaki wodne, podpisy lub wrażliwe dane lokalnie', tr: "PDF'den hassas bilgileri kalıcı olarak kaldırın" },
    btns:   { en: '🖌️ Cover Area', es: '🖌️ Ocultar área', pt: '🖌️ Ocultar área', de: '🖌️ Bereich abdecken', fr: '🖌️ Caviarder la zone', id: '🖌️ Hapus Area', vi: '🖌️ Xóa Vùng', ru: '🖌️ Скрыть область', ja: '🖌️ 領域を隠す', it: '🖌️ Copri Area', ko: '🖌️ 영역 가리기', nl: '🖌️ Gebied Afdekken', pl: '🖌️ Zakryj Obszar', tr: '🖌️ PDF Gizle' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  rotate: {
    icon:   '🔄',
    title:  'Rotate PDF',
    desc:   'Fix page orientation in any PDF',
    tags:   ['rotate', 'flip', 'orientation', 'turn', 'landscape', 'portrait',
             'fix rotation', 'upside down', 'drehen', 'rotar', 'faire pivoter'],
    btn:    '🔄 Rotate PDF',
    titles: { en: 'Rotate PDF', es: 'Rotar PDF', pt: 'Girar PDF', de: 'PDF Drehen', fr: 'Rotation PDF', id: 'Putar PDF', vi: 'Xoay PDF', ru: 'Повернуть PDF', ja: 'PDFを回転', it: 'Ruota PDF', ko: 'PDF 회전', nl: 'PDF Draaien', pl: 'Obróć PDF', tr: 'PDF Döndür' },
    descs:  { en: 'Fix page orientation in any PDF', es: 'Arregla la orientación de páginas en cualquier PDF', pt: 'Corrija a orientação das páginas em qualquer PDF', de: 'Seitenausrichtung in beliebigen PDFs korrigieren', fr: "Corriger l'orientation des pages dans n'importe quel PDF", id: 'Perbaiki orientasi halaman di PDF mana pun', vi: 'Sửa hướng trang trong bất kỳ PDF nào', ru: 'Исправляйте ориентацию страниц в любом PDF', ja: 'どのPDFでもページの向きを修正する', it: "Correggi l'orientamento delle pagine in qualsiasi PDF", ko: '모든 PDF의 페이지 방향을 수정하세요', nl: 'Corrigeer de pagina-oriëntatie in elke PDF', pl: 'Popraw orientację stron w dowolnym pliku PDF', tr: 'PDF sayfalarının yönünü düzeltin' },
    btns:   { en: '🔄 Rotate PDF', es: '🔄 Rotar PDF', pt: '🔄 Girar PDF', de: '🔄 PDF drehen', fr: '🔄 Faire pivoter', id: '🔄 Putar PDF', vi: '🔄 Xoay PDF', ru: '🔄 Повернуть PDF', ja: '🔄 PDFを回転', it: '🔄 Ruota PDF', ko: '🔄 PDF 회전', nl: '🔄 PDF Draaien', pl: '🔄 Obróć PDF', tr: '🔄 PDF Döndür' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  extract: {
    icon:   '📑',
    title:  'Extract Pages',
    desc:   'Pull selected pages into a new PDF — with smart presets',
    tags:   ['extract', 'take pages', 'select pages', 'get pages', 'pick pages',
             'subset', 'copy pages', 'save pages'],
    btn:    '📑 Extract Pages',
    titles: { en: 'Extract Pages', es: 'Extraer Páginas', pt: 'Extrair Páginas', de: 'Seiten Extrahieren', fr: 'Extraire Pages', id: 'Ekstrak Halaman', vi: 'Trích Xuất Trang', ru: 'Извлечь страницы', ja: 'ページを抽出', it: 'Estrai Pagine', ko: '페이지 추출', nl: "Pagina's Extraheren", pl: 'Wyodrębnij Strony', tr: 'Sayfa Çıkar' },
    descs:  { en: 'Pull selected pages into a new PDF', es: 'Extrae páginas seleccionadas a un nuevo PDF', pt: 'Extraia páginas selecionadas para um novo PDF', de: 'Ausgewählte Seiten in ein neues PDF extrahieren', fr: 'Extraire des pages sélectionnées dans un nouveau PDF', id: 'Ambil halaman terpilih ke PDF baru', vi: 'Lấy các trang được chọn vào PDF mới', ru: 'Извлекайте выбранные страницы в новый PDF', ja: '選択したページを新しいPDFにまとめる', it: 'Estrai le pagine selezionate in un nuovo PDF', ko: '선택한 페이지를 새 PDF로 가져오기', nl: "Haal geselecteerde pagina's in een nieuwe PDF", pl: 'Wyodrębnij wybrane strony do nowego pliku PDF', tr: "PDF'den belirli sayfaları çıkarın" },
    btns:   { en: '📑 Extract Pages', es: '📑 Extraer páginas', pt: '📑 Extrair páginas', de: '📑 Seiten extrahieren', fr: '📑 Extraire les pages', id: '📑 Ekstrak Halaman', vi: '📑 Trích Xuất Trang', ru: '📑 Извлечь страницы', ja: '📑 ページを抽出', it: '📑 Estrai Pagine', ko: '📑 페이지 추출', nl: "📑 Pagina's Extraheren", pl: '📑 Wyodrębnij Strony', tr: '📑 Sayfa Çıkar' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  watermark: {
    title:  'Watermark PDF',
    desc:   'Add text watermark to every page — diagonal, tiled or positioned',
    tags:   ['watermark', 'stamp', 'text overlay', 'brand', 'diagonal', 'add text',
             'add watermark', 'watermark pdf', 'put watermark',
             'wasserzeichen', 'marca de agua', 'filigrane'],
    btn:    '💧 Apply Watermark',
    titles: { en: 'Watermark PDF', es: 'Marca de agua', pt: "Marca d'água", de: 'Wasserzeichen PDF', fr: 'Filigrane PDF', id: 'Tanda Air PDF', vi: 'Thêm Watermark', ru: 'Водяной знак PDF', ja: '透かし追加', it: 'Filigrana PDF', ko: 'PDF 워터마크', nl: 'Watermerk PDF', pl: 'Znak wodny PDF', tr: 'PDF Filigran' },
    descs:  { en: 'Stamp text on every page — diagonal or tiled', es: 'Estampa texto en cada página — diagonal o en mosaico', pt: 'Estampe texto em cada página — diagonal ou em mosaico', de: 'Text auf jeder Seite stempeln — diagonal oder gekachelt', fr: 'Tamponner du texte sur chaque page — diagonal ou en mosaïque', id: 'Cetak teks di setiap halaman — diagonal atau berulang', vi: 'Đóng dấu văn bản trên mỗi trang — chéo hoặc lưới', ru: 'Ставьте текстовый штамп на каждой странице — диагонально или плиткой', ja: 'すべてのページにテキストを押す — 斜めまたはタイル状', it: 'Aggiungi timbri di testo al PDF — senza upload', ko: 'PDF에 텍스트 도장 추가 — 업로드 없음', nl: 'Tekststempels toevoegen aan PDF — geen upload', pl: 'Dodaj tekstowe stemple do PDF — bez przesyłania', tr: "PDF'e metin damgası ekle — yükleme yok" },
    btns:   { en: '💧 Apply Watermark', es: '💧 Aplicar marca de agua', pt: "💧 Aplicar marca d'água", de: '💧 Wasserzeichen einfügen', fr: '💧 Appliquer le filigrane', id: '💧 Tanda Air PDF', vi: '💧 Thêm Watermark', ru: '💧 Водяной знак PDF', ja: '💧 透かし追加', it: '💧 Filigrana PDF', ko: '💧 PDF 워터마크', nl: '💧 Watermerk PDF', pl: '💧 Znak wodny PDF', tr: '💧 PDF Filigran' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  pagenum: {
    icon:   '🔢',
    title:  'Add Page Numbers',
    desc:   'Number pages — Arabic, Roman or alphabetic, any position',
    tags:   ['page numbers', 'numbering', 'pagination', 'footer', 'number pages',
             'add numbers', 'page count', 'roman numerals'],
    btn:    '🔢 Add Numbers',
    titles: { en: 'Page Numbers', es: 'Números de página', pt: 'Números de página', de: 'Seitenzahlen', fr: 'Numérotation PDF', id: 'Nomor Halaman', vi: 'Số Trang PDF', ru: 'Номера страниц', ja: 'ページ番号', it: 'Numeri di Pagina', ko: '페이지 번호', nl: 'Paginanummers', pl: 'Numery Stron', tr: 'Sayfa Numarası Ekle' },
    descs:  { en: 'Add numbered footers — Arabic, Roman or ABC', es: 'Añade números de página en el pie — Arábigos, Romanos o ABC', pt: 'Adicione números de página no rodapé — Arábicos, Romanos ou ABC', de: 'Nummerierte Fußzeilen hinzufügen — Arabisch, Römisch oder ABC', fr: 'Ajouter des pieds de page numérotés — arabe, romain ou alphabétique', id: 'Tambah footer bernomor — Arab, Romawi atau ABC', vi: 'Thêm chân trang có số — Ả Rập, La Mã hoặc ABC', ru: 'Добавьте нумерованные колонтитулы — арабские, римские цифры или буквы', ja: '番号付きフッターを追加 — アラビア数字、ローマ数字、またはABC', it: 'Aggiungi piè di pagina numerati — arabo, romano o ABC', ko: '번호가 매겨진 바닥글 추가 — 아라비아, 로마 숫자 또는 ABC', nl: 'Genummerde voettekst toevoegen — Arabisch, Romeins of ABC', pl: 'Dodaj numerowane stopki — arabskie, rzymskie lub ABC', tr: "PDF'ye özelleştirilebilir sayfa numaraları ekleyin" },
    btns:   { en: '🔢 Add Numbers', es: '🔢 Añadir números', pt: '🔢 Adicionar números', de: '🔢 Nummern hinzufügen', fr: '🔢 Ajouter la numérotation', id: '🔢 Tambah Nomor Halaman', vi: '🔢 Thêm Số Trang', ru: '🔢 Номера страниц', ja: '🔢 ページ番号', it: '🔢 Numeri di Pagina', ko: '🔢 페이지 번호', nl: '🔢 Paginanummers', pl: '🔢 Numery Stron', tr: '🔢 Sayfa Numarası Ekle' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  meta: {
    icon:   '🏷️',
    title:  'Edit Metadata',
    desc:   'View and edit PDF title, author, subject and other fields',
    tags:   ['metadata', 'title', 'author', 'subject', 'properties', 'info',
             'document info', 'edit info', 'keywords'],
    btn:    '🏷️ Save Metadata',
    titles: { en: 'Edit Metadata', es: 'Editar Metadatos', pt: 'Editar Metadados', de: 'Metadaten Bearbeiten', fr: 'Métadonnées PDF', id: 'Edit Metadata', vi: 'Chỉnh Sửa Metadata', ru: 'Редактировать метаданные', ja: 'メタデータを編集', it: 'Modifica Metadati', ko: '메타데이터 편집', nl: 'Metadata Bewerken', pl: 'Edytuj Metadane', tr: 'PDF Meta Verisi' },
    descs:  { en: 'View and edit title, author, keywords', es: 'Ver y editar título, autor, palabras clave', pt: 'Ver e editar título, autor, palavras-chave', de: 'Titel, Autor, Schlüsselwörter anzeigen und bearbeiten', fr: 'Afficher et modifier titre, auteur, mots-clés', id: 'Lihat dan edit judul, penulis, kata kunci', vi: 'Xem và chỉnh sửa tiêu đề, tác giả, từ khóa', ru: 'Просматривайте и редактируйте заголовок, автора, ключевые слова', ja: 'タイトル、作成者、キーワードを表示・編集', it: 'Visualizza e modifica titolo, autore, parole chiave', ko: '제목, 작성자, 키워드 보기 및 편집', nl: 'Titel, auteur, trefwoorden bekijken en bewerken', pl: 'Wyświetlaj i edytuj tytuł, autora, słowa kluczowe', tr: "PDF'nin Yazar, Başlık ve anahtar kelimelerini düzenleyin" },
    btns:   { en: '🏷️ Save Metadata', es: '🏷️ Guardar metadatos', pt: '🏷️ Salvar metadados', de: '🏷️ Metadaten speichern', fr: '🏷️ Enregistrer les métadonnées', id: '🏷️ Edit Metadata', vi: '🏷️ Chỉnh Sửa Metadata', ru: '🏷️ Редактировать метаданные', ja: '🏷️ メタデータを編集', it: '🏷️ Modifica Metadati', ko: '🏷️ 메타데이터 편집', nl: '🏷️ Metadata Bewerken', pl: '🏷️ Edytuj Metadane', tr: '🏷️ PDF Meta Verisi' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  protect: {
    icon:   '🔒',
    title:  'Protect PDF',
    desc:   'Add open password & restrict permissions — fully client-side',
    tags:   ['protect', 'password', 'lock', 'encrypt', 'secure', 'restrict',
             'passwort', 'contraseña', 'mot de passe', 'add password'],
    btn:    '🔒 Protect PDF',
    titles: { en: 'Protect PDF', es: 'Proteger PDF', pt: 'Proteger PDF', de: 'PDF Schützen', fr: 'Protéger PDF', id: 'Lindungi PDF', vi: 'Bảo Vệ PDF', ru: 'Защитить PDF', ja: 'PDFを保護', it: 'Proteggi PDF', ko: 'PDF 보호', nl: 'PDF beveiligen', pl: 'Zabezpiecz PDF', tr: 'PDF Koru' },
    descs:  { en: 'Password & permissions — 100% private', es: 'Contraseña y permisos — 100% privado', pt: 'Senha e permissões — 100% privado', de: 'Passwort und Berechtigungen — 100 % privat', fr: 'Mot de passe et permissions — 100 % privé', id: 'Kata sandi & izin — 100% pribadi', vi: 'Mật khẩu & quyền — 100% riêng tư', ru: 'Пароль и права — 100% конфиденциально', ja: 'パスワード & アクセス権 — 100%プライベート', it: 'Proteggi PDF con password — nessun upload', ko: 'PDF에 비밀번호 설정 — 업로드 없음', nl: 'PDF beveiligen met wachtwoord — geen upload', pl: 'Zabezpiecz PDF hasłem — bez przesyłania', tr: "PDF'i parolayla koru — yükleme yok" },
    btns:   { en: '🔒 Protect PDF', es: '🔒 Proteger PDF', pt: '🔒 Proteger PDF', de: '🔒 PDF schützen', fr: '🔒 Protéger le PDF', id: '🔒 Lindungi PDF', vi: '🔒 Bảo Vệ PDF', ru: '🔒 Защитить PDF', ja: '🔒 PDFを保護', it: '🔒 Proteggi PDF', ko: '🔒 PDF 보호', nl: '🔒 PDF beveiligen', pl: '🔒 Zabezpiecz PDF', tr: '🔒 PDF Koru' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  fill: {
    icon:        '✏️',
    title:       'Fill PDF Form',
    desc:        'Fill any PDF form — text fields, checkboxes, dropdowns. No upload.',
    tags:        ['fill', 'form', 'checkbox', 'dropdown', 'text field', 'fill form',
                  'fill out', 'complete form', 'input', 'sign form',
                  'sign', 'signature', 'sign pdf', 'esign'],
    btn:         '✏️ Fill & Download PDF',
    titles: { es: 'Rellenar PDF', pt: 'Preencher PDF', de: 'PDF Formular Ausfüllen', fr: 'Remplir PDF', id: 'Isi Formulir PDF', vi: 'Điền Form PDF', ru: 'Заполнить PDF', ja: 'PDFに記入', it: 'Compila PDF', ko: 'PDF 양식 작성', nl: 'PDF Invullen', pl: 'Wypełnij PDF', tr: 'PDF Doldur' },
    descs:  { es: 'Rellena campos y firma PDFs localmente', pt: 'Preencha campos e assine PDFs localmente', de: 'Formulare ausfüllen und PDFs lokal unterschreiben', fr: 'Remplissez des champs de formulaire et signez des PDF localement', id: 'Isi kolom formulir dan tanda tangani PDF secara lokal', vi: 'Điền trường biểu mẫu và ký PDF cục bộ', ru: 'Заполняйте поля и подписывайте PDF локально', ja: 'フォームに入力してPDFにローカルで署名', it: 'Compila campi modulo e firma PDF localmente', ko: '양식을 채우고 PDF에 로컬에서 서명', nl: "Vul formuliervelden in en onderteken PDF's lokaal", pl: 'Wypełniaj pola formularza i podpisuj PDF lokalnie', tr: "Form alanlarını doldurun ve PDF'leri yerel olarak imzalayın" },
    btns:   { es: '✏️ Rellenar PDF', pt: '✏️ Preencher PDF', de: '✏️ PDF Formular Ausfüllen', fr: '✏️ Remplir PDF', id: '✏️ Isi Formulir PDF', vi: '✏️ Điền Form PDF', ru: '✏️ Заполнить PDF', ja: '✏️ PDFに記入', it: '✏️ Compila PDF', ko: '✏️ PDF 양식 작성', nl: '✏️ PDF Invullen', pl: '✏️ Wypełnij PDF', tr: '✏️ PDF Doldur' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
    inline:      false, // requires dedicated page HTML (fillOptions div)
  },
  'compress-email': {
    icon:        '📧',
    title:       'Compress PDF for Email',
    desc:        'Maximum compression — 96 DPI — optimized to fit Gmail and Outlook limits',
    tags:        ['email', 'gmail', 'outlook', 'send pdf', 'attach', 'small file',
                  'compress for email', 'email pdf', 'too large for email'],
    btn:         '📧 Compress for Email',
    // This tool's pages are hand-maintained static HTML (not generated from
    // tools-config.json — see scripts/build.py's SPECIALTY_PAGES), so these
    // translations are copied verbatim from the actual SSR'd #toolTitle/
    // #toolDesc/#mergeBtn text in de/es/pt/fr's compress-for-email pages,
    // not derived from cardNames/cardDescs like the tools-config-backed ones.
    titles: { de: 'PDF für E-Mail komprimieren', es: 'Comprimir PDF para email', pt: 'Comprimir PDF para email', fr: 'Compresser PDF pour email', id: 'Kompres PDF untuk Email', vi: 'Nén PDF để Gửi Email', ru: 'Сжать PDF для Email', ja: 'メール用にPDFを圧縮', it: 'Comprimi PDF per Email', ko: '이메일용 PDF 압축', nl: 'PDF comprimeren voor e-mail', pl: 'Kompresuj PDF do e-maila', tr: 'E-posta için PDF Sıkıştır' },
    descs:  { de: 'Maximale Komprimierung — 96 DPI — optimiert für Gmail und Outlook', es: 'Compresión máxima — 96 DPI — optimizado para Gmail y Outlook', pt: 'Compressão máxima — 96 DPI — otimizada para Gmail e Outlook', fr: 'Compression maximale — 96 DPI — optimisé pour Gmail et Outlook', id: 'Kompresi maksimal — 96 DPI — dioptimalkan untuk batas Gmail dan Outlook', vi: 'Nén tối đa — 96 DPI — tối ưu cho giới hạn Gmail và Outlook', ru: 'Максимальное сжатие — 96 DPI — оптимизировано под лимиты Gmail и Outlook', ja: '最大圧縮 — 96 DPI — GmailとOutlookの上限に最適化', it: 'Compressione massima — 96 DPI — ottimizzato per i limiti di Gmail e Outlook', ko: '최대 압축 — 96 DPI — Gmail 및 Outlook 제한에 최적화', nl: 'Maximale compressie — 96 DPI — geoptimaliseerd voor Gmail- en Outlook-limieten', pl: 'Maksymalna kompresja — 96 DPI — zoptymalizowane pod limity Gmaila i Outlooka', tr: 'Maksimum sıkıştırma — 96 DPI — Gmail ve Outlook sınırlarına göre optimize edildi' },
    btns:   { de: '📧 Für E-Mail komprimieren', es: '📧 Comprimir para email', pt: '🗜️ Comprimir para email', fr: '📧 Compresser pour email', id: '📧 Kompres untuk Email', vi: '📧 Nén để Gửi Email', ru: '📧 Сжать для email', ja: '📧 メール用に圧縮', it: '📧 Comprimi per email', ko: '📧 이메일용으로 압축', nl: '📧 Comprimeren voor e-mail', pl: '📧 Kompresuj do e-maila', tr: '📧 E-posta için sıkıştır' },
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  'draw-pdf': {
    icon:        '✏️',
    title:       'Draw on PDF',
    desc:        'Annotate PDFs with arrows, text and shapes — private, no upload',
    tags:        ['draw', 'annotate', 'annotation', 'mark up', 'markup', 'arrow', 'shape',
                  'text box', 'freehand', 'highlight', 'doodle', 'write on pdf'],
    titles: { en: 'Draw on PDF', es: 'Dibujar en PDF', pt: 'Desenhar no PDF', de: 'Auf PDF zeichnen', fr: 'Dessiner sur PDF', id: 'Gambar di PDF', vi: 'Vẽ lên PDF', ru: 'Рисовать на PDF', ja: 'PDFに描画', it: 'Disegna su PDF', ko: 'PDF에 그리기', nl: 'Tekenen op PDF', pl: 'Rysuj na PDF', tr: "PDF'e Çiz" },
    descs:  { en: 'Annotate PDFs with arrows, text and shapes — private, no upload', es: 'Anota PDFs con flechas, texto y formas — privado, sin subida', pt: 'Anote PDFs com setas, texto e formas — privado, sem upload', de: 'PDFs mit Pfeilen, Text und Formen annotieren — privat, kein Upload', fr: 'Annotez des PDFs avec flèches, texte et formes — privé, sans upload', id: 'Beri anotasi PDF dengan panah, teks, dan bentuk — privat, tanpa unggah', vi: 'Chú thích PDF bằng mũi tên, văn bản và hình dạng — riêng tư, không tải lên', ru: 'Аннотируйте PDF стрелками, текстом и фигурами — приватно, без загрузки', ja: '矢印、テキスト、図形でPDFに注釈を付ける — プライベート、アップロード不要', it: 'Annota i PDF con frecce, testo e forme — privato, senza upload', ko: '화살표, 텍스트, 도형으로 PDF에 주석 달기 — 비공개, 업로드 없음', nl: "PDF's annoteren met pijlen, tekst en vormen — privé, geen upload", pl: 'Dodawaj adnotacje do PDF strzałkami, tekstem i kształtami — prywatnie, bez przesyłania', tr: "Ok, metin ve şekillerle PDF'e not ekleyin — gizli, yükleme yok" },
    btns:   { en: '✏️ Save PDF', es: '✏️ Guardar PDF', pt: '✏️ Salvar PDF', de: '✏️ PDF speichern', fr: '✏️ Enregistrer le PDF', id: '✏️ Simpan PDF', vi: '✏️ Lưu PDF', ru: '✏️ Сохранить PDF', ja: '✏️ PDFを保存', it: '✏️ Salva PDF', ko: '✏️ PDF 저장', nl: '✏️ PDF opslaan', pl: '✏️ Zapisz PDF', tr: "✏️ PDF'i Kaydet" },
    btn:         '✏️ Save PDF',
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
    inline:      false, // requires dedicated page HTML (pdfCanvas, drawCanvas, canvasArea)
  },
  ocr: {
    icon:        '🔍',
    title:       'OCR PDF',
    desc:        'Extract text from scanned PDFs — runs in your browser, no upload',
    tags:        ['ocr', 'extract text', 'scanned', 'scan to text', 'text recognition',
                  'searchable', 'make searchable', 'image to text', 'recognize text'],
    titles: { en: 'OCR PDF', es: 'OCR PDF', pt: 'OCR de PDF', de: 'PDF-Texterkennung', fr: 'PDF OCR', id: 'OCR PDF', vi: 'Nhận Dạng Văn Bản', ru: 'Распознать Текст', ja: 'PDF文字認識', it: 'Riconosci Testo PDF', ko: 'PDF 문자 인식', nl: 'PDF Tekstherkenning', pl: 'Rozpoznaj Tekst PDF', tr: 'PDF Metin Tanıma' },
    descs:  { en: 'Extract text from scanned PDFs — runs in your browser, no upload', es: 'Extrae texto de PDFs escaneados — funciona en tu navegador, sin subida', pt: 'Extraia texto de PDFs digitalizados — funciona no seu navegador, sem upload', de: 'Text aus gescannten PDFs extrahieren — läuft im Browser, kein Upload', fr: 'Extraire le texte des PDFs numérisés — dans votre navigateur, sans upload', id: 'Ekstrak teks dari PDF hasil scan — di browser Anda, tanpa unggah', vi: 'Trích xuất văn bản từ PDF scan — chạy trong trình duyệt, không tải lên', ru: 'Извлекайте текст из отсканированных PDF — прямо в браузере, без загрузки', ja: 'スキャンPDFからテキストを抽出 — ブラウザ内で処理、アップロード不要', it: 'Estrai il testo dai PDF scansionati — nel browser, senza caricamento', ko: '스캔한 PDF에서 텍스트 추출 — 브라우저에서 실행, 업로드 없음', nl: "Haal tekst uit gescande PDF's — in je browser, zonder upload", pl: 'Wyodrębnij tekst z zeskanowanych PDF-ów — w przeglądarce, bez przesyłania', tr: "Taranan PDF'lerden metin çıkarın — tarayıcınızda, yükleme yok" },
    btns:   { en: '🔍 Make PDF Searchable', es: '🔍 Hacer PDF buscable', pt: '🔍 Tornar PDF pesquisável', de: '🔍 PDF durchsuchbar machen', fr: '🔍 Rendre le PDF cherchable', id: '🔍 Buat PDF Bisa Dicari', vi: '🔍 Làm PDF Có Thể Tìm Kiếm', ru: '🔍 Распознать текст в PDF', ja: '🔍 PDFを検索可能にする', it: '🔍 Rendi il PDF Ricercabile', ko: '🔍 PDF를 검색 가능하게 만들기', nl: '🔍 PDF Doorzoekbaar Maken', pl: '🔍 Rozpoznaj Tekst w PDF', tr: "🔍 PDF'i Aranabilir Yap" },
    btn:         '🔍 Make PDF Searchable',
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  'pdf2word': {
    icon:        '📝',
    title:       'PDF to Word',
    desc:        'Convert PDF to editable .docx — runs in your browser, no upload',
    tags:        ['word', 'docx', 'convert to word', 'pdf to docx', 'editable',
                  'pdf to doc', 'open in word', 'export to word'],
    titles: { en: 'PDF to Word', es: 'PDF a Word', pt: 'PDF para Word', de: 'PDF zu Word', fr: 'PDF en Word', id: 'PDF ke Word', vi: 'PDF sang Word', ru: 'PDF в Word', ja: 'PDFをWordに', tr: "PDF'den Word'e", it: 'PDF in Word', ko: 'PDF를 Word로', nl: 'PDF naar Word', pl: 'PDF do Word' },
    descs:  { en: 'Convert PDF to editable .docx — runs in your browser, no upload', es: 'Convierte PDF a .docx editable — funciona en tu navegador, sin subida', pt: 'Converta PDF para .docx editável — funciona no seu navegador, sem upload', de: 'PDF in bearbeitbares .docx konvertieren — läuft im Browser, kein Upload', fr: 'Convertir PDF en .docx éditable — dans votre navigateur, sans upload', id: 'Konversi PDF ke .docx yang dapat diedit — tanpa upload, 100% pribadi', vi: 'Chuyển đổi PDF sang .docx có thể chỉnh sửa — không tải lên, 100% riêng tư', ru: 'Конвертируйте PDF в редактируемый .docx — без загрузки, 100% конфиденциально', ja: 'PDFを編集可能な.docxに変換 — アップロード不要、100%プライベート', tr: "PDF'yi düzenlenebilir Word belgesine dönüştürün", it: 'Converti PDF in documento .docx modificabile. Senza caricamento, senza account.', ko: 'PDF를 편집 가능한 .docx 문서로 변환. 업로드 없음, 계정 불필요.', nl: 'Converteer PDF naar bewerkbaar .docx-document. Zonder upload, zonder account.', pl: 'Konwertuj PDF do edytowalnego dokumentu .docx. Bez przesyłania, bez konta.' },
    btns:   { en: '📝 Convert to Word', es: '📝 Convertir a Word', pt: '📝 Converter para Word', de: '📝 In Word konvertieren', fr: '📝 Convertir en Word', id: '📝 PDF ke Word', vi: '📝 PDF sang Word', ru: '📝 PDF в Word', ja: '📝 PDFをWordに', tr: "📝 PDF'den Word'e", it: '📝 PDF in Word', ko: '📝 PDF를 Word로', nl: '📝 PDF naar Word', pl: '📝 PDF do Word' },
    btn:         '📝 Convert to Word',
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  'pdf2excel': {
    icon:        '📊',
    title:       'PDF to Excel',
    desc:        'Extract tables from PDF into an .xlsx spreadsheet — runs in your browser, no upload',
    tags:        ['excel', 'xlsx', 'convert to excel', 'pdf to xlsx', 'extract table',
                  'pdf to spreadsheet', 'export to excel', 'table extraction'],
    titles: { en: 'PDF to Excel', es: 'PDF a Excel', pt: 'PDF para Excel', de: 'PDF zu Excel', fr: 'PDF en Excel', id: 'PDF ke Excel', vi: 'PDF sang Excel', ru: 'PDF в Excel', ja: 'PDFからExcel', it: 'PDF in Excel', ko: 'PDF를 Excel로', nl: 'PDF naar Excel', pl: 'PDF do Excel', tr: "PDF'den Excel'e" },
    descs:  { en: 'Extract tables from PDF into an .xlsx spreadsheet — runs in your browser, no upload', es: 'Extrae tablas de PDF a una hoja de cálculo .xlsx — funciona en tu navegador, sin subida', pt: 'Extraia tabelas do PDF para uma planilha .xlsx — funciona no seu navegador, sem upload', de: 'Tabellen aus PDF in eine .xlsx-Datei extrahieren — läuft im Browser, kein Upload', fr: "Extraire les tableaux d'un PDF vers une feuille .xlsx — dans votre navigateur, sans envoi", id: 'Konversi tabel PDF ke file .xlsx nyata. Tanpa unggah, tanpa akun.', vi: 'Chuyển bảng PDF thành file .xlsx thực sự. Không tải lên, không cần tài khoản.', ru: 'Конвертируйте таблицы PDF в настоящий .xlsx файл. Без загрузки, без аккаунта.', ja: 'PDFの表を本物の.xlsxファイルに変換。アップロードなし、アカウント不要。', it: 'Converti le tabelle PDF in un vero file .xlsx. Senza caricamento, senza account.', ko: 'PDF 표를 실제 .xlsx 파일로 변환. 업로드 없음, 계정 불필요.', nl: 'Converteer PDF-tabellen naar een echt .xlsx-bestand. Zonder upload, zonder account.', pl: 'Konwertuj tabele PDF do prawdziwego pliku .xlsx. Bez przesyłania, bez konta.', tr: "PDF tablolarını Excel'e dönüştürün" },
    btns:   { en: '📊 Convert to Excel', es: '📊 Convertir a Excel', pt: '📊 Converter para Excel', de: '📊 In Excel konvertieren', fr: '📊 Convertir en Excel', id: '📊 PDF ke Excel', vi: '📊 PDF sang Excel', ru: '📊 PDF в Excel', ja: '📊 PDFからExcel', it: '📊 PDF in Excel', ko: '📊 PDF를 Excel로', nl: '📊 PDF naar Excel', pl: '📊 PDF do Excel', tr: "📊 PDF'den Excel'e" },
    btn:         '📊 Convert to Excel',
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  'pdf2ppt': {
    icon:        '📽️',
    title:       'PDF to PowerPoint',
    desc:        'Convert PDF pages into slides — runs in your browser, no upload',
    tags:        ['powerpoint', 'pptx', 'convert to powerpoint', 'pdf to pptx',
                  'pdf to slides', 'export to powerpoint', 'pdf to presentation'],
    titles: { en: 'PDF to PowerPoint', es: 'PDF a PowerPoint', pt: 'PDF para PowerPoint', de: 'PDF zu PowerPoint', fr: 'PDF en PowerPoint', tr: "PDF'den PowerPoint'e", id: 'PDF ke PowerPoint', vi: 'PDF sang PowerPoint', ru: 'PDF в PowerPoint', ja: 'PDFからPowerPoint', it: 'PDF in PowerPoint', ko: 'PDF를 PowerPoint로', nl: 'PDF naar PowerPoint', pl: 'PDF do PowerPoint' },
    descs:  { en: 'Convert PDF pages into slides — runs in your browser, no upload', es: 'Convierte páginas PDF en una presentación localmente', pt: 'Converta páginas PDF em uma apresentação localmente', de: 'PDF-Seiten lokal in eine Präsentation umwandeln', fr: 'Convertir les pages PDF en diaporama localement', tr: "PDF'yi PowerPoint sunumuna dönüştürün", id: 'Konversi halaman PDF ke slide .pptx. Tanpa unggah, tanpa akun.', vi: 'Chuyển trang PDF thành slide .pptx. Không tải lên, không cần tài khoản.', ru: 'Конвертируйте страницы PDF в слайды .pptx. Без загрузки, без аккаунта.', ja: 'PDFページを.pptxスライドに変換。アップロードなし、アカウント不要。', it: 'Converti pagine PDF in slide .pptx. Senza caricamento, senza account.', ko: 'PDF 페이지를 .pptx 슬라이드로 변환. 업로드 없음, 계정 불필요.', nl: "Converteer PDF-pagina's naar .pptx-slides. Zonder upload, zonder account.", pl: 'Konwertuj strony PDF do slajdów .pptx. Bez przesyłania, bez konta.' },
    btns:   { en: '📽️ Convert to PowerPoint', es: '📽️ PDF a PowerPoint', pt: '📽️ PDF para PowerPoint', de: '📽️ PDF zu PowerPoint', fr: '📽️ PDF en PowerPoint', tr: "📽️ PDF'den PowerPoint'e", id: '📽️ PDF ke PowerPoint', vi: '📽️ PDF sang PowerPoint', ru: '📽️ PDF в PowerPoint', ja: '📽️ PDFからPowerPoint', it: '📽️ PDF in PowerPoint', ko: '📽️ PDF를 PowerPoint로', nl: '📽️ PDF naar PowerPoint', pl: '📽️ PDF do PowerPoint' },
    btn:         '📽️ Convert to PowerPoint',
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  'pdf2md': {
    icon:        '📝',
    title:       'PDF to Markdown',
    desc:        'Convert PDF text, headings and lists into Markdown — runs in your browser, no upload',
    tags:        ['markdown', 'md', 'convert to markdown', 'pdf to md',
                  'pdf to markdown', 'export to markdown', 'pdf to text'],
    titles: { en: 'PDF to Markdown', es: 'PDF a Markdown', pt: 'PDF para Markdown', de: 'PDF zu Markdown', fr: 'PDF en Markdown', tr: "PDF'den Markdown'a", id: 'PDF ke Markdown', vi: 'PDF sang Markdown', ru: 'PDF в Markdown', ja: 'PDFからMarkdown', it: 'PDF in Markdown', ko: 'PDF를 Markdown으로', nl: 'PDF naar Markdown', pl: 'PDF do Markdown' },
    descs:  { en: 'Convert PDF text, headings and lists into Markdown — runs in your browser, no upload', es: 'Convierte texto PDF en archivos .md limpios localmente', pt: 'Converta texto PDF em arquivos .md limpos localmente', de: 'PDF-Text lokal in saubere .md-Dateien umwandeln', fr: 'Convertir le texte PDF en fichiers .md propres localement', tr: "PDF'yi Markdown formatına dönüştürün", id: 'Konversi PDF ke teks Markdown yang ringan. Tanpa unggah, tanpa akun.', vi: 'Chuyển PDF sang văn bản Markdown nhẹ. Không tải lên, không cần tài khoản.', ru: 'Конвертируйте PDF в лёгкий текст Markdown. Без загрузки, без аккаунта.', ja: 'PDFを軽量Markdownテキストに変換。アップロードなし、アカウント不要。', it: 'Converti PDF in testo Markdown leggero. Senza caricamento, senza account.', ko: 'PDF를 가벼운 Markdown 텍스트로 변환. 업로드 없음, 계정 불필요.', nl: 'Converteer PDF naar lichte Markdown-tekst. Zonder upload, zonder account.', pl: 'Konwertuj PDF do lekkiego tekstu Markdown. Bez przesyłania, bez konta.' },
    btns:   { en: '📝 Convert to Markdown', es: '📝 PDF a Markdown', pt: '📝 PDF para Markdown', de: '📝 PDF zu Markdown', fr: '📝 PDF en Markdown', tr: "📝 PDF'den Markdown'a", id: '📝 PDF ke Markdown', vi: '📝 PDF sang Markdown', ru: '📝 PDF в Markdown', ja: '📝 PDFからMarkdown', it: '📝 PDF in Markdown', ko: '📝 PDF를 Markdown으로', nl: '📝 PDF naar Markdown', pl: '📝 PDF do Markdown' },
    btn:         '📝 Convert to Markdown',
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  unlock: {
    icon:        '🔓',
    title:       'Unlock PDF',
    desc:        'Remove PDF password protection — runs in your browser, no upload',
    tags:        ['unlock pdf', 'remove password', 'remove pdf password',
                  'open protected pdf', 'decrypt pdf', 'pdf password remover'],
    titles: { en: 'Unlock PDF', es: 'Desbloquear PDF', pt: 'Desbloquear PDF', de: 'PDF entsperren', fr: 'Déverrouiller PDF', id: 'Buka Kunci PDF', vi: 'Mở Khóa PDF', ru: 'Разблокировать PDF', ja: 'PDFのロック解除', it: 'Sblocca PDF', ko: 'PDF 잠금 해제', nl: 'PDF Ontgrendelen', pl: 'Odblokuj PDF', tr: 'PDF Kilidi Aç' },
    descs:  { en: 'Remove PDF password protection — runs in your browser, no upload', es: 'Elimina la protección por contraseña localmente', pt: 'Remova a proteção por senha localmente', de: 'Passwortschutz lokal entfernen', fr: 'Supprimer la protection par mot de passe localement', id: 'Hapus proteksi kata sandi secara lokal', vi: 'Xóa bảo vệ mật khẩu cục bộ', ru: 'Снимите защиту паролем локально', ja: 'パスワード保護をローカルで削除', it: 'Rimuovi la protezione password localmente', ko: '로컬에서 비밀번호 보호 제거', nl: 'Verwijder wachtwoordbeveiliging lokaal', pl: 'Usuń zabezpieczenie hasłem lokalnie', tr: "PDF'den parola ve kısıtlamaları kaldırın" },
    btns:   { en: '🔓 Remove Password Protection', es: '🔓 Desbloquear PDF', pt: '🔓 Desbloquear PDF', de: '🔓 PDF entsperren', fr: '🔓 Déverrouiller PDF', id: '🔓 Buka Kunci PDF', vi: '🔓 Mở Khóa PDF', ru: '🔓 Разблокировать PDF', ja: '🔓 PDFのロック解除', it: '🔓 Sblocca PDF', ko: '🔓 PDF 잠금 해제', nl: '🔓 PDF Ontgrendelen', pl: '🔓 Odblokuj PDF', tr: '🔓 PDF Kilidi Aç' },
    btn:         '🔓 Remove Password Protection',
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  flatten: {
    icon:        '🔒',
    title:       'Flatten PDF',
    desc:        'Bake form fields into the page — make PDF non-editable',
    tags:        ['flatten', 'lock form', 'non-editable', 'bake fields', 'lock pdf',
                  'freeze form', 'lock fields', 'make non editable', 'remove form fields'],
    titles: { en: 'Flatten PDF', es: 'Aplanar PDF', pt: 'Nivelar PDF', de: 'PDF glätten', fr: 'Aplatir PDF', id: 'Ratakan PDF', vi: 'Làm Phẳng PDF', ru: 'Уплощить PDF', ja: 'PDFを平坦化', it: 'Appiattisci PDF', ko: 'PDF 평면화', nl: 'PDF Afvlakken', pl: 'Spłaszcz PDF', tr: 'PDF Düzleştir' },
    descs:  { en: 'Bake form fields into the page — make PDF non-editable', es: 'Incrusta campos de formulario — hace el PDF no editable', pt: 'Incorpora campos de formulário — torna o PDF não editável', de: 'Formularfelder einbetten — PDF nicht bearbeitbar machen', fr: 'Intégrer les champs de formulaire — rendre le PDF non modifiable', id: 'Tanam kolom formulir ke halaman — cegah pengeditan', vi: 'Nhúng trường biểu mẫu vào trang — ngăn chỉnh sửa', ru: 'Встройте поля формы в страницу — предотвратите редактирование', ja: 'フォームフィールドをページに焼き付け — 編集を防止', it: 'Incorpora i campi del modulo nella pagina — impedisci la modifica', ko: '양식 필드를 페이지에 영구 반영 — 편집 방지', nl: 'Bak formuliervelden in de pagina — voorkom bewerking', pl: 'Wpisz pola formularza na stałe w stronę — zapobiegaj edycji', tr: 'PDF form alanlarını kalıcı olarak kilitleyin' },
    btns:   { en: '🔒 Lock PDF Form', es: '🔒 Bloquear formulario', pt: '🔒 Bloquear formulário', de: '🔒 Formular sperren', fr: '🔒 Verrouiller le formulaire', id: '🔒 Ratakan PDF', vi: '🔒 Làm Phẳng PDF', ru: '🔒 Уплощить PDF', ja: '🔒 PDFを平坦化', it: '🔒 Appiattisci PDF', ko: '🔒 PDF 평면화', nl: '🔒 PDF Afvlakken', pl: '🔒 Spłaszcz PDF', tr: '🔒 PDF Düzleştir' },
    btn:         '🔒 Lock PDF Form',
    multi:       false,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
  compare: {
    icon:        '⚖️',
    title:       'Compare PDF',
    desc:        'Compare two PDFs and highlight differences — 100% private, no upload',
    tags:        ['compare', 'diff', 'difference', 'changes', 'compare pdfs', 'compare two pdfs',
                  'find changes', 'document comparison', 'pdf diff', 'highlight differences'],
    titles: { en: 'Compare PDF', es: 'Comparar PDF', pt: 'Comparar PDF', de: 'PDF vergleichen', fr: 'Comparer des PDF', id: 'Bandingkan PDF', vi: 'So Sánh PDF', ru: 'Сравнить PDF', ja: 'PDFを比較', it: 'Confronta PDF', ko: 'PDF 비교', nl: "PDF's vergelijken", pl: 'Porównaj PDF', tr: 'PDF Karşılaştır' },
    descs:  { en: 'Compare two PDFs and highlight differences — 100% private, no upload', es: 'Compara dos PDFs y resalta las diferencias — 100% privado, sin subida', pt: 'Compare dois PDFs e destaque as diferenças — 100% privado, sem upload', de: 'Vergleiche zwei PDFs und markiere Unterschiede — 100 % privat, kein Upload', fr: 'Comparez deux PDF et mettez en évidence les différences — 100 % privé, sans upload', id: 'Bandingkan dua PDF dan soroti perbedaannya — 100% privat, tanpa unggah', vi: 'So sánh hai PDF và làm nổi bật sự khác biệt — 100% riêng tư, không tải lên', ru: 'Сравните два PDF и выделите различия — 100% приватно, без загрузки', ja: '2つのPDFを比較して差分をハイライト — 100%プライベート、アップロード不要', it: 'Confronta due PDF ed evidenzia le differenze — 100% privato, senza upload', ko: '두 PDF를 비교하고 차이점을 강조 표시 — 100% 비공개, 업로드 없음', nl: "Vergelijk twee PDF's en markeer verschillen — 100% privé, geen upload", pl: 'Porównaj dwa pliki PDF i wyróżnij różnice — 100% prywatnie, bez przesyłania', tr: "İki PDF'i karşılaştırın ve farkları vurgulayın — %100 gizli, yükleme yok" },
    btns:   { en: '⚖️ Compare PDFs', es: '⚖️ Comparar PDFs', pt: '⚖️ Comparar PDFs', de: '⚖️ PDFs vergleichen', fr: '⚖️ Comparer les PDF', id: '⚖️ Bandingkan PDF', vi: '⚖️ So Sánh PDF', ru: '⚖️ Сравнить PDF', ja: '⚖️ PDFを比較', it: '⚖️ Confronta PDF', ko: '⚖️ PDF 비교', nl: "⚖️ PDF's vergelijken", pl: '⚖️ Porównaj PDF', tr: "⚖️ PDF'leri Karşılaştır" },
    btn:         '⚖️ Compare PDFs',
    multi:       true,
    accept:      '.pdf,application/pdf',
    implemented: true,
  },
};
