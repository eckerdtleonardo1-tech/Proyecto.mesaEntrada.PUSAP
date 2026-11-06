/**
 * Integración de las tres caras del sistema, sobre una base descartable:
 *   - pública (sólo informa),
 *   - alumno (consultas + trámites que se cierran en persona),
 *   - personal (administra contenido, recibe consultas y solicitudes).
 */
require('./_db-temporal');
const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const app = require('../server');
const dbp = require('../lib/dbp');

const CLAVE = 'clave-de-prueba-123';

const formulario = (datos) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(datos)
});

// db.js crea tablas y datos iniciales de forma asíncrona: se espera a que termine
async function esperarBase() {
    for (let i = 0; i < 100; i++) {
        try {
            const [v, u, t, f] = await Promise.all([
                dbp.get('SELECT COUNT(*) AS n FROM ventajas'),
                dbp.get("SELECT COUNT(*) AS n FROM users WHERE role != 'alumno'"),
                dbp.get('SELECT COUNT(*) AS n FROM tipos_solicitud'),
                dbp.get('SELECT COUNT(*) AS n FROM faqs')
            ]);
            if (v.n > 0 && u.n > 0 && t.n > 0 && f.n > 0) return;
        } catch (e) { /* las tablas todavía no existen */ }
        await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('La base de datos de prueba no se inicializó a tiempo');
}

async function crearAlumno({ legajo, dni, nombre, apellido, email }) {
    const { lastID: alumnoId } = await dbp.run(
        'INSERT INTO alumnos (legajo, dni, nombre, apellido, email) VALUES (?, ?, ?, ?, ?)',
        [legajo, dni, nombre, apellido, email]);
    await dbp.run(`INSERT INTO users (username, password, name, role, email, dni, legajo, alumno_id, activo)
        VALUES (?, ?, ?, 'alumno', ?, ?, ?, ?, 1)`,
        [email, await bcrypt.hash(CLAVE, 4), `${nombre} ${apellido}`, email, dni, legajo, alumnoId]);
    return alumnoId;
}

test('Circuito completo: público, alumno y personal', async (t) => {
    await esperarBase();

    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    // --- usuarios de prueba ---
    const hash = await bcrypt.hash(CLAVE, 4);
    await dbp.run(`INSERT INTO users (username, password, name, role, area, activo) VALUES ('op_test', ?, 'Operadora Test', 'operador', 'Mesa de Entrada', 1)`, [hash]);
    await dbp.run(`INSERT INTO users (username, password, name, role, area, activo) VALUES ('int_test', ?, 'Interno Test', 'interno', 'Secretaría Académica', 1)`, [hash]);
    const alumnoA = await crearAlumno({ legajo: 'T-001', dni: '40000001', nombre: 'Ana', apellido: 'Prueba', email: 'ana@test.pusap' });
    await crearAlumno({ legajo: 'T-002', dni: '40000002', nombre: 'Beto', apellido: 'Ajeno', email: 'beto@test.pusap' });

    // Cada "navegador" guarda su cookie de sesión
    const login = async (usuario) => {
        const res = await fetch(`${base}/ingresar`, { redirect: 'manual', ...formulario({ username: usuario, password: CLAVE }) });
        assert.strictEqual(res.status, 302, `login de ${usuario}`);
        const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
        const cliente = (ruta, opts = {}) => fetch(base + ruta, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie } });
        cliente.post = (ruta, datos) => cliente(ruta, formulario(datos));
        cliente.destino = res.headers.get('location');
        return cliente;
    };

    const ana = await login('ana@test.pusap');
    const beto = await login('beto@test.pusap');
    const op = await login('op_test');
    const interno = await login('int_test');
    const anonimo = (ruta, opts = {}) => fetch(base + ruta, { redirect: 'manual', ...opts });

    await t.test('Cada rol aterriza en su propia cara tras ingresar', () => {
        assert.strictEqual(ana.destino, '/alumno');
        assert.strictEqual(op.destino, '/backoffice');
        assert.strictEqual(interno.destino, '/backoffice');
    });

    await t.test('Las caras están separadas: el alumno no entra al backoffice ni el personal al portal del alumno', async () => {
        assert.strictEqual((await ana('/backoffice')).status, 403);
        assert.strictEqual((await ana('/backoffice/consultas')).status, 403);
        assert.strictEqual((await op('/alumno')).status, 403);
        assert.strictEqual((await op('/alumno/consultas')).status, 403);
    });

    await t.test('Inicio del personal y del alumno cargan', async () => {
        const inicioPersonal = await op('/backoffice');
        assert.strictEqual(inicioPersonal.status, 200);
        assert.match(await inicioPersonal.text(), /Consultas sin responder/);
        const inicioAlumno = await ana('/alumno');
        assert.strictEqual(inicioAlumno.status, 200);
        assert.match(await inicioAlumno.text(), /Hola, Ana/);
    });

    // ------------------------------------------------------------------
    await t.test('Consultas: el alumno consulta, el personal responde y sólo el dueño la ve', async () => {
        const vacia = await ana.post('/alumno/consultas', { asunto: '  ', mensaje: 'x', categoria: 'Académica' });
        assert.strictEqual(vacia.status, 400, 'asunto vacío se rechaza');

        const creada = await ana.post('/alumno/consultas', { asunto: 'Fecha del final de Contabilidad', mensaje: '¿Cuándo es?', categoria: 'Académica' });
        assert.strictEqual(creada.status, 302);
        const rutaConsulta = creada.headers.get('location');
        const id = rutaConsulta.split('/').pop();

        assert.match(await (await ana(rutaConsulta)).text(), /Fecha del final de Contabilidad/);
        assert.strictEqual((await beto(rutaConsulta)).status, 404, 'otro alumno no puede abrirla');
        assert.strictEqual((await beto.post(`/alumno/consultas/${id}/responder`, { mensaje: 'intruso' })).status, 404);

        // Llega a la bandeja del personal
        assert.match(await (await op('/backoffice/consultas?estado=abierta')).text(), /Fecha del final de Contabilidad/);
        assert.match(await (await interno(`/backoffice/consultas/${id}`)).text(), /¿Cuándo es\?/, 'también la ve el personal no operador');

        // Respuesta del personal
        const resp = await op.post(`/backoffice/consultas/${id}/responder`, { mensaje: 'El final es el 12/12.' });
        assert.strictEqual(resp.status, 302);
        const c1 = await dbp.get('SELECT estado, asignado_a FROM consultas WHERE id = ?', [id]);
        assert.strictEqual(c1.estado, 'respondida');
        assert.ok(c1.asignado_a, 'queda asignada a quien respondió');
        const notif = await dbp.get("SELECT * FROM notificaciones WHERE alumno_id = ? AND mensaje LIKE '%Respondieron tu consulta%'", [alumnoA]);
        assert.ok(notif, 'el alumno recibe una notificación');
        assert.match(await (await ana(rutaConsulta)).text(), /El final es el 12\/12\./);
        assert.match(await (await ana('/alumno')).text(), /Respondieron 1 consulta/);

        // El alumno repregunta: vuelve a "abierta"
        await ana.post(`/alumno/consultas/${id}/responder`, { mensaje: 'Gracias, ¿y el aula?' });
        assert.strictEqual((await dbp.get('SELECT estado FROM consultas WHERE id = ?', [id])).estado, 'abierta');

        // Se cierra y ya no admite mensajes del alumno
        await ana.post(`/alumno/consultas/${id}/cerrar`, {});
        assert.strictEqual((await dbp.get('SELECT estado FROM consultas WHERE id = ?', [id])).estado, 'cerrada');
        await ana.post(`/alumno/consultas/${id}/responder`, { mensaje: 'mensaje tardío' });
        const { n } = await dbp.get('SELECT COUNT(*) AS n FROM consulta_mensajes WHERE consulta_id = ?', [id]);
        assert.strictEqual(n, 3, 'una consulta cerrada no acepta más mensajes del alumno');
    });

    // ------------------------------------------------------------------
    await t.test('Trámite: se pide online y se finaliza presencialmente', async () => {
        const tipo = await dbp.get('SELECT id FROM tipos_solicitud WHERE activo = 1 ORDER BY id LIMIT 1');

        const invalida = await ana.post('/alumno/solicitudes', { tipo_solicitud_id: '99999', accion: 'enviar' });
        assert.strictEqual(invalida.status, 200, 'un tipo inexistente vuelve al formulario con error');

        const creada = await ana.post('/alumno/solicitudes', { tipo_solicitud_id: String(tipo.id), accion: 'enviar' });
        assert.strictEqual(creada.status, 302);
        const rutaSol = creada.headers.get('location');
        const id = rutaSol.split('/').pop();
        const estado = async () => (await dbp.get('SELECT estado FROM solicitudes_doc WHERE id = ?', [id])).estado;

        assert.strictEqual(await estado(), 'enviada');
        assert.strictEqual((await beto(rutaSol)).status, 404, 'otro alumno no puede ver el trámite');
        assert.match(await (await op(`/backoffice/solicitudes/${id}`)).text(), /Acciones del Personal/);

        // La máquina de estados se aplica en el servidor, no sólo en la pantalla
        await op.post(`/backoffice/solicitudes/${id}/accion`, { accion: 'aprobada' });
        assert.strictEqual(await estado(), 'enviada', 'no se puede aprobar sin pasar por revisión');
        await op.post(`/backoffice/solicitudes/${id}/accion`, { accion: 'finalizada' });
        assert.strictEqual(await estado(), 'enviada', 'no se puede finalizar algo no aprobado');

        await op.post(`/backoffice/solicitudes/${id}/accion`, { accion: 'en_revision' });
        assert.strictEqual(await estado(), 'en_revision');
        await op.post(`/backoffice/solicitudes/${id}/accion`, { accion: 'observada', motivo: '' });
        assert.strictEqual(await estado(), 'en_revision', 'observar exige un motivo');

        await op.post(`/backoffice/solicitudes/${id}/accion`, {
            accion: 'aprobada',
            indicaciones: 'Traé tu DNI original a Mesa de Entrada.',
            fecha_presencial: 'lunes 10/11'
        });
        assert.strictEqual(await estado(), 'aprobada');

        // El alumno ve cómo cerrar el trámite en la institución
        const detalle = await (await ana(rutaSol)).text();
        assert.match(detalle, /falta finalizarlo en la institución/);
        assert.match(detalle, /Traé tu DNI original a Mesa de Entrada\./);
        assert.match(detalle, /lunes 10\/11/);
        assert.match(await (await ana('/alumno')).text(), /para finalizar en la institución/);

        // El personal registra que vino
        await op.post(`/backoffice/solicitudes/${id}/accion`, { accion: 'finalizada' });
        assert.strictEqual(await estado(), 'finalizada');
        const fila = await dbp.get('SELECT finalizada_at FROM solicitudes_doc WHERE id = ?', [id]);
        assert.ok(fila.finalizada_at, 'queda registrada la fecha de cierre');
        assert.match(await (await ana(rutaSol)).text(), /Trámite finalizado/);

        // Y ya no se puede tocar
        await op.post(`/backoffice/solicitudes/${id}/accion`, { accion: 'en_revision' });
        assert.strictEqual(await estado(), 'finalizada');
    });

    await t.test('Un borrador se puede enviar después, pero sólo su dueño', async () => {
        const tipo = await dbp.get('SELECT id FROM tipos_solicitud WHERE activo = 1 ORDER BY id LIMIT 1');
        const creada = await ana.post('/alumno/solicitudes', { tipo_solicitud_id: String(tipo.id), accion: 'guardar' });
        const id = creada.headers.get('location').split('/').pop();
        assert.strictEqual((await dbp.get('SELECT estado FROM solicitudes_doc WHERE id = ?', [id])).estado, 'borrador');

        assert.strictEqual((await beto.post(`/alumno/solicitudes/${id}/enviar`, {})).status, 404);
        await ana.post(`/alumno/solicitudes/${id}/enviar`, {});
        assert.strictEqual((await dbp.get('SELECT estado FROM solicitudes_doc WHERE id = ?', [id])).estado, 'enviada');
    });

    await t.test('Archivos privados: el alumno sólo accede a los suyos', async () => {
        const sol = await dbp.get('SELECT id FROM solicitudes_doc WHERE alumno_id = ? LIMIT 1', [alumnoA]);
        await dbp.run('INSERT INTO solicitud_adjuntos (solicitud_id, filename, original_name) VALUES (?, ?, ?)', [sol.id, 'adjunto-de-ana.pdf', 'dni.pdf']);

        // 403 = no autorizado; 404 = autorizado pero el archivo no existe en disco de pruebas
        assert.strictEqual((await beto('/descargas/privado/adjunto-de-ana.pdf')).status, 403);
        assert.strictEqual((await ana('/descargas/privado/adjunto-de-ana.pdf')).status, 404);
        assert.strictEqual((await op('/descargas/privado/adjunto-de-ana.pdf')).status, 404);
    });

    // ------------------------------------------------------------------
    await t.test('El personal controla lo que ven el público y los alumnos', async () => {
        // Ventajas -> home público
        await op.post('/backoffice/ventajas/nuevo', { titulo: 'Ventaja Única Z9', descripcion: 'Descripción de prueba', icono: 'fa-medal', orden: '99' });
        assert.match(await (await anonimo('/')).text(), /Ventaja Única Z9/);
        const v = await dbp.get("SELECT id FROM ventajas WHERE titulo = 'Ventaja Única Z9'");
        await op.post(`/backoffice/ventajas/editar/${v.id}`, { titulo: 'Ventaja Única Z9', descripcion: '', icono: 'fa-medal', orden: '99' }); // sin "activo" = oculta
        assert.doesNotMatch(await (await anonimo('/')).text(), /Ventaja Única Z9/, 'oculta deja de verse');
        // el ícono sólo admite el formato de FontAwesome (va dentro de un atributo class)
        await op.post('/backoffice/ventajas/nuevo', { titulo: 'Ventaja Ícono Malo', icono: '"><script>alert(1)</script>', orden: '1' });
        const malo = await dbp.get("SELECT icono FROM ventajas WHERE titulo = 'Ventaja Ícono Malo'");
        assert.strictEqual(malo.icono, 'fa-star');

        // Novedades según audiencia
        await op.post('/backoffice/novedades/nuevo', { titulo: 'Aviso Sólo Alumnos Q1', cuerpo: 'cuerpo', audiencia: 'alumnos' });
        await op.post('/backoffice/novedades/nuevo', { titulo: 'Aviso Sólo Público Q2', cuerpo: 'cuerpo', audiencia: 'publico' });
        await op.post('/backoffice/novedades/nuevo', { titulo: 'Aviso Para Todos Q3', cuerpo: 'cuerpo', audiencia: 'ambos' });
        const home = await (await anonimo('/')).text();
        const portal = await (await ana('/alumno')).text();
        assert.doesNotMatch(home, /Aviso Sólo Alumnos Q1/);
        assert.match(home, /Aviso Sólo Público Q2/);
        assert.match(home, /Aviso Para Todos Q3/);
        assert.match(portal, /Aviso Sólo Alumnos Q1/);
        assert.doesNotMatch(portal, /Aviso Sólo Público Q2/);
        assert.match(portal, /Aviso Para Todos Q3/);

        // FAQs según audiencia
        await op.post('/backoffice/faqs/nuevo', { categoria: 'Test', pregunta: 'Pregunta Alumnos F1', respuesta: 'r', audiencia: 'alumnos' });
        assert.doesNotMatch(await (await anonimo('/')).text(), /Pregunta Alumnos F1/);
        assert.match(await (await ana('/alumno')).text(), /Pregunta Alumnos F1/);

        // Carreras: ocultar / publicar / no borrar si está en uso
        const nueva = await op.post('/backoffice/carreras/nueva', { nombre: 'Tecnicatura de Prueba K7', tipo: 'carrera', modalidad: 'virtual', activo: '1', duracion: '2 años' });
        assert.strictEqual(nueva.status, 302);
        assert.match(await (await anonimo('/carreras')).text(), /Tecnicatura de Prueba K7/);
        const carrera = await dbp.get("SELECT id FROM carreras WHERE nombre = 'Tecnicatura de Prueba K7'");
        await op.post(`/backoffice/carreras/${carrera.id}/estado`, {});
        assert.doesNotMatch(await (await anonimo('/carreras')).text(), /Tecnicatura de Prueba K7/);
        await op.post(`/backoffice/carreras/${carrera.id}/estado`, {});
        assert.match(await (await anonimo('/carreras')).text(), /Tecnicatura de Prueba K7/);
        assert.strictEqual((await op.post('/backoffice/carreras/nueva', { nombre: '', tipo: 'carrera' })).status, 400, 'el nombre es obligatorio');

        await dbp.run("INSERT INTO alumno_carreras (alumno_id, carrera_id, estado) VALUES (?, ?, 'activo')", [alumnoA, carrera.id]);
        await op.post(`/backoffice/carreras/${carrera.id}/eliminar`, {});
        assert.ok(await dbp.get('SELECT id FROM carreras WHERE id = ?', [carrera.id]), 'no se borra una carrera con alumnos');

        // Datos institucionales -> contacto y portal del alumno (el caché se invalida al guardar)
        await op.post('/backoffice/contenido', { direccion: 'Calle Falsa 123, Piso 9', telefono: '555-0000', campo_ajeno: 'ignorado' });
        assert.match(await (await anonimo('/contacto')).text(), /Calle Falsa 123, Piso 9/);
        assert.match(await (await anonimo('/')).text(), /555-0000/);
        assert.strictEqual(await dbp.get("SELECT 1 AS x FROM contenido_publico WHERE clave = 'campo_ajeno'"), null, 'sólo se guardan claves conocidas');
    });

    await t.test('El personal "interno" atiende consultas y trámites pero no administra el sitio', async () => {
        assert.strictEqual((await interno('/backoffice/consultas')).status, 200);
        assert.strictEqual((await interno('/backoffice/solicitudes')).status, 200);
        for (const ruta of ['/backoffice/carreras', '/backoffice/ventajas', '/backoffice/contenido', '/backoffice/novedades', '/backoffice/faqs']) {
            assert.strictEqual((await interno(ruta)).status, 403, `GET ${ruta}`);
        }
        const intento = await interno.post('/backoffice/ventajas/nuevo', { titulo: 'No debería crearse' });
        assert.strictEqual(intento.status, 403);
        assert.strictEqual(await dbp.get("SELECT 1 AS x FROM ventajas WHERE titulo = 'No debería crearse'"), null);
    });

    await t.test('Todas las pantallas renderizan sin errores, con datos cargados', async () => {
        const carrera = await dbp.get('SELECT id FROM carreras LIMIT 1');
        const porRol = {
            anónimo: [anonimo, ['/', '/carreras', '/contacto', '/ingresar']],
            alumno: [ana, ['/alumno', '/alumno/cursos', '/alumno/cuotas', '/alumno/solicitudes', '/alumno/solicitudes/nueva',
                '/alumno/tramites', '/alumno/consultas', '/alumno/consultas/nueva', '/alumno/perfil', '/alumno/notificaciones']],
            operador: [op, ['/backoffice', '/backoffice/solicitudes', '/backoffice/solicitudes?estado=finalizada', '/backoffice/consultas',
                '/backoffice/consultas?estado=cerrada&search=Fecha', '/backoffice/carreras', '/backoffice/carreras/nueva',
                `/backoffice/carreras/${carrera.id}/editar`, '/backoffice/ventajas', '/backoffice/contenido', '/backoffice/novedades',
                '/backoffice/faqs', '/backoffice/alumnos', '/backoffice/tipos-solicitud', '/panel']]
        };
        // Un </div> de más o de menos rompe todo el diseño (el dashboard llegó a mostrarse en una sola fila):
        // la página completa, con header y footer, tiene que abrir y cerrar la misma cantidad de <div>.
        const divsBalanceados = (html) => {
            const limpio = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
            return { abre: (limpio.match(/<div[\s>]/g) || []).length, cierra: (limpio.match(/<\/div>/g) || []).length };
        };
        for (const [rol, [cliente, rutas]] of Object.entries(porRol)) {
            for (const ruta of rutas) {
                const res = await cliente(ruta);
                assert.strictEqual(res.status, 200, `${rol}: GET ${ruta} respondió ${res.status}`);
                const { abre, cierra } = divsBalanceados(await res.text());
                assert.strictEqual(abre, cierra, `${rol}: ${ruta} abre ${abre} <div> y cierra ${cierra}`);
            }
        }
    });

    await t.test('Dashboard de expedientes: el gráfico por área usa las áreas reales', async () => {
        await dbp.run(`INSERT INTO tickets (tracking_code, first_name, last_name, dni, category, status, area) VALUES ('PUSAP-AREA01', 'A', 'B', '1', 'X', 'Iniciado', 'Mesa de Entrada')`);
        const html = await (await op('/panel')).text();
        assert.match(html, /areaData = \{[^}]*"Mesa de Entrada":\d+/, 'las áreas llegan a la vista');
        assert.ok(!html.includes('"undefined"'), 'ningún expediente queda sin área en el gráfico');
    });

    await t.test('Panel del personal: Salir siempre a la vista y Volver en las páginas internas', async () => {
        const interna = await (await op('/backoffice/consultas')).text();
        assert.ok(interna.includes('href="/logout" title="Cerrar sesión"'), 'la barra superior tiene Salir');
        assert.ok(interna.includes("volverAtras('/backoffice')"), 'las páginas internas tienen Volver');
        const inicio = await (await op('/backoffice')).text();
        assert.ok(inicio.includes('href="/logout" title="Cerrar sesión"'), 'el inicio también tiene Salir');
        assert.ok(!inicio.includes("onclick=\"volverAtras('/backoffice')\""), 'el inicio no tiene Volver (no hay a dónde)');
    });

    await t.test('Portal del alumno y sitio público: botón Volver en las páginas internas', async () => {
        assert.ok((await (await ana('/alumno/consultas')).text()).includes("volverAtras('/alumno')"));
        assert.ok(!(await (await ana('/alumno')).text()).includes("onclick=\"volverAtras('/alumno')\""), 'la portada del alumno no lo muestra');
        assert.ok((await (await anonimo('/carreras')).text()).includes("volverAtras('/')"));
        assert.ok(!(await (await anonimo('/')).text()).includes("onclick=\"volverAtras('/')\""), 'la portada pública no lo muestra');
    });

    await t.test('Modo oscuro: la configuración de Tailwind va después de cargarlo y sólo el panel usa la clase', async () => {
        const panel = await (await op('/backoffice')).text();
        const cdn = panel.indexOf('cdn.tailwindcss.com');
        const config = panel.indexOf("tailwind.config = { darkMode: 'class' }");
        assert.ok(cdn > -1 && config > cdn, 'tailwind.config debe ir después del script de Tailwind (si no, el botón no hace nada)');
        assert.ok(panel.includes("classList.add('dark')"), 'el panel aplica el modo oscuro guardado');
        assert.ok(panel.includes('toggleDarkMode()'), 'el panel tiene el botón de modo oscuro');
        for (const html of [await (await anonimo('/')).text(), await (await ana('/alumno')).text()]) {
            assert.ok(!html.includes("classList.add('dark')"), 'el sitio público y el portal del alumno no usan modo oscuro');
        }
    });

    // ------------------------------------------------------------------
    // Todo lo que se carga desde el panel se puede editar y borrar (con las protecciones que corresponden)
    const enviar = (cliente, ruta, pares) => cliente(ruta, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(pares)
    });

    await t.test('Tipos de trámite: se editan, se desactivan y sólo se borran si nadie los usó', async () => {
        await op.post('/backoffice/tipos-solicitud/nuevo', { nombre: 'Tipo Temporal Z1', modalidad: 'emision', descripcion: 'desc', orden: '5' });
        const tipo = await dbp.get("SELECT * FROM tipos_solicitud WHERE nombre = 'Tipo Temporal Z1'");
        assert.ok(tipo, 'se crea');
        assert.strictEqual((await op.post('/backoffice/tipos-solicitud/nuevo', { nombre: '   ', modalidad: 'emision' })).headers.get('location'), '/backoffice/tipos-solicitud?error=nombre', 'el nombre es obligatorio');

        await op.post(`/backoffice/tipos-solicitud/editar/${tipo.id}`, { nombre: 'Tipo Temporal Z1 (editado)', modalidad: 'presentacion', descripcion: 'otra', orden: '7' }); // sin "activo" = inactivo
        const editado = await dbp.get('SELECT * FROM tipos_solicitud WHERE id = ?', [tipo.id]);
        assert.deepStrictEqual([editado.nombre, editado.modalidad, editado.orden, editado.activo], ['Tipo Temporal Z1 (editado)', 'presentacion', 7, 0]);
        assert.match(await (await op('/backoffice/tipos-solicitud')).text(), /Tipo Temporal Z1 \(editado\)/);

        // En uso: no se borra
        const enUso = await dbp.get('SELECT tipo_solicitud_id AS id FROM solicitudes_doc LIMIT 1');
        const r = await op.post(`/backoffice/tipos-solicitud/eliminar/${enUso.id}`, {});
        assert.strictEqual(r.headers.get('location'), '/backoffice/tipos-solicitud?error=en_uso');
        assert.ok(await dbp.get('SELECT id FROM tipos_solicitud WHERE id = ?', [enUso.id]), 'el tipo usado sigue existiendo');

        await op.post(`/backoffice/tipos-solicitud/eliminar/${tipo.id}`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM tipos_solicitud WHERE id = ?', [tipo.id]), null, 'el no usado se borra');
        assert.strictEqual((await interno.post('/backoffice/tipos-solicitud/eliminar/1', {})).status, 403, 'el personal interno no administra el catálogo');
    });

    await t.test('Alumnos: se editan (con su usuario), se bloquean y sólo se dan de baja sin historial', async () => {
        await op.post('/backoffice/alumnos/nuevo', { legajo: 'T-900', dni: '49000900', nombre: 'Carla', apellido: 'Editable', email: 'carla@test.pusap', telefono: '1', carrera_id: '' });
        const alumno = await dbp.get("SELECT * FROM alumnos WHERE legajo = 'T-900'");
        assert.ok(alumno, 'se registra');

        const carrera = await dbp.get('SELECT id FROM carreras LIMIT 1');
        await enviar(op, `/backoffice/alumnos/${alumno.id}/editar`, [
            ['legajo', 'T-900'], ['dni', '49000900'], ['nombre', 'Carolina'], ['apellido', 'Editada'], ['email', 'carolina@test.pusap'],
            ['telefono', '555'], ['direccion', 'Calle 1'], ['carreras', String(carrera.id)]
        ]);
        const a2 = await dbp.get('SELECT * FROM alumnos WHERE id = ?', [alumno.id]);
        assert.deepStrictEqual([a2.nombre, a2.apellido, a2.email, a2.direccion], ['Carolina', 'Editada', 'carolina@test.pusap', 'Calle 1']);
        const u2 = await dbp.get('SELECT * FROM users WHERE alumno_id = ?', [alumno.id]);
        assert.deepStrictEqual([u2.name, u2.email, u2.username], ['Carolina Editada', 'carolina@test.pusap', 'carolina@test.pusap'], 'el usuario del portal acompaña los cambios');
        assert.strictEqual((await dbp.get("SELECT estado FROM alumno_carreras WHERE alumno_id = ? AND carrera_id = ?", [alumno.id, carrera.id])).estado, 'activo');

        // Desmarcar la carrera la pasa a inactivo (el historial se conserva)
        await enviar(op, `/backoffice/alumnos/${alumno.id}/editar`, [['legajo', 'T-900'], ['dni', '49000900'], ['nombre', 'Carolina'], ['apellido', 'Editada'], ['email', 'carolina@test.pusap']]);
        assert.strictEqual((await dbp.get("SELECT estado FROM alumno_carreras WHERE alumno_id = ? AND carrera_id = ?", [alumno.id, carrera.id])).estado, 'inactivo');

        // Datos repetidos se rechazan sin dejar la edición a medias
        const choque = await enviar(op, `/backoffice/alumnos/${alumno.id}/editar`, [['legajo', 'T-001'], ['dni', '49000900'], ['nombre', 'X'], ['apellido', 'Y']]);
        assert.match(decodeURIComponent(choque.headers.get('location')), /Ya existe otro alumno/);
        assert.strictEqual((await dbp.get('SELECT nombre FROM alumnos WHERE id = ?', [alumno.id])).nombre, 'Carolina', 'no se aplicó nada');

        // Bloquear / habilitar: recién se puede cuando la cuenta fue activada
        const sinActivar = await op.post(`/backoffice/alumnos/${alumno.id}/acceso`, {});
        assert.match(decodeURIComponent(sinActivar.headers.get('location')), /todavía no fue activada/);
        await dbp.run('UPDATE users SET password = ?, activation_token = NULL, activo = 1 WHERE alumno_id = ?', [await bcrypt.hash(CLAVE, 4), alumno.id]);
        await op.post(`/backoffice/alumnos/${alumno.id}/acceso`, {});
        assert.strictEqual((await dbp.get('SELECT activo FROM users WHERE alumno_id = ?', [alumno.id])).activo, 0, 'bloqueado');
        const intento = await fetch(`${base}/ingresar`, { redirect: 'manual', ...formulario({ username: 'carolina@test.pusap', password: CLAVE }) });
        assert.ok(!intento.headers.get('location'), 'un alumno bloqueado no puede ingresar (se vuelve a mostrar el login)');
        await op.post(`/backoffice/alumnos/${alumno.id}/acceso`, {});
        assert.strictEqual((await dbp.get('SELECT activo FROM users WHERE alumno_id = ?', [alumno.id])).activo, 1, 'habilitado');

        // Con historial no se da de baja; sin historial sí
        const conHistorial = await op.post(`/backoffice/alumnos/${alumnoA}/eliminar`, {});
        assert.match(decodeURIComponent(conHistorial.headers.get('location')), /No se puede dar de baja/);
        assert.ok(await dbp.get('SELECT id FROM alumnos WHERE id = ?', [alumnoA]));
        await op.post(`/backoffice/alumnos/${alumno.id}/eliminar`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM alumnos WHERE id = ?', [alumno.id]), null, 'se da de baja');
        assert.strictEqual(await dbp.get('SELECT id FROM users WHERE alumno_id = ?', [alumno.id]), null, 'también su usuario');
        assert.strictEqual(await dbp.get('SELECT id FROM alumno_carreras WHERE alumno_id = ?', [alumno.id]), null, 'y sus inscripciones');
    });

    await t.test('Usuarios del personal: alta validada, edición, y protecciones', async () => {
        const mal = await op.post('/panel/usuarios/nuevo', { name: 'Corto', username: 'corto_t', password: '123', area: 'Mesa de Entrada', role: 'interno' });
        assert.match(decodeURIComponent(mal.headers.get('location')), /al menos 6 caracteres/);
        await op.post('/panel/usuarios/nuevo', { name: 'Persona Temporal', username: 'temp_t', password: 'secreta123', area: 'Mesa de Entrada', role: 'interno' });
        const nuevo = await dbp.get("SELECT * FROM users WHERE username = 'temp_t'");
        assert.ok(nuevo);
        const dup = await op.post('/panel/usuarios/nuevo', { name: 'Otra', username: 'temp_t', password: 'secreta123', area: 'Mesa de Entrada', role: 'interno' });
        assert.match(decodeURIComponent(dup.headers.get('location')), /ya existe/);

        // Editar: datos, rol y contraseña nueva (la vieja deja de servir)
        await op.post(`/panel/usuarios/editar/${nuevo.id}`, { name: 'Persona Editada', username: 'temp_t2', area: 'Secretaría Académica', role: 'operador', password: 'nuevaClave456' });
        const u = await dbp.get('SELECT * FROM users WHERE id = ?', [nuevo.id]);
        assert.deepStrictEqual([u.name, u.username, u.area, u.role], ['Persona Editada', 'temp_t2', 'Secretaría Académica', 'operador']);
        const ok = await fetch(`${base}/ingresar`, { redirect: 'manual', ...formulario({ username: 'temp_t2', password: 'nuevaClave456' }) });
        assert.strictEqual(ok.headers.get('location'), '/backoffice', 'entra con la contraseña nueva');
        const viejo = await fetch(`${base}/ingresar`, { redirect: 'manual', ...formulario({ username: 'temp_t2', password: 'secreta123' }) });
        assert.ok(!viejo.headers.get('location'), 'la contraseña anterior ya no sirve');
        // Sin tocar la contraseña, se conserva
        await op.post(`/panel/usuarios/editar/${nuevo.id}`, { name: 'Persona Editada', username: 'temp_t2', area: 'Secretaría Académica', role: 'interno', password: '' });
        const ok2 = await fetch(`${base}/ingresar`, { redirect: 'manual', ...formulario({ username: 'temp_t2', password: 'nuevaClave456' }) });
        assert.strictEqual(ok2.headers.get('location'), '/backoffice');

        // Protecciones
        const yo = await dbp.get("SELECT id FROM users WHERE username = 'op_test'");
        assert.match(decodeURIComponent((await op.post(`/panel/usuarios/eliminar/${yo.id}`, {})).headers.get('location')), /tu propio usuario/);
        assert.match(decodeURIComponent((await op.post(`/panel/usuarios/editar/${yo.id}`, { name: 'Operadora Test', username: 'op_test', area: 'Mesa de Entrada', role: 'interno' })).headers.get('location')), /vos mismo el rol/);
        assert.strictEqual((await dbp.get('SELECT role FROM users WHERE id = ?', [yo.id])).role, 'operador');
        // Las cuentas de alumnos no se listan ni se pueden borrar desde acá
        const alumnoUser = await dbp.get("SELECT id FROM users WHERE username = 'ana@test.pusap'");
        assert.ok(!(await (await op('/panel/usuarios')).text()).includes('ana@test.pusap'), 'la lista es sólo de personal');
        await op.post(`/panel/usuarios/eliminar/${alumnoUser.id}`, {});
        assert.ok(await dbp.get('SELECT id FROM users WHERE id = ?', [alumnoUser.id]), 'no se puede borrar un alumno desde acá');

        await op.post(`/panel/usuarios/eliminar/${nuevo.id}`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM users WHERE id = ?', [nuevo.id]), null);
        assert.strictEqual((await interno('/panel/usuarios')).status, 403);
    });

    await t.test('Configuración: áreas (renombrar con cascada y borrar protegido), respuestas rápidas y etiquetas', async () => {
        // Áreas
        await op.post('/panel/config/areas', { new_area: 'Area Temporal Z' });
        const area = await dbp.get("SELECT * FROM areas WHERE name = 'Area Temporal Z'");
        assert.ok(area);
        assert.match(decodeURIComponent((await op.post('/panel/config/areas', { new_area: 'Area Temporal Z' })).headers.get('location')), /Ya existe/);
        await dbp.run(`INSERT INTO tickets (tracking_code, first_name, last_name, dni, category, status, area) VALUES ('PUSAP-AREAZ', 'A', 'B', '2', 'X', 'Iniciado', 'Area Temporal Z')`);

        await op.post(`/panel/config/areas/editar/${area.id}`, { name: 'Area Renombrada Z' });
        assert.strictEqual((await dbp.get("SELECT area FROM tickets WHERE tracking_code = 'PUSAP-AREAZ'")).area, 'Area Renombrada Z', 'los expedientes siguen a su área');
        assert.match(await (await op('/panel')).text(), /<option value="Area Renombrada Z"/, 'el filtro del dashboard usa las áreas reales');

        assert.match(decodeURIComponent((await op.post(`/panel/config/areas/eliminar/${area.id}`, {})).headers.get('location')), /No se puede eliminar/);
        await dbp.run("UPDATE tickets SET area = 'Mesa de Entrada' WHERE tracking_code = 'PUSAP-AREAZ'");
        await op.post(`/panel/config/areas/eliminar/${area.id}`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM areas WHERE id = ?', [area.id]), null, 'sin uso, se borra');
        const base_ = await dbp.get("SELECT id FROM areas WHERE name = 'Mesa de Entrada'");
        assert.match(decodeURIComponent((await op.post(`/panel/config/areas/editar/${base_.id}`, { name: 'Otro' })).headers.get('location')), /no se puede renombrar/);
        assert.match(decodeURIComponent((await op.post(`/panel/config/areas/eliminar/${base_.id}`, {})).headers.get('location')), /no se puede eliminar/);

        // Respuestas rápidas
        await op.post('/panel/config/quick-replies/nuevo', { title: 'Resp Z', content: 'contenido uno' });
        const qr = await dbp.get("SELECT * FROM quick_replies WHERE title = 'Resp Z'");
        await op.post(`/panel/config/quick-replies/editar/${qr.id}`, { title: 'Resp Z2', content: 'contenido dos' });
        assert.deepStrictEqual((({ title, content }) => [title, content])(await dbp.get('SELECT * FROM quick_replies WHERE id = ?', [qr.id])), ['Resp Z2', 'contenido dos']);
        await op.post(`/panel/config/quick-replies/eliminar/${qr.id}`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM quick_replies WHERE id = ?', [qr.id]), null);

        // Etiquetas (borrarlas también las quita de los expedientes)
        await op.post('/panel/config/tags/nuevo', { name: 'Etiqueta Z', color: 'red' });
        const tag = await dbp.get("SELECT * FROM tags WHERE name = 'Etiqueta Z'");
        await op.post(`/panel/config/tags/editar/${tag.id}`, { name: 'Etiqueta Z2', color: 'inventado' });
        const tag2 = await dbp.get('SELECT * FROM tags WHERE id = ?', [tag.id]);
        assert.deepStrictEqual([tag2.name, tag2.color], ['Etiqueta Z2', 'blue'], 'un color inválido vuelve al azul');
        const tk = await dbp.get("SELECT id FROM tickets WHERE tracking_code = 'PUSAP-AREAZ'");
        await dbp.run('INSERT INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?)', [tk.id, tag.id]);
        await op.post(`/panel/config/tags/eliminar/${tag.id}`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM tags WHERE id = ?', [tag.id]), null);
        assert.strictEqual(await dbp.get('SELECT 1 AS x FROM ticket_tags WHERE tag_id = ?', [tag.id]), null, 'se quitó de los expedientes');
        assert.strictEqual((await interno('/panel/config')).status, 403);
    });

    await t.test('Novedades, FAQs y ventajas: se editan y se borran desde el panel', async () => {
        await op.post('/backoffice/novedades/nuevo', { titulo: 'Novedad Editable N1', cuerpo: 'a', audiencia: 'ambos' });
        const nov = await dbp.get("SELECT * FROM novedades WHERE titulo = 'Novedad Editable N1'");
        await op.post(`/backoffice/novedades/editar/${nov.id}`, { titulo: 'Novedad Editada N1', cuerpo: 'b', audiencia: 'alumnos', activo: '1', destacada: '1' });
        const n2 = await dbp.get('SELECT * FROM novedades WHERE id = ?', [nov.id]);
        assert.deepStrictEqual([n2.titulo, n2.audiencia, n2.destacada], ['Novedad Editada N1', 'alumnos', 1]);
        await op.post(`/backoffice/novedades/eliminar/${nov.id}`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM novedades WHERE id = ?', [nov.id]), null);

        await op.post('/backoffice/faqs/nuevo', { categoria: 'T', pregunta: 'Pregunta Editable F9', respuesta: 'r', audiencia: 'ambos' });
        const faq = await dbp.get("SELECT * FROM faqs WHERE pregunta = 'Pregunta Editable F9'");
        await op.post(`/backoffice/faqs/editar/${faq.id}`, { categoria: 'T2', pregunta: 'Pregunta Editada F9', respuesta: 'r2', orden: '3', activo: '1', audiencia: 'publico' });
        assert.strictEqual((await dbp.get('SELECT pregunta FROM faqs WHERE id = ?', [faq.id])).pregunta, 'Pregunta Editada F9');
        await op.post(`/backoffice/faqs/eliminar/${faq.id}`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM faqs WHERE id = ?', [faq.id]), null);

        await op.post('/backoffice/ventajas/nuevo', { titulo: 'Ventaja Borrable V1', descripcion: 'x', icono: 'fa-star', orden: '1' });
        const v = await dbp.get("SELECT id FROM ventajas WHERE titulo = 'Ventaja Borrable V1'");
        await op.post(`/backoffice/ventajas/editar/${v.id}`, { titulo: 'Ventaja Editada V1', descripcion: 'y', icono: 'fa-medal', orden: '2', activo: '1' });
        assert.strictEqual((await dbp.get('SELECT titulo FROM ventajas WHERE id = ?', [v.id])).titulo, 'Ventaja Editada V1');
        await op.post(`/backoffice/ventajas/eliminar/${v.id}`, {});
        assert.strictEqual(await dbp.get('SELECT id FROM ventajas WHERE id = ?', [v.id]), null);
    });

    await t.test('Un visitante anónimo no puede crear nada', async () => {
        const antes = await dbp.get('SELECT COUNT(*) AS n FROM tickets');
        await anonimo('/nuevo-tramite', formulario({ first_name: 'Anon', last_name: 'Imo', dni: '1', category: 'X' }));
        const despues = await dbp.get('SELECT COUNT(*) AS n FROM tickets');
        assert.strictEqual(despues.n, antes.n);
        assert.strictEqual((await anonimo('/alumno/consultas', formulario({ asunto: 'a', mensaje: 'b' }))).status, 302);
    });
});
