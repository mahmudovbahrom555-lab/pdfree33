// Cloudflare Worker entry point.
// Handles 301 redirects before passing to static assets.
// not_found_handling = "404-page" means any unmatched path — including
// stray locale roots (/ru/, /ja/, etc. with no dedicated homepage) and
// garbage URLs — now gets a real dist/404.html with a genuine 404 status,
// instead of the old "single-page-application" fallback that silently
// 200'd literally any path with the English homepage (a soft-404 that
// was polluting Search Console with duplicate-content noise).

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
  '/jpg-a-pdf':        '/es/jpg-a-pdf/',
  '/jpg-a-pdf/':       '/es/jpg-a-pdf/',
  '/pdf-a-jpg':        '/es/pdf-a-jpg/',
  '/pdf-a-jpg/':       '/es/pdf-a-jpg/',
  '/diviser-pdf':      '/fr/diviser-pdf/',
  '/diviser-pdf/':     '/fr/diviser-pdf/',
  '/seitenzahlen-pdf':  '/de/seitenzahlen-pdf/',
  '/seitenzahlen-pdf/': '/de/seitenzahlen-pdf/',
  '/pdf-metadaten':     '/de/pdf-metadaten/',
  '/pdf-metadaten/':    '/de/pdf-metadaten/',
  '/pdf-aufteilen':     '/de/pdf-aufteilen/',
  '/pdf-aufteilen/':    '/de/pdf-aufteilen/',
  '/pdf-komprimieren':  '/de/pdf-komprimieren/',
  '/pdf-komprimieren/': '/de/pdf-komprimieren/',
  // Old EN-slug-under-locale-prefix pages (predate per-locale slug localization)
  '/fr/watermark-pdf':  '/fr/filigrane-pdf/',
  '/fr/watermark-pdf/': '/fr/filigrane-pdf/',
  '/fr/metadata-pdf':   '/fr/metadonnees-pdf/',
  '/fr/metadata-pdf/':  '/fr/metadonnees-pdf/',
  '/de/split-pdf':      '/de/pdf-aufteilen/',
  '/de/split-pdf/':     '/de/pdf-aufteilen/',
  '/de/merge-pdf':      '/de/pdf-zusammenfuehren/',
  '/de/merge-pdf/':     '/de/pdf-zusammenfuehren/',
  '/blog/split-pdf':    '/blog/how-to-split-a-pdf/',
  '/blog/split-pdf/':   '/blog/how-to-split-a-pdf/',
  '/de/pagenum-pdf':    '/de/seitenzahlen-pdf/',
  '/de/pagenum-pdf/':   '/de/seitenzahlen-pdf/',
  '/de/redact-pdf':     '/de/pdf-schwaerzen/',
  '/de/redact-pdf/':    '/de/pdf-schwaerzen/',
  '/pt/jpg2pdf':        '/pt/jpg-para-pdf/',
  '/pt/jpg2pdf/':       '/pt/jpg-para-pdf/',
  '/ja/pdf2jpg':        '/ja/pdf-jpg-henkan/',
  '/ja/pdf2jpg/':       '/ja/pdf-jpg-henkan/',
  '/ja/draw-on-pdf':    '/draw-on-pdf/',
  '/ja/draw-on-pdf/':   '/draw-on-pdf/',
  '/id/draw-on-pdf':    '/draw-on-pdf/',
  '/id/draw-on-pdf/':   '/draw-on-pdf/',
  // Old ES redact slug (before it was renamed to censurar-pdf)
  '/es/tachar-pdf':     '/es/censurar-pdf/',
  '/es/tachar-pdf/':    '/es/censurar-pdf/',
  // Bare blog slugs (real posts live at /blog/how-to-.../)
  '/blog/jpg2pdf':      '/blog/how-to-convert-pdf-to-jpg/',
  '/blog/jpg2pdf/':     '/blog/how-to-convert-pdf-to-jpg/',
  '/blog/merge-pdf':    '/blog/how-to-merge-pdf-files-for-free/',
  '/blog/merge-pdf/':   '/blog/how-to-merge-pdf-files-for-free/',
  '/blog/rotate-pdf':   '/blog/how-to-rotate-pdf-pages/',
  '/blog/rotate-pdf/':  '/blog/how-to-rotate-pdf-pages/',
  '/blog/extract-pdf':  '/blog/how-to-extract-pages-from-pdf/',
  '/blog/extract-pdf/': '/blog/how-to-extract-pages-from-pdf/',
  '/blog/redact-pdf':   '/blog/',
  '/blog/redact-pdf/':  '/blog/',
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
  '/remove-password-from-pdf':  '/unlock-pdf/',
  '/remove-password-from-pdf/': '/unlock-pdf/',
  '/unlock':  '/unlock-pdf/',
  '/unlock/': '/unlock-pdf/',
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

// ── Feedback relay — POST /api/feedback → Telegram ─────────────────────────
// No database: each submission is forwarded as a Telegram message via the
// Bot API. TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are Cloudflare secrets
// (wrangler secret put), never committed to the repo.
//
// Spam mitigation without persistent storage (Workers are stateless across
// requests, so no reliable in-memory rate-limit — see honeypot + heuristics
// below instead):
//   - hp (honeypot) field: real users never fill a hidden input; if it has
//     a value, silently accept-and-drop so bots don't learn to avoid it.
//   - length caps + minimum length for types that require explanation.
//   - reject messages containing more than one URL (spam link-drop pattern).
//   - reject digit-only or heavily-repeated-character junk.
const _FEEDBACK_TYPES = new Set(['bug', 'idea', 'other', 'error', 'waitlist']);
const _TYPE_LABEL = { bug: '🐛 Bug', idea: '💡 Idea', other: '💬 Feedback', error: '⚠️ Error', waitlist: '📋 SDK waitlist' };
const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function _looksLikeSpam(text) {
  if (!text) return false;
  const urlCount = (text.match(/https?:\/\//gi) || []).length;
  if (urlCount > 1) return true;
  if (/^\d+$/.test(text)) return true;
  if (/(.)\1{9,}/.test(text)) return true; // 10+ repeated chars
  return false;
}

async function handleFeedback(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const type = _FEEDBACK_TYPES.has(body.type) ? body.type : 'other';

  // Honeypot tripped — pretend success, don't tip the bot off.
  //
  // Confirmed via a real user's DevTools payload: Chrome's autofill can
  // duplicate the email field's value into the very next text input on
  // the page regardless of its name/autocomplete attributes, which lands
  // straight in this hidden field and silently swallowed every legitimate
  // submission from autofill-enabled browsers. A real spam bot fills the
  // honeypot with its own junk, not a byte-for-byte copy of another field
  // it just filled in correctly — so only treat it as tripped when it
  // holds something that ISN'T simply the email autofill echoed back.
  if (body.hp && body.hp !== body.email) {
    console.log(`[feedback] honeypot tripped, type=${type}`);
    return new Response('OK', { status: 200 });
  }

  const text  = typeof body.text  === 'string' ? body.text.trim().slice(0, 1000)  : '';
  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 200)  : '';
  const tool  = typeof body.tool  === 'string' ? body.tool.trim().slice(0, 50)    : 'unknown';
  const pageUrl = typeof body.url === 'string' ? body.url.trim().slice(0, 300)    : '';

  // "All good" (type=other, no text) is valid; every other type needs a real message.
  if (type !== 'other' && type !== 'waitlist' && text.length < 3) {
    return new Response('Bad request', { status: 400 });
  }
  // Waitlist signups don't need a message, but a real-looking email is required.
  if (type === 'waitlist' && !_EMAIL_RE.test(email)) {
    console.log(`[feedback] waitlist rejected, invalid email format`);
    return new Response('Bad request', { status: 400 });
  }
  if (_looksLikeSpam(text)) {
    console.log(`[feedback] spam heuristic tripped, type=${type}`);
    return new Response('OK', { status: 200 }); // silently drop
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log(`[feedback] TELEGRAM secrets missing, type=${type} — message dropped`);
    return new Response('OK', { status: 200 }); // not configured yet — no-op, don't break the client
  }

  const parts = [`${_TYPE_LABEL[type] || type} — ${tool}`];
  if (text)    parts.push(text);
  if (email)   parts.push(`📧 ${email}`);
  if (pageUrl) parts.push(`🔗 ${pageUrl}`);

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No parse_mode — plain text, so user-supplied text can't break
      // Telegram's Markdown/HTML formatting or inject unintended entities.
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: parts.join('\n\n'),
        disable_web_page_preview: true,
      }),
    });
    // fetch() only throws on network failure — a non-2xx from Telegram
    // itself (bad chat_id, bot blocked, rate limit) resolves normally and
    // was previously invisible. Log it so a silent delivery gap shows up
    // in `wrangler tail` instead of just "the user says it never arrived".
    if (!tgRes.ok) {
      const body = await tgRes.text().catch(() => '');
      console.log(`[feedback] Telegram API rejected sendMessage: ${tgRes.status} ${body}`);
    } else {
      console.log(`[feedback] delivered to Telegram, type=${type}`);
    }
  } catch (err) {
    console.log(`[feedback] Telegram fetch threw: ${err && err.message}`);
  }

  return new Response('OK', { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/feedback') {
      return handleFeedback(request, env);
    }

    const target = REDIRECTS[url.pathname];
    if (target) {
      return new Response(null, {
        status: 301,
        headers: {
          Location: new URL(target, url.origin).href,
          'Cache-Control': 'no-store',
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
