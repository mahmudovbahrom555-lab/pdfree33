#!/usr/bin/env python3
"""
SSG build script for PDFree.

Generates all 60 tool pages from templates + data, then copies static assets
into dist/. One command produces a deployable directory.

Usage:
    python3 scripts/build.py           — full build into dist/
    python3 scripts/build.py --check   — dry run (render only, no write)

Output: dist/
  ├── {tool-slug}/index.html           (12 EN tool pages)
  ├── {lang}/{tool-slug}/index.html    (48 DE/ES/FR/PT tool pages)
  ├── index.html  de/ es/ fr/ pt/      (homepages, copied as-is)
  ├── css/ js/ fonts/ icons/           (static assets)
  ├── manifest.json  sw.js  favicon.ico
  └── sitemap.xml                      (auto-generated)
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import date

try:
    from jinja2 import Environment, FileSystemLoader, select_autoescape
except ImportError:
    print('ERROR: jinja2 not installed. Run: pip3 install jinja2', file=sys.stderr)
    sys.exit(1)

ROOT      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST      = os.path.join(ROOT, 'dist')
DATA      = os.path.join(ROOT, 'data')
TEMPLATES = os.path.join(ROOT, 'scripts', 'templates')
CONFIG    = os.path.join(DATA, 'tools-config.json')
CONTENT   = os.path.join(DATA, 'content')

BASE_URL = 'https://pdfree.io'

# Dirs/files to skip when copying root → dist
SKIP_DIRS = {
    '.git', 'node_modules', '.wrangler', '.claude', '.husky',
    'dist', 'data', 'scripts',
    # Short-slug source dirs superseded by keyword-rich SSG pages
    'compress-pdf', 'merge-pdf',
}
SKIP_FILES = {
    'wrangler.toml', '.assetsignore', 'eslint.config.js',
    'package-lock.json', '.gitignore', 'vercel.json',
    'CONTRIBUTING.md', 'LICENSE', 'README.md',
    '3c51839cdd6944c79259fdf6a0c383cc.txt',
}
SKIP_EXTS = {'.py', '.toml', '.local'}


# ── Asset hashing ────────────────────────────────────────────────────────────

def _md5_short(path, length=8):
    """Return first N chars of MD5 hash of file content."""
    if not os.path.exists(path):
        return 'missing'
    with open(path, 'rb') as f:
        return hashlib.md5(f.read()).hexdigest()[:length]


def _compute_hashes():
    return {
        'app':           _md5_short(os.path.join(ROOT, 'js', 'app.js')),
        'worker':        _md5_short(os.path.join(ROOT, 'js', 'worker.js')),
        'components_css': _md5_short(os.path.join(ROOT, 'css', 'components.css')),
    }


# ── Hreflang ─────────────────────────────────────────────────────────────────

def _hreflang_links(tool, config):
    """Return list of (lang_code, absolute_url) for all languages."""
    links = []
    for lang_code, lang_cfg in config['languages'].items():
        slug = tool['slugs'].get(lang_code)
        if not slug:
            continue
        if lang_code == 'en':
            url = f"{BASE_URL}/{slug}/"
        else:
            url = f"{BASE_URL}/{lang_cfg['dir']}/{slug}/"
        links.append((lang_code, url))
    return links


# ── Schema builders ───────────────────────────────────────────────────────────

def _webapp_schema(tool, lang, canonical_path):
    return json.dumps({
        "@context": "https://schema.org",
        "@type": "WebApplication",
        "name": tool['breadcrumb'][lang],
        "description": tool['metaDescs'].get(lang, tool['descs'][lang]),
        "url": f"{BASE_URL}/{canonical_path}",
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any",
        "browserRequirements": "Requires a modern browser with JavaScript enabled",
        "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
        "featureList": [
            "No file upload required",
            "100% private — files processed locally",
            "No account or signup needed",
            "No file size limits",
            "Works offline",
        ],
        "provider": {"@type": "Organization", "name": "PDFree", "url": "https://pdfree.io"},
    }, indent=2, ensure_ascii=False)


def _faq_schema(faq_items):
    return json.dumps({
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": faq_items,
    }, indent=2, ensure_ascii=False)


def _breadcrumb_schema(tool, lang, lang_cfg, canonical_path):
    items = [{"@type": "ListItem", "position": 1, "name": "PDFree", "item": "https://pdfree.io/"}]
    if lang != 'en':
        items.append({
            "@type": "ListItem", "position": 2,
            "name": lang_cfg['code'].upper(),
            "item": f"{BASE_URL}/{lang_cfg['dir']}/",
        })
        items.append({
            "@type": "ListItem", "position": 3,
            "name": tool['breadcrumb'][lang],
            "item": f"{BASE_URL}/{canonical_path}",
        })
    else:
        items.append({
            "@type": "ListItem", "position": 2,
            "name": tool['breadcrumb'][lang],
            "item": f"{BASE_URL}/{canonical_path}",
        })
    return json.dumps({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": items,
    }, indent=2, ensure_ascii=False)


# ── Content loading ───────────────────────────────────────────────────────────

def _load_content(tool_id, lang):
    """Load seo HTML + FAQ items for one tool/language pair."""
    seo_path = os.path.join(CONTENT, lang, f'{tool_id}.html')
    faq_path = os.path.join(CONTENT, lang, f'{tool_id}-faq.json')

    seo_html = ''
    if os.path.exists(seo_path):
        seo_html = open(seo_path, encoding='utf-8').read().strip()

    faq_items = []
    if os.path.exists(faq_path):
        faq_items = json.load(open(faq_path, encoding='utf-8'))

    return seo_html, faq_items


# ── Sitemap ───────────────────────────────────────────────────────────────────

def _git_lastmod(rel_path):
    """Return YYYY-MM-DD of the last git commit that touched rel_path.
    Falls back to today if the file has no git history (new/untracked)."""
    try:
        out = subprocess.check_output(
            ['git', 'log', '-1', '--format=%cI', '--', rel_path],
            cwd=ROOT,
            stderr=subprocess.DEVNULL,
        ).decode().strip()
        if out:
            return out[:10]
    except Exception:
        pass
    return date.today().isoformat()


SPECIALTY_PAGES = [
    'annotate-pdf',
    'highlight-pdf',
    'hipaa-pdf-tools',
    'ilovepdf-alternative',
    'merge-pdf-without-uploading',
    'secure-pdf-tools',
    'sign',
    'blog/how-to-annotate-pdf-on-mobile',
    'blog/how-to-fill-pdf-form',
    'blog/how-to-sign-pdf-free',
]


def _write_sitemap(config, out_dir):
    """Generate sitemap.xml with hreflang alternate links for all languages.
    lastmod reflects the last git commit date so Google only re-crawls changed pages."""

    langs = config['languages']  # ordered: en first
    lang_codes = list(langs.keys())

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ]

    def _url_block(loc, lastmod, alternates):
        """alternates: list of (hreflang, href)"""
        block = ['  <url>',
                 f'    <loc>{loc}</loc>',
                 f'    <lastmod>{lastmod}</lastmod>']
        for lang, href in alternates:
            block.append(f'    <xhtml:link rel="alternate" hreflang="{lang}" href="{href}"/>')
        block.append('  </url>')
        return block

    # ── Homepages ──────────────────────────────────────────────
    homepage_alts = [(lc if lc != 'en' else 'en', f"{BASE_URL}/{cfg['dir']}/" if lc != 'en' else f"{BASE_URL}/")
                     for lc, cfg in langs.items()]
    homepage_alts.append(('x-default', f'{BASE_URL}/'))
    lines += _url_block(f'{BASE_URL}/', _git_lastmod('index.html'), homepage_alts)

    # ── Tool pages ─────────────────────────────────────────────
    for tool in config['tools']:
        en_slug = tool['slugs'].get('en')
        if not en_slug:
            continue
        en_url = f"{BASE_URL}/{en_slug}/"
        lastmod = _git_lastmod(f"data/content/en/{tool['id']}.html")

        alts = []
        for lc, cfg in langs.items():
            slug = tool['slugs'].get(lc)
            if not slug:
                continue
            href = f"{BASE_URL}/{slug}/" if lc == 'en' else f"{BASE_URL}/{cfg['dir']}/{slug}/"
            alts.append((lc, href))
        alts.append(('x-default', en_url))
        lines += _url_block(en_url, lastmod, alts)

    # ── Specialty / SEO pages (EN only) ───────────────────────
    for slug in SPECIALTY_PAGES:
        url = f"{BASE_URL}/{slug}/"
        lines += _url_block(url, _git_lastmod(f"{slug}/index.html"), [('en', url), ('x-default', url)])

    lines.append('</urlset>')

    sitemap_path = os.path.join(out_dir, 'sitemap.xml')
    with open(sitemap_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'  sitemap.xml  ({sum(1 for l in lines if "<loc>" in l)} URLs, hreflang included)')


# ── Hash injection ────────────────────────────────────────────────────────────

def _inject_hashes(hashes, out_dir):
    """Replace __APP_HASH__, __WORKER_HASH__, __CSS_HASH__ placeholders in
    dist/sw.js and dist/js/processor.js, and append ?v=HASH to app.js script
    tags in all dist/**/*.html so the browser HTTP cache is busted on deploy."""
    targets = [
        os.path.join(out_dir, 'sw.js'),
        os.path.join(out_dir, 'js', 'processor.js'),
    ]
    replacements = {
        '__APP_HASH__':    hashes['app'],
        '__WORKER_HASH__': hashes['worker'],
        '__CSS_HASH__':    hashes['components_css'],
    }
    for path in targets:
        if not os.path.exists(path):
            print(f'  WARN: {path} not found, skipping injection')
            continue
        content = open(path, encoding='utf-8').read()
        for token, value in replacements.items():
            content = content.replace(token, value)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
    injected = [os.path.relpath(t, out_dir) for t in targets if os.path.exists(t)]
    print(f'  hash-injected: {injected}')

    # Inject version hash into every HTML file's app.js script tag.
    # Without this, Cache-Control: immutable on /js/* causes browsers to serve
    # the old app.js for up to a year even after a deployment.
    app_hash = hashes['app']
    html_count = 0
    for root, _dirs, files in os.walk(out_dir):
        for fname in files:
            if not fname.endswith('.html'):
                continue
            path = os.path.join(root, fname)
            content = open(path, encoding='utf-8').read()
            # Match all relative/absolute variants: ../js/app.js, js/app.js, /js/app.js
            new_content = content.replace(
                'app.js"', f'app.js?v={app_hash}"'
            )
            if new_content != content:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(new_content)
                html_count += 1
    print(f'  app.js?v={app_hash} injected into {html_count} HTML files')


# ── Static asset copy ─────────────────────────────────────────────────────────

def _should_skip(name, is_dir):
    if is_dir:
        return name in SKIP_DIRS
    if name in SKIP_FILES:
        return True
    _, ext = os.path.splitext(name)
    return ext in SKIP_EXTS


def _copy_static(src_root, dst_root, tool_dirs):
    """Copy everything from src_root to dst_root, skipping SSG-generated tool dirs."""
    copied = 0
    for entry in os.scandir(src_root):
        name = entry.name
        if name.startswith('.') and name not in {'.well-known'}:
            continue
        if _should_skip(name, entry.is_dir()):
            continue
        # Skip tool directories that will be generated
        if entry.is_dir() and name in tool_dirs:
            continue

        dst = os.path.join(dst_root, name)
        if entry.is_dir():
            # Deep copy directory, still skipping tool subdirs inside lang dirs
            _copy_dir_filtered(entry.path, dst, tool_dirs)
        else:
            os.makedirs(dst_root, exist_ok=True)
            shutil.copy2(entry.path, dst)
            copied += 1
    return copied


def _copy_dir_filtered(src, dst, tool_dirs):
    """Recursively copy a directory, skipping generated tool sub-dirs."""
    os.makedirs(dst, exist_ok=True)
    for entry in os.scandir(src):
        name = entry.name
        if name.startswith('.'):
            continue
        if _should_skip(name, entry.is_dir()):
            continue
        if entry.is_dir() and name in tool_dirs:
            continue
        dst_path = os.path.join(dst, name)
        if entry.is_dir():
            _copy_dir_filtered(entry.path, dst_path, tool_dirs)
        else:
            shutil.copy2(entry.path, dst_path)


# ── Tool page generation ──────────────────────────────────────────────────────

def _generate_pages(config, hashes, env, out_dir, dry_run=False):
    tmpl = env.get_template('tool-page.html')
    langs = config['languages']
    all_tools = config['tools']
    ui_all = config['ui']
    generated = 0

    for tool in all_tools:
        for lang, lang_cfg in langs.items():
            slug = tool['slugs'].get(lang)
            if not slug:
                continue

            if lang == 'en':
                canonical_path = f"{slug}/"
                prefix = '../'
            else:
                canonical_path = f"{lang_cfg['dir']}/{slug}/"
                prefix = '../../'

            seo_content, faq_items = _load_content(tool['id'], lang)
            hreflang = _hreflang_links(tool, config)

            html = tmpl.render(
                tool           = tool,
                lang           = lang,
                lang_cfg       = lang_cfg,
                prefix         = prefix,
                canonical_path = canonical_path,
                base_url       = BASE_URL,
                hreflang_links = hreflang,
                all_tools      = all_tools,
                ui             = ui_all[lang],
                seo_content    = seo_content,
                faq_items      = faq_items,
                webapp_schema  = _webapp_schema(tool, lang, canonical_path),
                faq_schema     = _faq_schema(faq_items) if faq_items else '',
                breadcrumb_schema = _breadcrumb_schema(tool, lang, lang_cfg, canonical_path),
                hashes         = type('H', (), hashes)(),  # dict → attr access
            )

            if not dry_run:
                if lang == 'en':
                    page_dir = os.path.join(out_dir, slug)
                else:
                    page_dir = os.path.join(out_dir, lang_cfg['dir'], slug)
                os.makedirs(page_dir, exist_ok=True)
                with open(os.path.join(page_dir, 'index.html'), 'w', encoding='utf-8') as f:
                    f.write(html)

            generated += 1

    return generated


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    dry_run = '--check' in sys.argv

    with open(CONFIG, encoding='utf-8') as f:
        config = json.load(f)

    # Build set of all tool directory names to skip during static copy
    tool_dirs = set()
    for tool in config['tools']:
        for lang, lang_cfg in config['languages'].items():
            slug = tool['slugs'].get(lang)
            if slug:
                tool_dirs.add(slug)

    hashes = _compute_hashes()
    print(f'Cache hashes: app={hashes["app"]}  worker={hashes["worker"]}  css={hashes["components_css"]}')

    env = Environment(
        loader=FileSystemLoader(TEMPLATES),
        autoescape=select_autoescape([]),  # HTML not auto-escaped — seo_content is trusted
        keep_trailing_newline=True,
    )

    if not dry_run:
        # Clean and recreate dist/
        if os.path.exists(DIST):
            shutil.rmtree(DIST)
        os.makedirs(DIST)

        # Copy static assets
        print('Copying static assets...')
        _copy_static(ROOT, DIST, tool_dirs)
        print('  done')

        # Inject computed hashes into sw.js and processor.js
        print('Injecting hashes...')
        _inject_hashes(hashes, DIST)

    # Generate tool pages
    print(f'Generating tool pages{"  (dry run)" if dry_run else ""}...')
    n = _generate_pages(config, hashes, env, DIST, dry_run)
    print(f'  {n} pages generated')

    if not dry_run:
        # Generate sitemap
        print('Writing sitemap...')
        _write_sitemap(config, DIST)

    print(f'\n{"DRY RUN OK" if dry_run else f"Build complete → dist/ ({n} tool pages)"}')


if __name__ == '__main__':
    main()
