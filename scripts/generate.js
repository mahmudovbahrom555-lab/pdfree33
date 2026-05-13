#!/usr/bin/env node
/**
 * PDFree page generator
 *
 * Modes:
 *   node scripts/generate.js --check          validate all existing pages
 *   node scripts/generate.js --lang es        regenerate pages for one language
 *   node scripts/generate.js --all            regenerate all localized pages
 *   node scripts/generate.js --add-lang XX    generate a NEW language (e.g. --add-lang it)
 *   node scripts/generate.js --dry-run --all  show what would change without writing
 *
 * For existing pages the seo-article section is preserved verbatim.
 * For new pages a minimal placeholder article is generated.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const DATA_FILE = path.join(__dirname, 'site-data.json');
const data      = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const doAll   = args.includes('--all');
const doCheck = args.includes('--check');
const langArg = args.includes('--lang')     ? args[args.indexOf('--lang')     + 1] : null;
const newLang = args.includes('--add-lang') ? args[args.indexOf('--add-lang') + 1] : null;

if (!doCheck && !doAll && !langArg && !newLang) {
  console.error('Usage: node scripts/generate.js [--check] [--all] [--lang XX] [--add-lang XX] [--dry-run]');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const BASE = data.baseUrl;

/** URL for a tool in a given language */
function toolUrl(tool, lang) {
  const slug = tool.slugs[lang];
  if (!slug) return null;
  if (lang === 'en') return `${BASE}/${slug}/`;
  return `${BASE}/${lang}/${slug}/`;
}

/** Relative path prefix from a localized page back to root */
function prefix(lang) {
  return lang === 'en' ? '../' : '../../';
}

/** hreflang block for a tool */
function hreflang(tool) {
  const langs = Object.keys(data.languages);
  return langs.map(l => {
    const url = toolUrl(tool, l);
    if (!url) return '';
    const tag = l === 'en' ? 'en' : l;
    return `  <link rel="alternate" hreflang="${tag}" href="${url}">`;
  }).filter(Boolean).join('\n') +
  `\n  <link rel="alternate" hreflang="x-default" href="${toolUrl(tool, 'en')}">`;
}

/** Nav links for a given language */
function navLinks(currentTool, lang) {
  const NAV_TOOLS = ['merge','split','compress','jpg2pdf','watermark','metadata','protect'];
  return NAV_TOOLS.map(id => {
    const t = data.tools.find(x => x.id === id);
    if (!t || !t.slugs[lang]) return '';
    const url  = lang === 'en' ? `../${t.slugs[lang]}/` : `../../${lang}/${t.slugs[lang]}/`;
    const active = id === currentTool.id ? ' class="nav-link active"' : ' class="nav-link"';
    return `      <a href="${url}"${active} data-tool="${t.toolKey}">${t.navLabels[lang]}</a>`;
  }).filter(Boolean).join('\n');
}

/** Tools grid for a given language */
function toolsGrid(lang) {
  return data.tools.map(t => {
    if (!t.slugs[lang]) return '';
    const url     = lang === 'en' ? `${prefix(lang)}${t.slugs[lang]}/` : `../../${lang}/${t.slugs[lang]}/`;
    const featured = t.id === 'merge' ? ' featured' : '';
    return `      <a href="${url}" class="tool-card${featured}" data-tool="${t.toolKey}" aria-label="${t.cardNames[lang]}">
        <span class="tool-icon">${t.icon}</span>
        <div class="tool-name">${t.cardNames[lang]}</div>
        <div class="tool-desc">${t.cardDescs[lang]}</div>
      </a>`;
  }).filter(Boolean).join('\n');
}

/** JSON-LD schemas */
function jsonLD(tool, lang) {
  const url  = toolUrl(tool, lang);
  const name = tool.cardNames[lang];
  const desc = tool.descs[lang];
  const u    = data.ui[lang];
  const webapp = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name,
    description: desc,
    url,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Any',
    browserRequirements: 'Requires a modern browser with JavaScript enabled',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    featureList: [
      'No file upload required',
      '100% private — files processed locally',
      'No registration required',
      'Free forever'
    ]
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: u.faqQ1, acceptedAnswer: { '@type': 'Answer', text: u.faqA1 } },
      { '@type': 'Question', name: u.faqQ2, acceptedAnswer: { '@type': 'Answer', text: u.faqA2 } }
    ]
  };
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'PDFree', item: `${BASE}/` },
      ...(lang !== 'en' ? [{ '@type': 'ListItem', position: 2, name: lang.toUpperCase(), item: `${BASE}/${lang}/` }] : []),
      { '@type': 'ListItem', position: lang !== 'en' ? 3 : 2, name: tool.breadcrumb[lang], item: url }
    ]
  };
  const j = JSON.stringify;
  return [webapp, faq, breadcrumb].map(s =>
    `  <script type="application/ld+json">\n  ${j(s, null, 2)}\n  </script>`
  ).join('\n');
}

/** Default seo-article for new pages */
function defaultArticle(tool, lang) {
  const u = data.ui[lang];
  return `  <section class="seo-article" aria-labelledby="seoArticleTitle">
    <div class="seo-article__inner">
      <h2 id="seoArticleTitle">${u.seoH2}</h2>
      <p>${u.seoP1}</p>
      <p>${u.seoP2}</p>
      <h3>${u.faqTitle}</h3>
      <dl class="seo-faq">
        <dt>${u.faqQ1}</dt>
        <dd>${u.faqA1}</dd>
        <dt>${u.faqQ2}</dt>
        <dd>${u.faqA2}</dd>
      </dl>
    </div>
  </section>`;
}

/** Extract existing seo-article section from HTML, or null */
function extractArticle(html) {
  const m = html.match(/<section class="seo-article"[\s\S]*?<\/section>/);
  return m ? m[0] : null;
}

/** Build the full page HTML */
function buildPage(tool, lang, existingArticle) {
  const u      = data.ui[lang];
  const pre    = prefix(lang);
  const url    = toolUrl(tool, lang);
  const locale = data.languages[lang].locale;
  const article = existingArticle || defaultArticle(tool, lang);

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <!--
    ════════════════════════════════════════════════════════════════
    Content Security Policy — defence-in-depth against XSS
    ════════════════════════════════════════════════════════════════
  -->
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'self';
    script-src  'self'
                'wasm-unsafe-eval'
                blob:
                https://cdnjs.cloudflare.com
                https://esm.sh
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
  <title>${tool.titles[lang]}</title>
  <meta name="description" content="${tool.descs[lang]}">
  <meta property="og:title"       content="${tool.titles[lang]}">
  <meta property="og:description" content="${tool.descs[lang]}">
  <meta property="og:type"        content="website">
  <meta property="og:url"       content="${url}">
  <meta property="og:site_name" content="PDFree">
  <meta property="og:locale"    content="${locale}">
  <meta property="og:image"     content="${BASE}/icons/og-image.jpg">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="633">
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:site"        content="@pdfree_io">
  <meta name="twitter:image"       content="${BASE}/icons/og-image.jpg">
  <link rel="canonical" href="${url}">
${hreflang(tool)}

  <!-- PWA -->
  <link rel="manifest" href="${pre}manifest.json">
  <meta name="theme-color" content="#2D7A4F">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="PDFree">
  <link rel="apple-touch-icon" href="${pre}icons/icon-192.png">
  <link rel="icon" type="image/svg+xml" href="/icons/favicon.svg">

  <script defer data-domain="pdfree.io" src="https://plausible.io/js/script.js"></script>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap"></noscript>

  <link rel="stylesheet" href="${pre}css/variables.css">
  <link rel="stylesheet" href="${pre}css/animations.css">
  <link rel="stylesheet" href="${pre}css/layout.css">
  <link rel="stylesheet" href="${pre}css/components.css">

${jsonLD(tool, lang)}
</head>
<body>

  <nav>
    <a href="${pre}${lang === 'en' ? '' : lang + '/'}" class="logo" id="logo" aria-label="Go to homepage" style="text-decoration:none">PDF<span>ree</span></a>
    <div class="nav-links">
${navLinks(tool, lang)}
    </div>
  </nav>

  <!-- ── Hero ── -->
  <section id="hero" class="hero">
    <div class="hero-badge">${u.heroBadge}</div>
    <h1>${u.heroH1}</h1>
    <p>${u.heroP}</p>
  </section>

  <!-- ── Privacy banner ── -->
  <section class="privacy-banner" aria-label="Privacy promise">
    <div class="privacy-banner__icon" aria-hidden="true">🔒</div>
    <div class="privacy-banner__text">
      <strong>${u.privacyBannerStrong}</strong>
      ${u.privacyBannerText}
    </div>
  </section>

  <!-- ── No-limit bar ── -->
  <div id="noLimitBar" class="no-limit-bar">
    <div class="no-limit-item"><span>✓</span> ${u.noLimit[0]}</div>
    <div class="no-limit-item"><span>✓</span> ${u.noLimit[1]}</div>
    <div class="no-limit-item"><span>✓</span> ${u.noLimit[2]}</div>
    <div class="no-limit-item"><span>🔒</span> ${u.noLimit[3]}</div>
  </div>

  <!-- ── Tools grid ── -->
  <section id="toolsGrid" class="tools-section">
    <div class="section-label">${u.sectionLabel}</div>
    <div class="tools-grid">
${toolsGrid(lang)}
    </div>
  </section>

  <!-- ── Privacy trust bar ── -->
  <section class="privacy-bar" aria-label="Privacy guarantee">
    <div class="privacy-bar__inner">
      <div class="privacy-bar__item">
        <span class="privacy-bar__icon" aria-hidden="true">🔒</span>
        <div>
          <strong>${u.privacy1Title}</strong>
          <p>${u.privacy1Desc}</p>
        </div>
      </div>
      <div class="privacy-bar__item">
        <span class="privacy-bar__icon" aria-hidden="true">⚙️</span>
        <div>
          <strong>${u.privacy2Title}</strong>
          <p>${u.privacy2Desc}</p>
        </div>
      </div>
      <div class="privacy-bar__item">
        <span class="privacy-bar__icon" aria-hidden="true">🗑️</span>
        <div>
          <strong>${u.privacy3Title}</strong>
          <p>${u.privacy3Desc}</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ── Tool workspace ── -->
  <main id="toolArea" class="main-area" style="display:none" aria-busy="false">

    <div class="tool-header">
      <div class="tool-header-icon" id="toolIcon" aria-hidden="true">${tool.icon}</div>
      <div class="tool-header-text">
        <h2 id="toolTitle">${tool.titles[lang].split(' — ')[0]}</h2>
        <p  id="toolDesc">${tool.descs[lang]}</p>
      </div>
    </div>

    <div id="dropZone" class="drop-zone" tabindex="0" role="button" aria-label="${u.dropTitle}">
      <input type="file" id="fileInput" multiple accept=".pdf" aria-hidden="true">
      <span class="drop-icon" aria-hidden="true">📂</span>
      <div class="drop-title">${u.dropTitle}</div>
      <div class="drop-sub">${u.dropSub}</div>
      <button class="drop-btn" id="chooseFilesBtn" type="button">${u.chooseBtn}</button>
    </div>

    <div id="fileList"    class="file-list" aria-live="polite" aria-label="${u.dropTitle}"></div>
    <div id="fileCount"   class="file-count"   style="display:none"></div>
    <div id="reorderHint" class="reorder-hint" style="display:none">${u.reorderHint}</div>

    <div id="splitOptions"    class="split-options"   style="display:none"></div>
    <div id="compressOptions" class="compress-options" style="display:none"></div>
    <div id="jpg2pdfOptions"  class="j2p-options"     style="display:none"></div>
    <div id="pdf2jpgOptions"  class="j2p-options"     style="display:none"></div>
    <div id="watermarkOptions" class="j2p-options"    style="display:none"></div>
    <div id="pageNumOptions"  class="j2p-options"     style="display:none"></div>
    <div id="metaOptions"     class="j2p-options"     style="display:none"></div>
    <div id="protectOptions"  class="j2p-options"     style="display:none"></div>
    <div id="redactOptions"   class="j2p-options"     style="display:none"></div>
    <div id="rotateOptions"   class="j2p-options"     style="display:none"></div>

    <button id="mergeBtn"  class="merge-btn"  type="button" disabled data-mode="process">${tool.cardNames[lang]}</button>
    <button id="cancelBtn" class="cancel-btn" type="button" style="display:none" aria-label="${u.cancelBtn}">${u.cancelBtn}</button>

    <div id="progressBar"   class="progress-bar"><div id="progressFill" class="progress-fill"></div></div>
    <div id="progressLabel" class="progress-label"></div>

    <div id="successCard" class="success-card" role="alert" aria-live="polite" style="display:none">
      <div class="success-top">
        <div class="success-icon" aria-hidden="true">✓</div>
        <div class="success-text">
          <h3 id="successTitle">${u.successTitle}</h3>
          <p  id="successDesc"></p>
        </div>
        <button id="downloadBtn" class="download-btn" type="button">${u.downloadBtn}</button>
      </div>
    </div>

  </main>

${article}

  <footer>
    PDFree · <strong>${u.footerLine1}</strong> · ${u.footerLine2}<br>
    <span style="color:var(--green)">🔒</span> ${u.footerGuarantee} &nbsp;·&nbsp;
    <span style="color:var(--green)">♥</span> ${u.footerFree}<br>
    <span style="font-size:11px;margin-top:8px;display:inline-block;color:var(--text3)">
      ${u.footerOpenSource}
      <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener" style="color:var(--green)">GNU AGPLv3</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/mahmudovbahrom555-lab/PDFree" target="_blank" rel="noopener" style="color:var(--green)">${u.footerGitHub}</a>
    </span>
  </footer>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script type="module" src="${pre}js/app.js?v=${data.appJsVersion}"></script>
<!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "${data.cfToken}"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>
`;
}

// ── Check mode ────────────────────────────────────────────────────────────────
function check() {
  let errors = 0, ok = 0;
  for (const lang of Object.keys(data.languages)) {
    if (lang === 'en') continue;
    for (const tool of data.tools) {
      if (!tool.slugs[lang]) continue;
      const fpath = path.join(ROOT, lang, tool.slugs[lang], 'index.html');
      if (!fs.existsSync(fpath)) { console.error(`MISSING: ${lang}/${tool.slugs[lang]}/index.html`); errors++; continue; }
      const html = fs.readFileSync(fpath, 'utf8');
      const hreflangCount = (html.match(/hreflang=/g) || []).length;
      const hasSchema     = html.includes('application/ld+json');
      const hasCanonical  = html.includes(`canonical" href="${BASE}/${lang}/`);
      const badDefault    = html.match(/x-default.*href="[^"]*\/(es|pt|de|fr)\//);
      const issues = [];
      if (hreflangCount < 6) issues.push(`hreflang:${hreflangCount}/6`);
      if (!hasSchema)        issues.push('no-JSON-LD');
      if (!hasCanonical)     issues.push('bad-canonical');
      if (badDefault)        issues.push('x-default→localized');
      if (issues.length) { console.error(`FAIL [${lang}/${tool.slugs[lang]}]: ${issues.join(', ')}`); errors++; }
      else { ok++; }
    }
  }
  console.log(`\nCheck complete: ${ok} OK, ${errors} errors`);
  process.exit(errors ? 1 : 0);
}

// ── Generate mode ─────────────────────────────────────────────────────────────
function generate(langs) {
  let updated = 0, unchanged = 0, created = 0;
  for (const lang of langs) {
    if (!data.ui[lang]) { console.error(`No UI data for lang: ${lang}`); continue; }
    for (const tool of data.tools) {
      if (!tool.slugs[lang]) continue;
      const dir   = lang === 'en' ? path.join(ROOT, tool.slugs[lang]) : path.join(ROOT, lang, tool.slugs[lang]);
      const fpath = path.join(dir, 'index.html');
      const isNew = !fs.existsSync(fpath);

      let existingArticle = null;
      if (!isNew) {
        const old = fs.readFileSync(fpath, 'utf8');
        existingArticle = extractArticle(old);
      }

      const html = buildPage(tool, lang, existingArticle);

      if (isNew) {
        if (!dryRun) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(fpath, html); }
        console.log(`CREATE: ${lang}/${tool.slugs[lang]}/index.html`);
        created++;
      } else {
        const old = fs.readFileSync(fpath, 'utf8');
        if (old === html) { unchanged++; continue; }
        if (!dryRun) fs.writeFileSync(fpath, html);
        console.log(`${dryRun ? 'WOULD UPDATE' : 'UPDATE'}: ${lang}/${tool.slugs[lang]}/index.html`);
        updated++;
      }
    }
  }
  console.log(`\nDone: ${created} created, ${updated} updated, ${unchanged} unchanged${dryRun ? ' (dry-run)' : ''}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────
if (doCheck) {
  check();
} else if (newLang) {
  if (!data.ui[newLang]) {
    console.error(`Add ui.${newLang} to site-data.json first, then run again.`);
    process.exit(1);
  }
  generate([newLang]);
} else if (langArg) {
  generate([langArg]);
} else if (doAll) {
  const langs = Object.keys(data.languages).filter(l => l !== 'en');
  generate(langs);
}
