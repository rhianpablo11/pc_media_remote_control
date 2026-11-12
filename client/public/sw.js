// Minimal pass-through Service Worker for local PWA install/shortcut metadata.
// Never caches WebSocket or live API state endpoints.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
