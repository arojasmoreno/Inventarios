// Service worker: la app (shell estático) se cachea para abrirse sin cobertura
// en planta. La API nunca se cachea: los consumos siempre van a la red.
// Cambiar el nombre de la caché en cada release purga las versiones antiguas
// que se quedaron instaladas en los navegadores de la planta.
const CACHE = "insuma-v2";

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // API en otro origen (producción)
  if (url.pathname.startsWith("/api/")) return;           // API siempre en red
  if (req.mode === "navigate") {
    // Navegación: red primero (para pillarr el último build), caché como respaldo.
    // `cache: "reload"` evita que el HTML salga de la caché HTTP del
    // alojamiento: sin esto, tras un despliegue se seguía cargando el
    // index.html antiguo (y con él, el bundle viejo) hasta caducar la caché.
    e.respondWith(
      fetch(req, { cache: "reload" }).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("/index.html", copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("/index.html")),
    );
    return;
  }
  // Estáticos con hash: caché primero (si está, no se vuelve a descargar).
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }),
  );
});
