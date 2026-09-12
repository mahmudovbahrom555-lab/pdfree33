# Self-hosting PDFree

Run the real [pdfree.io](https://pdfree.io) site — the same tools, the same UI, files still never
leave the browser — on **your own** infrastructure. Same client-side-processing guarantee as the
hosted site, just served from a machine you control instead of Cloudflare's edge.

## Quick start (Docker)

Pull the published image — no build step needed:

```bash
docker pull ghcr.io/mahmudovbahrom555-lab/pdfree-selfhosted:latest
docker run -p 8080:8080 ghcr.io/mahmudovbahrom555-lab/pdfree-selfhosted:latest
```

Or build it yourself from source — this now has two steps, not one: build the site first, then build
the image around it (the Dockerfile doesn't run the build itself anymore — see
[Why the build happens outside Docker](#why-the-build-happens-outside-docker) below for why):

```bash
git clone https://github.com/mahmudovbahrom555-lab/pdfree33
cd pdfree33
npm ci
pip3 install jinja2
python3 scripts/build.py        # produces dist/
docker build -t pdfree-selfhosted .
docker run -p 8080:8080 pdfree-selfhosted
```

Then open `http://localhost:8080/`.

## What this actually is

This image builds the real site with the project's own `scripts/build.py` (the same build that
produces production `pdfree.io`), then serves it via `selfhost/server.js` — a thin Node HTTP server
that imports `src/index.js`'s real, live routing logic directly (redirect table, `/embed/` header
handling, the `/api/feedback` and `/api/analytics` relays) rather than re-implementing any of it, so
self-hosted behavior stays faithful to production instead of silently drifting from a second,
hand-maintained copy of the same logic.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `DIST_DIR` | the image's built-in `dist/` | Override to serve a different build output. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | Optional — wire your own Telegram bot to receive `/api/feedback` submissions. Left unset by default; the endpoint stays a clean no-op (real `200`, message just isn't relayed anywhere) rather than an error. |
| `GSHEET_WEBHOOK_URL`, `GSHEET_SECRET` | unset | Optional second feedback channel (Google Sheets via an Apps Script webhook), same no-op-when-unset behavior. |

`ANALYTICS` is intentionally not configurable — Cloudflare Workers Analytics Engine is bound to a
Cloudflare account and has no self-hostable equivalent. `/api/analytics` is a clean no-op without it.

**`PDFREE_SITE_URL`** is a *build-time* variable, but it's read by `scripts/build.py` itself (not the
Dockerfile) — set it before running `python3 scripts/build.py` in the two-step source build above:

```bash
PDFREE_SITE_URL=https://pdf.yourcompany.internal python3 scripts/build.py
docker build -t pdfree-selfhosted .
```

This rewrites canonical/OG/hreflang URLs correctly for both the ~350 generated tool pages (which
already flow through a real `{{ base_url }}` template variable) and the 14 hand-copied homepage
files (a literal, non-regex string substitution over just those 14 files — see
`scripts/build.py`'s `_rewrite_site_url()`). Defaults to the real site, so a normal build that never
sets this is completely unaffected.

## Security — read this before exposing it beyond localhost

This image is deliberately minimal — it serves requests, nothing more. The following are **all**
explicitly out of scope, all for the same reason: a reverse proxy (nginx, Caddy, Traefik) already
does each of these well, and re-implementing any of them in `selfhost/server.js` would be duplicated,
worse-maintained effort. Put one in front if you need:

- **Authentication** — no built-in auth, matching this project's other self-hosted package
  ([`@pdfree/pdf2md-server`](packages/pdf2md-server/README.md)). Required if this is reachable from
  anywhere untrusted.
- **TLS termination** — this image only speaks plain HTTP.
- **Response compression** — no gzip/brotli (Cloudflare does this automatically for the hosted site).
- **Rate limiting** — no request throttling of any kind. Every request is served as fast as the
  process can handle it, with no per-IP or global cap.

Static assets ARE cache-controlled: anything requested with the `?v=`/`?t=` cache-busting query
string this project already uses (JS/CSS/search-index files) gets `Cache-Control: public,
max-age=31536000, immutable` — safe because the URL itself changes whenever the content does, so a
stale cached copy of an old URL is simply never requested again. Everything else gets a short
`max-age=3600`, and HTML always gets `no-cache`. This matters more here than on a typical static
site: PDFree's tools run via WebAssembly (a multi-megabyte `qpdf.wasm`) and several large JS
bundles, and a corporate network with no cache headers at all would silently re-download them on
every single page load.

## What's NOT included

- **No SSO / user accounts** — the site is anonymous-by-design, same as the hosted version. Adding
  real authentication would need its own backend, and isn't part of this package.
- **No billing/licensing gate** — can't be, by design: this project is
  [AGPLv3](LICENSE), so this image is free to run, fork, and redistribute for anyone, forever. If
  you want deployment help, custom branding, or a support contract, that's a conversation, not
  something this image enforces or checks for. See
  [pdfree.io/enterprise-pdf-tools/](https://pdfree.io/enterprise-pdf-tools/).
- **AGPLv3 source-offer notice**: if you modify this and let others interact with it over a network,
  AGPLv3 §13 requires you to offer them the corresponding source. The unmodified project's source is
  always at <https://github.com/mahmudovbahrom555-lab/pdfree33>.

## Known limitations

- `selfhost/assets.js` doesn't support HTTP Range requests or `ETag`/`If-None-Match` conditional
  requests, and doesn't auto-redirect a bare path to its trailing-slash form. Every internal link in
  this codebase already uses trailing slashes, so the last one rarely matters in practice; Range
  support would matter more for very large files served to a client that retries partial downloads —
  not a common case for this site's asset sizes today.
- `PDFREE_SITE_URL` (above) is good enough to stop your self-hosted instance's pages from linking
  back to the public site; it's still a build-time value baked into static HTML, not a substitute for
  actually deploying to a real public domain if you need working SEO metadata of your own.

## Why the build happens outside Docker

Earlier versions of this image ran `npm ci` and `python3 scripts/build.py` inside the Dockerfile's
own builder stage. A real incident changed that: building for `linux/arm64` under QEMU emulation
(needed so Apple Silicon / AWS Graviton / other arm64 machines can `docker pull` a native image) hit
`npm ci` hanging for **6 hours** until GitHub Actions' own job timeout killed it — a known class of
issue for I/O-heavy npm installs under an emulated architecture, not something specific to this
project's dependencies. The fix: build `dist/` once, natively, on a real (non-emulated) machine —
either your own shell (see the two-step source build above) or a native CI runner — and let Docker's
job be purely packaging already-built files, which stays cheap even under emulation.

## Development (without Docker)

```bash
python3 scripts/build.py     # produces dist/
node selfhost/server.js      # PORT=8080 by default
```

## License

AGPL-3.0-only, same as the parent project.
