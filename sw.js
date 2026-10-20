// Bump the version on every release; the new worker waits until the page asks for it (SKIP_WAITING)
const CACHE_NAME = 'grindpeople-v20261020-3';
const urlsToCache = [
  './',
  './index.html',
  './main.js',
  './i18n.js',
  './lang/ja.js',
  './lang/en.js',
  './styles.css',
  './icon-192.png',
  './icon-512.png',
  './manifest.json',
  './assets/sql-wasm.js',
  './assets/sql-wasm.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((cacheName) =>
            cacheName.startsWith('grindpeople-') && cacheName !== CACHE_NAME
              ? caches.delete(cacheName)
              : undefined,
          ),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const precachedPaths = new Set(urlsToCache.map((url) => new URL(url, self.location).pathname));

function isHtmlRequest(request) {
  return request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
}

const offlineFallbackHtml = `\n            <!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>People - Offline</title><style>body { font-family: sans-serif; background-color: #fafafa; color: #333; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; } h1 { font-size: 20px; color: #111827; margin-bottom: 16px; font-weight: bold; } p { font-size: 15px; color: #4b5563; line-height: 1.6; margin-bottom: 24px; } .icon { font-size: 48px; margin-bottom: 16px; }</style></head><body><div class="icon">💡</div><h1>You are offline / オフラインです</h1><p>Contact data is safely stored on your device.<br>To use the app offline again, please connect to the internet and reload the page once.<br><br>連絡先データはあなたのPCに安全に保存されています。<br>アプリを再びオフラインで使うには、一度インターネットに接続した状態でアクセスし直してください。</p></body></html>\n`;

function offlineResponse(request) {
  if (isHtmlRequest(request)) {
    return caches.match('./index.html').then(
      (cached) =>
        cached || new Response(offlineFallbackHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    );
  }
  return Response.error();
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !precachedPaths.has(url.pathname)) return;

  // Precached files come only from this version's cache; CACHE_NAME updates them as a whole
  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(event.request, { ignoreSearch: true }))
      .then((response) => response || fetch(event.request))
      .catch(() => offlineResponse(event.request)),
  );
});
