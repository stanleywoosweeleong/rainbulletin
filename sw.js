/* 雨情 RainBulletin MY — self-updating service worker

   There is no version number to bump. The app opens instantly from the cache;
   the page then sends "check", every shell file is re-fetched past the HTTP
   cache, and if index.html came back different every open window is sent
   "updated" so it can offer a reload. Deploying is just pushing the files. */
"use strict";

var CACHE_PREFIX = "rbmy-";           /* this app's caches — see activate */
var CACHE = "rbmy-shell";             /* fixed name; never changes between deploys */
var SHARE_CACHE = "rbmy-share";       /* parked share-target files; not ours to clear */
var INDEX = "./index.html";
/* icon.svg belongs here: the page links it as favicon and apple-touch-icon,
   the manifest names it, and the first-launch language picker shows it —
   without it cached, an offline launch 404s for its own icon. */
var SHELL = [INDEX, "./manifest.json", "./icon.svg"];

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  var x = new Uint8Array(a), y = new Uint8Array(b);
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/* Fetch one file past the HTTP cache and store it. Resolves true only when a
   copy was already cached and the new one differs. Errors and non-200
   responses leave the cache alone, so a 404/503 from the host can never
   replace the offline app with an error page. */
function refresh(url) {
  return fetch(url, { cache: "no-cache" }).then(function (res) {
    if (!res || !res.ok) return false;
    return caches.open(CACHE).then(function (c) {
      return c.match(url).then(function (old) {
        return Promise.all([
          old ? old.arrayBuffer() : null,
          res.clone().arrayBuffer()
        ]).then(function (b) {
          var changed = !!b[0] && !sameBytes(b[0], b[1]);
          return c.put(url, res).then(function () { return changed; });
        });
      });
    });
  }).catch(function () { return false; });
}

function refreshShell() {
  return Promise.all(SHELL.map(refresh)).then(function (changed) {
    return changed[SHELL.indexOf(INDEX)];
  });
}

/* install: precache, then take over at once. Safe because the cache name is
   stable — a new worker never strands an open page on a deleted cache. */
self.addEventListener("install", function (e) {
  e.waitUntil(refreshShell().then(function () { return self.skipWaiting(); }));
});

/* activate: delete only THIS app's other caches (the old rbmy-v4.x ones).
   Cache Storage is shared by the whole origin — on <user>.github.io that is
   every project page — so caches without our prefix are never touched. */
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) {
      return (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE && k !== SHARE_CACHE)
        ? caches.delete(k) : null;
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }

  /* ── share target ──────────────────────────────────────────────────
     Android and desktop Chrome can hand files to an installed PWA through the
     system share sheet. The POST cannot be read by the page directly, so it is
     caught here, the files are parked in a cache, and the page is redirected to
     collect them. iOS does not implement share_target, so this never fires
     there — the file picker remains the route on iPhone. */
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
      /* absolute, so it does not lean on the worker's base URL */
      return Response.redirect(new URL("./?shared=1", self.location.href).href, 303);
    })());
    return;
  }

  if (e.request.method !== "GET") return;

  /* Cross-origin (the Open-Meteo forecast call) is the page's business. */
  if (url.origin !== self.location.origin) return;

  /* Navigations get the cached app at once — query variants like ./?shared=1
     included — and the network only when nothing is cached yet. Freshness is
     the "check" message's job, not this handler's: on weak rural signal a
     network-first launch means waiting out a timeout before anything shows. */
  if (e.request.mode === "navigate") {
    e.respondWith(caches.match(INDEX).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        if (res.ok && !url.search) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(INDEX, copy); });
        }
        return res;
      });
    }));
    return;
  }

  /* Other same-origin files: cache first, then network, keeping what comes
     back. ignoreSearch is off on purpose — only exact shell URLs are served. */
  e.respondWith(caches.match(e.request).then(function (hit) {
    if (hit) return hit;
    return fetch(e.request).then(function (res) {
      if (res && res.status === 200 && res.type === "basic" && !url.search) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    });
  }));
});

/* "check" from a page: refresh the shell and, if index.html changed, tell
   every open window so each can offer a reload. The page drives this rather
   than the fetch handler so the answer cannot arrive before anyone listens. */
self.addEventListener("message", function (e) {
  if (e.data !== "check") return;
  e.waitUntil(refreshShell().then(function (changed) {
    if (!changed) return;
    return self.clients.matchAll({ type: "window" }).then(function (list) {
      list.forEach(function (c) { c.postMessage("updated"); });
    });
  }));
});
