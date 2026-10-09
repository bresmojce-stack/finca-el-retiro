/*
 * Service Worker - Finca El Retiro
 * Estrategia:
 *  - Página (index.html): red primero (máx. 3 s) → siempre la versión nueva; sin señal usa la copia
 *  - Iconos, fuentes, CDN: cache-first → carga instantánea, funciona offline
 *  - APIs (Supabase, Gemini, Open-Meteo): network-only → datos siempre frescos
 *  - Si la red falla y es una navegación, devuelve el index.html cacheado
 */

const CACHE_VERSION = 'finca-retiro-v11-1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './apple-touch-icon.png',
  './favicon.png'
];

// Dominios cuyas respuestas NUNCA se cachean (siempre van a red)
const API_HOSTS = [
  'supabase.co',
  'supabase.in',
  'generativelanguage.googleapis.com',
  'api.open-meteo.com',
  'geocoding-api.open-meteo.com'
];

// CDNs que SÍ cacheamos para que la app cargue offline
const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      // Intentar cachear todo, pero no fallar si algún archivo no está disponible
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('No se pudo cachear:', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // APIs: pasar directo a la red, sin caché
  if (API_HOSTS.some((h) => url.hostname.includes(h))) {
    return; // No interceptar, deja que el navegador maneje
  }

  // App shell y CDNs: cache-first con actualización en segundo plano
  const isAppShell = url.origin === location.origin;
  const isCdn = CDN_HOSTS.some((h) => url.hostname.includes(h));

  // La página (index.html) va primero a la red para que siempre llegue la versión nueva.
  // Si no hay señal o la red tarda más de 3 s, se usa la copia guardada.
  if (isAppShell && (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html'))) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const red = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        });
        red.catch(() => {});   // evita avisos si la red falla después de usar la copia
        const espera = new Promise((resolve) => setTimeout(resolve, 3000, null));
        try {
          const res = await Promise.race([red, espera]);
          if (res) return res;
        } catch (e) {}
        const guardada = (await cache.match(req)) || (await cache.match('./index.html')) || (await cache.match('./'));
        if (guardada) return guardada;
        try { return await red; } catch (e) { return new Response('', { status: 504, statusText: 'Sin conexión' }); }
      })
    );
    return;
  }

  if (isAppShell || isCdn) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const networkFetch = fetch(req)
          .then((res) => {
            // Solo guardar respuestas válidas
            if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
              cache.put(req, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => null);

        // Devolver caché si existe, mientras se actualiza en segundo plano
        if (cached) {
          networkFetch.catch(() => {}); // disparar pero no esperar
          return cached;
        }

        // Si no hay caché, esperar a la red
        const netRes = await networkFetch;
        if (netRes) return netRes;

        // Última opción: si fue una navegación, devolver el index cacheado
        // (cache.match devuelve una promesa: hay que esperarla, un || directo no funciona)
        if (req.mode === 'navigate') {
          const shell = (await cache.match('./index.html')) || (await cache.match('./'));
          if (shell) return shell;
        }
        return new Response('', { status: 504, statusText: 'Sin conexión' });
      })
    );
  }
});

// Permite que el cliente fuerce un skipWaiting (al recargar después de actualización)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
