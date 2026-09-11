# SPDX-License-Identifier: AGPL-3.0-only
#
# Self-hosted PDFree — runs the real site (the same dist/ scripts/build.py
# produces for pdfree.io itself) plus a thin Node server that imports the
# REAL, live src/index.js Worker handler directly (redirects table, /embed/
# header rewriting, /api/feedback + /api/analytics relays) instead of
# re-deriving any of that logic — see selfhost/server.js's own header
# comment for why, and SELF_HOSTING.md for what this does and doesn't cover.
#
#   docker build -t pdfree-selfhosted .
#   docker run -p 8080:8080 pdfree-selfhosted
#
# Build from the REPO ROOT (this file lives there) — build.py walks the
# whole repo (minus SKIP_DIRS/SKIP_FILES) to produce dist/, same as a real
# pdfree.io deploy.

FROM node:20-alpine AS builder

RUN apk add --no-cache python3 py3-pip \
    && pip3 install --no-cache-dir --break-system-packages jinja2

WORKDIR /repo
COPY . .

# Full install (not --omit=dev) — build.py shells out to terser
# (a devDependency) to minify dist/js/*.js, same as deploy.yml's own
# "Install dependencies" step.
RUN npm ci
RUN python3 scripts/build.py

# The 14 homepage files are hand-copied static HTML with
# https://pdfree.io hardcoded directly in source (canonical, og:url,
# hreflang alternates) — unlike the ~350 Jinja-generated tool pages, which
# already flow through a real base_url template variable. This is a blunt
# post-build string substitution covering both cases uniformly. Known
# limitation, documented in SELF_HOSTING.md: not real per-deployment SEO
# templating, good enough for internal/private use. Defaults to a no-op
# (SITE_URL defaults to the real site) if never overridden at build time.
ARG SITE_URL=https://pdfree.io
RUN if [ "$SITE_URL" != "https://pdfree.io" ]; then \
      grep -rl "https://pdfree.io" dist/ | xargs -r sed -i "s|https://pdfree.io|$SITE_URL|g"; \
    fi


FROM node:20-alpine AS final

WORKDIR /repo
COPY --from=builder /repo/dist ./dist
COPY --from=builder /repo/src ./src
COPY --from=builder /repo/data/tools-config.json ./data/tools-config.json
COPY --from=builder /repo/selfhost ./selfhost

# No built-in auth (matches packages/pdf2md-server's own self-hosted
# posture) — put this behind your own reverse proxy/firewall if exposed
# beyond localhost or a trusted network. See SELF_HOSTING.md.
EXPOSE 8080
ENV PORT=8080

# Node's built-in fetch, not curl/wget — alpine has neither by default,
# same reasoning as packages/pdf2md-server/Dockerfile's own HEALTHCHECK.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "selfhost/server.js"]
