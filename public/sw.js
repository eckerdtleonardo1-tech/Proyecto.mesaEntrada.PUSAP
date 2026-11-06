// Service worker de retiro.
//
// La versión anterior guardaba "/" en caché y la devolvía siempre desde ahí, así que los
// navegadores que ya la habían instalado seguían mostrando un inicio viejo (con la barra de
// navegación vieja) aunque el personal editara el contenido. El sitio es dinámico y trabaja con
// sesiones, por lo que no corresponde cachear páginas.
//
// Este archivo existe sólo para limpiar esos navegadores: cuando reemplaza al service worker
// viejo borra todas las cachés, se desregistra y recarga las pestañas abiertas. No intercepta
// ninguna petición. Se puede eliminar junto con el script de limpieza de views/partials/header.ejs
// cuando ya no queden navegadores con el service worker viejo.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const claves = await caches.keys();
        await Promise.all(claves.map((clave) => caches.delete(clave)));
        await self.registration.unregister();
        const pestanias = await self.clients.matchAll({ type: 'window' });
        pestanias.forEach((pestania) => pestania.navigate(pestania.url));
    })());
});
