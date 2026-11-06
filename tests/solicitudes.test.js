const test = require('node:test');
const assert = require('node:assert');
// Se prueba la máquina de estados real que usan las rutas (antes el test tenía una copia propia).
const { validarTransicion, TRANSICIONES_VALIDAS } = require('../lib/solicitud-estados');

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

test('Cierre presencial del trámite', async (t) => {
    await t.test('Una solicitud aprobada puede finalizarse directamente en persona', () => {
        assert.strictEqual(validarTransicion('aprobada', 'finalizada'), true);
    });

    await t.test('Una solicitud con documento emitido también se finaliza en persona', () => {
        assert.strictEqual(validarTransicion('emitida', 'finalizada'), true);
    });

    await t.test('NO se puede finalizar algo que todavía no fue aprobado', () => {
        ['borrador', 'enviada', 'en_revision', 'observada', 'rechazada'].forEach(estado => {
            assert.strictEqual(validarTransicion(estado, 'finalizada'), false, `${estado} → finalizada`);
        });
    });

    await t.test('Una solicitud finalizada es definitiva', () => {
        assert.deepStrictEqual(TRANSICIONES_VALIDAS.finalizada, []);
    });

    await t.test('Un estado desconocido no permite ninguna transición', () => {
        assert.strictEqual(validarTransicion('inexistente', 'aprobada'), false);
    });
});
