#!/usr/bin/env python3
"""
PDFree page generator

Usage:
  python3 scripts/generate.py --check          validate all existing pages
  python3 scripts/generate.py --lang es        regenerate pages for one language
  python3 scripts/generate.py --all            regenerate all localized pages
  python3 scripts/generate.py --add-lang XX    generate a NEW language (add data first)
  python3 scripts/generate.py --dry-run --all  show what would change without writing

For existing pages the seo-article section is preserved verbatim.
For new pages a minimal placeholder article is generated.
"""
import json, os, re, sys, argparse

ROOT      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_FILE = os.path.join(ROOT, "scripts", "site-data.json")

with open(DATA_FILE, encoding="utf-8") as f:
    data = json.load(f)

BASE     = data["baseUrl"]
CF_TOKEN = data["cfToken"]
APP_VER  = data["appJsVersion"]
LANGS    = data["languages"]
TOOLS    = data["tools"]
UI       = data["ui"]


# ── Helpers ───────────────────────────────────────────────────────────────────

def tool_url(tool, lang):
    slug = tool["slugs"].get(lang)
    if not slug:
        return None
    if lang == "en":
        return f"{BASE}/{slug}/"
    return f"{BASE}/{lang}/{slug}/"


def prefix(lang):
    return "../" if lang == "en" else "../../"


def hreflang_block(tool):
    lines = []
    for lang in LANGS:
        url = tool_url(tool, lang)
        if not url:
            continue
        lines.append(f'  <link rel="alternate" hreflang="{lang}" href="{url}">')
    lines.append(f'  <link rel="alternate" hreflang="x-default" href="{tool_url(tool, "en")}">')
    return "\n".join(lines)


NAV_TOOLS = ["merge", "split", "compress", "jpg2pdf", "watermark", "metadata", "protect"]

def nav_links(current_tool, lang):
    lines = []
    for tid in NAV_TOOLS:
        t = next((x for x in TOOLS if x["id"] == tid), None)
        if not t or not t["slugs"].get(lang):
            continue
        slug = t["slugs"][lang]
        url  = f"../{slug}/" if lang == "en" else f"../../{lang}/{slug}/"
        cls  = 'class="nav-link active"' if tid == current_tool["id"] else 'class="nav-link"'
        label = t["navLabels"][lang]
        lines.append(f'      <a href="{url}" {cls} data-tool="{t["toolKey"]}">{label}</a>')
    return "\n".join(lines)


def tools_grid(lang):
    pre = prefix(lang)
    lines = []
    for t in TOOLS:
        if not t["slugs"].get(lang):
            continue
        slug = t["slugs"][lang]
        url  = f"{pre}{slug}/" if lang == "en" else f"../../{lang}/{slug}/"
        featured = " featured" if t["id"] == "merge" else ""
        name = t["cardNames"][lang]
        desc = t["cardDescs"][lang]
        icon = t["icon"]
        key  = t["toolKey"]
        lines.append(
            f'      <a href="{url}" class="tool-card{featured}" data-tool="{key}" aria-label="{name}">\n'
            f'        <span class="tool-icon">{icon}</span>\n'
            f'        <div class="tool-name">{name}</div>\n'
            f'        <div class="tool-desc">{desc}</div>\n'
            f'      </a>'
        )
    return "\n".join(lines)


def json_ld(tool, lang):
    url  = tool_url(tool, lang)
    name = tool["cardNames"][lang]
    desc = tool["descs"][lang]
    u    = UI[lang]

    webapp = {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": name,
        "description": desc,
        "url": url,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires a modern browser with JavaScript enabled",
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "featureList": [
            "No file upload required",
            "100% private — files processed locally",
            "No registration required",
            "Free forever"
        ]
    }
    faq = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {"@type": "Question", "name": u["faqQ1"],
             "acceptedAnswer": {"@type": "Answer", "text": u["faqA1"]}},
            {"@type": "Question", "name": u["faqQ2"],
             "acceptedAnswer": {"@type": "Answer", "text": u["faqA2"]}}
        ]
    }
    breadcrumb_items = [
        {"@type": "ListItem", "position": 1, "name": "PDFree", "item": f"{BASE}/"}
    ]
    if lang != "en":
        breadcrumb_items.append(
            {"@type": "ListItem", "position": 2, "name": lang.upper(), "item": f"{BASE}/{lang}/"}
        )
    breadcrumb_items.append(
        {"@type": "ListItem",
         "position": 3 if lang != "en" else 2,
         "name": tool["breadcrumb"][lang],
         "item": url}
    )
    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": breadcrumb_items
    }

    blocks = []
    for schema in [webapp, faq, breadcrumb]:
        j = json.dumps(schema, ensure_ascii=False, indent=2)
        blocks.append(f'  <script type="application/ld+json">\n  {j}\n  </script>')
    return "\n".join(blocks)


def default_article(tool, lang):
    u = UI[lang]
    return (
        f'  <section class="seo-article" aria-labelledby="seoArticleTitle">\n'
        f'    <div class="seo-article__inner">\n'
        f'      <h2 id="seoArticleTitle">{u["seoH2"]}</h2>\n'
        f'      <p>{u["seoP1"]}</p>\n'
        f'      <p>{u["seoP2"]}</p>\n'
        f'      <h3>{u["faqTitle"]}</h3>\n'
        f'      <dl class="seo-faq">\n'
        f'        <dt>{u["faqQ1"]}</dt>\n'
        f'        <dd>{u["faqA1"]}</dd>\n'
        f'        <dt>{u["faqQ2"]}</dt>\n'
        f'        <dd>{u["faqA2"]}</dd>\n'
        f'      </dl>\n'
        f'    </div>\n'
        f'  </section>'
    )


def extract_article(html):
    m = re.search(r'<section class="seo-article"[\s\S]*?</section>', html)
    return m.group(0) if m else None


def build_page(tool, lang, existing_article):
    u       = UI[lang]
    pre     = prefix(lang)
    url     = tool_url(tool, lang)
    locale  = LANGS[lang]["locale"]
    article = existing_article or default_article(tool, lang)
    title_short = tool["titles"][lang].split(" — ")[0]

    return f"""<!DOCTYPE html>
<html lang="{lang}">
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
  <title>{tool["titles"][lang]}</title>
  <meta name="description" content="{tool["descs"][lang]}">
  <meta property="og:title"       content="{tool["titles"][lang]}">
  <meta property="og:description" content="{tool["descs"][lang]}">
  <meta property="og:type"        content="website">
  <meta property="og:url"       content="{url}">
  <meta property="og:site_name" content="PDFree">
  <meta property="og:locale"    content="{locale}">
  <meta property="og:image"     content="{BASE}/icons/og-image.jpg">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="633">
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:site"        content="@pdfree_io">
  <meta name="twitter:image"       content="{BASE}/icons/og-image.jpg">
  <link rel="canonical" href="{url}">
{hreflang_block(tool)}

  <!-- PWA -->
  <link rel="manifest" href="{pre}manifest.json">
  <meta name="theme-color" content="#2D7A4F">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="PDFree">
  <link rel="apple-touch-icon" href="{pre}icons/icon-192.png">
  <link rel="icon" type="image/svg+xml" href="/icons/favicon.svg">

  <script defer data-domain="pdfree.io" src="https://plausible.io/js/script.js"></script>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="preload" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap" as="style" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap"></noscript>

  <link rel="stylesheet" href="{pre}css/variables.css">
  <link rel="stylesheet" href="{pre}css/animations.css">
  <link rel="stylesheet" href="{pre}css/layout.css">
  <link rel="stylesheet" href="{pre}css/components.css">

{json_ld(tool, lang)}
</head>
<body>

  <nav>
    <a href="{pre}{"" if lang == "en" else lang + "/"}" class="logo" id="logo" aria-label="Go to homepage" style="text-decoration:none">PDF<span>ree</span></a>
    <div class="nav-links">
{nav_links(tool, lang)}
    </div>
  </nav>

  <!-- ── Hero ── -->
  <section id="hero" class="hero">
    <div class="hero-badge">{u["heroBadge"]}</div>
    <h1>{u["heroH1"]}</h1>
    <p>{u["heroP"]}</p>
  </section>

  <!-- ── Privacy banner ── -->
  <section class="privacy-banner" aria-label="Privacy promise">
    <div class="privacy-banner__icon" aria-hidden="true">🔒</div>
    <div class="privacy-banner__text">
      <strong>{u["privacyBannerStrong"]}</strong>
      {u["privacyBannerText"]}
    </div>
  </section>

  <!-- ── No-limit bar ── -->
  <div id="noLimitBar" class="no-limit-bar">
    <div class="no-limit-item"><span>✓</span> {u["noLimit"][0]}</div>
    <div class="no-limit-item"><span>✓</span> {u["noLimit"][1]}</div>
    <div class="no-limit-item"><span>✓</span> {u["noLimit"][2]}</div>
    <div class="no-limit-item"><span>🔒</span> {u["noLimit"][3]}</div>
  </div>

  <!-- ── Tools grid ── -->
  <section id="toolsGrid" class="tools-section">
    <div class="section-label">{u["sectionLabel"]}</div>
    <div class="tools-grid">
{tools_grid(lang)}
    </div>
  </section>

  <!-- ── Privacy trust bar ── -->
  <section class="privacy-bar" aria-label="Privacy guarantee">
    <div class="privacy-bar__inner">
      <div class="privacy-bar__item">
        <span class="privacy-bar__icon" aria-hidden="true">🔒</span>
        <div>
          <strong>{u["privacy1Title"]}</strong>
          <p>{u["privacy1Desc"]}</p>
        </div>
      </div>
      <div class="privacy-bar__item">
        <span class="privacy-bar__icon" aria-hidden="true">⚙️</span>
        <div>
          <strong>{u["privacy2Title"]}</strong>
          <p>{u["privacy2Desc"]}</p>
        </div>
      </div>
      <div class="privacy-bar__item">
        <span class="privacy-bar__icon" aria-hidden="true">🗑️</span>
        <div>
          <strong>{u["privacy3Title"]}</strong>
          <p>{u["privacy3Desc"]}</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ── Tool workspace ── -->
  <main id="toolArea" class="main-area" style="display:none" aria-busy="false">

    <div class="tool-header">
      <div class="tool-header-icon" id="toolIcon" aria-hidden="true">{tool["icon"]}</div>
      <div class="tool-header-text">
        <h2 id="toolTitle">{title_short}</h2>
        <p  id="toolDesc">{tool["descs"][lang]}</p>
      </div>
    </div>

    <div id="dropZone" class="drop-zone" tabindex="0" role="button" aria-label="{u["dropTitle"]}">
      <input type="file" id="fileInput" multiple accept=".pdf" aria-hidden="true">
      <span class="drop-icon" aria-hidden="true">📂</span>
      <div class="drop-title">{u["dropTitle"]}</div>
      <div class="drop-sub">{u["dropSub"]}</div>
      <button class="drop-btn" id="chooseFilesBtn" type="button">{u["chooseBtn"]}</button>
    </div>

    <div id="fileList"     class="file-list"    aria-live="polite" aria-label="{u["dropTitle"]}"></div>
    <div id="fileCount"    class="file-count"   style="display:none"></div>
    <div id="reorderHint"  class="reorder-hint" style="display:none">{u["reorderHint"]}</div>

    <div id="splitOptions"     class="split-options"    style="display:none"></div>
    <div id="compressOptions"  class="compress-options" style="display:none"></div>
    <div id="jpg2pdfOptions"   class="j2p-options"      style="display:none"></div>
    <div id="pdf2jpgOptions"   class="j2p-options"      style="display:none"></div>
    <div id="watermarkOptions" class="j2p-options"      style="display:none"></div>
    <div id="pageNumOptions"   class="j2p-options"      style="display:none"></div>
    <div id="metaOptions"      class="j2p-options"      style="display:none"></div>
    <div id="protectOptions"   class="j2p-options"      style="display:none"></div>
    <div id="redactOptions"    class="j2p-options"      style="display:none"></div>
    <div id="rotateOptions"    class="j2p-options"      style="display:none"></div>

    <button id="mergeBtn"  class="merge-btn"  type="button" disabled data-mode="process">{tool["cardNames"][lang]}</button>
    <button id="cancelBtn" class="cancel-btn" type="button" style="display:none" aria-label="{u["cancelBtn"]}">{u["cancelBtn"]}</button>

    <div id="progressBar"   class="progress-bar"><div id="progressFill" class="progress-fill"></div></div>
    <div id="progressLabel" class="progress-label"></div>

    <div id="successCard" class="success-card" role="alert" aria-live="polite" style="display:none">
      <div class="success-top">
        <div class="success-icon" aria-hidden="true">✓</div>
        <div class="success-text">
          <h3 id="successTitle">{u["successTitle"]}</h3>
          <p  id="successDesc"></p>
        </div>
        <button id="downloadBtn" class="download-btn" type="button">{u["downloadBtn"]}</button>
      </div>
    </div>

  </main>

{article}

  <footer>
    PDFree · <strong>{u["footerLine1"]}</strong> · {u["footerLine2"]}<br>
    <span style="color:var(--green)">🔒</span> {u["footerGuarantee"]} &nbsp;·&nbsp;
    <span style="color:var(--green)">♥</span> {u["footerFree"]}<br>
    <span style="font-size:11px;margin-top:8px;display:inline-block;color:var(--text3)">
      {u["footerOpenSource"]}
      <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener" style="color:var(--green)">GNU AGPLv3</a>
      &nbsp;·&nbsp;
      <a href="https://github.com/mahmudovbahrom555-lab/PDFree" target="_blank" rel="noopener" style="color:var(--green)">{u["footerGitHub"]}</a>
    </span>
  </footer>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script type="module" src="{pre}js/app.js?v={APP_VER}"></script>
<!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{{"token": "{CF_TOKEN}"}}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>
"""


# ── Check mode ────────────────────────────────────────────────────────────────

def check():
    errors = ok = 0
    for lang in LANGS:
        if lang == "en":
            continue
        for tool in TOOLS:
            if not tool["slugs"].get(lang):
                continue
            fpath = os.path.join(ROOT, lang, tool["slugs"][lang], "index.html")
            if not os.path.exists(fpath):
                print(f"MISSING: {lang}/{tool['slugs'][lang]}/index.html")
                errors += 1
                continue
            with open(fpath, encoding="utf-8") as f:
                html = f.read()
            hreflang_count = html.count("hreflang=")
            has_schema     = "application/ld+json" in html
            has_canonical  = f'canonical" href="{BASE}/{lang}/' in html
            bad_default    = re.search(r'x-default.*href="[^"]*/(?:es|pt|de|fr)/', html)
            issues = []
            if hreflang_count < 6:   issues.append(f"hreflang:{hreflang_count}/6")
            if not has_schema:       issues.append("no-JSON-LD")
            if not has_canonical:    issues.append("bad-canonical")
            if bad_default:          issues.append("x-default→localized")
            if issues:
                print(f"FAIL [{lang}/{tool['slugs'][lang]}]: {', '.join(issues)}")
                errors += 1
            else:
                ok += 1
    print(f"\nCheck complete: {ok} OK, {errors} errors")
    return errors


# ── Generate mode ─────────────────────────────────────────────────────────────

def generate(langs, dry_run=False):
    updated = unchanged = created = 0
    for lang in langs:
        if lang not in UI:
            print(f"ERROR: No ui.{lang} in site-data.json — add it first")
            continue
        for tool in TOOLS:
            if not tool["slugs"].get(lang):
                continue
            slug  = tool["slugs"][lang]
            if lang == "en":
                dirpath = os.path.join(ROOT, slug)
            else:
                dirpath = os.path.join(ROOT, lang, slug)
            fpath = os.path.join(dirpath, "index.html")
            is_new = not os.path.exists(fpath)

            existing_article = None
            if not is_new:
                with open(fpath, encoding="utf-8") as f:
                    old_html = f.read()
                existing_article = extract_article(old_html)

            new_html = build_page(tool, lang, existing_article)

            if is_new:
                if not dry_run:
                    os.makedirs(dirpath, exist_ok=True)
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(new_html)
                print(f"CREATE: {lang}/{slug}/index.html")
                created += 1
            else:
                if old_html == new_html:
                    unchanged += 1
                    continue
                if not dry_run:
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(new_html)
                action = "WOULD UPDATE" if dry_run else "UPDATE"
                print(f"{action}: {lang}/{slug}/index.html")
                updated += 1

    suffix = " (dry-run)" if dry_run else ""
    print(f"\nDone: {created} created, {updated} updated, {unchanged} unchanged{suffix}")


# ── Entry point ───────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument("--check",    action="store_true")
parser.add_argument("--all",      action="store_true")
parser.add_argument("--lang",     type=str)
parser.add_argument("--add-lang", type=str, dest="add_lang")
parser.add_argument("--dry-run",  action="store_true", dest="dry_run")
opts = parser.parse_args()

if opts.check:
    sys.exit(check())
elif opts.add_lang:
    if opts.add_lang not in UI:
        print(f"Add ui.{opts.add_lang} to site-data.json first, then run again.")
        sys.exit(1)
    generate([opts.add_lang], opts.dry_run)
elif opts.lang:
    generate([opts.lang], opts.dry_run)
elif opts.all:
    langs = [l for l in LANGS if l != "en"]
    generate(langs, opts.dry_run)
else:
    parser.print_help()
    sys.exit(1)
