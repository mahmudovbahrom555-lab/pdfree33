// Cloudflare Worker entry point.
// Handles 301 redirects before passing to static assets.
// not_found_handling = "404-page" means any unmatched path — including
// stray locale roots (/ru/, /ja/, etc. with no dedicated homepage) and
// garbage URLs — now gets a real dist/404.html with a genuine 404 status,
// instead of the old "single-page-application" fallback that silently
// 200'd literally any path with the English homepage (a soft-404 that
// was polluting Search Console with duplicate-content noise).

import toolsConfig from '../data/tools-config.json' with { type: 'json' };

// ── Redirect system overview ────────────────────────────────────────────────
// (Read this before touching anything below. Full incident history and
// reasoning: gsc_redirect_report_meta_slug_bug memory / git log on this file.)
//
// REDIRECTS = { ...GUESS_REDIRECTS, ...MANUAL_REDIRECTS } (MANUAL_REDIRECTS
// always wins on overlap). Two tables, two different trust levels:
//   MANUAL_REDIRECTS — hand-written below. You edit this by hand for cases
//     the generator structurally can't know about: renamed slugs, blog
//     aliases, deliberate page consolidation.
//   GUESS_REDIRECTS  — auto-derived by _buildGuessRedirects() further down
//     from data/tools-config.json, on every deploy, with zero manual
//     upkeep. Covers Googlebot's URL-pattern guesses (see that function's
//     own comment) and auto-resolves cross-locale slug collisions via
//     LOCALE_TIE_BREAK_PRIORITY (also further down).
// tests/redirects-parity.test.js is the safety net over both — it runs on
// every `npm test`/CI run and checks things this file alone can't
// self-verify (real-page collisions, staleness, target validity). Read its
// own file-header comment for the full list of what it checks and why each
// one is FAILING vs WARNING vs informational.

// Hand-maintained: legacy slugs, renamed pages, blog aliases, and other
// one-off cases the auto-generated GUESS_REDIRECTS below can't derive from
// data/tools-config.json. Takes precedence over GUESS_REDIRECTS on overlap
// (see REDIRECTS below) — so a correction here always wins.
const MANUAL_REDIRECTS = {
  // Locale slugs at root → correct locale URL
  // Old ES redact slug (before it was renamed to censurar-pdf) — not
  // derivable by GUESS_REDIRECTS below (redact isn't in this pattern; it's a
  // renamed-slug case, not a locale-prefix guess).
  '/es/tachar-pdf':     '/es/censurar-pdf/',
  '/es/tachar-pdf/':    '/es/censurar-pdf/',
  // Bare blog slugs (real posts live at /blog/how-to-.../) — blog content
  // isn't in data/tools-config.json, so none of these are derivable either.
  '/blog/jpg2pdf':      '/blog/how-to-convert-pdf-to-jpg/',
  '/blog/jpg2pdf/':     '/blog/how-to-convert-pdf-to-jpg/',
  '/blog/merge-pdf':    '/blog/how-to-merge-pdf-files-for-free/',
  '/blog/merge-pdf/':   '/blog/how-to-merge-pdf-files-for-free/',
  '/blog/split-pdf':    '/blog/how-to-split-a-pdf/',
  '/blog/split-pdf/':   '/blog/how-to-split-a-pdf/',
  '/blog/rotate-pdf':   '/blog/how-to-rotate-pdf-pages/',
  '/blog/rotate-pdf/':  '/blog/how-to-rotate-pdf-pages/',
  '/blog/extract-pdf':  '/blog/how-to-extract-pages-from-pdf/',
  '/blog/extract-pdf/': '/blog/how-to-extract-pages-from-pdf/',
  '/blog/redact-pdf':   '/blog/',
  '/blog/redact-pdf/':  '/blog/',
  '/blog/protect-pdf':   '/blog/how-to-password-protect-a-pdf/',
  '/blog/protect-pdf/':  '/blog/how-to-password-protect-a-pdf/',
  '/blog/watermark-pdf':  '/blog/how-to-add-watermark-to-pdf/',
  '/blog/watermark-pdf/': '/blog/how-to-add-watermark-to-pdf/',
  // No matching blog post exists for page numbering — send to the real tool page
  '/blog/pagenum-pdf':   '/pagenum-pdf/',
  '/blog/pagenum-pdf/':  '/pagenum-pdf/',
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

// Tie-break priority for bare (no locale-prefix) slug guesses shared
// identically by 2+ locales — e.g. es and pt both translate "split" to
// "dividir-pdf". Rather than leave every such collision 404ing forever
// waiting on a human to notice and add a MANUAL_REDIRECTS entry (the
// dividir-pdf precedent — and 9 more just like it were found completely
// unhandled the same way, see gsc_redirect_report_meta_slug_bug memory),
// the highest-priority locale among the actual colliding candidates wins
// automatically. This is a deliberate, single, documented policy — change
// THIS list if it turns out wrong; don't add a one-off MANUAL_REDIRECTS
// entry to relitigate a single case.
//
// Basis, honestly scoped — two different kinds of evidence, not one:
//  - {es, pt, fr} being the front group IS real evidence: every bare-slug
//    collision found so far (10, see gsc_redirect_report_meta_slug_bug
//    memory) involves only these three, because Romance-language PDF-tool
//    vocabulary happens to overlap heavily across them (e.g. "proteger",
//    "dividir") — de/ja/etc. slugs turned out distinct enough from each
//    other to never collide at all. That's a structural fact about this
//    site's actual translated-slug data, not a guess.
//  - es-over-pt-over-fr, and the entire order of the other 10 locales, is
//    NOT independently measured — no real per-locale traffic split was
//    available when this was written (this session had no CF_TOKEN to run
//    scripts/analytics.py's Cloudflare GraphQL query). It's a plausible
//    default by rough global language prevalence, nothing more. If real
//    per-locale traffic data becomes available later, re-rank this list
//    against it rather than assume the current order is correct.
const LOCALE_TIE_BREAK_PRIORITY = [
  'es', 'pt', 'fr', 'de', 'ru', 'ja', 'it', 'id', 'tr', 'ko', 'vi', 'nl', 'pl',
];

// ── Auto-derived locale-slug guess redirects ────────────────────────────────
// Googlebot has crawled a handful of real pages where a locale's translated
// slug happens to equal the EN slug (e.g. /id/metadata-pdf/, /id/ocr-pdf/,
// /de/ocr-pdf/ are genuinely real) and learned "{locale}/{EN-slug}/" as a
// URL pattern for this site. It then guesses the same pattern against every
// OTHER tool — most of which use a genuinely different translated slug — and
// reports the misses as 404s in Search Console (a report that kept growing,
// 19→21 pages, as new tools shipped and Google tried the pattern against
// them too). Rebuilt from data/tools-config.json on every deploy so a newly
// added localized tool is covered automatically, with zero manual upkeep —
// same self-healing philosophy as scripts/check_dom.py's homepage-container
// guard. See also MANUAL_REDIRECTS above for cases this can't derive
// (renamed slugs, blog aliases, EN-only tools not in tools-config.json).
function _buildGuessRedirects(config) {
  const redirects = {};
  // Tracks every write so a same-key-different-value collision INTERNAL to
  // this function (e.g. two tools accidentally configured with the same EN
  // slug in tools-config.json) is caught rather than silently overwritten —
  // structurally shouldn't be possible given valid config, but cheap to
  // assert rather than assume. Distinct from the ambiguous-bare-slug case
  // below, which is an expected, handled situation, not a bug.
  const internalCollisions = [];
  function set(key, value) {
    if (key in redirects && redirects[key] !== value) {
      internalCollisions.push({ key, existing: redirects[key], attempted: value });
      return;
    }
    redirects[key] = value;
  }

  const langDirs = {};
  for (const [lc, cfg] of Object.entries(config.languages)) {
    if (lc !== 'en') langDirs[lc] = cfg.dir;
  }
  const allEnSlugs = new Set(config.tools.map(t => t.slugs.en));
  // slug (no locale prefix) → every {lc, real} candidate that uses this
  // slug as its translated slug.
  const bareSlugCandidates = {};

  for (const tool of config.tools) {
    const enSlug = tool.slugs.en;
    for (const [lc, dir] of Object.entries(langDirs)) {
      const slug = tool.slugs[lc];
      if (!slug || slug === enSlug) continue;
      const real = `/${dir}/${slug}/`;

      // Pattern 1: {locale}/{EN-slug}/ → {locale}/{real-slug}/
      const guess1 = `/${dir}/${enSlug}`;
      set(guess1, real);
      set(`${guess1}/`, real);

      // Pattern 2: {real-slug}/ (no locale prefix) → {locale}/{real-slug}/
      if (!allEnSlugs.has(slug)) {
        (bareSlugCandidates[slug] ??= []).push({ lc, real });
      }
    }
  }

  const ambiguousBareSlugs = []; // no candidate locale is even in the priority list — truly unresolved
  const tieBreakResolved = [];   // resolved via LOCALE_TIE_BREAK_PRIORITY — visible, not a "problem"
  for (const [slug, candidates] of Object.entries(bareSlugCandidates)) {
    const distinctTargets = new Set(candidates.map(c => c.real));
    if (distinctTargets.size === 1) {
      set(`/${slug}`, candidates[0].real);
      set(`/${slug}/`, candidates[0].real);
      continue;
    }
    const ranked = candidates
      .filter(c => LOCALE_TIE_BREAK_PRIORITY.includes(c.lc))
      .sort((a, b) => LOCALE_TIE_BREAK_PRIORITY.indexOf(a.lc) - LOCALE_TIE_BREAK_PRIORITY.indexOf(b.lc));
    if (ranked.length) {
      set(`/${slug}`, ranked[0].real);
      set(`/${slug}/`, ranked[0].real);
      tieBreakResolved.push({ slug, winner: ranked[0].real, candidates: [...distinctTargets] });
    } else {
      ambiguousBareSlugs.push({ slug, targets: [...distinctTargets] });
    }
  }

  // Tools absent from tools-config.json's `tools` list (EN-only, or with a
  // hand-maintained slug map elsewhere) can't be derived above — mirror them
  // explicitly so their locale-guesses resolve too.
  const drawSlugs = { // mirrors scripts/build.py's _draw_slugs
    de: 'de/pdf-zeichnen', es: 'es/dibujar-en-pdf', fr: 'fr/dessiner-sur-pdf', pt: 'pt/desenhar-no-pdf',
    id: 'id/gambar-pdf', vi: 'vi/ve-pdf', ru: 'ru/risovat-pdf', ja: 'ja/pdf-byouga', it: 'it/disegna-pdf',
    ko: 'ko/pdf-geurigi', nl: 'nl/pdf-tekenen', pl: 'pl/rysuj-pdf', tr: 'tr/pdf-ciz',
  };
  for (const [lc, path] of Object.entries(drawSlugs)) {
    const guess = `/${lc}/draw-on-pdf`;
    set(guess, `/${path}/`);
    set(`${guess}/`, `/${path}/`);
  }
  // compare + scanDocument: genuinely EN-only, no locale page exists at all —
  // send any locale-guess to the real EN page rather than 404.
  for (const lc of Object.keys(langDirs)) {
    set(`/${lc}/compare-pdf`, '/compare-pdf/');
    set(`/${lc}/compare-pdf/`, '/compare-pdf/');
    set(`/${lc}/scan-document`, '/scan-document/');
    set(`/${lc}/scan-document/`, '/scan-document/');
  }

  return { redirects, ambiguousBareSlugs, tieBreakResolved, internalCollisions };
}

const {
  redirects: GUESS_REDIRECTS,
  ambiguousBareSlugs: AMBIGUOUS_BARE_SLUGS,
  tieBreakResolved: TIE_BREAK_RESOLVED,
  internalCollisions: INTERNAL_COLLISIONS,
} = _buildGuessRedirects(toolsConfig);

// MANUAL_REDIRECTS wins on overlap — a hand-added correction should never be
// silently shadowed by the derived guess table.
const REDIRECTS = { ...GUESS_REDIRECTS, ...MANUAL_REDIRECTS };

// Exported (in addition to the default fetch handler below) purely so
// tests/redirects-parity.test.js can check for things nothing else would
// ever surface: MANUAL_REDIRECTS entries now redundant with GUESS_REDIRECTS,
// bare-slug collisions the tie-break policy couldn't resolve, and internal
// generation collisions (a tools-config.json data mistake). Unused by the
// Worker runtime itself (Wrangler only bundles the default export).
export {
  MANUAL_REDIRECTS, GUESS_REDIRECTS, REDIRECTS, toolsConfig,
  LOCALE_TIE_BREAK_PRIORITY, AMBIGUOUS_BARE_SLUGS, TIE_BREAK_RESOLVED, INTERNAL_COLLISIONS,
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
//   indexes: [eventName]                            — primary filter/group dimension
//   blobs:   [locale, tool, session, "key=value"...] — locale/tool/session get
//             fixed slots (present on nearly every event; session is a clean
//             equality-joinable column specifically so "did this session's
//             Tool Error get followed by a Tool Success" is a plain SQL join
//             instead of string-matching), everything else remaining is
//             tagged "key=value" so it stays identifiable in queries
//   doubles: [...values that parse as finite numbers]
//
// Limits (per Cloudflare docs): 20 blobs, 20 doubles, 1 index per write,
// index ≤ 96 bytes, 16 KB total blob size per call — truncated defensively
// below, well under those ceilings for anything this site actually sends.
// Coarse, privacy-bucketed device/browser classification from the User-
// Agent header — same "round it into a bucket, not the raw value" posture
// this codebase already uses for file sizes (_sizeBucket in js/analytics.js).
// Server-side only, same reasoning as country: request.headers is the only
// source that can't be spoofed by editing client-side props. Order matters
// for browser detection — Edge/Opera UAs also contain "Chrome" and
// "Safari" tokens, so they must be checked first, and Chrome UAs also
// contain "Safari", so Chrome must be checked before Safari.
// Known real limitation, stated honestly rather than silently: iPadOS 13+
// Safari reports a desktop-class "Macintosh" UA with no "iPad" token, so
// recent iPads are indistinguishable from real Macs by UA alone — this
// bucket is directionally useful, not perfectly accurate.
export function _classifyUserAgent(ua) {
  ua = ua || '';
  let device = 'desktop';
  if (/iPad/i.test(ua)) device = 'tablet';
  else if (/Android/i.test(ua)) device = /Mobile/i.test(ua) ? 'mobile' : 'tablet';
  else if (/iPhone|iPod|Mobi/i.test(ua)) device = 'mobile';

  let browser = 'other';
  if (/Edg\//i.test(ua)) browser = 'edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'opera';
  else if (/Firefox\//i.test(ua)) browser = 'firefox';
  else if (/Chrome\//i.test(ua)) browser = 'chrome';
  else if (/Safari\//i.test(ua)) browser = 'safari';

  return { device, browser };
}

export function _dataPointFromEvent(eventName, props) {
  const { locale = '', tool = '', session = '', ...rest } = props;
  const blobs = [String(locale).slice(0, 100), String(tool).slice(0, 100), String(session).slice(0, 100)];
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

// Browsers always send Origin on same-origin POST requests, not just
// cross-origin ones — js/analytics.js's fetch('/api/analytics') always has
// one that matches this Worker's own origin. A request with no Origin, or
// one that doesn't match, didn't come from a page that actually loaded
// pdfree.io — blocks the laziest form of abuse (scripts/bots posting
// directly to this endpoint) for free, no persistent state required.
// Not foolproof (Origin is trivially spoofable by a determined attacker),
// but Workers are stateless per-request — same constraint already
// documented for /api/feedback — so real rate-limiting needs a binding
// (KV, Durable Objects) this project doesn't have yet. This is the
// zero-infrastructure first line of defense, not the last one.
function _hasValidOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return origin === url.origin;
}

// Hard cap on request body size, checked before JSON parsing — a legit
// event (locale/tool/session + a handful of short props) is well under
// 1KB; anything wildly larger is either a mistake or someone testing how
// much they can push through, not a real analytics event.
const MAX_ANALYTICS_BODY_BYTES = 8 * 1024;

async function handleAnalytics(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  if (!_hasValidOrigin(request, url)) {
    return new Response('Forbidden', { status: 403 });
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_ANALYTICS_BODY_BYTES) {
    return new Response('Payload too large', { status: 413 });
  }

  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_ANALYTICS_BODY_BYTES) {
      return new Response('Payload too large', { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const eventName = typeof body.event === 'string' ? body.event.trim() : '';
  if (!eventName) {
    return new Response('Bad request', { status: 400 });
  }
  // Internal/testing traffic (Uzbekistan) is dropped outright, not just
  // tagged — after repeatedly having to remember a UZ filter in every ad
  // hoc query during the 2026-08-20 analytics review, excluding it at
  // write time means the dataset itself never accumulates the noise in
  // the first place, mirroring the existing UZ exclusion in
  // scripts/analytics.py's separate GraphQL-based pipeline (that script
  // filters live HTTP-request traffic after the fact; this prevents the
  // behavioral-events dataset from ever recording it).
  if (request.cf?.country === 'UZ') {
    return new Response('OK', { status: 200 });
  }

  const props = (body.props && typeof body.props === 'object') ? body.props : {};
  // Server-side geo/device/browser, never client-supplied — request.cf and
  // the User-Agent header are the only trustworthy sources (a client could
  // otherwise just lie about its own country/device in props). Overwrites
  // any client-sent keys of the same name on purpose.
  props.country = request.cf?.country || '';
  const { device, browser } = _classifyUserAgent(request.headers.get('User-Agent'));
  props.device  = device;
  props.browser = browser;

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
