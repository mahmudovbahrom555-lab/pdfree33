# Turkish Style Guide — PDFree

Reference glossary for all Turkish content, FAQ, UI strings, and future articles.
> **Claims check:** Before publishing copy, verify current behavior in `js/fileLimits.js` and the project's README. PDF processing is local, but the site can request assets and send usage analytics or user-submitted feedback. File-size limits apply. Do not assert GDPR/RODO/KVKK/AVG compliance without a documented legal assessment.


## Tool Names

| English | Turkish | Notes |
|---------|---------|-------|
| Merge PDF | PDF Birleştir | ⭐⭐⭐⭐⭐ most searched; NOT "PDF'leri Birleştirin" |
| Compress PDF | PDF Sıkıştır | standard; NOT "PDF Küçült" |
| Split PDF | PDF Böl | standard; NOT "PDF Ayır" |
| Rotate PDF | PDF Döndür | standard |
| Watermark PDF | PDF'ye Filigran Ekle | NOT "Watermark" or "Damga" |
| Protect PDF | PDF'yi Parolayla Koru | NOT "PDF'yi Şifrele" (too ambiguous) |
| Fill PDF | PDF Formu Doldur | NOT "PDF Doldurma" |
| Compare PDF | PDF Karşılaştır | standard |
| Flatten PDF | PDF Formunu Düzleştir | or "PDF Alanlarını Sabitle" |
| Extract Pages | PDF Sayfalarını Çıkar | natural |
| Page Numbers | Sayfa Numarası Ekle | natural |
| OCR PDF | OCR PDF | do not translate |
| JPG to PDF | JPG'den PDF'ye | natural directional form |
| PDF to JPG | PDF'den JPG'ye | standard |
| PDF to Word | PDF'den Word'e | standard |

## Core Phrases

| English | Turkish | Notes |
|---------|---------|-------|
| Free | Ücretsiz | NOT "Bedava" — sounds unprofessional |
| Online | Çevrimiçi / Online | both acceptable |
| No upload | Yükleme Yapmadan | or "Dosyalarınızı yüklemeniz gerekmez." |
| No registration | Kayıt Olmadan | NOT "Hesap oluşturmadan" in H1 |
| File-size limits apply | Dosya boyutu sınırları geçerlidir. | Check js/fileLimits.js; limits vary by tool and device |
| Processed in browser | Tarayıcınızda işlenir. | or "Her şey tarayıcınızda gerçekleşir." |
| PDF processing stays on your device | PDF dosyalarınız cihazınızda işlenir. | Describes PDF processing, not all website network traffic |
| Also natural | Dosyalarınız hiçbir sunucuya gönderilmez. | alternative privacy phrase |
| Local processing | Her şey tarayıcınızda gerçekleşir. | NOT "Yerel işlem" in SEO text |
| Safe | Güvenli | |
| Fast | Hızlı | |
| Choose file | Dosya Seç | or "PDF Seç" |
| Drag here | PDF'inizi buraya sürükleyin | natural CTA |
| Download | İndir | |
| Cancel | İptal | |
| Start free | Ücretsiz Başla | CTA variant |
| Download again | Tekrar İndir | |
| Process again | Tekrar İşle | |

## H1 Pattern

```
{Tool name} — Ücretsiz, Yükleme Yapmadan
```

Examples:
- PDF Birleştir — Ücretsiz, Yükleme Yapmadan
- PDF Sıkıştır — Ücretsiz, Yükleme Yapmadan
- PDF Böl — Ücretsiz, Yükleme Yapmadan
- PDF'yi Parolayla Koru — Ücretsiz, AES-256, Yükleme Yapmadan
- JPG'den PDF'ye — Ücretsiz, Yükleme Yapmadan

## SEO Keywords by Tool

### Merge
```
PDF Birleştir
PDF birleştir ücretsiz
PDF birleştir online
PDF dosyaları birleştir
PDF birleştirme
Kayıt olmadan PDF birleştir
```

### Compress
```
PDF Sıkıştır
PDF sıkıştır ücretsiz
PDF boyutunu küçült
PDF sıkıştırma
```

### Split
```
PDF Böl
PDF böl ücretsiz
PDF sayfa böl
PDF bölme
```

### JPG → PDF
```
JPG'den PDF'ye
JPG PDF dönüştür
Resim PDF'ye çevir
```

### PDF → JPG
```
PDF'den JPG'ye
PDF JPG dönüştür
PDF resme çevir
```

### Watermark
```
PDF'ye Filigran Ekle
PDF filigran
PDF damgala
```

### Protect
```
PDF'yi Parolayla Koru
PDF şifrele
PDF parola ekle
```

### Fill Form
```
PDF Formu Doldur
PDF form doldur
```

### Rotate
```
PDF Döndür
PDF döndür online
PDF sayfası döndür
```

### Extract Pages
```
PDF Sayfalarını Çıkar
PDF sayfa çıkar
PDF sayfası ayır
```

### OCR
```
OCR PDF
PDF OCR
```
Do not translate OCR.

## FAQ Style

Short, direct Turkish questions (informal but professional):
- PDF'lerim sunucuya yükleniyor mu?
- Gerçekten ücretsiz mi?
- Kayıt olmadan kullanabilir miyim?
- iPhone'da çalışıyor mu?
- Mac'te çalışıyor mu?
- 100'den fazla PDF birleştirebilir miyim?
- Parola korumalı PDF'leri destekliyor mu?
- Dosya boyutu sınırı var mı?
- PDF dosyalarım nerede işleniyor?

## Do Not Translate

These stay in Latin script:
- PDF
- JPG, PNG, WEBP
- OCR
- AES-256
- Web Worker

## Content Style

Direct, practical Turkish. Short sentences — modern Turkish SaaS style:

✅ Correct:
```
PDF dosyalarınızı doğrudan tarayıcınızda birleştirin.
Dosyalarınız yüklenmez.
Kayıt gerekmez.
Tamamen ücretsizdir.
```

❌ Avoid:
```
Bu araç, PDF dosyalarınızı güvenli bir şekilde birleştirmenize olanak tanır.
```

## Comparison Table

Anonymous label (never name competitors):
- Column header: "Tipik bulut araçları"
- Feature column: "Özellik"

## Navigation Labels

| Tool | Nav Label |
|------|-----------|
| merge | PDF Birleştir |
| compress | PDF Sıkıştır |
| split | PDF Böl |
| watermark | Filigran Ekle |
| protect | PDF Koru |
| jpg2pdf | JPG → PDF |
| pdf2jpg | PDF → JPG |

## Slugs

Turkish special characters converted to ASCII for URLs (ş→s, ı→i, ğ→g, ç→c, ö→o, ü→u):

| Tool | Turkish Slug |
|------|-------------|
| merge | pdf-birlestir |
| compress | pdf-sikistir |
| split | pdf-bol |
| jpg2pdf | jpg-den-pdf-ye |
| pdf2jpg | pdf-den-jpg-ye |
| watermark | pdf-filigran |
| protect | pdf-koru |

## Special Notes for Turkish Audience

- **"Ücretsiz" not "Bedava"**: "Bedava" sounds too cheap/casual. "Ücretsiz" is the professional standard used by Turkish SaaS products.
- **"Filigran" not "Watermark"/"Damga"**: "Filigran" is the correct Turkish technical term. "Damga" means stamp/seal, not watermark.
- **KVKK/GDPR**: Do not claim legal compliance without a documented legal assessment. Describe local PDF processing instead.
- **File-size wording**: Avoid "Sınırsız", "Sınır yok" and "Herhangi bir limit yok" for file sizes. Use "Dosya boyutu sınırları geçerlidir" and check the tool's current cap.
- **Short sentences**: Turkish SaaS uses very direct, short sentences. No long relative clauses.
- **"Tarayıcınızda" construction**: "Your browser" in Turkish becomes "tarayıcınızda" (in your browser) — a commonly understood phrase that signals privacy and local processing.
- **ASCII slugs**: Turkish characters must be converted for URLs: birleştir→birlestir, sıkıştır→sikistir, böl→bol, etc.
