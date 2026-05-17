#!/usr/bin/env python3
"""
PDFree Localization Generator
Generates correct localized index.html files for de/es/fr/pt
based on EN structure, with full translations.

This ensures:
- All locales have IDENTICAL HTML structure
- All locales have CORRECT CSS class names (tool-icon-wrapper, not tool-icon)
- All locales have ALL sections (trust-alert, no-limit-bar, privacy-bar, main, etc)
- All locales have CORRECT script paths (../js/app.js for nested locales)
- All locales have proper SEO meta tags and hreflang
"""

import re
import os
import sys

# ════════════════════════════════════════════════════════════════
# TRANSLATIONS — full text dictionary for each locale
# ════════════════════════════════════════════════════════════════

TRANSLATIONS = {
    'en': {
        'lang': 'en',
        'locale': 'en_US',
        'base_path': '/',
        'title': 'PDFree — Free PDF Tools, No Limits',
        'description': 'Private PDF tools: merge, split, compress, watermark, add page numbers, extract pages, edit metadata. All processing in your browser — files never uploaded. Free, no limits, no signup.',
        'keywords': 'merge pdf, split pdf, compress pdf, pdf tools free, combine pdf files, private pdf, no upload pdf, client-side pdf, watermark pdf, page numbers pdf, extract pages pdf, pdf metadata editor',
        'og_title': 'PDFree — Private PDF Tools, Free Forever',
        'og_description': 'Merge, split, compress, watermark PDF files. 100% private — files never leave your device. No signup, no limits.',
        
        'go_home': 'Go to homepage',
        'nav': {
            'merge': 'Merge',
            'split': 'Split',
            'compress': 'Compress',
            'jpg2pdf': 'JPG→PDF',
            'watermark': 'Watermark',
            'meta': 'Metadata',
            'protect': 'Protect',
        },
        
        'hero_badge': '🔒 100% private · no upload · no signup · no limits',
        'hero_h1_1': 'PDF tools that',
        'hero_h1_em': 'actually work',
        'hero_p': 'Merge, split, compress, watermark, convert — everything runs <strong>in your browser</strong>. Your files never leave your device. No server. No account. Just results.',
        
        'feature_private': '100% Private',
        'feature_private_sub': 'Files never leave your device',
        'feature_fast': 'Blazing Fast',
        'feature_fast_sub': 'Works instantly, offline',
        'feature_nolimit': 'No Limits',
        'feature_nolimit_sub': 'No file size or daily limits',
        
        'trust_alert_label': 'Privacy promise',
        'trust_alert_strong': 'Your files stay on your device.',
        'trust_alert_text': 'We use Web Workers and client-side libraries — nothing is ever sent to any server.',
        
        'nolimit_files': 'No file limits',
        'nolimit_watermarks': 'No watermarks added',
        'nolimit_signup': 'No signup required',
        'nolimit_leave': 'Files never leave your device',
        
        'all_tools': 'All tools',
        
        'tool_merge': 'Merge PDF',
        'tool_merge_desc': 'Combine any number of PDFs — no restrictions',
        'tool_split': 'Split PDF',
        'tool_split_desc': 'Extract pages or split into separate files instantly',
        'tool_compress': 'Compress PDF',
        'tool_compress_desc': 'Reduce file size without losing quality — locally',
        'tool_jpg2pdf': 'JPG to PDF',
        'tool_jpg2pdf_desc': 'Convert your images to a single PDF instantly',
        'tool_pdf2jpg': 'PDF to JPG',
        'tool_pdf2jpg_desc': 'Extract pages as high-quality images',
        'tool_extract': 'Extract Pages',
        'tool_extract_desc': 'Pull selected pages into a new clean PDF',
        'tool_watermark': 'Watermark',
        'tool_watermark_desc': 'Stamp text on every page — diagonal or tiled',
        'tool_pagenum': 'Page Numbers',
        'tool_pagenum_desc': 'Add numbered footers — Arabic, Roman or ABC',
        'tool_meta': 'Edit Metadata',
        'tool_meta_desc': 'View and edit title, author, and keywords',
        'tool_redact': 'Cover Area',
        'tool_redact_desc': 'Hide watermarks, signatures or sensitive data locally',
        'tool_rotate': 'Rotate PDF',
        'tool_rotate_desc': 'Fix page orientation visually in any PDF',
        'tool_protect': 'Protect PDF',
        'tool_protect_desc': 'AES-256 password & permissions — 100% private',
        
        'privacy_bar_label': 'Privacy guarantee',
        'privacy_bar_1_strong': '100% private by design',
        'privacy_bar_1_p': 'Your files are processed entirely in your browser. Zero uploads — ever.',
        'privacy_bar_2_strong': 'Runs on your device',
        'privacy_bar_2_p': 'All PDF operations run inside a Web Worker — a sandboxed thread in your own hardware.',
        'privacy_bar_3_strong': 'Instantly forgotten',
        'privacy_bar_3_p': 'Files live only in RAM. Close the tab and they vanish — no logs, no traces.',
        
        'tool_header_title': 'Merge PDF',
        'tool_header_desc': 'Combine unlimited PDF files — no restrictions',
        'drop_files_label': 'Upload files — click or drag and drop',
        'drop_title': 'Drop files here',
        'drop_sub': 'or click to browse — any number of files',
        'choose_files': 'Choose files',
        'reorder_hint': '↕ Drag to reorder files before merging',
        'merge_btn': '🔗 Merge PDF files',
        'cancel_btn': '✕ Cancel',
        'cancel_aria': 'Cancel processing',
        'done': 'Done!',
        'pwa_text': '⚡ Install for instant access — works offline',
        'pwa_install': 'Install app',
        'pwa_dismiss': 'Dismiss',
        
        'footer_main': 'All processing happens 100% in your browser',
        'footer_main_2': 'never uploaded',
        'footer_lock': 'Your documents never leave your device',
        'footer_heart': 'Built to be free for everyone, forever',
        'footer_privacy': 'Privacy',
        'footer_terms': 'Terms',
        'footer_github': 'GitHub',
    },
    
    'de': {
        'lang': 'de',
        'locale': 'de_DE',
        'base_path': '/de/',
        'title': 'PDFree — Kostenlose PDF-Tools, Keine Limits',
        'description': 'Private PDF-Tools: zusammenfügen, aufteilen, komprimieren, Wasserzeichen, Seitenzahlen, Seiten extrahieren, Metadaten bearbeiten. Alles im Browser — Dateien werden nie hochgeladen. Kostenlos, keine Limits, keine Anmeldung.',
        'keywords': 'pdf zusammenfügen, pdf aufteilen, pdf komprimieren, kostenlose pdf-tools, pdf dateien zusammenführen, privates pdf, pdf ohne upload, client-side pdf, pdf wasserzeichen, pdf seitenzahlen, pdf-metadaten-editor',
        'og_title': 'PDFree — Private PDF-Tools, für immer kostenlos',
        'og_description': 'PDFs zusammenfügen, aufteilen, komprimieren, Wasserzeichen. 100 % privat — Dateien verlassen nie dein Gerät. Keine Anmeldung, keine Limits.',
        
        'go_home': 'Zur Startseite',
        'nav': {
            'merge': 'Zusammenfügen',
            'split': 'Aufteilen',
            'compress': 'Komprimieren',
            'jpg2pdf': 'JPG→PDF',
            'watermark': 'Wasserzeichen',
            'meta': 'Metadaten',
            'protect': 'Schützen',
        },
        
        'hero_badge': '🔒 100 % privat · kein Upload · kein Konto · keine Limits',
        'hero_h1_1': 'PDF-Werkzeuge, die',
        'hero_h1_em': 'wirklich funktionieren',
        'hero_p': 'Zusammenfügen, aufteilen, komprimieren, Wasserzeichen, konvertieren — alles läuft <strong>in deinem Browser</strong>. Deine Dateien verlassen nie dein Gerät. Kein Server. Kein Konto. Nur Ergebnisse.',
        
        'feature_private': '100 % privat',
        'feature_private_sub': 'Dateien verlassen nie dein Gerät',
        'feature_fast': 'Blitzschnell',
        'feature_fast_sub': 'Sofort einsatzbereit, offline',
        'feature_nolimit': 'Keine Limits',
        'feature_nolimit_sub': 'Keine Dateigröße- oder Tageslimits',
        
        'trust_alert_label': 'Datenschutzversprechen',
        'trust_alert_strong': 'Deine Dateien bleiben auf deinem Gerät.',
        'trust_alert_text': 'Wir verwenden Web Workers und clientseitige Bibliotheken — nichts wird jemals an einen Server gesendet.',
        
        'nolimit_files': 'Keine Datei-Limits',
        'nolimit_watermarks': 'Keine Wasserzeichen',
        'nolimit_signup': 'Keine Anmeldung nötig',
        'nolimit_leave': 'Dateien verlassen nie dein Gerät',
        
        'all_tools': 'Alle Werkzeuge',
        
        'tool_merge': 'PDF Zusammenfügen',
        'tool_merge_desc': 'Beliebig viele PDFs kombinieren — ohne Einschränkungen',
        'tool_split': 'PDF Aufteilen',
        'tool_split_desc': 'Seiten extrahieren oder in Einzeldateien aufteilen',
        'tool_compress': 'PDF Komprimieren',
        'tool_compress_desc': 'Dateigröße reduzieren ohne Qualitätsverlust — lokal',
        'tool_jpg2pdf': 'JPG zu PDF',
        'tool_jpg2pdf_desc': 'Bilder sofort in ein PDF umwandeln',
        'tool_pdf2jpg': 'PDF zu JPG',
        'tool_pdf2jpg_desc': 'Seiten als hochwertige Bilder exportieren',
        'tool_extract': 'Seiten Extrahieren',
        'tool_extract_desc': 'Ausgewählte Seiten als neues PDF speichern',
        'tool_watermark': 'Wasserzeichen',
        'tool_watermark_desc': 'Text auf jeder Seite stempeln — diagonal oder als Kachel',
        'tool_pagenum': 'Seitenzahlen',
        'tool_pagenum_desc': 'Seitenzahlen einfügen — arabisch, römisch oder alphabetisch',
        'tool_meta': 'Metadaten Bearbeiten',
        'tool_meta_desc': 'Titel, Autor und Schlüsselwörter ansehen und bearbeiten',
        'tool_redact': 'PDF Schwärzen',
        'tool_redact_desc': 'Wasserzeichen, Unterschriften oder sensible Daten lokal verbergen',
        'tool_rotate': 'PDF Drehen',
        'tool_rotate_desc': 'Seitenausrichtung in beliebigen PDFs korrigieren',
        'tool_protect': 'PDF Schützen',
        'tool_protect_desc': 'AES-256-Passwort und Berechtigungen — 100 % privat',
        
        'privacy_bar_label': 'Datenschutzgarantie',
        'privacy_bar_1_strong': '100 % privat by design',
        'privacy_bar_1_p': 'Deine Dateien werden vollständig in deinem Browser verarbeitet. Null Uploads — nie.',
        'privacy_bar_2_strong': 'Läuft auf deinem Gerät',
        'privacy_bar_2_p': 'Alle PDF-Operationen laufen in einem Web Worker — ein gesicherter Thread in deiner eigenen Hardware.',
        'privacy_bar_3_strong': 'Sofort vergessen',
        'privacy_bar_3_p': 'Dateien existieren nur im RAM. Tab schließen und sie verschwinden — keine Protokolle, keine Spuren.',
        
        'tool_header_title': 'PDF Zusammenfügen',
        'tool_header_desc': 'Unbegrenzte PDF-Dateien kombinieren — ohne Einschränkungen',
        'drop_files_label': 'Dateien hochladen — klicken oder ziehen und ablegen',
        'drop_title': 'Dateien hier ablegen',
        'drop_sub': 'oder klicken, um zu durchsuchen — beliebig viele Dateien',
        'choose_files': 'Dateien auswählen',
        'reorder_hint': '↕ Ziehen, um Dateien vor dem Zusammenfügen neu zu sortieren',
        'merge_btn': '🔗 PDF-Dateien zusammenfügen',
        'cancel_btn': '✕ Abbrechen',
        'cancel_aria': 'Verarbeitung abbrechen',
        'done': 'Fertig!',
        'pwa_text': '⚡ Installieren für sofortigen Zugriff — funktioniert offline',
        'pwa_install': 'App installieren',
        'pwa_dismiss': 'Schließen',
        
        'footer_main': 'Alle Verarbeitung erfolgt zu 100 % in deinem Browser',
        'footer_main_2': 'nie hochgeladen',
        'footer_lock': 'Deine Dokumente verlassen nie dein Gerät',
        'footer_heart': 'Erstellt, um für immer kostenlos zu bleiben',
        'footer_privacy': 'Datenschutz',
        'footer_terms': 'AGB',
        'footer_github': 'GitHub',
    },
    
    'es': {
        'lang': 'es',
        'locale': 'es_ES',
        'base_path': '/es/',
        'title': 'PDFree — Herramientas PDF Gratis, Sin Límites',
        'description': 'Herramientas PDF privadas: unir, dividir, comprimir, marca de agua, números de página, extraer páginas, editar metadatos. Todo en tu navegador — los archivos nunca se suben. Gratis, sin límites, sin registro.',
        'keywords': 'unir pdf, dividir pdf, comprimir pdf, herramientas pdf gratis, combinar archivos pdf, pdf privado, pdf sin subir, pdf client-side, marca de agua pdf, números de página pdf, editor metadatos pdf',
        'og_title': 'PDFree — Herramientas PDF Privadas, Gratis para Siempre',
        'og_description': 'Une, divide, comprime, marca de agua en archivos PDF. 100% privado — los archivos nunca salen de tu dispositivo. Sin registro, sin límites.',
        
        'go_home': 'Ir a inicio',
        'nav': {
            'merge': 'Unir',
            'split': 'Dividir',
            'compress': 'Comprimir',
            'jpg2pdf': 'JPG→PDF',
            'watermark': 'Marca de agua',
            'meta': 'Metadatos',
            'protect': 'Proteger',
        },
        
        'hero_badge': '🔒 100% privado · sin subidas · sin registro · sin límites',
        'hero_h1_1': 'Herramientas PDF que',
        'hero_h1_em': 'realmente funcionan',
        'hero_p': 'Unir, dividir, comprimir, marca de agua, convertir — todo se ejecuta <strong>en tu navegador</strong>. Tus archivos nunca salen de tu dispositivo. Sin servidor. Sin cuenta. Solo resultados.',
        
        'feature_private': '100% Privado',
        'feature_private_sub': 'Los archivos nunca salen de tu dispositivo',
        'feature_fast': 'Súper Rápido',
        'feature_fast_sub': 'Funciona al instante, sin conexión',
        'feature_nolimit': 'Sin Límites',
        'feature_nolimit_sub': 'Sin límites de tamaño o uso diario',
        
        'trust_alert_label': 'Promesa de privacidad',
        'trust_alert_strong': 'Tus archivos permanecen en tu dispositivo.',
        'trust_alert_text': 'Usamos Web Workers y bibliotecas del lado cliente — nada se envía nunca a ningún servidor.',
        
        'nolimit_files': 'Sin límites de archivos',
        'nolimit_watermarks': 'Sin marcas de agua añadidas',
        'nolimit_signup': 'Sin registro requerido',
        'nolimit_leave': 'Los archivos nunca salen de tu dispositivo',
        
        'all_tools': 'Todas las herramientas',
        
        'tool_merge': 'Unir PDF',
        'tool_merge_desc': 'Combina cualquier cantidad de PDFs — sin restricciones',
        'tool_split': 'Dividir PDF',
        'tool_split_desc': 'Extrae páginas o divide en archivos separados al instante',
        'tool_compress': 'Comprimir PDF',
        'tool_compress_desc': 'Reduce el tamaño sin perder calidad — localmente',
        'tool_jpg2pdf': 'JPG a PDF',
        'tool_jpg2pdf_desc': 'Convierte tus imágenes a un único PDF al instante',
        'tool_pdf2jpg': 'PDF a JPG',
        'tool_pdf2jpg_desc': 'Extrae páginas como imágenes de alta calidad',
        'tool_extract': 'Extraer Páginas',
        'tool_extract_desc': 'Saca las páginas seleccionadas en un nuevo PDF limpio',
        'tool_watermark': 'Marca de Agua',
        'tool_watermark_desc': 'Estampa texto en cada página — diagonal o en mosaico',
        'tool_pagenum': 'Números de Página',
        'tool_pagenum_desc': 'Añade pies de página numerados — Arábigo, Romano o ABC',
        'tool_meta': 'Editar Metadatos',
        'tool_meta_desc': 'Ver y editar título, autor y palabras clave',
        'tool_redact': 'Censurar PDF',
        'tool_redact_desc': 'Oculta marcas de agua, firmas o datos sensibles localmente',
        'tool_rotate': 'Rotar PDF',
        'tool_rotate_desc': 'Corrige la orientación de páginas en cualquier PDF',
        'tool_protect': 'Proteger PDF',
        'tool_protect_desc': 'Contraseña AES-256 y permisos — 100% privado',
        
        'privacy_bar_label': 'Garantía de privacidad',
        'privacy_bar_1_strong': '100% privado por diseño',
        'privacy_bar_1_p': 'Tus archivos se procesan completamente en tu navegador. Cero subidas — nunca.',
        'privacy_bar_2_strong': 'Funciona en tu dispositivo',
        'privacy_bar_2_p': 'Todas las operaciones PDF se ejecutan en un Web Worker — un hilo aislado en tu propio hardware.',
        'privacy_bar_3_strong': 'Olvidado al instante',
        'privacy_bar_3_p': 'Los archivos solo viven en RAM. Cierra la pestaña y desaparecen — sin registros, sin rastros.',
        
        'tool_header_title': 'Unir PDF',
        'tool_header_desc': 'Combina archivos PDF ilimitados — sin restricciones',
        'drop_files_label': 'Subir archivos — clic o arrastra y suelta',
        'drop_title': 'Suelta los archivos aquí',
        'drop_sub': 'o haz clic para buscar — cualquier cantidad de archivos',
        'choose_files': 'Elegir archivos',
        'reorder_hint': '↕ Arrastra para reordenar archivos antes de unir',
        'merge_btn': '🔗 Unir archivos PDF',
        'cancel_btn': '✕ Cancelar',
        'cancel_aria': 'Cancelar procesamiento',
        'done': '¡Listo!',
        'pwa_text': '⚡ Instala para acceso instantáneo — funciona sin conexión',
        'pwa_install': 'Instalar app',
        'pwa_dismiss': 'Descartar',
        
        'footer_main': 'Todo el procesamiento sucede 100% en tu navegador',
        'footer_main_2': 'nunca se suben',
        'footer_lock': 'Tus documentos nunca salen de tu dispositivo',
        'footer_heart': 'Hecho para ser gratis para todos, para siempre',
        'footer_privacy': 'Privacidad',
        'footer_terms': 'Términos',
        'footer_github': 'GitHub',
    },
    
    'fr': {
        'lang': 'fr',
        'locale': 'fr_FR',
        'base_path': '/fr/',
        'title': 'PDFree — Outils PDF Gratuits, Sans Limites',
        'description': 'Outils PDF privés : fusionner, diviser, compresser, filigrane, numéros de page, extraire des pages, modifier les métadonnées. Tout dans votre navigateur — les fichiers ne sont jamais envoyés. Gratuit, sans limites, sans inscription.',
        'keywords': 'fusionner pdf, diviser pdf, compresser pdf, outils pdf gratuits, combiner fichiers pdf, pdf privé, pdf sans envoi, pdf côté client, filigrane pdf, numéros de page pdf, éditeur métadonnées pdf',
        'og_title': 'PDFree — Outils PDF Privés, Gratuits Pour Toujours',
        'og_description': 'Fusionner, diviser, compresser, filigraner des PDF. 100% privé — les fichiers ne quittent jamais votre appareil. Sans inscription, sans limites.',
        
        'go_home': 'Aller à l\'accueil',
        'nav': {
            'merge': 'Fusionner',
            'split': 'Diviser',
            'compress': 'Compresser',
            'jpg2pdf': 'JPG→PDF',
            'watermark': 'Filigrane',
            'meta': 'Métadonnées',
            'protect': 'Protéger',
        },
        
        'hero_badge': '🔒 100 % privé · aucun envoi · aucun compte · aucune limite',
        'hero_h1_1': 'Des outils PDF qui',
        'hero_h1_em': 'fonctionnent vraiment',
        'hero_p': 'Fusionner, diviser, compresser, filigraner, convertir — tout fonctionne <strong>dans votre navigateur</strong>. Vos fichiers ne quittent jamais votre appareil. Aucun serveur. Aucun compte. Juste des résultats.',
        
        'feature_private': '100 % privé',
        'feature_private_sub': 'Les fichiers ne quittent jamais votre appareil',
        'feature_fast': 'Ultra rapide',
        'feature_fast_sub': 'Fonctionne instantanément, hors ligne',
        'feature_nolimit': 'Aucune limite',
        'feature_nolimit_sub': 'Pas de limite de taille ou quotidienne',
        
        'trust_alert_label': 'Engagement de confidentialité',
        'trust_alert_strong': 'Vos fichiers restent sur votre appareil.',
        'trust_alert_text': 'Nous utilisons des Web Workers et des bibliothèques côté client — rien n\'est jamais envoyé à un serveur.',
        
        'nolimit_files': 'Aucune limite de fichiers',
        'nolimit_watermarks': 'Aucun filigrane ajouté',
        'nolimit_signup': 'Aucune inscription requise',
        'nolimit_leave': 'Les fichiers ne quittent jamais votre appareil',
        
        'all_tools': 'Tous les outils',
        
        'tool_merge': 'Fusionner PDF',
        'tool_merge_desc': 'Combinez n\'importe quel nombre de PDF — sans restrictions',
        'tool_split': 'Diviser PDF',
        'tool_split_desc': 'Extraire des pages ou diviser en fichiers séparés instantanément',
        'tool_compress': 'Compresser PDF',
        'tool_compress_desc': 'Réduire la taille du fichier sans perdre en qualité — localement',
        'tool_jpg2pdf': 'JPG en PDF',
        'tool_jpg2pdf_desc': 'Convertir vos images en un seul PDF instantanément',
        'tool_pdf2jpg': 'PDF en JPG',
        'tool_pdf2jpg_desc': 'Extraire les pages comme images haute qualité',
        'tool_extract': 'Extraire des Pages',
        'tool_extract_desc': 'Mettre les pages sélectionnées dans un nouveau PDF propre',
        'tool_watermark': 'Filigrane',
        'tool_watermark_desc': 'Tamponner du texte sur chaque page — diagonal ou en mosaïque',
        'tool_pagenum': 'Numéros de Page',
        'tool_pagenum_desc': 'Ajouter des pieds de page numérotés — Arabe, Romain ou ABC',
        'tool_meta': 'Modifier les Métadonnées',
        'tool_meta_desc': 'Voir et modifier le titre, l\'auteur et les mots-clés',
        'tool_redact': 'Censurer PDF',
        'tool_redact_desc': 'Masquer filigranes, signatures ou données sensibles localement',
        'tool_rotate': 'Rotation PDF',
        'tool_rotate_desc': 'Corriger l\'orientation des pages dans n\'importe quel PDF',
        'tool_protect': 'Protéger PDF',
        'tool_protect_desc': 'Mot de passe AES-256 et permissions — 100 % privé',
        
        'privacy_bar_label': 'Garantie de confidentialité',
        'privacy_bar_1_strong': '100 % privé par conception',
        'privacy_bar_1_p': 'Vos fichiers sont traités entièrement dans votre navigateur. Zéro envoi — jamais.',
        'privacy_bar_2_strong': 'Fonctionne sur votre appareil',
        'privacy_bar_2_p': 'Toutes les opérations PDF s\'exécutent dans un Web Worker — un thread isolé sur votre propre matériel.',
        'privacy_bar_3_strong': 'Oublié instantanément',
        'privacy_bar_3_p': 'Les fichiers vivent uniquement en RAM. Fermez l\'onglet et ils disparaissent — aucun journal, aucune trace.',
        
        'tool_header_title': 'Fusionner PDF',
        'tool_header_desc': 'Combiner des fichiers PDF illimités — sans restrictions',
        'drop_files_label': 'Télécharger des fichiers — cliquer ou glisser-déposer',
        'drop_title': 'Déposez les fichiers ici',
        'drop_sub': 'ou cliquez pour parcourir — n\'importe quel nombre de fichiers',
        'choose_files': 'Choisir des fichiers',
        'reorder_hint': '↕ Glisser pour réorganiser les fichiers avant de fusionner',
        'merge_btn': '🔗 Fusionner les fichiers PDF',
        'cancel_btn': '✕ Annuler',
        'cancel_aria': 'Annuler le traitement',
        'done': 'Terminé !',
        'pwa_text': '⚡ Installer pour un accès instantané — fonctionne hors ligne',
        'pwa_install': 'Installer l\'app',
        'pwa_dismiss': 'Fermer',
        
        'footer_main': 'Tout le traitement se passe 100 % dans votre navigateur',
        'footer_main_2': 'jamais envoyés',
        'footer_lock': 'Vos documents ne quittent jamais votre appareil',
        'footer_heart': 'Conçu pour être gratuit pour tous, pour toujours',
        'footer_privacy': 'Confidentialité',
        'footer_terms': 'Conditions',
        'footer_github': 'GitHub',
    },
    
    'pt': {
        'lang': 'pt',
        'locale': 'pt_BR',
        'base_path': '/pt/',
        'title': 'PDFree — Ferramentas PDF Grátis, Sem Limites',
        'description': 'Ferramentas PDF privadas: juntar, dividir, comprimir, marca d\'água, números de página, extrair páginas, editar metadados. Tudo no seu navegador — arquivos nunca enviados. Grátis, sem limites, sem cadastro.',
        'keywords': 'juntar pdf, dividir pdf, comprimir pdf, ferramentas pdf grátis, combinar arquivos pdf, pdf privado, pdf sem upload, pdf client-side, marca d\'água pdf, números de página pdf, editor metadados pdf',
        'og_title': 'PDFree — Ferramentas PDF Privadas, Grátis para Sempre',
        'og_description': 'Juntar, dividir, comprimir, marca d\'água em PDFs. 100% privado — arquivos nunca saem do seu dispositivo. Sem cadastro, sem limites.',
        
        'go_home': 'Ir para página inicial',
        'nav': {
            'merge': 'Juntar',
            'split': 'Dividir',
            'compress': 'Comprimir',
            'jpg2pdf': 'JPG→PDF',
            'watermark': 'Marca d\'água',
            'meta': 'Metadados',
            'protect': 'Proteger',
        },
        
        'hero_badge': '🔒 100% privado · sem uploads · sem cadastro · sem limites',
        'hero_h1_1': 'Ferramentas PDF que',
        'hero_h1_em': 'realmente funcionam',
        'hero_p': 'Juntar, dividir, comprimir, marca d\'água, converter — tudo roda <strong>no seu navegador</strong>. Seus arquivos nunca saem do seu dispositivo. Sem servidor. Sem conta. Apenas resultados.',
        
        'feature_private': '100% Privado',
        'feature_private_sub': 'Arquivos nunca saem do seu dispositivo',
        'feature_fast': 'Super Rápido',
        'feature_fast_sub': 'Funciona instantaneamente, offline',
        'feature_nolimit': 'Sem Limites',
        'feature_nolimit_sub': 'Sem limites de tamanho ou diários',
        
        'trust_alert_label': 'Promessa de privacidade',
        'trust_alert_strong': 'Seus arquivos permanecem no seu dispositivo.',
        'trust_alert_text': 'Usamos Web Workers e bibliotecas client-side — nada nunca é enviado para nenhum servidor.',
        
        'nolimit_files': 'Sem limites de arquivos',
        'nolimit_watermarks': 'Sem marcas d\'água adicionadas',
        'nolimit_signup': 'Sem cadastro necessário',
        'nolimit_leave': 'Arquivos nunca saem do seu dispositivo',
        
        'all_tools': 'Todas as ferramentas',
        
        'tool_merge': 'Juntar PDF',
        'tool_merge_desc': 'Combine qualquer quantidade de PDFs — sem restrições',
        'tool_split': 'Dividir PDF',
        'tool_split_desc': 'Extrair páginas ou dividir em arquivos separados instantaneamente',
        'tool_compress': 'Comprimir PDF',
        'tool_compress_desc': 'Reduza o tamanho sem perder qualidade — localmente',
        'tool_jpg2pdf': 'JPG para PDF',
        'tool_jpg2pdf_desc': 'Converta suas imagens em um único PDF instantaneamente',
        'tool_pdf2jpg': 'PDF para JPG',
        'tool_pdf2jpg_desc': 'Extraia páginas como imagens de alta qualidade',
        'tool_extract': 'Extrair Páginas',
        'tool_extract_desc': 'Pegue páginas selecionadas em um novo PDF limpo',
        'tool_watermark': 'Marca d\'Água',
        'tool_watermark_desc': 'Carimbar texto em cada página — diagonal ou em mosaico',
        'tool_pagenum': 'Números de Página',
        'tool_pagenum_desc': 'Adicionar rodapés numerados — Arábico, Romano ou ABC',
        'tool_meta': 'Editar Metadados',
        'tool_meta_desc': 'Ver e editar título, autor e palavras-chave',
        'tool_redact': 'Censurar PDF',
        'tool_redact_desc': 'Oculte marcas d\'água, assinaturas ou dados sensíveis localmente',
        'tool_rotate': 'Girar PDF',
        'tool_rotate_desc': 'Corrige a orientação de páginas em qualquer PDF',
        'tool_protect': 'Proteger PDF',
        'tool_protect_desc': 'Senha AES-256 e permissões — 100% privado',
        
        'privacy_bar_label': 'Garantia de privacidade',
        'privacy_bar_1_strong': '100% privado por design',
        'privacy_bar_1_p': 'Seus arquivos são processados inteiramente no seu navegador. Zero uploads — nunca.',
        'privacy_bar_2_strong': 'Roda no seu dispositivo',
        'privacy_bar_2_p': 'Todas as operações PDF rodam em um Web Worker — uma thread isolada no seu próprio hardware.',
        'privacy_bar_3_strong': 'Esquecido instantaneamente',
        'privacy_bar_3_p': 'Os arquivos vivem apenas na RAM. Feche a aba e eles desaparecem — sem logs, sem rastros.',
        
        'tool_header_title': 'Juntar PDF',
        'tool_header_desc': 'Combine arquivos PDF ilimitados — sem restrições',
        'drop_files_label': 'Enviar arquivos — clique ou arraste e solte',
        'drop_title': 'Solte os arquivos aqui',
        'drop_sub': 'ou clique para navegar — qualquer quantidade de arquivos',
        'choose_files': 'Escolher arquivos',
        'reorder_hint': '↕ Arraste para reordenar arquivos antes de juntar',
        'merge_btn': '🔗 Juntar arquivos PDF',
        'cancel_btn': '✕ Cancelar',
        'cancel_aria': 'Cancelar processamento',
        'done': 'Pronto!',
        'pwa_text': '⚡ Instale para acesso instantâneo — funciona offline',
        'pwa_install': 'Instalar app',
        'pwa_dismiss': 'Fechar',
        
        'footer_main': 'Todo o processamento acontece 100% no seu navegador',
        'footer_main_2': 'nunca enviados',
        'footer_lock': 'Seus documentos nunca saem do seu dispositivo',
        'footer_heart': 'Feito para ser grátis para todos, para sempre',
        'footer_privacy': 'Privacidade',
        'footer_terms': 'Termos',
        'footer_github': 'GitHub',
    },
}


def generate_index(locale_code):
    """Generate localized index.html for given locale."""
    t = TRANSLATIONS[locale_code]
    is_root = (locale_code == 'en')
    
    # Asset paths depend on whether we're in root or nested folder
    css_path = 'css' if is_root else '../css'
    js_path = 'js' if is_root else '../js'
    icons_path = '/icons' if is_root else '/icons'
    manifest_path = '/manifest.json' if is_root else '/manifest.json'
    
    canonical = 'https://pdfree.io/' if is_root else f'https://pdfree.io/{locale_code}/'
    
    html = f'''<!DOCTYPE html>
<html lang="{t['lang']}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <meta http-equiv="Content-Security-Policy" content="
    default-src 'self';
    script-src  'self'
                'wasm-unsafe-eval'
                blob:
                https://cdnjs.cloudflare.com
                https://plausible.io
                https://pagead2.googlesyndication.com
                https://static.cloudflareinsights.com;
    style-src   'self' 'unsafe-inline'
                https://fonts.googleapis.com;
    font-src    https://fonts.gstatic.com;
    img-src     'self' data: blob: https:;
    connect-src 'self'
                https://cdnjs.cloudflare.com
                https://*.workers.dev
                https://plausible.io
                https://pagead2.googlesyndication.com
                https://www.googletagservices.com
                https://*.doubleclick.net
                https://cloudflareinsights.com;
    frame-src   https://googleads.g.doubleclick.net
                https://tpc.googlesyndication.com;
    worker-src  'self' blob:;
    object-src  'none';
  ">
  <title>{t['title']}</title>
  <meta name="description" content="{t['description']}">
  <meta name="keywords"    content="{t['keywords']}">
  <meta property="og:title"       content="{t['og_title']}">
  <meta property="og:description" content="{t['og_description']}">
  <meta property="og:type"        content="website">
  <meta property="og:url"       content="{canonical}">
  <meta property="og:site_name" content="PDFree">
  <meta property="og:locale"    content="{t['locale']}">
  <meta property="og:image"     content="https://pdfree.io/icons/og-image.jpg">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="633">
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:site"        content="@pdfree_io">
  <meta name="twitter:image"       content="https://pdfree.io/icons/og-image.jpg">

  <link rel="canonical" href="{canonical}">
  <link rel="alternate" hreflang="en" href="https://pdfree.io/">
  <link rel="alternate" hreflang="es" href="https://pdfree.io/es/">
  <link rel="alternate" hreflang="pt" href="https://pdfree.io/pt/">
  <link rel="alternate" hreflang="de" href="https://pdfree.io/de/">
  <link rel="alternate" hreflang="fr" href="https://pdfree.io/fr/">
  <link rel="alternate" hreflang="x-default" href="https://pdfree.io/">

  <!-- PWA -->
  <link rel="manifest" href="{manifest_path}">
  <meta name="theme-color" content="#2D7A4F">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="PDFree">
  <link rel="apple-touch-icon" href="{icons_path}/icon-192.png">
  <link rel="icon" type="image/svg+xml" href="{icons_path}/favicon.svg">

  <!-- Privacy-first analytics (no cookies, GDPR compliant) -->
  <script defer data-domain="pdfree.io" src="https://plausible.io/js/script.js"></script>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap"></noscript>

  <link rel="stylesheet" href="{css_path}/variables.css">
  <link rel="stylesheet" href="{css_path}/animations.css">
  <link rel="stylesheet" href="{css_path}/layout.css">
  <link rel="stylesheet" href="{css_path}/components.css">

</head>
<body>

  <!-- ── Navigation ── -->
  <nav>
    <div class="logo" id="logo" tabindex="0" role="button" aria-label="{t['go_home']}">
      <div class="logo-icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
      </div>
      <span class="logo-text">PDF<span>ree</span></span>
    </div>
    <div class="nav-links">
      <button class="nav-link" data-tool="merge">{t['nav']['merge']}</button>
      <button class="nav-link" data-tool="split">{t['nav']['split']}</button>
      <button class="nav-link" data-tool="compress">{t['nav']['compress']}</button>
      <button class="nav-link" data-tool="jpg2pdf">{t['nav']['jpg2pdf']}</button>
      <button class="nav-link" data-tool="watermark">{t['nav']['watermark']}</button>
      <button class="nav-link" data-tool="meta">{t['nav']['meta']}</button>
      <button class="nav-link" data-tool="protect">{t['nav']['protect']}</button>
    </div>
  </nav>

  <!-- ── Hero ── -->
  <section id="hero" class="hero">
    <div class="hero-badge">{t['hero_badge']}</div>
    <h1>{t['hero_h1_1']}<br><em>{t['hero_h1_em']}</em></h1>
    <p>{t['hero_p']}</p>

    <div class="hero-features">
      <div class="hero-feature">
        <div class="hero-feature__icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <strong>{t['feature_private']}</strong>
          <span>{t['feature_private_sub']}</span>
        </div>
      </div>
      <div class="hero-feature">
        <div class="hero-feature__icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        </div>
        <div>
          <strong>{t['feature_fast']}</strong>
          <span>{t['feature_fast_sub']}</span>
        </div>
      </div>
      <div class="hero-feature">
        <div class="hero-feature__icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        </div>
        <div>
          <strong>{t['feature_nolimit']}</strong>
          <span>{t['feature_nolimit_sub']}</span>
        </div>
      </div>
    </div>
  </section>

  <!-- ── Trust alert block ── -->
  <div class="trust-alert" id="trustAlert" aria-label="{t['trust_alert_label']}">
    <div class="trust-alert-icon" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>
    </div>
    <div class="trust-alert-text">
      <strong>{t['trust_alert_strong']}</strong>
      <span>{t['trust_alert_text']}</span>
    </div>
  </div>

  <!-- ── No-limit bar ── -->
  <div id="noLimitBar" class="no-limit-bar">
    <div class="no-limit-item">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      {t['nolimit_files']}
    </div>
    <div class="no-limit-item">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      {t['nolimit_watermarks']}
    </div>
    <div class="no-limit-item">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      {t['nolimit_signup']}
    </div>
    <div class="no-limit-item">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      {t['nolimit_leave']}
    </div>
  </div>

  <!-- ── Tools grid ── -->
  <section id="toolsGrid" class="tools-section">
    <div class="section-label">{t['all_tools']}</div>
    <div class="tools-grid">
      <div class="tool-card featured" data-tool="merge" tabindex="0" role="button" aria-label="{t['tool_merge']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></div>
        <div class="tool-name">{t['tool_merge']}</div>
        <div class="tool-desc">{t['tool_merge_desc']}</div>
      </div>
      <div class="tool-card" data-tool="split" tabindex="0" role="button" aria-label="{t['tool_split']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg></div>
        <div class="tool-name">{t['tool_split']}</div>
        <div class="tool-desc">{t['tool_split_desc']}</div>
      </div>
      <div class="tool-card" data-tool="compress" tabindex="0" role="button" aria-label="{t['tool_compress']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/><path d="M5 2h14"/><path d="M5 22h14"/></svg></div>
        <div class="tool-name">{t['tool_compress']}</div>
        <div class="tool-desc">{t['tool_compress_desc']}</div>
      </div>
      <div class="tool-card" data-tool="jpg2pdf" tabindex="0" role="button" aria-label="{t['tool_jpg2pdf']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>
        <div class="tool-name">{t['tool_jpg2pdf']}</div>
        <div class="tool-desc">{t['tool_jpg2pdf_desc']}</div>
      </div>
      <div class="tool-card" data-tool="pdf2jpg" tabindex="0" role="button" aria-label="{t['tool_pdf2jpg']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg></div>
        <div class="tool-name">{t['tool_pdf2jpg']}</div>
        <div class="tool-desc">{t['tool_pdf2jpg_desc']}</div>
      </div>
      <div class="tool-card" data-tool="extract" tabindex="0" role="button" aria-label="{t['tool_extract']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="M12 12v6"/><path d="m9 15 3-3 3 3"/></svg></div>
        <div class="tool-name">{t['tool_extract']}</div>
        <div class="tool-desc">{t['tool_extract_desc']}</div>
      </div>
      <div class="tool-card" data-tool="watermark" tabindex="0" role="button" aria-label="{t['tool_watermark']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg></div>
        <div class="tool-name">{t['tool_watermark']}</div>
        <div class="tool-desc">{t['tool_watermark_desc']}</div>
      </div>
      <div class="tool-card" data-tool="pagenum" tabindex="0" role="button" aria-label="{t['tool_pagenum']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22h14a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4"/><polyline points="14 2 14 8 20 8"/><path d="M2 15h4v4"/><path d="M4 15v6"/><path d="M10 15v6"/><path d="M14 15v6"/></svg></div>
        <div class="tool-name">{t['tool_pagenum']}</div>
        <div class="tool-desc">{t['tool_pagenum_desc']}</div>
      </div>
      <div class="tool-card" data-tool="meta" tabindex="0" role="button" aria-label="{t['tool_meta']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg></div>
        <div class="tool-name">{t['tool_meta']}</div>
        <div class="tool-desc">{t['tool_meta_desc']}</div>
      </div>
      <div class="tool-card" data-tool="redact" tabindex="0" role="button" aria-label="{t['tool_redact']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/></svg></div>
        <div class="tool-name">{t['tool_redact']}</div>
        <div class="tool-desc">{t['tool_redact_desc']}</div>
      </div>
      <div class="tool-card" data-tool="rotate" tabindex="0" role="button" aria-label="{t['tool_rotate']}">
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></div>
        <div class="tool-name">{t['tool_rotate']}</div>
        <div class="tool-desc">{t['tool_rotate_desc']}</div>
      </div>
      <div class="tool-card" data-tool="protect" tabindex="0" role="button" aria-label="{t['tool_protect']}">
        <div class="tool-card-pulse" aria-hidden="true">
          <div class="tool-card-pulse__ring"></div>
          <div class="tool-card-pulse__dot"></div>
        </div>
        <div class="tool-icon-wrapper" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <div class="tool-name">{t['tool_protect']}</div>
        <div class="tool-desc">{t['tool_protect_desc']}</div>
      </div>
    </div>
  </section>

  <!-- ── Privacy trust bar ── -->
  <section class="privacy-bar" aria-label="{t['privacy_bar_label']}">
    <div class="privacy-bar__inner">
      <div class="privacy-bar__item">
        <div class="privacy-bar__icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </div>
        <div>
          <strong>{t['privacy_bar_1_strong']}</strong>
          <p>{t['privacy_bar_1_p']}</p>
        </div>
      </div>
      <div class="privacy-bar__item">
        <div class="privacy-bar__icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </div>
        <div>
          <strong>{t['privacy_bar_2_strong']}</strong>
          <p>{t['privacy_bar_2_p']}</p>
        </div>
      </div>
      <div class="privacy-bar__item">
        <div class="privacy-bar__icon" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
        </div>
        <div>
          <strong>{t['privacy_bar_3_strong']}</strong>
          <p>{t['privacy_bar_3_p']}</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ── Tool workspace ── -->
  <main id="toolArea" class="main-area" style="display:none" aria-busy="false">

    <div class="tool-header">
      <div class="tool-header-icon" id="toolIcon" aria-hidden="true">🔗</div>
      <div class="tool-header-text">
        <h2 id="toolTitle">{t['tool_header_title']}</h2>
        <p  id="toolDesc">{t['tool_header_desc']}</p>
      </div>
    </div>

    <div id="dropZone" class="drop-zone" tabindex="0" role="button" aria-label="{t['drop_files_label']}">
      <input type="file" id="fileInput" multiple accept=".pdf" aria-hidden="true">
      <span class="drop-icon" aria-hidden="true">📂</span>
      <div class="drop-title">{t['drop_title']}</div>
      <div class="drop-sub">{t['drop_sub']}</div>
      <button class="drop-btn" id="chooseFilesBtn" type="button">{t['choose_files']}</button>
    </div>

    <div id="fileList"    class="file-list" aria-live="polite" aria-label="Selected files"></div>
    <div id="fileCount"   class="file-count"   style="display:none"></div>
    <div id="reorderHint" class="reorder-hint" style="display:none">{t['reorder_hint']}</div>

    <div id="splitOptions"    class="split-options"   style="display:none" aria-label="Split options"></div>
    <div id="compressOptions" class="compress-options" style="display:none" aria-label="Compression options"></div>
    <div id="jpg2pdfOptions"  class="j2p-options"     style="display:none" aria-label="JPG to PDF options"></div>
    <div id="pdf2jpgOptions"  class="j2p-options"     style="display:none" aria-label="PDF to JPG options"></div>
    <div id="watermarkOptions" class="j2p-options"    style="display:none" aria-label="Watermark options"></div>
    <div id="pageNumOptions"  class="j2p-options"     style="display:none" aria-label="Page numbers options"></div>
    <div id="metaOptions"     class="j2p-options"     style="display:none" aria-label="Metadata editor"></div>
    <div id="protectOptions"  class="j2p-options"     style="display:none" aria-label="Protect PDF options"></div>
    <div id="redactOptions"   class="j2p-options"     style="display:none" aria-label="Cover Area options"></div>
    <div id="rotateOptions"   class="j2p-options"     style="display:none" aria-label="Rotate PDF options"></div>

    <button id="mergeBtn"  class="merge-btn"  type="button" disabled data-mode="process">{t['merge_btn']}</button>
    <button id="cancelBtn" class="cancel-btn" type="button" style="display:none" aria-label="{t['cancel_aria']}">{t['cancel_btn']}</button>

    <div id="progressBar"   class="progress-bar"><div id="progressFill" class="progress-fill"></div></div>
    <div id="progressLabel" class="progress-label"></div>

    <!-- Success card -->
    <div id="successCard" class="success-card" role="alert" aria-live="polite" style="display:none">
      <div class="success-top">
        <div class="success-icon" aria-hidden="true">✓</div>
        <div class="success-text">
          <h3 id="successTitle">{t['done']}</h3>
          <p  id="successDesc"></p>
        </div>
        <button id="downloadBtn" class="download-btn" type="button">⬇ Download</button>
      </div>

      <!-- Install PWA nudge — shown only when browser supports it -->
      <div class="pwa-nudge" id="pwaNudge" style="display:none">
        <span class="pwa-nudge__text">{t['pwa_text']}</span>
        <button type="button" class="pwa-nudge__btn" id="pwaNudgeBtn">{t['pwa_install']}</button>
        <button type="button" class="pwa-nudge__skip" id="pwaNudgeSkip" aria-label="{t['pwa_dismiss']}">✕</button>
      </div>

    </div>

  </main>

  <footer>
    PDFree · <strong>{t['footer_main']}</strong> · <strong>{t['footer_main_2']}</strong><br>
    <span style="color:var(--green)">🔒</span> {t['footer_lock']} &nbsp;·&nbsp;
    <span style="color:var(--green)">♥</span> {t['footer_heart']}<br>
    <span style="font-size:11px;margin-top:8px;display:inline-block;color:var(--text3)">
      <a href="/privacy.html" style="color:var(--green)">{t['footer_privacy']}</a>
      &nbsp;·&nbsp;
      <a href="/terms.html" style="color:var(--green)">{t['footer_terms']}</a>
      &nbsp;·&nbsp;
      <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener" style="color:var(--green)">GNU AGPLv3</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/mahmudovbahrom555-lab/pdfree33" target="_blank" rel="noopener" style="color:var(--green)">{t['footer_github']}</a>
    </span>
  </footer>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <!-- JSZip для создания ZIP-архива при Split PDF -->
  <!-- pdf-lib нужен в основном потоке для splitUI.js (window.PDFLib) -->
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"></script>
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
  <!-- Inline version check: runs before modules, shows cache diagnostic in console -->
  <script>
    console.info('[PDFree] v6.3 loaded. If rotate tool fails, open DevTools → Application → Service Workers → Unregister → hard reload (Ctrl+F5).');
  </script>
  <script type="module" src="{js_path}/app.js?v=6"></script>


<!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{{"token": "5cbef445bc6d4370af5d5ad3d9633534"}}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>
'''
    
    return html


def main():
    base_dir = '/home/claude/pdfree'
    
    # Generate index.html for each locale
    for locale in ['de', 'es', 'fr', 'pt']:
        target_path = os.path.join(base_dir, locale, 'index.html')
        
        if not os.path.exists(os.path.dirname(target_path)):
            print(f"⚠️  Skipping {locale}: directory doesn't exist")
            continue
        
        html = generate_index(locale)
        
        with open(target_path, 'w', encoding='utf-8') as f:
            f.write(html)
        
        line_count = html.count('\n')
        print(f"✅ Generated {locale}/index.html ({line_count} lines, {len(html)} bytes)")
    
    print("\n✅ All localized index.html files regenerated with consistent structure")


if __name__ == '__main__':
    main()
