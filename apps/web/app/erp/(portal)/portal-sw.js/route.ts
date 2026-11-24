/**
 * Service worker of the portals, served at /erp/portal-sw.js (scope /erp/). It touches only the portal screens and Next's static
 * assets: pages are network-first with the last visited copy as fallback (the screens are client-rendered shells, so a saved page
 * holds no family data; the data itself is cached by the app in localStorage per user and child). Everything else, in particular
 * every request to the Data API, goes straight to the network.
 */
export const dynamic = 'force-static';

const SW = `
const V = 'portal-v1';
const PORTAL = /^\\/erp\\/(parent|student|driver|gate|signin)(\\/|$)/;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.startsWith('/_next/static/')) {
    e.respondWith(caches.open(V).then(async (c) => (await c.match(r)) || fetch(r).then((res) => { if (res.ok) c.put(r, res.clone()); return res; })));
    return;
  }
  if (r.mode === 'navigate' && PORTAL.test(u.pathname)) {
    e.respondWith(fetch(r).then((res) => { if (res.ok) caches.open(V).then((c) => c.put(r, res.clone())); return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match('/erp/parent') || Response.error())));
  }
});
`;

export function GET() {
  return new Response(SW, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/erp/' } });
}
