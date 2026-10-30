process.env.NODE_ENV = 'test';
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

    await t.test('GET /seguimiento es público y responde HTTP 200', async () => {
        const res = await fetch(`${baseUrl}/seguimiento?codigo=PUSAP-TEST`, { redirect: 'manual' });
        assert.strictEqual(res.status, 200);
        const text = await res.text();
        assert.match(text, /Seguimiento de Expediente/);
        assert.match(text, /PUSAP-TEST/);
    });

    await t.test('GET /ruta-inexistente responde HTTP 404', async () => {
        const res = await fetch(`${baseUrl}/esta-ruta-no-existe-xyz`, { redirect: 'manual' });
        assert.strictEqual(res.status, 404);
        const text = await res.text();
        assert.match(text, /404/);
    });
});
