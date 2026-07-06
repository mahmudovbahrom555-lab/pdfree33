// Cloudflare Worker entry point.
// Handles 301 redirects before passing to static assets.
// Required because not_found_handling = "single-page-application" intercepts
// unmatched paths before _redirects can process them.

const REDIRECTS = {
  // Locale slugs at root → correct locale URL
  '/nivelar-pdf':    '/pt/nivelar-pdf/',
  '/nivelar-pdf/':   '/pt/nivelar-pdf/',
  '/pdf-abflachen':  '/de/pdf-abflachen/',
  '/pdf-abflachen/': '/de/pdf-abflachen/',
  '/aplanar-pdf':    '/es/aplanar-pdf/',
  '/aplanar-pdf/':   '/es/aplanar-pdf/',
  '/aplatir-pdf':    '/fr/aplatir-pdf/',
  '/aplatir-pdf/':   '/fr/aplatir-pdf/',
  '/pdf-zu-word':    '/de/pdf-zu-word/',
  '/pdf-zu-word/':   '/de/pdf-zu-word/',
  '/pdf-a-word':     '/es/pdf-a-word/',
  '/pdf-a-word/':    '/es/pdf-a-word/',
  '/pdf-en-word':    '/fr/pdf-en-word/',
  '/pdf-en-word/':   '/fr/pdf-en-word/',
  '/pdf-para-word':  '/pt/pdf-para-word/',
  '/pdf-para-word/': '/pt/pdf-para-word/',
  // Legacy English slugs
  '/index.html':     '/',
  '/annotate':       '/annotate-pdf/',
  '/annotate/':      '/annotate-pdf/',
  '/add-page-numbers-to-pdf':  '/pagenum-pdf/',
  '/add-page-numbers-to-pdf/': '/pagenum-pdf/',
  '/meta-pdf':       '/metadata-pdf/',
  '/meta-pdf/':      '/metadata-pdf/',
  '/cover-area':     '/redact-pdf/',
  '/cover-area/':    '/redact-pdf/',
  '/pdf-to-jpg':     '/pdf2jpg/',
  '/pdf-to-jpg/':    '/pdf2jpg/',
  '/jpg-to-pdf':     '/jpg2pdf/',
  '/jpg-to-pdf/':    '/jpg2pdf/',
  '/image-to-pdf':   '/jpg2pdf/',
  '/image-to-pdf/':  '/jpg2pdf/',
  '/images-to-pdf':  '/jpg2pdf/',
  '/images-to-pdf/': '/jpg2pdf/',
  '/pdf-compress':   '/compress-pdf/',
  '/pdf-compress/':  '/compress-pdf/',
  '/compress':       '/compress-pdf/',
  '/compress/':      '/compress-pdf/',
  '/merge':          '/merge-pdf/',
  '/merge/':         '/merge-pdf/',
  '/split':          '/split-pdf/',
  '/split/':         '/split-pdf/',
  '/rotate':         '/rotate-pdf/',
  '/rotate/':        '/rotate-pdf/',
  '/watermark':      '/watermark-pdf/',
  '/watermark/':     '/watermark-pdf/',
  '/protect':        '/protect-pdf/',
  '/protect/':       '/protect-pdf/',
  '/pdf-password':   '/protect-pdf/',
  '/pdf-password/':  '/protect-pdf/',
  '/add-password-to-pdf':      '/protect-pdf/',
  '/add-password-to-pdf/':     '/protect-pdf/',
  '/remove-password-from-pdf':  '/protect-pdf/',
  '/remove-password-from-pdf/': '/protect-pdf/',
  '/page-numbers':   '/pagenum-pdf/',
  '/page-numbers/':  '/pagenum-pdf/',
  '/add-page-numbers':  '/pagenum-pdf/',
  '/add-page-numbers/': '/pagenum-pdf/',
  '/extract':        '/extract-pdf/',
  '/extract/':       '/extract-pdf/',
  '/redact':         '/redact-pdf/',
  '/redact/':        '/redact-pdf/',
  '/flatten':        '/flatten-pdf/',
  '/flatten/':       '/flatten-pdf/',
  '/fill-pdf':       '/fill/',
  '/fill-pdf/':      '/fill/',
  '/fill-pdf-form':  '/fill/',
  '/fill-pdf-form/': '/fill/',
  '/pdf-metadata':   '/metadata-pdf/',
  '/pdf-metadata/':  '/metadata-pdf/',
  '/edit-metadata':  '/metadata-pdf/',
  '/edit-metadata/': '/metadata-pdf/',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const target = REDIRECTS[url.pathname];
    if (target) {
      return Response.redirect(new URL(target, url.origin).href, 301);
    }
    return env.ASSETS.fetch(request);
  },
};
