#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Self-hosts DM Sans + DM Mono fonts — removes Google Fonts CDN from all HTML pages.
# Run once from project root: python3 scripts/self_host_fonts.py

import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent

# ── 1. Font files to download ──────────────────────────────────────────────────

FONT_FILES = [
    # DM Mono
    ('dm-mono-400-latin-ext.woff2', 'https://fonts.gstatic.com/s/dmmono/v16/aFTU7PB1QTsUX8KYthSQBK6PYK3EXw.woff2'),
    ('dm-mono-400-latin.woff2',     'https://fonts.gstatic.com/s/dmmono/v16/aFTU7PB1QTsUX8KYthqQBK6PYK0.woff2'),
    ('dm-mono-500-latin-ext.woff2', 'https://fonts.gstatic.com/s/dmmono/v16/aFTR7PB1QTsUX8KYvumzEY2tbYf-Vlh3uA.woff2'),
    ('dm-mono-500-latin.woff2',     'https://fonts.gstatic.com/s/dmmono/v16/aFTR7PB1QTsUX8KYvumzEYOtbYf-Vlg.woff2'),
    # DM Sans — variable font: one woff2 covers all weights 300–600
    ('dm-sans-latin-ext.woff2',     'https://fonts.gstatic.com/s/dmsans/v17/rP2Yp2ywxg089UriI5-g4vlH9VoD8Cmcqbu6-K6z9mXgjU0.woff2'),
    ('dm-sans-latin.woff2',         'https://fonts.gstatic.com/s/dmsans/v17/rP2Yp2ywxg089UriI5-g4vlH9VoD8Cmcqbu0-K6z9mXg.woff2'),
]

LATIN_EXT_RANGE = (
    'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, '
    'U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, '
    'U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'
)
LATIN_RANGE = (
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, '
    'U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, '
    'U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
)

# ── 2. Generate fonts.css content ──────────────────────────────────────────────

FONTS_CSS = """\
/* SPDX-License-Identifier: AGPL-3.0-only */
/* Self-hosted DM Sans + DM Mono — no Google Fonts, no external requests */

/* DM Mono 400 */
@font-face {{
  font-family: 'DM Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/dm-mono-400-latin-ext.woff2') format('woff2');
  unicode-range: {latin_ext};
}}
@font-face {{
  font-family: 'DM Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/dm-mono-400-latin.woff2') format('woff2');
  unicode-range: {latin};
}}

/* DM Mono 500 */
@font-face {{
  font-family: 'DM Mono';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/dm-mono-500-latin-ext.woff2') format('woff2');
  unicode-range: {latin_ext};
}}
@font-face {{
  font-family: 'DM Mono';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/dm-mono-500-latin.woff2') format('woff2');
  unicode-range: {latin};
}}

/* DM Sans 300 */
@font-face {{
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 300;
  font-display: swap;
  src: url('/fonts/dm-sans-latin-ext.woff2') format('woff2');
  unicode-range: {latin_ext};
}}
@font-face {{
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 300;
  font-display: swap;
  src: url('/fonts/dm-sans-latin.woff2') format('woff2');
  unicode-range: {latin};
}}

/* DM Sans 400 */
@font-face {{
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/dm-sans-latin-ext.woff2') format('woff2');
  unicode-range: {latin_ext};
}}
@font-face {{
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/dm-sans-latin.woff2') format('woff2');
  unicode-range: {latin};
}}

/* DM Sans 500 */
@font-face {{
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/dm-sans-latin-ext.woff2') format('woff2');
  unicode-range: {latin_ext};
}}
@font-face {{
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/dm-sans-latin.woff2') format('woff2');
  unicode-range: {latin};
}}

/* DM Sans 600 */
@font-face {{
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/dm-sans-latin-ext.woff2') format('woff2');
  unicode-range: {latin_ext};
}}
@font-face {{
  font-family: 'DM Sans';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('/fonts/dm-sans-latin.woff2') format('woff2');
  unicode-range: {latin};
}}
""".format(latin_ext=LATIN_EXT_RANGE, latin=LATIN_RANGE)

# ── 3. HTML patterns to remove / replace ───────────────────────────────────────

# Matches both preconnect lines (we remove them entirely)
RE_PRECONNECT = re.compile(
    r'\s*<link rel="preconnect" href="https://fonts\.(googleapis|gstatic)\.com"[^>]*>\n?',
    re.IGNORECASE,
)

# Matches the async-loaded preload+stylesheet trick
RE_PRELOAD = re.compile(
    r'<link rel="preload" href="https://fonts\.googleapis\.com/css2\?[^"]*"[^>]*>\n?',
    re.IGNORECASE,
)

# Matches the noscript fallback
RE_NOSCRIPT = re.compile(
    r'<noscript><link rel="stylesheet" href="https://fonts\.googleapis\.com/css2\?[^"]*"></noscript>\n?',
    re.IGNORECASE,
)

# CSP: remove "https://fonts.googleapis.com" from style-src line
RE_CSP_STYLE_GOOGLE = re.compile(
    r'\s*https://fonts\.googleapis\.com\s*;?',
    re.IGNORECASE,
)

# CSP: replace font-src with 'self' only
RE_CSP_FONT_SRC = re.compile(
    r"font-src\s+https://fonts\.gstatic\.com\s*;",
    re.IGNORECASE,
)


def depth_prefix(html_path: Path) -> str:
    """Return relative prefix from this HTML file to project root."""
    parts = html_path.relative_to(ROOT).parts
    depth = len(parts) - 1  # number of directories above file
    return '../' * depth if depth else ''


def patch_html(html_path: Path) -> bool:
    text = html_path.read_text(encoding='utf-8')
    original = text

    # Skip files that don't reference Google Fonts
    if 'fonts.googleapis.com' not in text and 'fonts.gstatic.com' not in text:
        return False

    prefix = depth_prefix(html_path)
    local_font_tag = f'<link rel="stylesheet" href="{prefix}css/fonts.css">'

    # Remove preconnect lines
    text = RE_PRECONNECT.sub('', text)

    # Replace preload line with local stylesheet link
    text = RE_PRELOAD.sub(local_font_tag + '\n', text)

    # Remove noscript fallback
    text = RE_NOSCRIPT.sub('', text)

    # CSP style-src: remove Google Fonts entry, fix trailing semicolon
    def fix_style_src(m):
        line = m.group(0)
        line = RE_CSP_STYLE_GOOGLE.sub('', line)
        # Ensure style-src line ends with semicolon
        if not line.rstrip().endswith(';'):
            line = line.rstrip() + ';'
        return line

    text = re.sub(
        r"style-src\s+'self'.*?;",
        fix_style_src,
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )

    # CSP font-src: replace with 'self'
    text = RE_CSP_FONT_SRC.sub("font-src    'self';", text)

    if text == original:
        print(f'  SKIP (no change): {html_path.relative_to(ROOT)}')
        return False

    html_path.write_text(text, encoding='utf-8')
    return True


def download_fonts():
    fonts_dir = ROOT / 'fonts'
    fonts_dir.mkdir(exist_ok=True)
    print('Downloading font files...')
    ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120'
    for filename, url in FONT_FILES:
        dest = fonts_dir / filename
        if dest.exists():
            print(f'  SKIP (exists): {filename}')
            continue
        req = urllib.request.Request(url, headers={'User-Agent': ua})
        with urllib.request.urlopen(req) as r, open(dest, 'wb') as f:
            f.write(r.read())
        print(f'  OK: {filename} ({dest.stat().st_size // 1024} KB)')


def write_fonts_css():
    dest = ROOT / 'css' / 'fonts.css'
    dest.write_text(FONTS_CSS, encoding='utf-8')
    print(f'Written: css/fonts.css')


def patch_all_html():
    print('Patching HTML files...')
    updated = total = 0
    for html in sorted(ROOT.rglob('*.html')):
        # Skip node_modules or hidden dirs
        if any(p.startswith('.') for p in html.parts):
            continue
        total += 1
        if patch_html(html):
            print(f'  OK: {html.relative_to(ROOT)}')
            updated += 1
    print(f'HTML: {updated}/{total} updated.')


def patch_sw():
    sw = ROOT / 'sw.js'
    text = sw.read_text(encoding='utf-8')

    # Add font files and fonts.css to STATIC_ASSETS if not already there
    if '/fonts/dm-sans-latin.woff2' in text:
        print('sw.js: fonts already listed.')
        return

    font_entries = '\n'.join(
        f"  '/fonts/{name}'," for name, _ in FONT_FILES
    )
    font_entries += "\n  '/css/fonts.css',"

    # Insert after the last existing CSS entry
    text = text.replace(
        "  '/css/components.css',",
        "  '/css/components.css',\n  '/css/fonts.css',"
    )
    # Insert font woff2 files before the icons block
    text = text.replace(
        "  '/icons/icon-48.png',",
        '\n'.join(f"  '/fonts/{name}'," for name, _ in FONT_FILES) +
        "\n  '/icons/icon-48.png',"
    )

    sw.write_text(text, encoding='utf-8')
    print('sw.js: font entries added to STATIC_ASSETS.')


def remove_cdn_font_prefixes():
    """Remove Google Fonts from SW CDN_PREFIXES."""
    sw = ROOT / 'sw.js'
    text = sw.read_text(encoding='utf-8')
    text = re.sub(r"\s*'https://fonts\.googleapis\.com/',\n", '\n', text)
    text = re.sub(r"\s*'https://fonts\.gstatic\.com/',\n", '\n', text)
    sw.write_text(text, encoding='utf-8')
    print('sw.js: removed Google Fonts from CDN_PREFIXES.')


def main():
    download_fonts()
    write_fonts_css()
    patch_all_html()
    patch_sw()
    remove_cdn_font_prefixes()
    print('\nDone. Google Fonts fully removed.')


if __name__ == '__main__':
    main()
