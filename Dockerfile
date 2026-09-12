# SPDX-License-Identifier: AGPL-3.0-only
#
# Self-hosted PDFree — runs the real site (the same dist/ scripts/build.py
# produces for pdfree.io itself) plus a thin Node server that imports the
# REAL, live src/index.js Worker handler directly (redirects table, /embed/
# header rewriting, /api/feedback + /api/analytics relays) instead of
# re-deriving any of that logic — see selfhost/server.js's own header
# comment for why, and SELF_HOSTING.md for what this does and doesn't cover.
#
# dist/ must already be built BEFORE this Dockerfile runs — it does NOT run
# npm ci/scripts/build.py itself. This is a deliberate change from an
# earlier version that did: a real CI incident (linux/arm64's `npm ci`
# hanging under QEMU emulation for 6 hours until GitHub's own job timeout
# killed it — a known class of issue for I/O-heavy npm installs under
# emulated architectures) showed that heavy build work has no business
# running per-platform inside a multi-arch Buildx build. The actual build
# (Node + Python + Jinja2 + terser) now runs ONCE, natively, on the CI
# runner's real architecture (see .github/workflows/pdfree-self-hosted-
# docker.yml) — Docker's only job here is packaging already-built output,
# which is cheap even under QEMU emulation.
#
#   python3 scripts/build.py            # produces dist/ — do this first
#   docker build -t pdfree-selfhosted .
#   docker run -p 8080:8080 pdfree-selfhosted
#
# To build for a private domain instead of the public site, set
# PDFREE_SITE_URL before the build step above (see scripts/build.py and
# SELF_HOSTING.md) — this Dockerfile has no SITE_URL handling of its own
# anymore; dist/ simply arrives already correct.

# Pinned to a specific patch (not the floating `node:20-alpine` tag) —
# verified via Docker Hub's own tag list at pin time, same "never a moving
# alias" reasoning already applied to GitHub Actions in this repo's other
# workflows. A floating tag means the base image's Node patch — and
# therefore its exact module-system-detection behavior (see
# selfhost/package.json's own comment for why that specifically matters
# here) — can silently change under a rebuild with no corresponding commit
# in this repo. Bump deliberately on a real version review, not silently.
FROM node:20.20.2-alpine

WORKDIR /repo
COPY dist ./dist
COPY src ./src
COPY data/tools-config.json ./data/tools-config.json
COPY selfhost ./selfhost
# Makes this image's module system explicit rather than relying on Node's
# own default-when-absent behavior — see selfhost/package.json's comment.
COPY selfhost/package.json ./package.json

# No built-in auth (matches packages/pdf2md-server's own self-hosted
# posture) — put this behind your own reverse proxy/firewall if exposed
# beyond localhost or a trusted network; a reverse proxy is also where
# gzip/brotli compression and TLS termination belong (Node's server here
# does neither, same as packages/pdf2md-server's own posture). See
# SELF_HOSTING.md.
EXPOSE 8080
ENV PORT=8080

# Node's built-in fetch, not curl/wget — alpine has neither by default,
# same reasoning as packages/pdf2md-server/Dockerfile's own HEALTHCHECK.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "selfhost/server.js"]
