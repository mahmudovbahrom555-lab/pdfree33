# SPDX-License-Identifier: AGPL-3.0-only
#
# Build from the REPO ROOT, not this directory — the build context must
# include js/, the same way `npm run sync` needs repo-root access locally
# (see packages/pdf2read-core/scripts/copy-core.mjs):
#
#   docker build -f packages/pdf2read-server/Dockerfile -t pdf2read-server .
#   docker run -p 8080:8080 pdf2read-server
#
# Multi-stage: builder installs + syncs pdf2read-core's core/ from js/, final
# stage keeps only what's needed to run. @pdfree/pdf2read-core is a `file:`
# dependency (npm symlinks it, doesn't copy) — the final stage preserves
# the same packages/pdf2read-core + packages/pdf2read-server sibling layout
# so that symlink still resolves; copying only pdf2read-server's
# node_modules would leave it dangling.

FROM node:20-alpine AS builder

WORKDIR /repo
COPY js/pdf2readCore.js js/pdf2wordTables.js js/pdf2wordColumns.js js/pdf2wordBorders.js js/textLayoutUtils.js ./js/

# Explicit files, not `COPY packages/pdf2read-core ./packages/pdf2read-core`
# — a wholesale directory copy would also pick up a local dev node_modules/
# or already-synced src/core/ if present when building from a dev
# checkout, wasting cache/context for no benefit (there's no .dockerignore
# here to filter it: this Dockerfile's build context is the REPO ROOT, not
# this directory, so a .dockerignore placed in packages/pdf2read-server/
# would silently never apply — listing exact files avoids the problem
# entirely instead of shipping a misleading ignore file).
COPY packages/pdf2read-core/package.json      ./packages/pdf2read-core/package.json
COPY packages/pdf2read-core/package-lock.json ./packages/pdf2read-core/package-lock.json
COPY packages/pdf2read-core/scripts           ./packages/pdf2read-core/scripts
COPY packages/pdf2read-core/src               ./packages/pdf2read-core/src
COPY packages/pdf2read-server/package.json      ./packages/pdf2read-server/package.json
COPY packages/pdf2read-server/package-lock.json ./packages/pdf2read-server/package-lock.json
COPY packages/pdf2read-server/server.js         ./packages/pdf2read-server/server.js
COPY packages/pdf2read-server/convertWorker.js  ./packages/pdf2read-server/convertWorker.js

WORKDIR /repo/packages/pdf2read-core
RUN npm ci --omit=optional && npm run sync

WORKDIR /repo/packages/pdf2read-server
RUN npm ci --omit=optional


FROM node:20-alpine AS final

WORKDIR /repo
COPY --from=builder /repo/packages/pdf2read-core/node_modules ./packages/pdf2read-core/node_modules
COPY --from=builder /repo/packages/pdf2read-core/src           ./packages/pdf2read-core/src
COPY --from=builder /repo/packages/pdf2read-core/package.json  ./packages/pdf2read-core/package.json
COPY --from=builder /repo/packages/pdf2read-server/node_modules ./packages/pdf2read-server/node_modules
COPY --from=builder /repo/packages/pdf2read-server/server.js        ./packages/pdf2read-server/server.js
COPY --from=builder /repo/packages/pdf2read-server/convertWorker.js ./packages/pdf2read-server/convertWorker.js
COPY --from=builder /repo/packages/pdf2read-server/package.json     ./packages/pdf2read-server/package.json

WORKDIR /repo/packages/pdf2read-server

# No built-in auth (see README.md) — do not expose this port directly to
# an untrusted network without your own reverse proxy/firewall in front.
EXPOSE 8080
ENV PORT=8080

# Node's built-in fetch, not curl/wget — alpine has neither installed by
# default, and adding one just for this would be a real extra package for
# a single GET request Node can already do natively (18+).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Runs as the non-root 'node' user the base image already provides —
# converting an arbitrary uploaded PDF is exactly the kind of untrusted
# input that shouldn't run as root.
USER node

CMD ["node", "server.js"]
