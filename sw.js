// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 PDFree Contributors  https://github.com/mahmudovbahrom555-lab/pdfree33

// ============================================================
//  sw.js — PDFree Service Worker
//
//  Strategy:
//  - HTML (index.html): stale-while-revalidate — user always
//    gets a response instantly, but a fresh copy is fetched
//    in the background so the next load is up to date.
//  - Static assets (JS/CSS): cache-first — never changes for
//    a given URL, so no need to hit network.
//  - CDN resources (pdf-lib, JSZip): cache-first with network
//    fallback — these are versioned URLs so safe to cache.
//  - Everything else: network-first with cache fallback.
//
//  Versioning: bump CACHE_VERSION when deploying to force
//  the activate handler to clear the old cache.
// ============================================================

const CACHE_VERSION  = '__CACHE_VERSION__';  // auto-set by build.py; never edit manually
const STATIC_CACHE   = `pdfree-static-${CACHE_VERSION}`;
const CDN_CACHE      = `pdfree-cdn-${CACHE_VERSION}`;
const ALL_CACHES     = [STATIC_CACHE, CDN_CACHE];

// Static assets — always serve from cache
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/variables.css',
  '/css/animations.css',
  '/css/layout.css',
  '/css/components.css',
  '/css/components.css?v=__CSS_HASH__',
  '/css/fonts.css',
  '/js/app.js',
  '/js/app.js?v=__APP_HASH__',
  '/js/i18n.js',
  '/js/locales/de.js',
  '/js/locales/es.js',
  '/js/locales/fr.js',
  '/js/locales/pt.js',
  '/js/config.js',
  '/js/utils.js',
  '/js/ui.js',
  '/js/files.js',
  '/js/processor.js',
  '/js/worker.js?v=__WORKER_HASH__',
  '/js/pageSelectorUtils.js',
  '/js/compressUI.js',
  '/js/jpg2pdfUI.js',
  '/js/pdf2jpgUI.js',
  '/js/watermarkUI.js',
  '/js/pageNumUI.js',
  '/js/metaUI.js',
  '/js/extractUI.js',
  '/js/analytics.js',
  '/js/uiComponents.js',
  '/js/protectUI.js',
  '/js/rotateUI.js',
  '/js/redactUI.js',
  '/js/redact-worker.js',
  '/js/behavioralSignals.js',
  '/js/feedback.js',
  '/js/pageNumUtils.js',
  '/js/vendor/pdf.worker.min.js',
  '/js/toolRegistrations.js',
  '/js/pdfEncrypt.js',
  '/js/watermarkImage.js',
  '/js/watermarkRemoveUI.js',
  '/js/pdf2wordTables.js',
  '/js/pdf2wordBorders.js',
  '/js/pdf2wordUI.js',
  '/js/ocrUI.js',
  '/js/fillUI.js',
  '/js/drawUI.js',
  '/js/drawPointer.js',
  '/js/decryptPdf.js',
  '/js/lazyLibs.js',
  '/js/theme.js',
  '/js/toolRegistry.js',
  '/js/search.js',
  '/offline.html',
  '/fonts/dm-mono-400-latin-ext.woff2',
  '/fonts/dm-mono-400-latin.woff2',
  '/fonts/dm-mono-500-latin-ext.woff2',
  '/fonts/dm-mono-500-latin.woff2',
  '/fonts/dm-sans-latin-ext.woff2',
  '/fonts/dm-sans-latin.woff2',
  '/favicon.ico',
  '/icons/favicon.svg',
  '/icons/icon-48.png',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-128.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/privacy.html',
  '/terms.html',
];

// CDN assets — cache on first use (versioned URLs, safe to store)
const CDN_PREFIXES = [
  'https://cdnjs.cloudflare.com/',
];

// Temp store for files received via Share Target (keyed by UUID, cleared after retrieval)
const _sharedFiles = new Map();

// ── Install: pre-cache all static assets ─────────────────────
self.addEventListener('install', event => {
  // skipWaiting() forces immediate activation so the activate handler can
  // delete the broken v69 cache that caused ERR_FAILED on navigation.
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(
        // cache:'reload' bypasses the browser HTTP cache so we always fetch
        // fresh files from the network. Without this, JS/CSS files served
        // with Cache-Control: immutable would be pulled from the stale HTTP
        // cache — causing the new SW to pre-cache the OLD file versions.
        // This is why regular Chrome showed old UI while incognito worked fine.
        STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' }))
      ))
      .catch(err => console.warn('[SW] Pre-cache partial failure:', err))
  );
});

// ── Activate: clean up old caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !ALL_CACHES.includes(k))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())  // Take control immediately
  );
});

// ── Message handler ───────────────────────────────────────────
self.addEventListener('message', event => {
  // Client requests immediate activation (user clicked "Update now")
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  // Client wants a file that arrived via Share Target
  if (event.data?.type === 'GET_SHARED_FILE') {
    const files = _sharedFiles.get(event.data.uuid);
    if (files) {
      _sharedFiles.delete(event.data.uuid);
      event.ports[0]?.postMessage({ files });
    } else {
      event.ports[0]?.postMessage({ files: [] });
    }
  }
});

// ── Fetch: routing by strategy ────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Share Target: POST to / with PDF files
  if (request.method === 'POST' && url.pathname === '/') {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // Only handle GET requests for everything else
  if (request.method !== 'GET') return;

  // Legal pages: let browser fetch directly from network — no SW caching.
  // Bypassing SW avoids mode:navigate and stale-cache issues for these pages.
  if (url.pathname === '/privacy.html' || url.pathname === '/terms.html') return;

  // CDN resources: cache-first
  if (CDN_PREFIXES.some(p => request.url.startsWith(p))) {
    event.respondWith(cdnFirst(request));
    return;
  }

  // Navigation requests (F5, direct URL, browser back/forward)
  // Strategy: try network (serves real file if it exists), fall back to
  // cached /index.html for SPA route URLs like /jpg2pdf/ or /compress-pdf/.
  // This makes F5 work on any route even when Live Server returns 404.
  if (request.mode === 'navigate') {
    event.respondWith(navigateFallback(request));
    return;
  }

  // Same-origin HTML: stale-while-revalidate (non-navigation HTML requests)
  if (url.origin === self.location.origin && (
      request.headers.get('accept')?.includes('text/html') ||
      url.pathname === '/' ||
      url.pathname.endsWith('.html')
  )) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Same-origin static assets: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Everything else: network with cache fallback
  event.respondWith(networkFirst(request));
});

// ── Strategy implementations ──────────────────────────────────

// Navigate fallback: stale-while-revalidate for HTML pages.
// Always fetches fresh HTML in the background so the next load
// (or this one, on first visit) gets the latest page with
// PDFREE_INITIAL_TOOL set. Falls back to cache when offline.
// Uses URL string (not Request object) to avoid navigate-mode issues in SW.
async function navigateFallback(request) {
  const cache  = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  // A cached response that came from a redirect has response.url !== the cache
  // key. Serving it for a navigate event causes ERR_FAILED in Chrome because
  // the browser sees the response URL doesn't match the navigation URL.
  // Treat such entries as a cache miss and always go to the network.
  const validCached = (cached && cached.url === request.url) ? cached : undefined;

  // Background fetch — updates cache silently; always resolves to a Response.
  const fetchPromise = fetch(request.url).then(response => {
    if (response.ok && response.url === request.url) {
      // Clean non-redirected response — cache and serve.
      cache.put(request.url, response.clone());
      return response;
    }
    // Server redirected us (stale CDN cache or intentional redirect).
    // Returning a "redirected" Response directly to a navigate event causes
    // ERR_FAILED in Chrome. Convert it to a proper 302 so Chrome follows it
    // cleanly instead.
    if (response.redirected && response.url) {
      return Response.redirect(response.url, 302);
    }
    return response;
  }).catch(async () => {
    // Network failed: cached version → SPA shell → branded offline page.
    return validCached
        || await caches.match('/index.html')
        || await caches.match('/')
        || await caches.match('/offline.html')
        || new Response('Offline', { status: 503 });
  });

  // Return valid cache immediately (instant load); otherwise wait for network.
  return validCached ?? fetchPromise;
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — resource unavailable', { status: 503 });
  }
}

async function cdnFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CDN_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — CDN resource unavailable', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  // Kick off background fetch regardless — updates cache silently.
  // IMPORTANT: .catch must return a Response, never null.
  // event.respondWith() will throw TypeError if it receives null/undefined.
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => new Response('Offline', { status: 503, statusText: 'Offline' }));

  // Return cached immediately if available; wait for network only on first visit.
  // fetchPromise always resolves to a Response (never null) so this is safe.
  return cached ?? fetchPromise;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response('Offline', { status: 503 });
  }
}

// ── Share Target ──────────────────────────────────────────────
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('pdf').filter(f => f instanceof File);
    if (files.length) {
      const uuid = crypto.randomUUID();
      _sharedFiles.set(uuid, files);
      // Auto-cleanup after 60s in case client never retrieves it
      setTimeout(() => _sharedFiles.delete(uuid), 60_000);
      return Response.redirect(`/?shared=${uuid}`, 303);
    }
  } catch (e) {
    console.warn('[SW] Share Target error:', e);
  }
  return Response.redirect('/', 303);
}
