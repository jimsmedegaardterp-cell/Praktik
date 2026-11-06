// Service worker: gør appen installérbar og lader den åbne uden net.
// Net først (altid nyeste version); kun hvis nettet mangler, bruges den senest hentede kopi. Kun egne filer – aldrig Supabase/Google.
const CACHE = 'sindal-app-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
    .catch(() => caches.match(req).then((hit) => hit || caches.match('./'))));
});

// Klik på en notifikation åbner/fokuserer appen
self.addEventListener('notificationclick', (e) => { e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./')))); });
