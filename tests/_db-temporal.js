/**
 * Helper de tests: apunta la app a una base SQLite descartable y activa NODE_ENV=test.
 * Debe requerirse ANTES de cargar ../server o ../db. No lo recoge `node --test`
 * porque el patrón es tests/*.test.js.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// En Windows la base no se puede borrar mientras este proceso la tiene abierta, así que cada
// corrida elimina las que dejaron las anteriores. Sólo las de más de un minuto: los archivos de
// test corren en paralelo y no hay que tocar la base de uno que está en curso.
for (const archivo of fs.readdirSync(os.tmpdir())) {
    if (!archivo.startsWith('pusap-test-')) continue;
    const completa = path.join(os.tmpdir(), archivo);
    try {
        if (Date.now() - fs.statSync(completa).mtimeMs > 60 * 1000) fs.unlinkSync(completa);
    } catch (e) { /* ya no existe o está en uso */ }
}

const ruta = path.join(os.tmpdir(), `pusap-test-${process.pid}-${Date.now()}.db`);
process.env.NODE_ENV = 'test';
process.env.DB_PATH = ruta;

// Limpieza best-effort: en Windows el archivo puede seguir tomado por la conexión abierta
process.on('exit', () => {
    ['', '-wal', '-shm'].forEach(ext => { try { fs.unlinkSync(ruta + ext); } catch (e) { /* ignorar */ } });
});

module.exports = ruta;
