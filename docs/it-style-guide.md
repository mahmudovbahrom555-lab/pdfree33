# Italian Style Guide — PDFree

Reference glossary for all Italian content, FAQ, UI strings, and future articles.
> **Claims check:** Before publishing copy, verify current behavior in `js/fileLimits.js` and the project's README. PDF processing is local, but the site can request assets and send usage analytics or user-submitted feedback. File-size limits apply. Do not assert GDPR/RODO/KVKK/AVG compliance without a documented legal assessment.


## Tool Names

| English | Italian |
|---------|---------|
| Merge PDF | Unisci PDF |
| Split PDF | Dividi PDF |
| Compress PDF | Comprimi PDF |
| Rotate PDF | Ruota PDF |
| Watermark PDF | Aggiungi Filigrana PDF |
| Protect PDF | Proteggi PDF |
| Fill PDF | Compila PDF |
| Extract Pages | Estrai Pagine PDF |
| Page Numbers | Aggiungi Numeri di Pagina |
| Compare PDF | Confronta PDF |
| Flatten PDF | Appiattisci PDF |
| OCR PDF | OCR PDF |
| JPG to PDF | JPG in PDF |
| PDF to JPG | PDF in JPG |
| PDF to Word | PDF in Word |

## Core Phrases

| English | Italian | Notes |
|---------|---------|-------|
| Free | Gratis | Never "Gratuito" in H1 — Gratis is more natural |
| No upload | Senza Caricare i File | Standard; also "Senza Caricamento" |
| No registration | Senza Registrazione | Never "Nessun Account" |
| Processed in browser | Elaborato direttamente nel browser | Or: "Tutto avviene nel tuo browser" |
| PDF processing stays on your device | I PDF vengono elaborati sul tuo dispositivo. | Describes PDF processing, not all website network traffic |
| Private | I file rimangono sul tuo dispositivo | More natural than the word "Privato" alone |
| Without uploading | Senza Caricare i File | e.g. "Unisci PDF Senza Caricare i File" |
| File-size limits apply | Si applicano limiti di dimensione dei file | See js/fileLimits.js; limits vary by tool and device |
| Online | Online | Keep as-is |
| Safe | Sicuro | |
| Fast | Veloce | |

## H1 Pattern

```
{Verb} PDF Gratis Online — Senza Caricare File
```

Examples:
- Unisci PDF Gratis Online — Senza Caricare File
- Comprimi PDF Gratis Online — Senza Caricare File
- Dividi PDF Gratis Online
- Aggiungi Filigrana PDF Gratis — Senza Upload
- Proteggi PDF con Password Gratis — Senza Upload

## SEO Keywords by Tool

### Merge
```
Unisci PDF
Unire PDF
Unisci PDF Gratis
Unisci PDF Online
Unisci PDF Senza Registrazione
Unisci PDF Senza Caricare File
```

### Compress
```
Comprimi PDF
Comprimi PDF Gratis
Riduci Dimensione PDF
```

### Split
```
Dividi PDF
Dividere PDF
Dividi PDF Gratis
```

### JPG → PDF
```
JPG in PDF
Converti JPG in PDF
```

### PDF → JPG
```
PDF in JPG
Converti PDF in JPG
```

### Watermark
```
Aggiungi Filigrana PDF
```
Not: "Watermark PDF"

### Protect
```
Proteggi PDF
Proteggi PDF con Password
```

### Fill Form
```
Compila PDF
```

### Page Numbers
```
Numera Pagine PDF
Aggiungi Numeri di Pagina
```

### Flatten
```
Appiattisci PDF
```

### Compare
```
Confronta PDF
```

### Extract Pages
```
Estrai Pagine PDF
```

### OCR
```
OCR PDF
```
Do not translate "OCR".

## FAQ Style

Conversational, natural Italian:
- Posso unire PDF senza caricarli?
- È davvero gratis?
- I miei file vengono caricati su un server?
- Funziona su iPhone?
- Funziona su Mac?
- Posso unire più di 100 PDF?
- Come vengono elaborati i miei PDF?
- C'è un limite alla dimensione dei file?

## Do Not Translate

These stay in Latin script:
- PDF
- JPG, PNG, WEBP
- OCR
- AES-256
- Web Worker

## Content Style

Short sentences. Modern Italian SaaS style:

✅ Correct:
```
Unisci i PDF direttamente nel browser.
Nessun upload.
Nessuna registrazione.
I file rimangono sul tuo dispositivo.
```

❌ Avoid:
```
Questo strumento consente di unire facilmente file PDF direttamente nel browser senza alcun caricamento.
```

## Comparison Table

Anonymous label (never name competitors):
- Column header: "Strumenti cloud tipici"
- Feature column: "Funzionalità"

## Navigation Labels

| Tool | Nav Label |
|------|-----------|
| merge | Unisci |
| compress | Comprimi |
| split | Dividi |
| watermark | Filigrana |
| protect | Proteggi |
| jpg2pdf | JPG → PDF |
| pdf2jpg | PDF → JPG |

## Slugs

| Tool | Italian Slug |
|------|-------------|
| merge | unisci-pdf |
| compress | comprimi-pdf |
| split | dividi-pdf |
| jpg2pdf | jpg-in-pdf |
| pdf2jpg | pdf-in-jpg |
| watermark | filigrana-pdf |
| protect | proteggi-pdf |

## Special Notes for Italian Audience

- **Privacy questions**: Explain that PDF processing takes place in the browser. Do not treat local processing as proof of GDPR compliance.
- **Mac users**: Italy has higher Mac market share than EU average. Include "Funziona su Mac?" in FAQ.
- **Trust signals**: Prefer "Elaborazione nel browser" and "Nessun caricamento dei PDF" to legal guarantees or claims of zero network requests.
