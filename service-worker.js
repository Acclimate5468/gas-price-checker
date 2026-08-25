const CACHE = 'gas-check-v8';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon.ico',
];

const API_HOSTS = ['api.eia.gov', 'bigdatacloud.net', 'overpass-api.de', 'zippopotam.us', 'cdn.jsdelivr.net'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
);

self.addEventListener('activate', e =>
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
);

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (API_HOSTS.some(h => url.hostname.includes(h))) return;
  if (url.pathname.startsWith('/.netlify/functions/')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});
