// SPDX-License-Identifier: AGPL-3.0-only
// Spanish (ES) UI strings — loaded before app.js on /es/ pages
window.PDFREE_LOCALE = {
  // app
  wait_processing:  '⏳ Por favor espera a que termine el procesamiento',
  coming_soon:      '🚧 ¡Próximamente!',
  done_time:        '⚡ Listo en {time}s — procesado localmente, sin cargas',
  done_no_time:     '⚡ Procesado localmente — tus archivos nunca salieron de tu dispositivo',
  saved_device:     '✓ Guardado en el dispositivo',
  sent:             '✓ Enviado',
  process_again:    '↺ Procesar de nuevo',

  // files
  split_one_only:  'Split funciona con un solo PDF. Elimina el archivo actual primero.',
  invalid_pdf:     'Por favor selecciona un archivo PDF — abre la app de Archivos, no Fotos o Cámara',
  invalid_img:     'Por favor selecciona una imagen JPG o PNG',
  dupe_skip_one:   '{n} duplicado omitido',
  dupe_skip_many:  '{n} duplicados omitidos',
  not_valid_pdf:   '⚠️ "{name}" no es un archivo PDF válido',
  aes_help:        '🔒 PDF cifrado con {ver} — no se puede procesar sin la contraseña del propietario. {restricted} Solución: 1) Abre en Adobe Acrobat. 2) Archivo → Propiedades → Seguridad. 3) Método de seguridad: Sin seguridad → Guardar. Luego vuelve a subir aquí.',

  // ui
  btn_processing:   '⏳ Procesando...',
  drop_mobile_hint: 'Abre la app de Archivos y selecciona un PDF — no Fotos o Cámara',

  // progress
  cancelled:         'Procesamiento cancelado',
  prog_reading:      'Leyendo archivos...',
  prog_merging:      'Combinando...',
  prog_done:         '¡Listo!',
  prog_loading_pdf:  'Cargando PDF...',
  prog_loading_imgs: 'Cargando imágenes...',
  prog_packaging:    'Empaquetando...',
  prog_zip:          'Creando ZIP...',
  prog_compressing:  'Comprimiendo...',
  prog_processing:   'Procesando...',
  prog_rendering:    'Renderizando página {i} de {n}...',
  prog_watermark:    'Aplicando marca de agua...',
  prog_pagenum:      'Añadiendo números de página...',
  prog_meta:         'Actualizando metadatos...',
  prog_protect:      'Cifrando PDF...',
  prog_rotate:       'Aplicando rotaciones...',
  prog_flatten:      'Bloqueando campos del formulario...',
  prog_redact:       'Cubriendo áreas...',

  // success descriptions
  desc_merged_partial:      'Combinados {n} de {total} archivos · {pages} páginas · {size}',
  desc_merged:              '{total} archivos combinados · {pages} páginas · {size}',
  desc_compress_saved:      'Comprimido · procesado localmente · sin subida',
  desc_compress_optimized:  'Ya optimizado · procesado localmente · sin subida',
  desc_watermark:           'Marca de agua añadida · {pages} páginas · {size}',
  desc_pagenum:             'Números de página añadidos · {pages} páginas · {size}',
  desc_meta:                'Metadatos actualizados · {pages} páginas · {size}',
  desc_protect:             'Protegido con AES-256 · {pages} páginas · {size}{extra}',
  desc_rotate:              'Rotado · {pages} páginas · {size}',
  desc_redact:              'Áreas cubiertas · {pages} páginas · {size}',
  desc_fill:                'Formulario completado · {pages} páginas · {size}',
  desc_flatten:             'Campos bloqueados · {pages} páginas · {size}',
  warn_xfa_form:            'ℹ️ No se encontraron campos editables — archivo devuelto sin cambios. Los formularios XFA requieren Adobe Acrobat.',
  desc_split_single:        '{n} página extraída · {size}',
  desc_split_single_many:   '{n} páginas extraídas · {size}',
  desc_split_separate:      'Dividido en {n} archivo · {size}',
  desc_split_separate_many: 'Dividido en {n} archivos · {size}',
  desc_pdf2jpg_one:         '1 página · {ext} · {size}',
  desc_pdf2jpg_many:        '{n} imágenes {ext} · {size}',

  // word units
  word_page:   'página',
  word_pages:  'páginas',
  word_image:  'imagen',
  word_images: 'imágenes',

  // toasts / warnings
  skipped_files_one:   '⚠️ {n} archivo omitido: {labels}',
  skipped_files_many:  '⚠️ {n} archivos omitidos: {labels}',
  hint_protected:      ' (protegido con contraseña)',
  hint_corrupted:      ' (dañado)',
  more_files:          '+{n} más',
  warn_encrypted_pdf:  '⚠️ El PDF cifrado se procesó con limitaciones',
  skipped_imgs_one:    '⚠️ {n} imagen omitida (no se pudo decodificar): #{nums}',
  skipped_imgs_many:   '⚠️ {n} imágenes omitidas (no se pudieron decodificar): #{nums}',
  warn_large_export:   '⏳ Exportación grande ({n} páginas a {dpi} DPI) — el procesamiento puede tardar.',
  warn_page_fail:      '⚠️ Página {page} fallida: {msg}',
  already_protected:   'ℹ️ El archivo ya estaba protegido — contraseña actualizada',
  warn_file_too_large:  '⚠️ El archivo pesa {size} — el navegador procesa PDFs en RAM, límite: {max} MB. Consejo: divide el PDF primero y procesa cada parte.',
  warn_total_too_large: '⚠️ Tamaño total: {size} — límite del navegador: {max} MB. Elimina algunos archivos para continuar.',

  // splitUI
  no_pages_pdf:             'Este PDF no tiene páginas',
  warn_large_pdf:           '⚠️ PDF grande ({n} páginas) — el procesamiento puede tardar',
  split_info_page:          '{n} página',
  split_info_pages:         '{n} páginas',
  split_mode_separate:      'Archivos separados',
  split_mode_separate_desc: 'Cada página → PDF individual',
  split_mode_single:        'Un archivo',
  split_mode_single_desc:   'Páginas seleccionadas → un PDF',
  split_pages_label:        'Páginas a extraer',
  err_read_pages:           'No se pudieron leer las páginas del PDF: {msg}',
  select_all:               'Seleccionar todo',
  deselect_all:             'Deseleccionar todo',
  select_all_short:         'Todo',
  deselect_all_short:       'Ninguno',
  pages_selected:           '{n} de {total} páginas seleccionadas',
  invalid_range:            'Rango inválido — no se encontraron páginas válidas',
  split_btn_separate:       '✂️ Dividir en {n} archivo',
  split_btn_separate_many:  '✂️ Dividir en {n} archivos',
  split_btn_single:         '📄 Extraer {n} página',
  split_btn_single_many:    '📄 Extraer {n} páginas',
  split_btn_disabled:       '✂️ Selecciona páginas para dividir',

  // pdf2jpgUI
  err_pdf_engine: 'El motor PDF no pudo cargarse. Comprueba tu conexión a internet.',
  retry:          '⟳ Intentar de nuevo',

  // ocrUI
  install_ocr_first:   'Instala primero el motor OCR — haz clic en "Instalar OCR PDF"',

  // errors
  no_pages_selected:   'No hay páginas válidas seleccionadas',
  err_no_render:       'Ninguna página se renderizó correctamente',
  err_no_renderer:     'Renderizador PDF no cargado — por favor reabre la herramienta',
  err_enc_unavailable: 'La biblioteca de cifrado no pudo cargarse. Por favor recarga la página.',
  err_enc_failed:      'Cifrado fallido. El PDF puede estar en un formato no compatible.',
  err_encrypted_pdf:   'Este PDF está protegido con contraseña o tiene restricciones de edición. Elimina la contraseña primero y vuelve a intentarlo.',
  err_compress_timeout: '⏱ Compresión cancelada — el archivo tiene demasiadas imágenes para el navegador. Prueba el preset Light o divide el PDF primero.',
  warn_compress_large:  '⚠️ Archivo grande ({size}) — la compresión puede tardar 1–2 minutos. El navegador lo procesa todo localmente en memoria.',
  compress_scan_skipped: 'Archivo grande — pre-escaneo omitido para ahorrar memoria',
  error_msg:           'Error: {msg}',

  // search
  search_placeholder: 'unir PDF, comprimir, PDF a Word…',
  search_aria:        'Buscar herramientas PDF',
  search_drop:        'o arrastra un PDF aquí',
  search_choose:      'Elegir archivo →',
  search_miss:        'No se encontró herramienta para "{q}" — prueba "unir", "comprimir" o "dividir"',
};
