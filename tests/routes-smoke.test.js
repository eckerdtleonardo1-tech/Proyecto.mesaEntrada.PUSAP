require('./_db-temporal'); // base descartable: el smoke test no toca database_v2.db
const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');

test('Smoke Test de Rutas Públicas vs. Protegidas', async (t) => {
    let server;
    let baseUrl;

    await new Promise((resolve) => {
        server = app.listen(0, () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });

    t.after(() => {
        server.close();
    });

    await t.test('GET / es público y responde HTTP 200', async () => {
        const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
        assert.strictEqual(res.status, 200);
        const text = await res.text();
        assert.match(text, /PUSAP/);
    });

    await t.test('GET /ingresar es público y responde HTTP 200', async () => {
        const res = await fetch(`${baseUrl}/ingresar`, { redirect: 'manual' });
        assert.strictEqual(res.status, 200);
        const text = await res.text();
        assert.match(text, /Ingresar al Portal/);
    });

    await t.test('GET /login redirige 301 a /ingresar', async () => {
        const res = await fetch(`${baseUrl}/login`, { redirect: 'manual' });
        assert.strictEqual(res.status, 301);
        assert.strictEqual(res.headers.get('location'), '/ingresar');
    });

    await t.test('GET /alumno sin sesión redirige 302 a /ingresar con next', async () => {
        const res = await fetch(`${baseUrl}/alumno`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/ingresar?next=%2Falumno');
    });

    await t.test('GET /alumno/cuotas sin sesión redirige 302 a /ingresar con next', async () => {
        const res = await fetch(`${baseUrl}/alumno/cuotas`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/ingresar?next=%2Falumno%2Fcuotas');
    });

    await t.test('GET /backoffice/solicitudes sin sesión redirige 302 a /ingresar con next', async () => {
        const res = await fetch(`${baseUrl}/backoffice/solicitudes`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/ingresar?next=%2Fbackoffice%2Fsolicitudes');
    });

    await t.test('GET /panel sin sesión redirige a /login (comportamiento original)', async () => {
        const res = await fetch(`${baseUrl}/panel`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.match(res.headers.get('location'), /login/);
    });

    await t.test('GET /carreras es público y responde HTTP 200', async () => {
        const res = await fetch(`${baseUrl}/carreras`, { redirect: 'manual' });
        assert.strictEqual(res.status, 200);
        const text = await res.text();
        assert.match(text, /Oferta Académica/);
    });

    await t.test('GET /contacto es público y responde HTTP 200', async () => {
        const res = await fetch(`${baseUrl}/contacto`, { redirect: 'manual' });
        assert.strictEqual(res.status, 200);
        const text = await res.text();
        assert.match(text, /Contacto/);
    });

    await t.test('GET /seguimiento ya no es público: redirige al login', async () => {
        const res = await fetch(`${baseUrl}/seguimiento?codigo=PUSAP-TEST`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/ingresar');
    });

    await t.test('GET /nuevo-tramite ya no es público: redirige al login', async () => {
        const res = await fetch(`${baseUrl}/nuevo-tramite`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/ingresar');
    });

    await t.test('POST /nuevo-tramite no crea expedientes sin sesión', async () => {
        const res = await fetch(`${baseUrl}/nuevo-tramite`, {
            method: 'POST', redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'first_name=Anonimo&last_name=Test&dni=1&category=Test'
        });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/ingresar');
    });

    await t.test('Las páginas públicas no ofrecen iniciar ni seguir trámites', async () => {
        for (const ruta of ['/', '/carreras', '/contacto']) {
            const html = await (await fetch(`${baseUrl}${ruta}`)).text();
            assert.ok(!html.includes('href="/nuevo-tramite'), `${ruta} enlaza a /nuevo-tramite`);
            assert.ok(!html.includes('href="/seguimiento'), `${ruta} enlaza a /seguimiento`);
        }
    });

    await t.test('El inicio público muestra las ventajas de la institución', async () => {
        const html = await (await fetch(`${baseUrl}/`)).text();
        assert.match(html, /id="ventajas"/);
        assert.match(html, /Ventajas de estudiar en PUSAP/);
    });

    for (const ruta of [
        '/backoffice', '/backoffice/consultas', '/backoffice/consultas/1', '/backoffice/carreras',
        '/backoffice/carreras/nueva', '/backoffice/ventajas', '/backoffice/contenido',
        '/backoffice/novedades', '/backoffice/faqs', '/alumno/consultas', '/alumno/consultas/nueva'
    ]) {
        await t.test(`GET ${ruta} sin sesión redirige al login`, async () => {
            const res = await fetch(`${baseUrl}${ruta}`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.ok(res.headers.get('location').startsWith('/ingresar?next='), `${ruta} → ${res.headers.get('location')}`);
        });
    }

    await t.test('Los archivos privados exigen sesión', async () => {
        const res = await fetch(`${baseUrl}/descargas/privado/cualquiera.pdf`, { redirect: 'manual' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/ingresar');
    });

    await t.test('El service worker no sirve páginas desde caché (evita inicios y barras viejas)', async () => {
        const sw = await (await fetch(`${baseUrl}/sw.js`)).text();
        assert.ok(!sw.includes("'fetch'"), 'sw.js no debe interceptar peticiones');
        assert.ok(sw.includes('caches.delete'), 'sw.js debe borrar las cachés del service worker viejo');
        const home = await (await fetch(`${baseUrl}/`)).text();
        assert.ok(!home.includes("register('/sw.js')"), 'las páginas no deben registrar el service worker');
    });

    await t.test('GET /ruta-inexistente responde HTTP 404', async () => {
        const res = await fetch(`${baseUrl}/esta-ruta-no-existe-xyz`, { redirect: 'manual' });
        assert.strictEqual(res.status, 404);
        const text = await res.text();
        assert.match(text, /404/);
    });
});
