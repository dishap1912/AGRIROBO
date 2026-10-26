/* AgriRobo Service Worker — offline app shell */
var CACHE = 'agrirobo-v2';
var ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/store.js',
  './js/api.js',
  './js/charts.js',
  './js/app.js',
  './js/chart.umd.min.js',
  './manifest.json',
  './icons/icon.svg'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // add one by one so a single missing file can't break the whole install
      return Promise.all(ASSETS.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Never cache API calls to the ESP32 (or anything cross-origin)
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      });
    }).catch(function () {
      return caches.match('./index.html');
    })
  );
});
