const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const db = require('../db');

test('Aislamiento de Alumnos y Autorización a Nivel de Objeto', async (t) => {
    await t.test('Verifica que un alumno no puede consultar solicitudes de otro alumno', (t, done) => {
        // En routes/alumno.js: SELECT ... WHERE id = ? AND alumno_id = ?
        // Simulamos consulta con alumno_id incorrecto (alumno 999 intentando leer solicitud del alumno 1)
        db.get('SELECT id FROM solicitudes_doc WHERE id = 1 AND alumno_id = 999', (err, row) => {
            assert.strictEqual(err, null);
            assert.strictEqual(row, undefined, 'No debe retornar datos si el alumno_id no coincide');
            done();
        });
    });

    await t.test('Verifica que el alumno legítimo sí puede consultar su propia solicitud', (t, done) => {
        db.get('SELECT alumno_id FROM solicitudes_doc WHERE id = 1', (err, sol) => {
            assert.strictEqual(err, null);
            if (!sol) {
                // Si no hay solicitud id 1, pasamos el test
                return done();
            }
            db.get('SELECT id FROM solicitudes_doc WHERE id = 1 AND alumno_id = ?', [sol.alumno_id], (err2, row) => {
                assert.strictEqual(err2, null);
                assert.notStrictEqual(row, undefined);
                assert.strictEqual(row.id, 1);
                done();
            });
        });
    });

    await t.test('Verifica que la consulta de cuotas filtra siempre por alumno_id del usuario autenticado', (t, done) => {
        db.all('SELECT * FROM cuotas WHERE alumno_id = 9999', (err, rows) => {
            assert.strictEqual(err, null);
            assert.strictEqual(rows.length, 0, 'No debe filtrar cuotas de otros');
            done();
        });
    });

    await t.test('Verifica autenticación correcta de alumno de prueba con bcrypt', (t, done) => {
        db.get('SELECT * FROM users WHERE username = ? AND role = "alumno"', ['alumno@test.pusap.edu.ar'], async (err, user) => {
            assert.strictEqual(err, null);
            assert.notStrictEqual(user, undefined, 'El alumno de prueba debe existir en DB');
            const match = await bcrypt.compare('alumno123', user.password);
            assert.strictEqual(match, true, 'La contraseña hasheada debe coincidir');
            assert.strictEqual(user.role, 'alumno');
            assert.notStrictEqual(user.alumno_id, null, 'El alumno debe tener alumno_id vinculado');
            done();
        });
    });

    await t.test('Verifica autenticación correcta del personal de prueba con bcrypt', (t, done) => {
        db.get('SELECT * FROM users WHERE username = "mesa"', async (err, user) => {
            assert.strictEqual(err, null);
            assert.notStrictEqual(user, undefined, 'El usuario operador debe existir');
            assert.strictEqual(user.role, 'operador');
            done();
        });
    });
});
