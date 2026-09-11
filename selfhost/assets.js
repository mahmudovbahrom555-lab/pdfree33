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
import { join, normalize, extname } from 'node:path';

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

export function createAssetsBinding(distDir) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      // Strip any ../ segments before joining — normalize() collapses them,
      // and the startsWith(distDir) check below rejects anything that still
      // escapes the dist/ root after normalization.
      const decoded = decodeURIComponent(url.pathname);
      const safePath = normalize(join('/', decoded)).slice(1);
      const base = join(distDir, safePath);

      const candidates = extname(safePath)
        ? [base]
        : [join(base, 'index.html'), `${base}.html`];

      for (const candidate of candidates) {
        if (!(candidate === distDir || candidate.startsWith(distDir + '/'))) continue; // path traversal guard
        const body = await readIfExists(candidate);
        if (body) {
          const type = MIME_TYPES[extname(candidate)] || 'application/octet-stream';
          return new Response(body, { status: 200, headers: { 'Content-Type': type } });
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
