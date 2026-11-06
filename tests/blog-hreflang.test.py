# SPDX-License-Identifier: AGPL-3.0-only
import tempfile,unittest,sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from pathlib import Path
from blog_hreflang import normalize_blog_hreflang, BlogHead

class BlogHreflangTest(unittest.TestCase):
 def test_reciprocal_and_sitemap(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);base='https://example.test';paths={'en':'blog/rotate','pt':'pt/blog/girar','fr':'fr/blog/rotation'}
   for lang,path in paths.items():
    p=root/path/'index.html';p.parent.mkdir(parents=True)
    alts='' if lang=='en' else '<link rel="alternate" hreflang="en" href="https://example.test/blog/rotate/">'
    p.write_text(f'<html lang="{lang}"><head><link rel="canonical" href="{base}/{path}/">{alts}</head><body>unchanged</body></html>')
   root.joinpath('sitemap.xml').write_text('<urlset>'+''.join(f'<url><loc>{base}/{p}/</loc><lastmod>2026-01-01</lastmod><xhtml:link rel="alternate" hreflang="en" href="{base}/blog/rotate/"/></url>' for p in paths.values())+'</urlset>')
   self.assertEqual(normalize_blog_hreflang(root,base),3)
   for path in paths.values():
    parser=BlogHead();source=(root/path/'index.html').read_text();parser.feed(source)
    self.assertEqual(dict(parser.alternates),{**{l:f'{base}/{p}/' for l,p in paths.items()},'x-default':f'{base}/blog/rotate/'})
    self.assertIn('<body>unchanged</body>',source)
   site=(root/'sitemap.xml').read_text();self.assertEqual(site.count('hreflang="pt"'),3);self.assertEqual(site.count('<lastmod>2026-01-01</lastmod>'),3)
   before=(root/'blog/rotate/index.html').read_text();normalize_blog_hreflang(root,base);self.assertEqual(before,(root/'blog/rotate/index.html').read_text())
 def test_no_fabricated_targets(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'blog/only/index.html';p.parent.mkdir(parents=True);source='<html lang="en"><head><link rel="canonical" href="https://example.test/blog/only/"></head></html>';p.write_text(source);Path(d,'sitemap.xml').write_text('<urlset/>')
   self.assertEqual(normalize_blog_hreflang(d,'https://example.test'),0);self.assertEqual(p.read_text(),source)

 def test_rejects_two_pages_for_one_language(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);base='https://example.test'
   for path,lang in [('blog/a','en'),('pt/blog/a','pt'),('pt/blog/b','pt')]:
    p=root/path/'index.html';p.parent.mkdir(parents=True)
    p.write_text(f'<html lang="{lang}"><head><link rel="canonical" href="{base}/{path}/"><link rel="alternate" hreflang="en" href="{base}/blog/a/"></head></html>')
   (root/'sitemap.xml').write_text('<urlset/>')
   with self.assertRaises(ValueError):normalize_blog_hreflang(root,base)

if __name__=='__main__':unittest.main()

