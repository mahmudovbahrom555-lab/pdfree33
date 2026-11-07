# SPDX-License-Identifier: AGPL-3.0-only
"""Make existing blog translation groups reciprocal in generated HTML and sitemap."""
from html import escape
from html.parser import HTMLParser
from pathlib import Path
import re


class BlogHead(HTMLParser):
    def __init__(self):
        super().__init__()
        self.lang = None
        self.canonical = None
        self.alternates = []
        self.noindex = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'html':
            self.lang = attrs.get('lang')
        if tag == 'meta' and attrs.get('name') == 'robots':
            self.noindex = 'noindex' in attrs.get('content', '').lower()
        if tag == 'link':
            if attrs.get('rel') == 'canonical':
                self.canonical = attrs.get('href')
            if attrs.get('rel') == 'alternate' and attrs.get('hreflang'):
                self.alternates.append((attrs['hreflang'], attrs.get('href')))


def normalize_blog_hreflang(out_dir, base_url):
    root = Path(out_dir)
    pages = {}
    for path in root.rglob('index.html'):
        parts = path.relative_to(root).parts
        if not (parts[0] == 'blog' or len(parts) > 1 and parts[1] == 'blog'):
            continue
        source = path.read_text(encoding='utf-8')
        head = BlogHead()
        head.feed(source)
        expected = base_url.rstrip('/') + '/' + str(path.relative_to(root).parent) + '/'
        if not head.noindex and head.lang and head.canonical == expected:
            pages[expected] = (path, source, head)
    # Join only declared alternate relationships to real, canonical blog pages.
    graph = {url: set() for url in pages}
    for url, (_, _, head) in pages.items():
        for lang, target in head.alternates:
            if lang != 'x-default' and target in pages:
                if pages[target][2].lang != lang:
                    raise ValueError(f'Blog hreflang language mismatch: {url} -> {target}')
                graph[url].add(target)
                graph[target].add(url)
    groups = {}
    seen = set()
    for url in pages:
        if url in seen:
            continue
        stack, component = [url], set()
        while stack:
            current = stack.pop()
            if current in component:
                continue
            component.add(current)
            stack.extend(graph[current] - component)
        seen.update(component)
        langs = {}
        for member in sorted(component):
            lang = pages[member][2].lang
            if lang in langs:
                raise ValueError(f'Ambiguous blog translation group for {lang}: {component}')
            langs[lang] = member
        if len(component) < 2:
            continue
        alts = sorted(langs.items())
        # Only use the real English member as the default; never invent a fallback.
        if 'en' in langs:
            alts.append(('x-default', langs['en']))
        for member in component:
            groups[member] = alts
    pattern = r'\s*<link\b(?=[^>]*\brel=[\"\']alternate[\"\'])(?=[^>]*\bhreflang=)[^>]*>'
    for url, alts in groups.items():
        path, source, _ = pages[url]
        source = re.sub(pattern, '', source, flags=re.I)
        links = '\n'.join(f'  <link rel="alternate" hreflang="{escape(lang, quote=True)}" href="{escape(href, quote=True)}">' for lang, href in alts)
        source = re.sub(r'\s*</head>', '\n' + links + '\n</head>', source, count=1)
        path.write_text(source, encoding='utf-8')
    sitemap_path = root / 'sitemap.xml'
    sitemap = sitemap_path.read_text(encoding='utf-8')
    def update_block(match):
        block = match.group()
        loc = re.search(r'<loc>(.*?)</loc>', block)
        alts = groups.get(loc[1]) if loc else None
        if not alts:
            return block
        block = re.sub(r'\s*<xhtml:link\b[^>]*/>', '', block)
        links = ''.join(f'\n    <xhtml:link rel="alternate" hreflang="{escape(lang, quote=True)}" href="{escape(href, quote=True)}"/>' for lang, href in alts)
        return block.replace('</url>', links + '\n  </url>')
    sitemap = re.sub(r'<url>.*?</url>', update_block, sitemap, flags=re.S)
    sitemap_path.write_text(sitemap, encoding='utf-8')
    return len(groups)
