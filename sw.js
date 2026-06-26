// 💡 アップデート時はここを書き換えることで更新が発火します
const CACHE_NAME = "grindpeople-v20260625-5";
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



// インストール時にキャッシュを作成
self.addEventListener('install', (event) => {
  // 新しいService Workerを即座にアクティブにする
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // ローカルファイルは通常通り一括追加
      await cache.addAll(urlsToCache.filter(url => !url.endsWith('.wasm')));
      // WASMは個別にキャッシュ（失敗してもService Worker自体は止めない）
      cache.add('./assets/sql-wasm.wasm').catch(() => console.warn("WASM cache failed."));
    }),
  );
});

// 古いキャッシュを削除
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

// fetchイベントでキャッシュを返す
self.addEventListener("fetch", (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    // クエリパラメータを無視してWASMファイルなどを確実にキャッシュヒットさせる
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      // ネットワークから最新を取得するPromise
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        // 取得成功したらキャッシュを裏でこっそり更新する (CORSリソースの場合は type="basic" 以外も許可するためOK判定のみ)
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // オフラインかつキャッシュにもない場合のフォールバック（HTMLへのアクセス時のみ）
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
        return cachedResponse;
      });

      // キャッシュがあれば即座に返し(爆速)、無ければネットワークの完了を待つ (Stale-while-revalidate)
      return cachedResponse || fetchPromise;
    }),
  );
});
