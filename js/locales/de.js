// SPDX-License-Identifier: AGPL-3.0-only
// German (DE) UI strings — loaded before app.js on /de/ pages
// Sets window.PDFREE_LOCALE which i18n.js merges over EN defaults.
window.PDFREE_LOCALE = {
  // app
  wait_processing:  '⏳ Bitte warten, bis die Verarbeitung abgeschlossen ist',
  coming_soon:      '🚧 Demnächst verfügbar!',
  done_time:        '⚡ Fertig in {time}s — lokal verarbeitet, kein Upload',
  done_no_time:     '⚡ Lokal verarbeitet — deine Dateien haben dein Gerät nie verlassen',
  saved_device:     '✓ Auf Gerät gespeichert',
  sent:             '✓ Gesendet',
  process_again:    '↺ Erneut verarbeiten',
  download_again:      '⬇ Erneut herunterladen',
  auto_download_hint:  'Ihr Download sollte automatisch starten.',

  // files
  split_one_only:  'Split funktioniert nur mit einer PDF. Bitte zuerst die aktuelle Datei entfernen.',
  invalid_pdf:     'Bitte eine PDF-Datei auswählen — Dateien-App öffnen, nicht Fotos oder Kamera',
  invalid_img:     'Bitte ein JPG- oder PNG-Bild auswählen',
  dupe_skip_one:   '{n} Duplikat übersprungen',
  dupe_skip_many:  '{n} Duplikate übersprungen',
  not_valid_pdf:   '⚠️ „{name}" ist keine gültige PDF-Datei',
  aes_help:        '🔒 {ver}-verschlüsseltes PDF — ohne Eigentümer-Passwort nicht verarbeitbar. {restricted} Lösung: 1) In Adobe Acrobat öffnen. 2) Datei → Eigenschaften → Sicherheit. 3) Sicherheitsmethode: Keine Sicherheit → Speichern. Dann hier erneut hochladen.',

  // ui
  btn_processing:   '⏳ Wird verarbeitet...',
  drop_mobile_hint: 'Dateien-App öffnen und eine PDF auswählen — nicht Fotos oder Kamera',

  // progress
  cancelled:         'Verarbeitung abgebrochen',
  prog_reading:      'Dateien werden gelesen...',
  prog_merging:      'Wird zusammengeführt...',
  prog_done:         'Fertig!',
  prog_loading_pdf:  'PDF wird geladen...',
  prog_loading_imgs: 'Bilder werden geladen...',
  prog_packaging:    'Wird verpackt...',
  prog_zip:          'ZIP wird erstellt...',
  prog_compressing:  'Wird komprimiert...',
  prog_processing:   'Wird verarbeitet...',
  prog_rendering:    'Seite {i} von {n} wird gerendert...',
  prog_watermark:    'Wasserzeichen wird angewendet...',
  prog_pagenum:      'Seitenzahlen werden hinzugefügt...',
  prog_meta:         'Metadaten werden aktualisiert...',
  prog_protect:      'PDF wird verschlüsselt...',
  prog_rotate:       'Drehungen werden angewendet...',
  prog_flatten:      'Formularfelder werden fixiert...',
  prog_redact:       'Bereiche werden abgedeckt...',

  // success descriptions
  desc_merged_partial:      '{n} von {total} Dateien zusammengeführt · {pages} Seiten · {size}',
  desc_merged:              '{total} Dateien zusammengeführt · {pages} Seiten · {size}',
  desc_compress_saved:      'Komprimiert · lokal verarbeitet · kein Upload',
  desc_compress_optimized:  'Bereits optimiert · lokal verarbeitet · kein Upload',
  desc_watermark:           'Wasserzeichen hinzugefügt · {pages} Seiten · {size}',
  desc_pagenum:             'Seitenzahlen hinzugefügt · {pages} Seiten · {size}',
  desc_meta:                'Metadaten aktualisiert · {pages} Seiten · {size}',
  desc_protect:             'AES-256 geschützt · {pages} Seiten · {size}{extra}',
  desc_rotate:              'Gedreht · {pages} Seiten · {size}',
  desc_redact:              'Bereiche abgedeckt · {pages} Seiten · {size}',
  desc_fill:                'Formular ausgefüllt · {pages} Seiten · {size}',
  desc_flatten:             'Felder gesperrt · {pages} Seiten · {size}',
  warn_xfa_form:            'ℹ️ Keine bearbeitbaren Felder gefunden — Datei unverändert zurückgegeben. XFA-Formulare erfordern Adobe Acrobat.',
  desc_split_single:        '{n} Seite extrahiert · {size}',
  desc_split_single_many:   '{n} Seiten extrahiert · {size}',
  desc_split_separate:      'In {n} Datei aufgeteilt · {size}',
  desc_split_separate_many: 'In {n} Dateien aufgeteilt · {size}',
  desc_pdf2jpg_one:         '1 Seite · {ext} · {size}',
  desc_pdf2jpg_many:        '{n} {ext}-Bilder · {size}',

  // word units
  word_page:   'Seite',
  word_pages:  'Seiten',
  word_image:  'Bild',
  word_images: 'Bilder',

  // toasts / warnings
  skipped_files_one:   '⚠️ {n} Datei übersprungen: {labels}',
  skipped_files_many:  '⚠️ {n} Dateien übersprungen: {labels}',
  hint_protected:      ' (passwortgeschützt)',
  hint_corrupted:      ' (beschädigt)',
  more_files:          '+{n} weitere',
  warn_encrypted_pdf:  '⚠️ Verschlüsseltes PDF wurde mit Einschränkungen verarbeitet',
  skipped_imgs_one:    '⚠️ {n} Bild übersprungen (konnte nicht dekodiert werden): #{nums}',
  skipped_imgs_many:   '⚠️ {n} Bilder übersprungen (konnten nicht dekodiert werden): #{nums}',
  warn_large_export:   '⏳ Großer Export ({n} Seiten bei {dpi} DPI) — Verarbeitung kann einen Moment dauern.',
  warn_page_fail:      '⚠️ Seite {page} fehlgeschlagen: {msg}',
  already_protected:   'ℹ️ Datei war bereits geschützt — Passwort aktualisiert',
  warn_file_too_large:  '⚠️ Datei ist {size} — der Browser verarbeitet PDFs im Arbeitsspeicher, Limit: {max} MB. Tipp: PDF zuerst aufteilen, dann jeden Teil verarbeiten.',
  warn_total_too_large: '⚠️ Gesamtgröße ist {size} — Browser-Limit: {max} MB. Entfernen Sie einige Dateien.',

  // splitUI
  no_pages_pdf:             'Diese PDF hat keine Seiten',
  warn_large_pdf:           '⚠️ Große PDF ({n} Seiten) — Verarbeitung kann dauern',
  split_info_page:          '{n} Seite',
  split_info_pages:         '{n} Seiten',
  split_mode_separate:      'Einzelne Dateien',
  split_mode_separate_desc: 'Jede Seite → eigene PDF',
  split_mode_single:        'Eine Datei',
  split_mode_single_desc:   'Ausgewählte Seiten → eine PDF',
  split_pages_label:        'Zu extrahierende Seiten',
  err_read_pages:           'PDF-Seiten konnten nicht gelesen werden: {msg}',
  select_all:               'Alle auswählen',
  deselect_all:             'Alle abwählen',
  select_all_short:         'Alle',
  deselect_all_short:       'Keine',
  pages_selected:           '{n} von {total} Seiten ausgewählt',
  invalid_range:            'Ungültiger Bereich — keine gültigen Seiten gefunden',
  split_btn_separate:       '✂️ In {n} Datei aufteilen',
  split_btn_separate_many:  '✂️ In {n} Dateien aufteilen',
  split_btn_single:         '📄 {n} Seite extrahieren',
  split_btn_single_many:    '📄 {n} Seiten extrahieren',
  split_btn_disabled:       '✂️ Seiten zum Aufteilen auswählen',

  // pdf2jpgUI
  err_pdf_engine: 'PDF-Engine konnte nicht geladen werden. Bitte Internetverbindung prüfen.',
  retry:          '⟳ Erneut versuchen',

  // ocrUI
  install_ocr_first:   'Bitte zuerst die OCR-Engine installieren — klicke auf „OCR PDF installieren"',

  // errors
  no_pages_selected:   'Keine gültigen Seiten ausgewählt',
  err_no_render:       'Keine Seiten konnten erfolgreich gerendert werden',
  err_no_renderer:     'PDF-Renderer nicht geladen — bitte Tool neu öffnen',
  err_enc_unavailable: 'Verschlüsselungsbibliothek konnte nicht geladen werden. Bitte Seite neu laden.',
  err_enc_failed:      'Verschlüsselung fehlgeschlagen. Das PDF-Format wird möglicherweise nicht unterstützt.',
  err_encrypted_pdf:   'Diese PDF ist passwortgeschützt oder hat Bearbeitungseinschränkungen. Bitte zuerst das Passwort entfernen (mit Acrobat) und erneut versuchen.',
  err_compress_timeout: '⏱ Komprimierung abgebrochen — die Datei enthält zu viele Bilder für den Browser. Versuche das Light-Preset oder teile die PDF zuerst auf.',
  warn_compress_large:  '⚠️ Große Datei ({size}) — Komprimierung kann 1–2 Minuten dauern. Der Browser verarbeitet alles lokal im Arbeitsspeicher.',
  compress_scan_skipped: 'Große Datei — Vorabscan übersprungen, um Speicher zu sparen',
  error_msg:           'Fehler: {msg}',

  // search
  search_placeholder: 'PDF zusammenfügen, komprimieren, drehen, Wasserzeichen, PDF zu Word…',
  search_aria:        'PDF-Tools suchen',
  search_drop:        'oder PDF hier ablegen',
  search_start:       'Starten →',
  search_miss:        'Kein Tool für „{q}" gefunden — versuche „zusammenfügen", „komprimieren" oder „aufteilen"',

  // hero drop zone
  hero_drop:          'PDF hier ablegen',
  hero_or:            'oder',
  hero_drop_choose:   'Datei wählen',
  hero_file_single:   '{name} ({size})',
  hero_file_multi:    '{n} PDFs ausgewählt',
  hero_or_search:     'oder nach Name suchen',
  hero_pick_which:    'welche Datei?',
  hero_pick_back:     '← Zurück',
  hero_hint_multi:    'Empfohlen: {tool}',
  hero_chip_one_file: '1 Datei',
  hero_img_hint:      '🖼️ Haben Sie ein Bild?',
};
