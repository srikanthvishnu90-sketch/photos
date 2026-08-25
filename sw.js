// Gems service worker — an offline app shell, and nothing more.
//
// Scope of caching is deliberately narrow and SAFE:
//   - Only SAME-ORIGIN GET requests are ever touched.
//   - Cross-origin traffic (Supabase, Google auth, jsdelivr CDN, Gemini) is
//     never intercepted — it must reach the network untouched, or auth and the
//     AI features break. We simply don't call respondWith() for those.
//   - Navigations are network-first (always try for fresh HTML), falling back
//     to the cached shell so the app opens offline.
//   - Static assets are cache-first with a background refresh (stale-while-
//     revalidate), so repeat launches are instant and self-heal on the next
//     online visit.
//
// Every handler is wrapped so a cache miss or error can never break the page.

const CACHE = "gems-shell-v17";

const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  // Public legal pages (also linked from the App Store listing)
  "privacy.html",
  "terms.html",
  "legal.css",
  // Stylesheets
  "styles.css",
  "home.css",
  "discover.css",
  "photos.css",
  "editor.css",
  "studio.css",
  "profile.css",
  "reveal.css",
  // App-shell modules (the full graph, so the app runs offline)
  "app.js",
  "app-tabs.js",
  "auth-actions.js",
  "discover-actions.js",
  "discover.js",
  "editor-actions.js",
  "editor.js",
  "gems-board.js",
  "gems-board-view.js",
  "gems-canvas.js",
  "gems-commitment.js",
  "gems-commitment-view.js",
  "gems-collections.js",
  "gems-daily.js",
  "gems-memories.js",
  "gems-memories-view.js",
  "gems-dump.js",
  "gems-edit-intent.js",
  "gems-enrich.js",
  "gems-chat-context.js",
  "gems-edit-interpreter.js",
  "gems-embeddings.js",
  "gems-faces.js",
  "gems-people-view.js",
  "gems-export.js",
  "gems-modes.js",
  "gems-moodboards.js",
  "gems-native.js",
  "gems-photolib.js",
  "gems-presets.js",
  "gems-privacy.js",
  "gems-scene-view.js",
  "gems-scenes.js",
  "gems-segment.js",
  "gems-rank-assembly.js",
  "gems-ranker.js",
  "gems-reveal.js",
  "gems-share.js",
  "gems-style.js",
  "gems-supabase.js",
  "gems-templates.js",
  "gems-zip.js",
  "home-actions.js",
  "home.js",
  "onboarding-api.js",
  "onboarding.js",
  "photos-actions.js",
  "photos.js",
  "profile-actions.js",
  "profile.js",
  "pwa.js",
  "studio-actions.js",
  "studio.js",
  // Icons
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        // addAll is atomic — if one URL 404s the whole precache rejects, so add
        // individually and tolerate the odd miss rather than failing install.
        await Promise.all(
          SHELL.map((url) =>
            cache.add(url).catch(() => {
              /* a missing shell file must not abort the SW */
            }),
          ),
        );
      } catch {
        /* install must never throw */
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        );
        await self.clients.claim();
      } catch {
        /* activate must never throw */
      }
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only ever handle same-origin GETs. Everything else — cross-origin API/auth/
  // CDN calls, POSTs — is left entirely to the browser.
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to the cached shell (offline open).
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(request)) ||
            (await cache.match("index.html")) ||
            (await cache.match("./")) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // Static assets: cache-first with a background refresh.
  event.respondWith(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok && response.type === "basic") {
              cache.put(request, response.clone()).catch(() => {});
            }
            return response;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      } catch {
        try {
          return await fetch(request);
        } catch {
          return Response.error();
        }
      }
    })(),
  );
});
