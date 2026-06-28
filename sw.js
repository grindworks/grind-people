// 💡 Rewrite this on update to trigger an update
const CACHE_NAME = "grindpeople-v20260629-2";
const urlsToCache = [
  "./",
  "./index.html",
  "./main.js",
  "./i18n.js",
  "./lang/ja.js",
  "./lang/en.js",
  "./styles.css",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.json",
  './assets/sql-wasm.js',
  './assets/sql-wasm.wasm',
];



// Create cache on install
self.addEventListener('install', (event) => {
  // Immediately activate the new Service Worker
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Add local files in bulk as usual
      await cache.addAll(urlsToCache.filter(url => !url.endsWith('.wasm')));
      // Cache WASM individually (Do not stop Service Worker itself even if it fails)
      cache.add('./assets/sql-wasm.wasm').catch(() => console.warn("WASM cache failed."));
    }),
  );
});

// Delete old cache
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log("古いキャッシュを削除しました:", cacheName);
              return caches.delete(cacheName);
            }
          }),
        );
      })
      .then(() => self.clients.claim()),
  );
});

// Return cache on fetch event
self.addEventListener("fetch", (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    // Ignore query parameters to ensure cache hits for WASM files etc.
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      // Promise to fetch the latest from the network
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // If fetching is successful, silently update the cache in the background (For CORS resources, type is not 'basic', so just checking ok is enough)
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback when offline and not in cache (Only upon HTML access)
        if (
          event.request.mode === "navigate" ||
          (event.request.headers.get("accept") &&
            event.request.headers.get("accept").includes("text/html"))
        ) {
          const fallbackHtml = `\n            <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>People - Offline</title><style>body { font-family: sans-serif; background-color: #fafafa; color: #333; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; } h1 { font-size: 20px; color: #111827; margin-bottom: 16px; font-weight: bold; } p { font-size: 15px; color: #4b5563; line-height: 1.6; margin-bottom: 24px; } .icon { font-size: 48px; margin-bottom: 16px; }</style></head><body><div class="icon">💡</div><h1>You are offline / オフラインです</h1><p>Contact data is safely stored on your device.<br>To use the app offline again, please connect to the internet and reload the page once.<br><br>連絡先データはあなたのPCに安全に保存されています。<br>アプリを再びオフラインで使うには、一度インターネットに接続した状態でアクセスし直してください。</p></body></html>\n          `;
          return new Response(fallbackHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        // If no cache, return explicit error response instead of undefined
        return cachedResponse || new Response("Offline", { status: 503, statusText: "Service Unavailable" });
      });

      // Return immediately if cached (super fast), otherwise wait for network completion (Stale-while-revalidate)
      return cachedResponse || fetchPromise;
    }),
  );
});
