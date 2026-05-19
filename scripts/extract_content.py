#!/usr/bin/env python3
"""
Phase 1 of SSG: extract content from existing 60 tool pages into data/content/.

For each tool × language:
  data/content/{lang}/{tool_id}.html      — inner HTML of .seo-article__inner
  data/content/{lang}/{tool_id}-faq.json  — FAQPage mainEntity array

Also enriches data/tools-config.json with:
  metaDescs  — <meta name="description"> per lang
  ogTitles   — <meta property="og:title">  per lang
  ogDescs    — <meta property="og:description"> per lang

Run once (or re-run after editing tool pages to re-sync content files).
"""
import json
import os
import re
import sys

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, 'data', 'tools-config.json')

# ── HTML helpers ─────────────────────────────────────────────────────────────

def _extract_div_inner(html, class_name):
    """Return the trimmed content inside the first <div class="class_name">."""
    start = html.find(f'class="{class_name}"')
    if start == -1:
        return None
    # Walk back to find the opening <
    tag_start = html.rfind('<', 0, start)
    # Find the > that closes the opening tag
    close_bracket = html.index('>', start)
    content_start = close_bracket + 1

    # Count depth to find the matching </div>
    depth = 1
    pos = content_start
    while depth > 0:
        next_open  = html.find('<div',  pos)
        next_close = html.find('</div', pos)
        if next_close == -1:
            break
        if next_open != -1 and next_open < next_close:
            depth += 1
            pos = next_open + 4
        else:
            depth -= 1
            if depth == 0:
                return html[content_start:next_close].strip()
            pos = next_close + 6
    return None


def _extract_section_inner(html, class_name):
    """Return trimmed content inside <section class="class_name">."""
    start = html.find(f'class="{class_name}"')
    if start == -1:
        return None
    close_bracket = html.index('>', start)
    content_start = close_bracket + 1

    depth = 1
    pos = content_start
    while depth > 0:
        next_open  = html.find('<section', pos)
        next_close = html.find('</section', pos)
        if next_close == -1:
            break
        if next_open != -1 and next_open < next_close:
            depth += 1
            pos = next_open + 8
        else:
            depth -= 1
            if depth == 0:
                return html[content_start:next_close].strip()
            pos = next_close + 9
    return None


def _extract_seo_content(html):
    """Extract inner HTML of the SEO article section."""
    # Try .seo-article__inner first (used in some pages)
    inner = _extract_div_inner(html, 'seo-article__inner')
    if inner:
        return inner
    # Fall back to .seo-content (older EN pages)
    inner = _extract_div_inner(html, 'seo-content')
    if inner:
        return inner
    # Fall back to whole seo-article section content
    return _extract_section_inner(html, 'seo-article')


def _extract_faq_items(html):
    """Extract FAQPage mainEntity array from application/ld+json blocks."""
    blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL
    )
    for block in blocks:
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get('@type') == 'FAQPage':
            return data.get('mainEntity', [])
    return []


def _extract_meta(html, prop_name):
    """Extract content="..." from <meta name="..." or property="...">."""
    m = re.search(
        rf'<meta[^>]+(?:name|property)=["\'](?:og:)?{re.escape(prop_name)}["\'][^>]+content=["\']([^"\']+)["\']',
        html
    )
    if not m:
        m = re.search(
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:name|property)=["\'](?:og:)?{re.escape(prop_name)}["\']',
            html
        )
    return m.group(1) if m else None


# ── Page path resolution ──────────────────────────────────────────────────────

def _page_path(lang, slug, config):
    """Return absolute path to the tool page HTML file."""
    lang_cfg = config['languages'][lang]
    lang_dir = lang_cfg['dir']
    if lang == 'en':
        return os.path.join(ROOT, slug, 'index.html')
    return os.path.join(ROOT, lang_dir, slug, 'index.html')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    with open(CONFIG, encoding='utf-8') as f:
        config = json.load(f)

    langs  = list(config['languages'].keys())
    tools  = config['tools']

    ok = err = 0

    # Ensure per-lang content dirs exist
    for lang in langs:
        os.makedirs(os.path.join(ROOT, 'data', 'content', lang), exist_ok=True)

    for tool in tools:
        tool_id = tool['id']
        # Init enrichment dicts if not present
        for field in ('metaDescs', 'ogTitles', 'ogDescs'):
            if field not in tool:
                tool[field] = {}

        for lang in langs:
            slug = tool['slugs'].get(lang)
            if not slug:
                continue

            page_path = _page_path(lang, slug, config)
            if not os.path.exists(page_path):
                print(f'  MISSING  {page_path}', file=sys.stderr)
                err += 1
                continue

            html = open(page_path, encoding='utf-8').read()

            # ── Extract SEO article ───────────────────────────────────────────
            seo_html = _extract_seo_content(html)
            if seo_html:
                out_path = os.path.join(ROOT, 'data', 'content', lang, f'{tool_id}.html')
                with open(out_path, 'w', encoding='utf-8') as f:
                    f.write(seo_html + '\n')
            else:
                print(f'  NO SEO   {lang}/{slug}', file=sys.stderr)
                err += 1
                continue

            # ── Extract FAQ schema items ──────────────────────────────────────
            faq_items = _extract_faq_items(html)
            if faq_items:
                out_path = os.path.join(ROOT, 'data', 'content', lang, f'{tool_id}-faq.json')
                with open(out_path, 'w', encoding='utf-8') as f:
                    json.dump(faq_items, f, indent=2, ensure_ascii=False)
                    f.write('\n')
            else:
                print(f'  NO FAQ   {lang}/{slug}', file=sys.stderr)

            # ── Extract meta/OG tags ──────────────────────────────────────────
            meta_desc = _extract_meta(html, 'description')
            og_title  = _extract_meta(html, 'title')
            og_desc   = _extract_meta(html, 'description')  # og:description

            # More precise OG extraction
            m = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html)
            if not m:
                m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']', html)
            if m:
                og_title = m.group(1)

            m = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html)
            if not m:
                m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:description["\']', html)
            if m:
                og_desc = m.group(1)

            if meta_desc:
                tool['metaDescs'][lang] = meta_desc
            if og_title:
                tool['ogTitles'][lang] = og_title
            if og_desc:
                tool['ogDescs'][lang] = og_desc

            ok += 1
            print(f'  OK  {lang}/{tool_id}')

    # Write enriched config back
    with open(CONFIG, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write('\n')

    print(f'\nExtracted {ok} pages  ({err} errors)')
    if err:
        sys.exit(1)


if __name__ == '__main__':
    main()
