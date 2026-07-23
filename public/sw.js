// public/sw.js —— minimal SW: meets the PWA installability requirement (has a fetch handler),
// but caches no HTML/JS/CSS (a refresh always fetches the latest), only providing an offline fallback when navigation fails.
// Never intercept /api/, /ws, or non-GET —— WebSocket / PTF / REST must connect directly.
const OFFLINE = '<!doctype html><meta charset=utf-8><body style="font-family:-apple-system,sans-serif;background:#f0eee6;color:#2b2a27;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div>Offline — check your connection</div></body>';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// Web Push: the server pushes when "this reply turn ends" (can wake the app even when closed).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '🔔 Claude', {
    body: d.body || 'New reply', icon: '/icon.svg', badge: '/icon.svg',
    tag: d.tag || 'push', renotify: true, data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) if ('focus' in c) { try { if ('navigate' in c && url !== '/') await c.navigate(url); } catch (_) {} return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
self.addEventListener('fetch', (e) => {
  const u = e.request.url;
  if (e.request.method !== 'GET' || u.includes('/api/') || u.includes('/ws')) return;
  e.respondWith(
    fetch(e.request).catch(() =>
      e.request.mode === 'navigate'
        ? new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : Response.error()
    )
  );
});
