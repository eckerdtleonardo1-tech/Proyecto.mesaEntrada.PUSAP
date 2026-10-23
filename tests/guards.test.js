const test = require('node:test');
const assert = require('node:assert');
const { requireGuest, requireAlumno, requirePersonal, requireOperador } = require('../middleware/auth');

function createMocks(user = null, originalUrl = '/test-url') {
    let redirectedTo = null;
    let statusCode = 200;
    let renderedView = null;
    let nextCalled = false;

    const req = {
        session: { user },
        originalUrl
    };

    const res = {
        redirect: (url) => { redirectedTo = url; },
        status: (code) => {
            statusCode = code;
            return res;
        },
        render: (view) => { renderedView = view; }
    };

    const next = () => { nextCalled = true; };

    return { req, res, next, getResults: () => ({ redirectedTo, statusCode, renderedView, nextCalled }) };
}

test('Guards de Autenticación y Autorización', async (t) => {
    await t.test('requireGuest: permite pasar a un visitante sin sesión', () => {
        const { req, res, next, getResults } = createMocks(null);
        requireGuest(req, res, next);
        const { nextCalled, redirectedTo } = getResults();
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(redirectedTo, null);
    });

    await t.test('requireGuest: redirige al alumno logueado a /alumno', () => {
        const { req, res, next, getResults } = createMocks({ role: 'alumno' });
        requireGuest(req, res, next);
        const { nextCalled, redirectedTo } = getResults();
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(redirectedTo, '/alumno');
    });

    await t.test('requireGuest: redirige al personal logueado a /backoffice', () => {
        const { req, res, next, getResults } = createMocks({ role: 'operador' });
        requireGuest(req, res, next);
        const { nextCalled, redirectedTo } = getResults();
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(redirectedTo, '/backoffice');
    });

    await t.test('requireAlumno: sin sesión redirige a /ingresar conservando next', () => {
        const { req, res, next, getResults } = createMocks(null, '/alumno/cuotas');
        requireAlumno(req, res, next);
        const { nextCalled, redirectedTo } = getResults();
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(redirectedTo, '/ingresar?next=%2Falumno%2Fcuotas');
    });

    await t.test('requireAlumno: usuario no alumno recibe 403', () => {
        const { req, res, next, getResults } = createMocks({ role: 'operador' });
        requireAlumno(req, res, next);
        const { nextCalled, statusCode, renderedView } = getResults();
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(statusCode, 403);
        assert.strictEqual(renderedView, 'errors/403');
    });

    await t.test('requireAlumno: alumno activo pasa sin problemas', () => {
        const { req, res, next, getResults } = createMocks({ role: 'alumno', alumno_id: 1 });
        requireAlumno(req, res, next);
        const { nextCalled } = getResults();
        assert.strictEqual(nextCalled, true);
    });

    await t.test('requirePersonal: sin sesión redirige a /ingresar', () => {
        const { req, res, next, getResults } = createMocks(null, '/backoffice/solicitudes');
        requirePersonal(req, res, next);
        const { nextCalled, redirectedTo } = getResults();
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(redirectedTo, '/ingresar?next=%2Fbackoffice%2Fsolicitudes');
    });

    await t.test('requirePersonal: alumno intentando entrar a personal recibe 403', () => {
        const { req, res, next, getResults } = createMocks({ role: 'alumno' });
        requirePersonal(req, res, next);
        const { nextCalled, statusCode, renderedView } = getResults();
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(statusCode, 403);
        assert.strictEqual(renderedView, 'errors/403');
    });

    await t.test('requirePersonal: operador e interno pasan exitosamente', () => {
        const { req: reqOp, res: resOp, next: nextOp, getResults: resOpG } = createMocks({ role: 'operador' });
        requirePersonal(reqOp, resOp, nextOp);
        assert.strictEqual(resOpG().nextCalled, true);

        const { req: reqInt, res: resInt, next: nextInt, getResults: resIntG } = createMocks({ role: 'interno' });
        requirePersonal(reqInt, resInt, nextInt);
        assert.strictEqual(resIntG().nextCalled, true);
    });

    await t.test('requireOperador: interno recibe 403 al intentar acción de operador', () => {
        const { req, res, next, getResults } = createMocks({ role: 'interno' });
        requireOperador(req, res, next);
        const { nextCalled, statusCode, renderedView } = getResults();
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(statusCode, 403);
        assert.strictEqual(renderedView, 'errors/403');
    });
});
