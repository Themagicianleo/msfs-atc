// Network first, cache as fallback: works offline after one visit, and
// updates show up on the next load. Airport files are cached as you open them.
const CACHE = 'tower-v9';
const SHELL = ['./', 'index.html', 'efb-glass.css', 'tower.css', 'manifest.webmanifest', 'icons/icon-180.png',
  'js/app.js', 'js/commands.js', 'js/geo.js', 'js/layout.js', 'js/render.js', 'js/world.js', 'js/weather.js', 'js/osm.js', 'js/ops.js', 'js/zh.js', 'js/scene3d.js', 'js/vendor/three.module.min.js',
  'js/lib/format.js', 'js/lib/frequency.js', 'js/lib/parser.js', 'js/lib/runway.js', 'js/lib/speech.js', 'js/lib/radio.js', 'js/lib/neural.js', 'js/lib/neural-worker.js', 'js/lib/voice.js',
  'data/phraseology.json', 'data/phraseology-zh.json', 'data/airlines.json', 'data/aircraft.json', 'data/demo.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && /^tower-v\d+$/.test(k)).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});
