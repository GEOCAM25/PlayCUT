// sw.js — Service Worker: cachea la app para que funcione sin internet.
// El contenido del usuario NO se cachea aquí (vive en IndexedDB, en el dispositivo).

const CACHE = 'playcut-v15';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/state.js',
  './js/db.js',
  './js/media.js',
  './js/engine.js',
  './js/timeline.js',
  './js/exporter.js',
  './js/perf.js',
  './js/audioextract.js',
  './js/vendor/lame.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // solo recursos propios

  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        // Cachea nuevos recursos de la propia app.
        if (res.ok && (request.destination === 'script' || request.destination === 'style' || request.destination === 'image' || url.pathname.endsWith('.html'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
