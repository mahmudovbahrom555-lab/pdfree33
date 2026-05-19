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

const CACHE_VERSION  = 'v63';   // Let browser fetch legal pages directly, bypass SW
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
  '/css/fonts.css',
  '/js/app.js',
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
  '/js/worker.js',
  '/js/worker.js?v=18',
  '/js/ads.js',
  '/js/pageSelectorUtils.js',
  '/js/splitUI.js',
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
  '/js/feedback.js',
  '/js/vendor/pdf.worker.min.js',
  '/js/toolRegistrations.js',
  '/js/pdfEncrypt.js',
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

// ── Install: pre-cache all static assets ─────────────────────
self.addEventListener('install', event => {
  // Skip waiting so the new SW activates immediately
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
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

// ── Fetch: routing by strategy ────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
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

// Navigate fallback: F5 on /jpg2pdf/ etc.
// 1. Try network (SEO page exists as real file → serves correctly)
// 2. If network fails (offline, Live Server 404) → serve cached index.html
// This makes the SPA work on refresh in all environments.
async function navigateFallback(request) {
  // Cache-first for pre-cached HTML pages (privacy, terms, index).
  // Avoids fetch(request) with mode:navigate which can misbehave in SW context.
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    // Fetch by URL string (not request object) to avoid navigate-mode issues.
    const response = await fetch(request.url);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request.url, response.clone());
      return response;
    }
    throw new Error(`HTTP ${response.status}`);
  } catch {
    // Offline or 404: serve the root SPA shell from cache.
    const fallback = await caches.match('/index.html')
                  || await caches.match('/');
    return fallback || new Response('Offline', { status: 503 });
  }
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
