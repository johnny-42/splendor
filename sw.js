// 서비스 워커 — 앱 셸을 캐시해서 오프라인에서도 실행되게 한다.
// (혼자 하기/같이 하기는 로컬 엔진으로 동작, 온라인 방은 서버 연결 필요)
const CACHE = 'splendor-v3';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'client.js',
  'local.js',
  'manifest.webmanifest',
  'game/cards.js',
  'game/game.js',
  'game/ai.js',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'socket.io/socket.io.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // 일부 파일이 없어도 설치는 계속한다
      Promise.allSettled(ASSETS.map((a) => c.add(a)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // socket.io 실시간 통신은 가로채지 않는다 (스크립트 파일만 캐시)
  if (url.pathname.startsWith('/socket.io/') && url.pathname !== '/socket.io/socket.io.js') return;

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            // 같은 서버 리소스와 구글 폰트는 런타임 캐시 (다음부터 오프라인 사용 가능)
            const cacheable =
              (res.ok || res.type === 'opaque') &&
              (url.origin === location.origin ||
                url.hostname === 'fonts.googleapis.com' ||
                url.hostname === 'fonts.gstatic.com');
            if (cacheable) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return res;
          })
          .catch(() => {
            // 오프라인: 페이지 요청이면 캐시된 앱 셸로
            if (e.request.mode === 'navigate') return caches.match('./');
            return undefined;
          })
    )
  );
});
