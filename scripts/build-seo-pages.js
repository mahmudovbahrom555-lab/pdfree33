const fs = require('fs');
const path = require('path');

const rootDir = __dirname + '/..';
const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');

const TOOLS = {
  merge: { title: 'Merge PDF', desc: 'Combine unlimited PDF files — no restrictions' },
  split: { title: 'Split PDF', desc: 'Extract pages or split into separate files' },
  compress: { title: 'Compress PDF', desc: 'Reduce file size while preserving text and vector quality' },
  jpg2pdf: { title: 'JPG to PDF', desc: 'Convert images to PDF — EXIF rotation corrected automatically' },
  pdf2jpg: { title: 'PDF to JPG', desc: 'Extract pages as high-quality JPG or PNG images' },
  redact: { title: 'Cover Area', desc: 'Hide watermarks, signatures or sensitive data with an opaque cover' },
  rotate: { title: 'Rotate PDF', desc: 'Fix page orientation in any PDF' },
  extract: { title: 'Extract Pages', desc: 'Pull selected pages into a new PDF — with smart presets' },
  watermark: { title: 'Watermark PDF', desc: 'Add text watermark to every page — diagonal, tiled or positioned' },
  pagenum: { title: 'Add Page Numbers', desc: 'Number pages — Arabic, Roman or alphabetic, any position' },
  meta: { title: 'Edit Metadata', desc: 'View and edit PDF title, author, subject and other fields' },
  protect: { title: 'Protect PDF', desc: 'Add open password & restrict permissions — AES-256, fully client-side' },
};

// Also create 404.html for GitHub Pages fallback
const fallbackHtml = indexHtml.replace(
  '<head>',
  `<head>
  <script>
    // GitHub Pages 404 fallback to route correctly
    (function(){
      const l = window.location;
      if (l.pathname.endsWith('-pdf/') || l.pathname.endsWith('-pdf') || l.pathname.endsWith('2pdf/') || l.pathname.endsWith('2jpg/')) {
        sessionStorage.redirect = l.href;
      }
    })();
  </script>`
);
fs.writeFileSync(path.join(rootDir, '404.html'), fallbackHtml);

for (const [tool, meta] of Object.entries(TOOLS)) {
  const folderName = tool.includes('pdf') ? tool : `${tool}-pdf`;
  const toolDir = path.join(rootDir, folderName);
  if (!fs.existsSync(toolDir)) {
    fs.mkdirSync(toolDir);
  }

  // Update relative paths to point to parent
  let html = indexHtml
    .replace(/(href|src)="css\//g, '$1="../css/')
    .replace(/(href|src)="js\//g, '$1="../js/')
    .replace(/(href|src)="img\//g, '$1="../img/')
    // Handle inline script injection
    .replace('<title>PDFree — Process PDF locally. Free &amp; Private</title>', `<title>${meta.title} — PDFree</title>`)
    .replace('<meta name="description" content="Merge, split, compress, protect and watermark PDF files securely in your browser. 100% free, no data leaves your device.">', `<meta name="description" content="${meta.desc}">`)
    .replace('</body>', `
  <script>
    // Pre-select tool based on directory name
    window.PDFREE_INITIAL_TOOL = '${tool}';
  </script>
</body>`);

  fs.writeFileSync(path.join(toolDir, 'index.html'), html);
  console.log(`Generated ${folderName}/index.html`);
}
