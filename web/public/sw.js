/**
 * Offline service worker for FrameScript Studio.
 *
 * The app has no backend and does all its work on device, so it should keep
 * working without a network. Strategy:
 *
 *   - navigations: network first, falling back to the cached shell, so a new
 *     deploy is picked up promptly but offline still loads;
 *   - static assets: cache first, since Vite fingerprints their filenames and a
 *     changed asset is a different URL.
 *
 * It never caches or inspects user media. Files the user opens are read through
 * the File API and never touch this cache.
 *
 * `/api/*` is excluded outright. Those requests carry speech windows, selected
 * keyframes and transcripts; none of it may be stored, replayed from a cache,
 * or served to a later visitor. The guard is by URL prefix rather than by
 * method, so a GET to an API route is skipped too.
 */

const VERSION = 'framescript-studio-v3';
const SHELL = [
  '/',
  '/studio',
  '/view',
  '/docs',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-32.png',
  '/icons/icon-128.png',
  '/icons/icon-512.png',
];

async function precacheShell() {
  const cache = await caches.open(VERSION);
  await Promise.allSettled(SHELL.map((path) => cache.add(path)));

  // Vite fingerprints production JS and CSS, so discover only the same-origin
  // /assets references declared by our generated HTML. User files never enter
  // this path: File API objects are not part of the application shell.
  const response = await fetch('/index.html', { cache: 'no-cache' });
  if (!response.ok || response.type !== 'basic') return;
  const html = await response.clone().text();
  await cache.put('/index.html', response);
  const assets = [
    ...new Set(
      [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)]
        .map((match) => match[1])
        .filter(Boolean),
    ),
  ];
  await Promise.allSettled(assets.map((path) => cache.add(path)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheShell()
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('framescript-studio-') && key !== VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Analysis endpoints: never cached, never intercepted. Falls through to the
  // network exactly as if no service worker were installed.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches.open(VERSION).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  const cacheableDestination = ['script', 'style', 'image', 'font', 'manifest'].includes(
    request.destination,
  );
  if (!cacheableDestination) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Only cache successful same-origin responses; an opaque or errored
        // response cached here would be served forever.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
