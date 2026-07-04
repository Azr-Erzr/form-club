/* Form — offline shell */
const VERSION = 'form-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'data/exercises.csv', 'data/workouts.csv', 'data/workout_days.csv',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Google Sheets / Apps Script / YouTube: network only, never cache.
  if (url.hostname.includes('google') || url.hostname.includes('youtube') || url.hostname.includes('gstatic')) return;

  // Same-origin shell + fonts/lucide CDN: cache-first with background refresh.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const fetched = fetch(e.request).then((res) => {
        if (res.ok && (url.origin === location.origin || url.hostname === 'unpkg.com' || url.hostname === 'fonts.googleapis.com')) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fetched;
    })
  );
});
