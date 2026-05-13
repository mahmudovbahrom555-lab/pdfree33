import os
import json
from jinja2 import Environment, FileSystemLoader

# Configuration
DOMAIN = "https://mahmudovbahrom555-lab.github.io/PDFree"
LANGUAGES = ['en', 'es', 'pt']
DEFAULT_LANG = 'en'

root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
scripts_dir = os.path.join(root_dir, 'scripts')

# Load Translations
with open(os.path.join(scripts_dir, 'translations.json'), 'r', encoding='utf-8') as f:
    translations = json.load(f)

# Jinja2 Environment
env = Environment(loader=FileSystemLoader(root_dir))
template = env.get_template('index.template.html')

def t(key, lang):
    """Retrieve translation with fallback to DEFAULT_LANG"""
    parts = key.split('.')
    category = parts[0]
    sub_key = '.'.join(parts[1:])
    
    try:
        val = translations[category][sub_key].get(lang)
        if not val:
            val = translations[category][sub_key].get(DEFAULT_LANG)
        return val
    except KeyError:
        return f"[{key}]"

def url_helper(tool_key, lang):
    """Generate the relative path for a tool based on language"""
    slug = t(f"seo.{tool_key}.slug", lang)
    if lang == DEFAULT_LANG:
        # e.g., merge-pdf/
        folder = slug if 'pdf' in slug else f"{slug}-pdf"
        return f"{folder}/"
    else:
        # e.g., es/unir-pdf/
        folder = slug if 'pdf' in slug else f"{slug}-pdf"
        return f"{lang}/{folder}/"

def absolute_url(tool_key, lang):
    """Generate the absolute URL for a tool based on language"""
    slug = t(f"seo.{tool_key}.slug", lang)
    folder = slug if 'pdf' in slug else f"{slug}-pdf"
    rel_path = f"{folder}/" if lang == DEFAULT_LANG else f"{lang}/{folder}/"
    return f"{DOMAIN}/{rel_path}"

tools = ['merge', 'split', 'compress', 'jpg2pdf', 'pdf2jpg', 'extract', 'watermark', 'pagenum', 'meta', 'redact', 'rotate', 'protect']
sitemap_urls = []

# Generate Pages
for lang in LANGUAGES:
    # Set the base directory for the language
    lang_dir = root_dir if lang == DEFAULT_LANG else os.path.join(root_dir, lang)
    if not os.path.exists(lang_dir):
        os.makedirs(lang_dir)

    # 1. Generate language homepage (redirect to default tool, usually merge)
    # The actual HTML is just the merge tool for now, matching the old behavior
    # But wait, PDFree root index.html is essentially the merge tool.
    # We will generate it exactly like the merge tool, but placed at lang_dir/index.html
    
    for tool in tools:
        # Determine output path
        slug = t(f"seo.{tool}.slug", lang)
        folder_name = slug if 'pdf' in slug else f"{slug}-pdf"
        
        # If default lang, folder is root_dir / folder_name
        # If other lang, folder is root_dir / lang / folder_name
        tool_dir = os.path.join(lang_dir, folder_name)
        if not os.path.exists(tool_dir):
            os.makedirs(tool_dir)

        # Generate hreflang tags
        hreflang_tags = ""
        for l in LANGUAGES:
            hreflang_tags += f'  <link rel="alternate" hreflang="{l}" href="{absolute_url(tool, l)}">\n'
        hreflang_tags += f'  <link rel="alternate" hreflang="x-default" href="{absolute_url(tool, DEFAULT_LANG)}">'

        # Determine relative paths to assets
        # If DEFAULT_LANG: inside /merge-pdf/, depth is 1
        # If other lang: inside /es/unir-pdf/, depth is 2
        base_prefix = "../" if lang == DEFAULT_LANG else "../../"

        # Context for Jinja
        context = {
            'lang': lang,
            'canonical_url': absolute_url(tool, lang),
            'hreflang_tags': hreflang_tags,
            'base_url': base_prefix if lang == DEFAULT_LANG else f"{base_prefix}{lang}/",
            'current_tool': tool,
            't': lambda k: t(k, lang),
            'url': lambda k: f"{base_prefix}{t(f'seo.{k}.slug', lang)}{'-pdf' if 'pdf' not in t(f'seo.{k}.slug', lang) else ''}/" if lang == DEFAULT_LANG else f"{base_prefix}{lang}/{t(f'seo.{k}.slug', lang)}{'-pdf' if 'pdf' not in t(f'seo.{k}.slug', lang) else ''}/",
        }

        # Render HTML
        html = template.render(context)
        
        # Fix asset paths dynamically since they are deep
        # A simpler way is to replace standard asset prefixes
        html = html.replace('href="css/', f'href="{base_prefix}css/')
        html = html.replace('src="js/', f'src="{base_prefix}js/')
        html = html.replace('href="manifest.json"', f'href="{base_prefix}manifest.json"')
        html = html.replace('href="icons/', f'href="{base_prefix}icons/')
        
        # Write file
        with open(os.path.join(tool_dir, 'index.html'), 'w', encoding='utf-8') as f:
            f.write(html)
            
        sitemap_urls.append(absolute_url(tool, lang))

        # Root index.html should be a copy of the merge tool for the respective language
        if tool == 'merge':
            # Root needs depth adjusted
            root_context = context.copy()
            root_context['base_url'] = "./" if lang == DEFAULT_LANG else f"../{lang}/"
            root_html = template.render(root_context)
            # No base_prefix replacement needed for DEFAULT_LANG root, 
            # but for /es/index.html depth is 1.
            root_base_prefix = "" if lang == DEFAULT_LANG else "../"
            if root_base_prefix:
                root_html = root_html.replace('href="css/', f'href="{root_base_prefix}css/')
                root_html = root_html.replace('src="js/', f'src="{root_base_prefix}js/')
                root_html = root_html.replace('href="manifest.json"', f'href="{root_base_prefix}manifest.json"')
                root_html = root_html.replace('href="icons/', f'href="{root_base_prefix}icons/')
            
            with open(os.path.join(lang_dir, 'index.html'), 'w', encoding='utf-8') as f:
                f.write(root_html)
            
            sitemap_urls.append(f"{DOMAIN}/" if lang == DEFAULT_LANG else f"{DOMAIN}/{lang}/")

print("Generated all localized SEO pages successfully.")

# Generate sitemap.xml
import datetime
today = datetime.datetime.now().strftime("%Y-%m-%d")

sitemap_content = '<?xml version="1.0" encoding="UTF-8"?>\n'
sitemap_content += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'

for url in set(sitemap_urls): # Use set to avoid duplicates
    sitemap_content += '  <url>\n'
    sitemap_content += f'    <loc>{url}</loc>\n'
    sitemap_content += f'    <lastmod>{today}</lastmod>\n'
    sitemap_content += '    <changefreq>weekly</changefreq>\n'
    sitemap_content += '    <priority>0.8</priority>\n'
    sitemap_content += '  </url>\n'

sitemap_content += '</urlset>'

with open(os.path.join(root_dir, 'sitemap.xml'), 'w', encoding='utf-8') as f:
    f.write(sitemap_content)

print("Generated sitemap.xml")

# Fix 404.html using the template
fallback_context = {
    'lang': DEFAULT_LANG,
    'canonical_url': f"{DOMAIN}/",
    'hreflang_tags': '',
    'base_url': "./",
    'current_tool': 'merge',
    't': lambda k: t(k, DEFAULT_LANG),
    'url': lambda k: f"./{t(f'seo.{k}.slug', DEFAULT_LANG)}{'-pdf' if 'pdf' not in t(f'seo.{k}.slug', DEFAULT_LANG) else ''}/",
}
fallback_html = template.render(fallback_context)
fallback_html = fallback_html.replace(
    '<head>',
    '''<head>
  <script>
    // GitHub Pages 404 fallback to route correctly
    (function(){
      const l = window.location;
      if (l.pathname.endsWith('-pdf/') || l.pathname.endsWith('-pdf') || l.pathname.endsWith('2pdf/') || l.pathname.endsWith('2jpg/')) {
        sessionStorage.redirect = l.href;
      }
    })();
  </script>'''
)
with open(os.path.join(root_dir, '404.html'), 'w', encoding='utf-8') as f:
    f.write(fallback_html)
