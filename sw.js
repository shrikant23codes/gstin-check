/* Service worker for GSTIN Check.
 *
 * Two caches:
 *   shell  — this app's own files, small, kept fresh
 *   vendor — Tesseract.js, its wasm core and the English traineddata, plus the
 *            web fonts. These are large (the language data alone is ~11 MB), so
 *            they are cached on first use rather than at install time. After one
 *            scan the app works offline for reading images.
 */
var VERSION = 'v1';
var SHELL_CACHE = 'gstin-check-shell-' + VERSION;
var VENDOR_CACHE = 'gstin-check-vendor-' + VERSION;

var SHELL = [
  './',
  'index.html',
  'gstin-core.js',
  'bill-parse.js',
  'image-prep.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

var VENDOR_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'tessdata.projectnaptha.com'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_CACHE && k !== VENDOR_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isVendor(url) {
  for (var i = 0; i < VENDOR_HOSTS.length; i++) {
    if (url.hostname === VENDOR_HOSTS[i] || url.hostname.endsWith('.' + VENDOR_HOSTS[i])) return true;
  }
  return false;
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Never touch a lookup request — those must always hit the network, and the
  // response is about the live status of one specific taxpayer.
  if (url.origin !== self.location.origin && !isVendor(url)) return;

  // App navigations: serve the cached shell immediately, refresh it in the
  // background so the next launch has the new version.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html').then(function (cached) {
        var network = fetch(req).then(function (res) {
          if (res && res.ok) caches.open(SHELL_CACHE).then(function (c) { c.put('index.html', res.clone()); });
          return res;
        }).catch(function () { return cached; });
        return cached || network;
      })
    );
    return;
  }

  // Vendor assets and own files: cache-first, then fill the cache.
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) {
        // Refresh the app's own shell files in the background; leave the big
        // vendor blobs alone until the version changes.
        if (url.origin === self.location.origin) {
          fetch(req).then(function (res) {
            if (res && res.ok) caches.open(SHELL_CACHE).then(function (c) { c.put(req, res.clone()); });
          }).catch(function () {});
        }
        return cached;
      }
      return fetch(req).then(function (res) {
        var cacheName = isVendor(url) ? VENDOR_CACHE : SHELL_CACHE;
        if (res && (res.ok || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(cacheName).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      });
    })
  );
});
