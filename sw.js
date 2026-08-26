/* Allied Telecalling PWA Service Worker
   Version: 2.0 — Mobile-First Build */

const CACHE_NAME = 'allied-call-v22';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
];

// Install: cache all static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('Some assets failed to cache:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first for Google Sheets API, cache-first for static assets
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Always use network for Google Sheets / Script requests (live data)
  if (url.includes('script.google.com') || url.includes('googleapis.com')) {
    return; // Let it go to network directly
  }

  event.respondWith(
    fetch(event.request).then(response => {
      // Network first — always get latest app files
      if (response && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      // Fall back to cache only when offline
      return caches.match(event.request);
    })
  );
});
