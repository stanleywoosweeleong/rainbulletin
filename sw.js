/* 雨情通报 RainBulletin MY — service worker
   Keep CACHE_VERSION in step with the constant in index.html. */
var CACHE_VERSION = "rbmy-v4.31.1-20260728";
/* icon.svg belongs here: since v4.29.1 the page links it as favicon and
   apple-touch-icon, and the manifest names it too — without it cached, an
   offline launch 404s for its own icon. */
var SHELL = ["./", "./index.html", "./manifest.json", "./icon.svg"];
var SHARE_CACHE = "rbmy-share";

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_VERSION).then(function (c) { return c.addAll(SHELL); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === CACHE_VERSION ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* ── share target ──────────────────────────────────────────────────
   Android and desktop Chrome can hand files to an installed PWA through the
   system share sheet. The POST cannot be read by the page directly, so it is
   caught here, the files are parked in a cache, and the page is redirected to
   collect them. iOS does not implement share_target, so this never fires
   there — the file picker remains the route on iPhone. */
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);

  if (e.request.method === "POST" && url.pathname.indexOf("share-target") !== -1) {
    e.respondWith((async function () {
      try {
        var fd = await e.request.formData();
        var files = fd.getAll("images").filter(function (f) { return f && f.size; });
        var cache = await caches.open(SHARE_CACHE);
        var old = await cache.keys();
        await Promise.all(old.map(function (k) { return cache.delete(k); }));
        for (var i = 0; i < files.length; i++) {
          await cache.put("./__shared/" + i, new Response(files[i], {
            headers: {
              "content-type": files[i].type || "image/png",
              "x-shot": String(files[i].lastModified || 0)
            }
          }));
        }
        await cache.put("./__shared/count", new Response(String(files.length)));
      } catch (err) { /* fall through to the app either way */ }
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }

  if (e.request.method !== "GET") return;

  /* The app talks to no weather API at all — rain arrives only as pasted
     images — so everything cacheable here is the shell itself. */
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then(function (hit) {
      var live = fetch(e.request).then(function (res) {
        /* don't let query variants (./?shared=1) pollute the versioned shell */
        if (res && res.ok && !url.search) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        if (hit) return hit;
        /* offline navigation to an uncached variant still gets the app shell
           instead of a browser error page */
        if (e.request.mode === "navigate") return caches.match("./index.html");
        return undefined;
      });
      return hit || live;
    })
  );
});
