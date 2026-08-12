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
  // Technical error string computed client-side (processor.js's _handleError) —
  // shown to the user as read-only context, forwarded here so a report actually
  // carries a diagnosable cause instead of just "it didn't work".
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
  // Deterministic per-(tool, errorType) code, e.g. "MERGE-7F32" — same
  // underlying failure always produces the same code, so repeat reports of
  // the same bug are recognizable by eye in Telegram without a database.
  const errorId = typeof body.errorId === 'string' ? body.errorId.trim().slice(0, 30) : '';
  // "OS · Browser", not a raw User-Agent — see feedback.js _detectDevice().
  const device  = typeof body.device  === 'string' ? body.device.trim().slice(0, 100)  : '';

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

  // ── Channel 1: Telegram — real-time notification ──────────────────────
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log(`[feedback] TELEGRAM secrets missing, type=${type} — message dropped`);
  } else {
    const parts = [`${_TYPE_LABEL[type] || type} — ${tool}`];
    if (text)    parts.push(text);
    if (message) parts.push(`🔧 ${message}`);
    if (errorId) parts.push(`🆔 ${errorId}`);
    if (device)  parts.push(`📱 ${device}`);
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
  }

  // ── Channel 2: Google Sheet — structured, queryable log ────────────────
  // Independent of the Telegram channel above (and of each other's
  // failures) — Apps Script Web App bound to a Sheet's doPost(), appends
  // one row per submission. No database provisioned for this: a Sheet is
  // enough to filter/pivot by tool, error_type, errorId over time, and to
  // build closing-the-loop follow-ups later (a Status column + a
  // time-based Apps Script trigger that emails anyone with a saved email
  // once their row is marked Fixed).
  if (!env.GSHEET_WEBHOOK_URL || !env.GSHEET_SECRET) {
    console.log(`[feedback] GSHEET secrets missing, type=${type} — row not logged`);
  } else {
    try {
      // redirect: 'manual' — Apps Script Web Apps always answer with a 302
      // to a one-shot script.googleusercontent.com/macros/echo?... URL that
      // carries the actual response text. Confirmed empirically that
      // auto-following that redirect (curl -L, and fetch()'s own default
      // redirect:'follow') lands on a broken/expired target instead of the
      // real body — but doPost() (including the sheet.appendRow() side
      // effect) has ALREADY run synchronously by the time the 302 comes
      // back, regardless of whether anything follows it. So there's
      // nothing worth reading past the redirect: getting a response at
      // all (no thrown network error) is the actual success signal here.
      const sheetRes = await fetch(env.GSHEET_WEBHOOK_URL, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: env.GSHEET_SECRET,
          type, tool, errorId, message, text, email, device,
          url: pageUrl,
        }),
      });
      console.log(`[feedback] Sheets webhook responded: status=${sheetRes.status}, type=${type}`);
    } catch (err) {
      console.log(`[feedback] Sheets webhook fetch threw: ${err && err.message}`);
    }
  }

  // Optional screenshot — sent as a separate message right after the text
  // one, via sendPhoto. Kept out of the sendMessage call above because
  // Telegram caption length (1024 chars) is shorter than our text field.
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID && typeof body.screenshot === 'string' && body.screenshot) {
    const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(body.screenshot);
    const MAX_SCREENSHOT_BYTES = 6 * 1024 * 1024;
    if (!match) {
      console.log(`[feedback] screenshot rejected: not a recognized image data URL`);
    } else {
      try {
        const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
        if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_BYTES) {
          console.log(`[feedback] screenshot rejected: size=${bytes.length}`);
        } else {
          const form = new FormData();
          form.append('chat_id', env.TELEGRAM_CHAT_ID);
          form.append('photo', new Blob([bytes], { type: `image/${match[1]}` }), 'screenshot.jpg');
          const photoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
            method: 'POST',
            body: form,
          });
          if (!photoRes.ok) {
            const photoBody = await photoRes.text().catch(() => '');
            console.log(`[feedback] Telegram API rejected sendPhoto: ${photoRes.status} ${photoBody}`);
          }
        }
      } catch (err) {
        console.log(`[feedback] screenshot relay threw: ${err && err.message}`);
      }
    }
  }

  return new Response('OK', { status: 200 });
}

// ── Analytics relay — POST /api/analytics → Workers Analytics Engine ───────
// Replaces the paid Plausible custom-event service. Analytics Engine has no
// client-side JS API (unlike window.plausible()) — every event needs this
// server round-trip so the Worker can call env.ANALYTICS.writeDataPoint().
//
// Analytics Engine has no named fields, just positional blobs[]/doubles[]/a
// single indexes[0] — so this uses one generic, event-shape-agnostic mapping
// rather than per-event-type logic (avoids touching this endpoint every time
// js/analytics.js gains a new event):
//   indexes: [eventName]                    — primary filter/group dimension
//   blobs:   [locale, tool, "key=value"...] — locale/tool get fixed slots
//             (present on nearly every event), everything else remaining
//             is tagged "key=value" so it stays identifiable in queries
//   doubles: [...values that parse as finite numbers]
//
// Limits (per Cloudflare docs): 20 blobs, 20 doubles, 1 index per write,
// index ≤ 96 bytes, 16 KB total blob size per call — truncated defensively
// below, well under those ceilings for anything this site actually sends.
function _dataPointFromEvent(eventName, props) {
  const { locale = '', tool = '', ...rest } = props;
  const blobs = [String(locale).slice(0, 100), String(tool).slice(0, 100)];
  const doubles = [];

  for (const [key, value] of Object.entries(rest)) {
    const n = Number(value);
    if (value !== '' && value !== null && value !== undefined && Number.isFinite(n)) {
      doubles.push(n);
    } else {
      blobs.push(`${key}=${String(value)}`.slice(0, 200));
    }
  }

  return {
    indexes: [String(eventName).slice(0, 96)],
    blobs: blobs.slice(0, 20),
    doubles: doubles.slice(0, 20),
  };
}

async function handleAnalytics(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const eventName = typeof body.event === 'string' ? body.event.trim() : '';
  if (!eventName) {
    return new Response('Bad request', { status: 400 });
  }
  const props = (body.props && typeof body.props === 'object') ? body.props : {};

  if (!env.ANALYTICS) {
    console.log(`[analytics] ANALYTICS binding missing, event=${eventName} — dropped`);
    return new Response('OK', { status: 200 }); // not configured yet — no-op, don't break the client
  }

  try {
    env.ANALYTICS.writeDataPoint(_dataPointFromEvent(eventName, props));
  } catch (err) {
    // Never let analytics break the app — same posture as the client's own
    // _track() try/catch.
    console.log(`[analytics] writeDataPoint threw: ${err && err.message}`);
  }

  return new Response('OK', { status: 200 });
}

// Embed pages (js/embedBridge.js's iframe target, loaded via embed/sdk.js on
// third-party domains) need to be frameable cross-origin — the global
// X-Frame-Options: SAMEORIGIN in _headers blocks that for every other path
// on the site (clickjacking protection, left untouched everywhere else).
// Applied here rather than relied on via _headers because this Worker uses
// the newer Workers Assets binding, not classic Cloudflare Pages, and this
// guarantees correctness regardless of _headers support under that binding.
function withEmbedFrameHeaders(response) {
  const headers = new Headers(response.headers);
  headers.delete('X-Frame-Options');
  headers.set('Content-Security-Policy', 'frame-ancestors *;');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/feedback') {
      return handleFeedback(request, env);
    }

    if (url.pathname === '/api/analytics') {
      return handleAnalytics(request, env);
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

    if (url.pathname.startsWith('/embed/')) {
      return withEmbedFrameHeaders(await env.ASSETS.fetch(request));
    }

    return env.ASSETS.fetch(request);
  },
};
