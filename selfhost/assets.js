// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  selfhost/assets.js — local-disk stand-in for Cloudflare's `env.ASSETS`
//  binding (wrangler.toml's `[assets] directory = "./dist" binding =
//  "ASSETS"`), so the real src/index.js fetch handler's
//  `env.ASSETS.fetch(request)` calls work unmodified outside Cloudflare.
//
//  Approximates `not_found_handling = "404-page"`: an unresolved path gets
//  a real dist/404.html body with a genuine 404 status, matching
//  src/index.js's own header comment about why that setting matters
//  (avoids a soft-404 that 200s any path with the homepage).
//
//  Known, disclosed fidelity gaps vs. the real Workers Assets binding (see
//  SELF_HOSTING.md): no ETag/If-None-Match, no Range support, no automatic
//  trailing-slash canonicalization redirect. Low real-world impact — every
//  internal link in this codebase already uses trailing slashes.
// ============================================================

import { readFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.wasm':  'application/wasm',
  '.txt':   'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.pdf':   'application/pdf',
};

async function readIfExists(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

// Static assets referenced with a `?v=`/`?t=` cache-busting query string
// (js/css/searchKeywords — see build.py's _inject_hashes) are safe to cache
// for a year: the URL itself changes whenever the content does, so a stale
// cache entry for an OLD url is simply never requested again. Anything
// requested without one of those query params (a bare URL, or an asset type
// this project doesn't version this way — favicons, manifest.json) gets a
// short cache instead, so an update to it is picked up within the hour
// rather than a full year.
function cacheControlFor(pathname, hasVersionQuery) {
  if (extname(pathname) === '.html') return 'no-cache';
  return hasVersionQuery ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}

export function createAssetsBinding(distDir) {
  const resolvedDist = resolve(distDir);

  return {
    async fetch(request) {
      const url = new URL(request.url);

      let decoded;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        // Malformed percent-encoding (e.g. a lone "%") throws — a real 400,
        // not an unhandled exception that would otherwise 500.
        return new Response('Bad Request', { status: 400 });
      }

      const safePath = decoded.startsWith('/') ? decoded.slice(1) : decoded;
      const base = join(distDir, safePath);

      const candidates = extname(safePath)
        ? [base]
        : [join(base, 'index.html'), `${base}.html`];

      const hasVersionQuery = url.searchParams.has('v') || url.searchParams.has('t');

      for (const candidate of candidates) {
        // path.resolve fully normalizes .. / . segments against an absolute
        // base — any candidate that still escapes dist/ after that is a
        // real traversal attempt, not normalize()'s narrower string-based
        // collapsing.
        const resolvedCandidate = resolve(candidate);
        if (resolvedCandidate !== resolvedDist && !resolvedCandidate.startsWith(resolvedDist + sep)) continue;

        const body = await readIfExists(resolvedCandidate);
        if (body) {
          const type = MIME_TYPES[extname(resolvedCandidate)] || 'application/octet-stream';
          return new Response(body, {
            status: 200,
            headers: {
              'Content-Type': type,
              'Cache-Control': cacheControlFor(resolvedCandidate, hasVersionQuery),
            },
          });
        }
      }

      const notFound = await readIfExists(join(distDir, '404.html'));
      return new Response(notFound || 'Not Found', {
        status: 404,
        headers: { 'Content-Type': notFound ? 'text/html; charset=utf-8' : 'text/plain' },
      });
    },
  };
}
