// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  selfhost/server.js — self-hosted entry point for the real pdfree.io
//  site outside Cloudflare Workers.
//
//  Imports the REAL, live default-exported fetch handler from
//  ../src/index.js directly — the same redirects table, /embed/ header
//  rewriting, and /api/feedback + /api/analytics relay logic that runs in
//  production, not a re-derived copy. This deliberately avoids duplicating
//  that routing logic into a second hand-maintained source of truth: this
//  codebase has been burned by exactly that failure mode before (the old
//  `_redirects` file silently going stale while src/index.js's REDIRECTS
//  table was the real, live one — see CLAUDE.md's GSC investigation
//  history). Importing the live object/handler instead of re-deriving it
//  sidesteps that trap entirely.
//
//  Every Cloudflare-account-specific binding src/index.js touches is
//  already defensively guarded in that file itself (checked directly,
//  not assumed): `if (!env.TELEGRAM_BOT_TOKEN...) return`,
//  `if (!env.GSHEET_WEBHOOK_URL...) return`, `if (!env.ANALYTICS) return`.
//  So the only thing this file needs to actually supply is a working
//  `env.ASSETS` (see ./assets.js) — everything else no-ops cleanly when
//  the matching env vars are left unset, which is the normal state for a
//  self-hosted deployment that doesn't have this project's own Telegram
//  bot or Cloudflare Analytics Engine account.
//
//  No built-in auth, by design — matches packages/pdf2md-server's own
//  self-hosted posture. Put this behind your own reverse proxy/firewall if
//  exposed beyond localhost or a trusted network. See SELF_HOSTING.md.
// ============================================================

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/index.js';
import { createAssetsBinding } from './assets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = Number(process.env.PORT) || 8080;
const DIST_DIR  = process.env.DIST_DIR || join(__dirname, '..', 'dist');

const env = {
  ASSETS: createAssetsBinding(DIST_DIR),
  // Optional — wire your own if you want the feedback relay; already a
  // clean no-op in src/index.js when left unset.
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,
  GSHEET_WEBHOOK_URL: process.env.GSHEET_WEBHOOK_URL,
  GSHEET_SECRET:      process.env.GSHEET_SECRET,
  // ANALYTICS intentionally NOT wired — Workers Analytics Engine is a
  // Cloudflare-account-bound binding with no self-hostable equivalent;
  // src/index.js's `if (!env.ANALYTICS) return` guard makes this a clean
  // no-op rather than an error.
};

async function toWebRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

function sendWebResponse(response, res) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body).pipe(res);
}

const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  try {
    const request  = await toWebRequest(req);
    const response = await worker.fetch(request, env);
    sendWebResponse(response, res);
  } catch (err) {
    console.error('[pdfree-selfhost] request failed:', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`pdfree self-hosted listening on :${PORT}`);
});
