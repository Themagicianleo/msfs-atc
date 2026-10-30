// Network-first service worker: always tries the helper first so edits to
// phraseology files show up at once; falls back to the cached app shell.
const CACHE = 'openatc-v2';
const SHELL = ['./', 'index.html', 'app.css', 'manifest.webmanifest', 'js/main.js', 'js/speech.js', 'js/voice.js',
  'js/atc/engine.js', 'js/atc/format.js', 'js/atc/frequency.js', 'js/atc/parser.js', 'js/atc/runway.js', 'js/atc/phraseology.js',
  'icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});
