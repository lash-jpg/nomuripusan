const CACHE_VERSION = 'e';  // 같은 날 재배포 시 알파벳 한 글자 올리면 강제 갱신
const CACHE_NAME = 'muriopbs-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + CACHE_VERSION;
const STATIC = ['/', '/onboarding.html', '/results.html', '/course.html', '/share.html', '/offline.html', '/css/style.css', '/js/app.js', '/js/onboarding.js', '/js/results.js', '/js/course.js', '/js/share.js', '/manifest.json'];

const RUNTIME_CONFIG_CACHE = 'runtime-config-v1';
const RUNTIME_CONFIG_TTL = 60 * 60 * 1000; // 1 hour

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME && k !== RUNTIME_CONFIG_CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === '/runtime-config.js') {
    // Network First, cache successful responses with timestamp; expire after 1 hour
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(RUNTIME_CONFIG_CACHE).then(async c => {
          const body = await clone.arrayBuffer();
          const h = new Headers(clone.headers);
          h.set('x-sw-cached-at', String(Date.now()));
          c.put(e.request, new Response(body, { status: clone.status, statusText: clone.statusText, headers: h }));
        });
        return r;
      }).catch(async () => {
        const cache = await caches.open(RUNTIME_CONFIG_CACHE);
        const cached = await cache.match(e.request);
        if (cached) {
          const cachedAt = parseInt(cached.headers.get('x-sw-cached-at') || '0', 10);
          if (Date.now() - cachedAt < RUNTIME_CONFIG_TTL) return cached;
        }
        return new Response(
          'window.RUNTIME_CONFIG=window.RUNTIME_CONFIG||{};window.RUNTIME_CONFIG.kakaoMapKey=null;window.KAKAO_MAP_KEY=window.RUNTIME_CONFIG.kakaoMapKey;\n',
          { headers: { 'Content-Type': 'application/javascript' } }
        );
      })
    );
  } else if (url.pathname.startsWith('/api/')) {
    // Network First for API — 오프라인 시 사용자 친화 메시지 제공
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(
          JSON.stringify({
            error: 'offline',
            detail: '네트워크에 연결되어 있지 않습니다. 저장된 코스 정보는 계속 볼 수 있어요.',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
        )
      )
    );
  } else if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.html')) {
    // Network First for JS/CSS/HTML — 배포 즉시 반영, 오프라인 시 캐시 폴백
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return r;
      }).catch(() => caches.match(e.request).then(cached => {
        if (cached) return cached;
        if (e.request.mode === 'navigate') return caches.match('/offline.html');
        return new Response('', { status: 408 });
      }))
    );
  } else {
    // Cache First for other static (icons, images, manifest)
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(r => {
      const clone = r.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return r;
    }).catch(() => {
      if (e.request.mode === 'navigate') return caches.match('/offline.html');
      return new Response('', { status: 408 });
    })));
  }
});
