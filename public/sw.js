/* 별무리 워크스페이스 서비스 워커 — 범위는 /workspace/ 안에서만 동작합니다.
   · push: 서버(workspace-fn)가 보낸 알림을 브라우저에 띄웁니다 (앱을 닫아도 도착).
   · notificationclick: 이미 열린 워크스페이스 탭을 찾아 앞으로 가져오고, 없으면 새로 엽니다.
   저장소(캐시)는 쓰지 않습니다. 화면은 항상 네트워크에서 새로 받습니다. */
const SCOPE = '/workspace/';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try { data = { body: event.data.text() }; } catch { data = {}; }
  }
  const title = String(data.title || '별무리 워크스페이스');
  const body = String(data.body || '새 메시지가 도착했어요.');
  const url = String(data.url || SCOPE);
  const tag = String(data.tag || 'workspace');
  const icon = data.icon ? String(data.icon) : undefined;

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    icon,
    badge: icon,
    data: { url },
    renotify: false,
    silent: false,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || SCOPE;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.includes(SCOPE)) {
        await client.focus();
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

// 설치형(PWA)으로 인정받기 위한 최소한의 통과 처리. 캐시는 하지 않습니다.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => new Response('오프라인입니다.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })));
});
