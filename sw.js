// Service Worker: macht die App offline nutzbar.
// Strategie "Netz zuerst, sonst Zwischenspeicher": Mit Internet kommt automatisch die neueste Version,
// ohne Internet (Schwimmhalle) startet die App aus dem Zwischenspeicher. Es werden nur die eigenen
// App-Dateien geladen - keine fremden Adressen, keine Daten.
const CACHE = 'dlrg-anwesenheit-v1';
const FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/model.js',
  './js/export.js',
  './js/importer.js',
  './js/backup.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function fromNetwork(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS);
    fetch(request, { cache: 'no-cache' }).then((res) => {
      clearTimeout(timer);
      if (!res || !res.ok) { reject(new Error('status')); return; }
      resolve(res);
    }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fromNetwork(req);
      cache.put(req, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true }) ||
        (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      return hit || new Response('Offline und nicht im Zwischenspeicher.', { status: 503 });
    }
  })());
});
