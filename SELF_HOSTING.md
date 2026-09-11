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

Or build it yourself from source:

```bash
git clone https://github.com/mahmudovbahrom555-lab/pdfree33
cd pdfree33
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
| `SITE_URL` (build-time `ARG`, not a runtime env var) | `https://pdfree.io` | Rewrites canonical/OG/hreflang URLs in the built HTML at image-build time. See [Known limitation](#known-limitation) below. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | Optional — wire your own Telegram bot to receive `/api/feedback` submissions. Left unset by default; the endpoint stays a clean no-op (real `200`, message just isn't relayed anywhere) rather than an error. |
| `GSHEET_WEBHOOK_URL`, `GSHEET_SECRET` | unset | Optional second feedback channel (Google Sheets via an Apps Script webhook), same no-op-when-unset behavior. |

`ANALYTICS` is intentionally not configurable — Cloudflare Workers Analytics Engine is bound to a
Cloudflare account and has no self-hostable equivalent. `/api/analytics` is a clean no-op without it.

To build with a custom `SITE_URL`:

```bash
docker build --build-arg SITE_URL=https://pdf.yourcompany.internal -t pdfree-selfhosted .
```

## Security — read this before exposing it beyond localhost

**There is no built-in authentication**, matching this project's other self-hosted package
([`@pdfree/pdf2md-server`](packages/pdf2md-server/README.md)). Put this behind your own reverse
proxy, firewall, VPN, or SSO layer if it needs to be reachable from anywhere untrusted — this image
does not include one.

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

## Known limitation

`SITE_URL` is a blunt build-time find-and-replace over the already-rendered HTML output, not real
per-deployment templating — the 14 homepage files hardcode `https://pdfree.io` directly in their
source (unlike the ~350 generated tool pages, which already flow through a real template variable).
Good enough to stop your self-hosted instance's pages from linking back to the public site; not a
substitute for actually deploying to a real public domain if you need working SEO metadata of your
own.

## Development (without Docker)

```bash
python3 scripts/build.py     # produces dist/
node selfhost/server.js      # PORT=8080 by default
```

## License

AGPL-3.0-only, same as the parent project.
