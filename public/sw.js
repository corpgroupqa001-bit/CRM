// corpgroup.com service worker: offline shell + web push (PWA, NFR-10/11)
const CACHE = "cg-shell-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/manifest.webmanifest", "/icons/icon.svg"])));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
// network-first for pages, so data is never stale; fall back to cache when offline
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(data.title || "corpgroup.com", {
    body: data.body || "", icon: "/icons/icon.svg", data: { url: data.url || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow(e.notification.data.url));
});
