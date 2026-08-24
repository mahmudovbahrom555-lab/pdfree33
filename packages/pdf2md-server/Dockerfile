# SPDX-License-Identifier: AGPL-3.0-only
#
# Build from the REPO ROOT, not this directory — the build context must
# include js/, the same way `npm run sync` needs repo-root access locally
# (see packages/pdf2md-core/scripts/copy-core.mjs):
#
#   docker build -f packages/pdf2md-server/Dockerfile -t pdf2md-server .
#   docker run -p 8080:8080 pdf2md-server
#
# Multi-stage: builder installs + syncs pdf2md-core's core/ from js/, final
# stage keeps only what's needed to run. @pdfree/pdf2md-core is a `file:`
# dependency (npm symlinks it, doesn't copy) — the final stage preserves
# the same packages/pdf2md-core + packages/pdf2md-server sibling layout so
# that symlink still resolves; copying only pdf2md-server's node_modules
# would leave it dangling.

FROM node:20-alpine AS builder

WORKDIR /repo
COPY js/pdf2mdCore.js js/pdf2wordTables.js js/pdf2wordColumns.js js/textLayoutUtils.js ./js/

# Explicit files, not `COPY packages/pdf2md-core ./packages/pdf2md-core` —
# a wholesale directory copy would also pick up a local dev node_modules/
# or already-synced src/core/ if present when building from a dev
# checkout, wasting cache/context for no benefit (there's no .dockerignore
# here to filter it: this Dockerfile's build context is the REPO ROOT, not
# this directory, so a .dockerignore placed in packages/pdf2md-server/
# would silently never apply — listing exact files avoids the problem
# entirely instead of shipping a misleading ignore file).
COPY packages/pdf2md-core/package.json      ./packages/pdf2md-core/package.json
COPY packages/pdf2md-core/package-lock.json ./packages/pdf2md-core/package-lock.json
COPY packages/pdf2md-core/scripts           ./packages/pdf2md-core/scripts
COPY packages/pdf2md-core/src               ./packages/pdf2md-core/src
COPY packages/pdf2md-server/package.json      ./packages/pdf2md-server/package.json
COPY packages/pdf2md-server/package-lock.json ./packages/pdf2md-server/package-lock.json
COPY packages/pdf2md-server/server.js         ./packages/pdf2md-server/server.js
COPY packages/pdf2md-server/convertWorker.js  ./packages/pdf2md-server/convertWorker.js

WORKDIR /repo/packages/pdf2md-core
RUN npm ci --omit=optional && npm run sync

WORKDIR /repo/packages/pdf2md-server
RUN npm ci --omit=optional


FROM node:20-alpine AS final

WORKDIR /repo
COPY --from=builder /repo/packages/pdf2md-core/node_modules ./packages/pdf2md-core/node_modules
COPY --from=builder /repo/packages/pdf2md-core/src           ./packages/pdf2md-core/src
COPY --from=builder /repo/packages/pdf2md-core/package.json  ./packages/pdf2md-core/package.json
COPY --from=builder /repo/packages/pdf2md-server/node_modules ./packages/pdf2md-server/node_modules
COPY --from=builder /repo/packages/pdf2md-server/server.js        ./packages/pdf2md-server/server.js
COPY --from=builder /repo/packages/pdf2md-server/convertWorker.js ./packages/pdf2md-server/convertWorker.js
COPY --from=builder /repo/packages/pdf2md-server/package.json     ./packages/pdf2md-server/package.json

WORKDIR /repo/packages/pdf2md-server

# No built-in auth (see README.md) — do not expose this port directly to
# an untrusted network without your own reverse proxy/firewall in front.
EXPOSE 8080
ENV PORT=8080

# Runs as the non-root 'node' user the base image already provides —
# converting an arbitrary uploaded PDF is exactly the kind of untrusted
# input that shouldn't run as root.
USER node

CMD ["node", "server.js"]
