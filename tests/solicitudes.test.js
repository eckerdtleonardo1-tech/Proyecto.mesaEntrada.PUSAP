const test = require('node:test');
const assert = require('node:assert');

const TRANSICIONES_VALIDAS = {
    'borrador': ['enviada'],
    'enviada': ['en_revision'],
    'en_revision': ['observada', 'aprobada', 'rechazada'],
    'observada': ['enviada'],
    'aprobada': ['emitida'],
    'rechazada': [],
    'emitida': []
};

function validarTransicion(estadoActual, estadoNuevo) {
    const permitidos = TRANSICIONES_VALIDAS[estadoActual] || [];
    return permitidos.includes(estadoNuevo);
}

test('Transiciones de Estado de Solicitudes de Documentación', async (t) => {
    await t.test('Alumno puede enviar una solicitud en borrador', () => {
        assert.strictEqual(validarTransicion('borrador', 'enviada'), true);
    });

    await t.test('Personal puede tomar una solicitud enviada para ponerla en revisión', () => {
        assert.strictEqual(validarTransicion('enviada', 'en_revision'), true);
    });

    await t.test('Personal puede observar una solicitud en revisión', () => {
        assert.strictEqual(validarTransicion('en_revision', 'observada'), true);
    });

    await t.test('Alumno puede reenviar una solicitud observada tras adjuntar corrección', () => {
        assert.strictEqual(validarTransicion('observada', 'enviada'), true);
    });

    await t.test('Personal puede aprobar una solicitud en revisión', () => {
        assert.strictEqual(validarTransicion('en_revision', 'aprobada'), true);
    });

    await t.test('Personal puede emitir documento sobre una solicitud aprobada', () => {
        assert.strictEqual(validarTransicion('aprobada', 'emitida'), true);
    });

    await t.test('Personal puede rechazar una solicitud en revisión', () => {
        assert.strictEqual(validarTransicion('en_revision', 'rechazada'), true);
    });

    await t.test('NO se permite pasar de borrador directo a emitida', () => {
        assert.strictEqual(validarTransicion('borrador', 'emitida'), false);
    });

    await t.test('NO se permite modificar una solicitud rechazada', () => {
        assert.strictEqual(validarTransicion('rechazada', 'aprobada'), false);
        assert.strictEqual(validarTransicion('rechazada', 'enviada'), false);
    });

    await t.test('NO se permite reabrir una solicitud ya emitida', () => {
        assert.strictEqual(validarTransicion('emitida', 'en_revision'), false);
    });
});
