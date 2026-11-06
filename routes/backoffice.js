/**
 * routes/backoffice.js
 * Backoffice del personal. Reutiliza el router de tickets existente
 * y agrega las rutas nuevas de esta fase.
 * Todas las rutas requieren rol operador o interno.
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const moment = require('moment');
const crypto = require('crypto');
const db = require('../db');
const dbp = require('../lib/dbp');
const contenido = require('../lib/contenido');
const { validarTransicion, TRANSICIONES_VALIDAS } = require('../lib/solicitud-estados');
const { requirePersonal, requireOperador } = require('../middleware/auth');

// Aplicar guard a todo el router
router.use(requirePersonal);

// Multer para documentos emitidos
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/privado/'),
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, Date.now() + '-emitido-' + safeName);
    }
});
const fileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Solo PDF, JPG y PNG.'), false);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// ----------------------------------------------------------------
// Inicio del backoffice: qué está esperando acción del personal
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        const [porEstado, consultasAbiertas, expedientes, alumnos, ultimasSolicitudes, ultimasConsultas] = await Promise.all([
            dbp.all(`SELECT estado, COUNT(*) AS n FROM solicitudes_doc GROUP BY estado`),
            dbp.get(`SELECT COUNT(*) AS n FROM consultas WHERE estado = 'abierta'`),
            dbp.get(`SELECT COUNT(*) AS n FROM tickets WHERE deleted_at IS NULL AND status NOT IN ('Aprobado', 'Rechazado')`),
            dbp.get(`SELECT COUNT(*) AS n FROM alumnos`),
            dbp.all(`SELECT sd.id, sd.estado, sd.updated_at, ts.nombre AS tipo_nombre,
                        a.nombre AS alumno_nombre, a.apellido AS alumno_apellido
                    FROM solicitudes_doc sd
                    JOIN tipos_solicitud ts ON ts.id = sd.tipo_solicitud_id
                    JOIN alumnos a ON a.id = sd.alumno_id
                    WHERE sd.estado IN ('enviada', 'en_revision')
                    ORDER BY sd.updated_at ASC LIMIT 6`),
            dbp.all(`SELECT c.id, c.asunto, c.categoria, c.updated_at,
                        a.nombre AS alumno_nombre, a.apellido AS alumno_apellido
                    FROM consultas c JOIN alumnos a ON a.id = c.alumno_id
                    WHERE c.estado = 'abierta'
                    ORDER BY c.updated_at ASC LIMIT 6`)
        ]);

        const conteo = {};
        porEstado.forEach(r => { conteo[r.estado] = r.n; });

        res.render('backoffice/index', {
            title: 'Inicio del Personal',
            user: req.session.user,
            conteo,
            consultasAbiertas: consultasAbiertas.n,
            expedientes: expedientes.n,
            totalAlumnos: alumnos.n,
            ultimasSolicitudes,
            ultimasConsultas,
            moment
        });
    } catch (err) {
        console.error('Error en inicio de backoffice:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

// ----------------------------------------------------------------
// Bandeja de solicitudes de documentación
// ----------------------------------------------------------------
router.get('/solicitudes', (req, res) => {
    const user = req.session.user;
    const { estado, tipo, search, page: pageQ } = req.query;
    const page = parseInt(pageQ) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    let where = ['1=1'];
    let params = [];

    if (estado) { where.push('sd.estado = ?'); params.push(estado); }
    if (tipo) { where.push('sd.tipo_solicitud_id = ?'); params.push(tipo); }
    if (search) {
        where.push('(a.nombre LIKE ? OR a.apellido LIKE ? OR a.dni LIKE ? OR a.legajo LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like);
    }

    const whereStr = where.join(' AND ');

    db.get(`SELECT COUNT(*) as count FROM solicitudes_doc sd
        JOIN alumnos a ON a.id = sd.alumno_id
        WHERE ${whereStr}`, params, (err, countRow) => {

        db.all(`SELECT sd.*, ts.nombre as tipo_nombre, ts.modalidad as tipo_modalidad,
                a.nombre as alumno_nombre, a.apellido as alumno_apellido, a.legajo, a.dni,
                u.name as asignado_nombre
            FROM solicitudes_doc sd
            JOIN tipos_solicitud ts ON ts.id = sd.tipo_solicitud_id
            JOIN alumnos a ON a.id = sd.alumno_id
            LEFT JOIN users u ON u.id = sd.asignado_a
            WHERE ${whereStr}
            ORDER BY sd.updated_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset], (err, solicitudes) => {

            db.all(`SELECT * FROM tipos_solicitud WHERE activo = 1 ORDER BY nombre`, [], (err, tipos) => {
                const total = countRow ? countRow.count : 0;
                const totalPages = Math.ceil(total / limit) || 1;

                res.render('backoffice/solicitudes', {
                    title: 'Bandeja de Solicitudes',
                    user,
                    solicitudes: solicitudes || [],
                    tipos: tipos || [],
                    total,
                    page,
                    totalPages,
                    query: req.query,
                    moment
                });
            });
        });
    });
});

// Detalle de solicitud
router.get('/solicitudes/:id', (req, res) => {
    const { id } = req.params;

    db.get(`SELECT sd.*, ts.nombre as tipo_nombre, ts.modalidad as tipo_modalidad, ts.descripcion as tipo_desc,
            a.nombre as alumno_nombre, a.apellido as alumno_apellido, a.legajo, a.dni, a.email as alumno_email
        FROM solicitudes_doc sd
        JOIN tipos_solicitud ts ON ts.id = sd.tipo_solicitud_id
        JOIN alumnos a ON a.id = sd.alumno_id
        WHERE sd.id = ?`, [id], (err, solicitud) => {
        if (err || !solicitud) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });

        db.all(`SELECT * FROM solicitud_historia WHERE solicitud_id = ? ORDER BY created_at ASC`, [id], (err, historia) => {
            db.all(`SELECT * FROM solicitud_adjuntos WHERE solicitud_id = ? ORDER BY created_at ASC`, [id], (err, adjuntos) => {
                db.all(`SELECT id, name FROM users WHERE role IN ('operador','interno') ORDER BY name`, [], (err, personal) => {
                    res.render('backoffice/solicitud-detalle', {
                        title: 'Detalle de Solicitud',
                        user: req.session.user,
                        solicitud,
                        historia: historia || [],
                        adjuntos: adjuntos || [],
                        personal: personal || [],
                        // Sólo se ofrecen los cambios de estado que la máquina de estados permite
                        siguientes: TRANSICIONES_VALIDAS[solicitud.estado] || [],
                        error: req.query.error || null,
                        moment
                    });
                });
            });
        });
    });
});

// Acción sobre solicitud (en_revision / observada / aprobada / rechazada / finalizada).
// La máquina de estados (lib/solicitud-estados) decide qué cambios son válidos.
router.post('/solicitudes/:id/accion', async (req, res) => {
    const { id } = req.params;
    const accion = String(req.body.accion || '');
    const motivo = String(req.body.motivo || '').trim();
    const indicaciones = String(req.body.indicaciones || '').trim();
    const fechaPresencial = String(req.body.fecha_presencial || '').trim();
    const user = req.session.user;
    const volver = (q = '') => res.redirect(`/backoffice/solicitudes/${id}${q}`);

    const accionesPermitidas = ['en_revision', 'observada', 'aprobada', 'rechazada', 'finalizada'];
    if (!accionesPermitidas.includes(accion)) return volver();

    try {
        const sol = await dbp.get(`SELECT * FROM solicitudes_doc WHERE id = ?`, [id]);
        if (!sol) return res.status(404).render('errors/404', { title: 'No encontrado', user });
        if (!validarTransicion(sol.estado, accion)) return volver('?error=transicion');
        // Observar o rechazar sin explicar no le sirve al alumno
        if ((accion === 'observada' || accion === 'rechazada') && !motivo) return volver('?error=motivo');

        const asignado = req.body.asignado_a || sol.asignado_a || (accion === 'en_revision' ? user.id : null);
        const guardaMotivo = (accion === 'observada' || accion === 'rechazada') ? motivo : null;

        await dbp.run(`UPDATE solicitudes_doc SET
                estado = ?, motivo_observacion = ?, asignado_a = ?,
                indicaciones_presencial = CASE WHEN ? = 'aprobada' THEN ? ELSE indicaciones_presencial END,
                fecha_presencial = CASE WHEN ? = 'aprobada' THEN ? ELSE fecha_presencial END,
                finalizada_at = CASE WHEN ? = 'finalizada' THEN CURRENT_TIMESTAMP ELSE finalizada_at END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
            [accion, guardaMotivo, asignado,
             accion, indicaciones || null,
             accion, fechaPresencial || null,
             accion, id]);

        const comentario = accion === 'aprobada' ? (indicaciones || null) : (motivo || null);
        await dbp.run(`INSERT INTO solicitud_historia (solicitud_id, user_id, user_name, estado_anterior, estado_nuevo, comentario)
            VALUES (?, ?, ?, ?, ?, ?)`, [id, user.id, user.name, sol.estado, accion, comentario]);

        // Notificar al alumno
        const mensajes = {
            en_revision: 'Tu solicitud está siendo revisada por el personal.',
            observada: `Tu solicitud fue observada. Motivo: ${motivo}. Por favor, corregí y reenviá.`,
            aprobada: 'Tu solicitud fue aprobada. Para finalizar el trámite tenés que acercarte a la institución' +
                (fechaPresencial ? ` (a partir del ${fechaPresencial})` : '') + '. Mirá las indicaciones en el detalle.',
            rechazada: `Tu solicitud fue rechazada. Motivo: ${motivo}.`,
            finalizada: 'Tu trámite quedó finalizado. ¡Gracias por acercarte!'
        };
        await dbp.run(`INSERT INTO notificaciones (alumno_id, tipo, mensaje, url) VALUES (?, ?, ?, ?)`,
            [sol.alumno_id, accion === 'rechazada' ? 'error' : (accion === 'finalizada' ? 'success' : 'info'),
             mensajes[accion], `/alumno/solicitudes/${id}`]);

        volver();
    } catch (err) {
        console.error('Error actualizando solicitud:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user });
    }
});

// Subir documento emitido (sólo sobre solicitudes aprobadas; reemplazar el archivo está permitido)
router.post('/solicitudes/:id/emitir', upload.single('documento'), async (req, res) => {
    const { id } = req.params;
    const user = req.session.user;
    const volver = (q = '') => res.redirect(`/backoffice/solicitudes/${id}${q}`);

    if (!req.file) return volver('?error=archivo');

    try {
        const sol = await dbp.get(`SELECT * FROM solicitudes_doc WHERE id = ?`, [id]);
        if (!sol) return res.status(404).render('errors/404', { title: 'No encontrado', user });
        // Aprobada → emitida es una transición; emitida → emitida sólo cambia el archivo
        if (sol.estado !== 'emitida' && !validarTransicion(sol.estado, 'emitida')) return volver('?error=transicion');

        await dbp.run(`UPDATE solicitudes_doc SET
                estado = 'emitida', documento_emitido_filename = ?, documento_emitido_original_name = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`, [req.file.filename, req.file.originalname, id]);
        await dbp.run(`INSERT INTO solicitud_historia (solicitud_id, user_id, user_name, estado_anterior, estado_nuevo, comentario)
            VALUES (?, ?, ?, ?, 'emitida', 'Documento emitido subido por el personal.')`, [id, user.id, user.name, sol.estado]);
        await dbp.run(`INSERT INTO notificaciones (alumno_id, tipo, mensaje, url) VALUES (?, 'success', ?, ?)`,
            [sol.alumno_id, 'El documento solicitado fue emitido y está disponible para descargar. Recordá finalizar el trámite en la institución.', `/alumno/solicitudes/${id}`]);
        volver();
    } catch (err) {
        console.error('Error emitiendo documento:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user });
    }
});

// ----------------------------------------------------------------
// ABM Alumnos
// ----------------------------------------------------------------
router.get('/alumnos', requireOperador, (req, res) => {
    const { search } = req.query;
    let where = '1=1';
    let params = [];
    if (search) {
        where = '(a.nombre LIKE ? OR a.apellido LIKE ? OR a.dni LIKE ? OR a.legajo LIKE ?)';
        const like = `%${search}%`;
        params = [like, like, like, like];
    }
    // "historial" = solicitudes + cuotas + consultas del alumno: si tiene, no se puede dar de baja (sólo bloquear el acceso)
    db.all(`SELECT a.*, u.id as user_id, u.username as user_email, u.activo as cuenta_activa, u.activation_token,
        GROUP_CONCAT(c.nombre, ' / ') as carreras,
        GROUP_CONCAT(c.id) as carreras_ids,
        (SELECT COUNT(*) FROM solicitudes_doc WHERE alumno_id = a.id)
          + (SELECT COUNT(*) FROM cuotas WHERE alumno_id = a.id)
          + (SELECT COUNT(*) FROM consultas WHERE alumno_id = a.id) as historial
        FROM alumnos a
        LEFT JOIN users u ON u.alumno_id = a.id
        LEFT JOIN alumno_carreras ac ON ac.alumno_id = a.id AND ac.estado = 'activo'
        LEFT JOIN carreras c ON c.id = ac.carrera_id
        WHERE ${where}
        GROUP BY a.id
        ORDER BY a.apellido, a.nombre`, params, (err, alumnos) => {
        // Para editar se ofrecen TODAS las carreras (también las ocultas del sitio), así una carrera oculta
        // en la que el alumno cursa no se desmarca sin querer.
        db.all(`SELECT id, nombre, activo FROM carreras ORDER BY activo DESC, nombre`, [], (errCarreras, todasCarreras) => {
            res.render('backoffice/alumnos', {
                title: 'Gestión de Alumnos',
                user: req.session.user,
                alumnos: alumnos || [],
                carreras: (todasCarreras || []).filter(c => c.activo),
                todasCarreras: todasCarreras || [],
                query: req.query,
                success: req.query.success || null,
                ok: req.query.ok || null,
                token: req.query.token || null,
                alumnoNombre: req.query.alumno || null,
                error: req.query.error || null
            });
        });
    });
});

const textoAlumno = (v, max = 200) => String(v || '').trim().slice(0, max);
const errorAlumno = (res, mensaje) => res.redirect('/backoffice/alumnos?error=' + encodeURIComponent(mensaje));

// Editar los datos de un alumno y sus carreras. También actualiza su usuario del portal para que no queden desfasados.
router.post('/alumnos/:id/editar', requireOperador, async (req, res) => {
    const id = req.params.id;
    const d = {
        legajo: textoAlumno(req.body.legajo, 50), dni: textoAlumno(req.body.dni, 20),
        nombre: textoAlumno(req.body.nombre), apellido: textoAlumno(req.body.apellido),
        email: textoAlumno(req.body.email), telefono: textoAlumno(req.body.telefono, 50), direccion: textoAlumno(req.body.direccion, 300)
    };
    if (!d.legajo || !d.dni || !d.nombre || !d.apellido) return errorAlumno(res, 'Legajo, DNI, nombre y apellido son obligatorios.');

    try {
        const alumno = await dbp.get(`SELECT id FROM alumnos WHERE id = ?`, [id]);
        if (!alumno) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });

        // Se comprueban los duplicados antes de escribir, para no dejar la edición a medias
        const usuarioNuevo = d.email || d.legajo;
        const choque = await dbp.get(`SELECT 1 AS x FROM alumnos WHERE id != ? AND (legajo = ? OR dni = ?)`, [id, d.legajo, d.dni]);
        if (choque) return errorAlumno(res, 'Ya existe otro alumno con ese legajo o DNI.');
        const choqueUsuario = await dbp.get(`SELECT 1 AS x FROM users WHERE username = ? AND (alumno_id IS NULL OR alumno_id != ?)`, [usuarioNuevo, id]);
        if (choqueUsuario) return errorAlumno(res, 'Ese email ya está en uso por otro usuario del sistema.');

        await dbp.run(`UPDATE alumnos SET legajo = ?, dni = ?, nombre = ?, apellido = ?, email = ?, telefono = ?, direccion = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [d.legajo, d.dni, d.nombre, d.apellido, d.email, d.telefono, d.direccion, id]);
        await dbp.run(`UPDATE users SET name = ?, email = ?, dni = ?, legajo = ?, username = ? WHERE alumno_id = ?`,
            [`${d.nombre} ${d.apellido}`, d.email, d.dni, d.legajo, usuarioNuevo, id]);

        // Carreras: se activan las marcadas y se pasan a "inactivo" (sin borrar el historial) las desmarcadas
        const marcadas = [].concat(req.body.carreras || []).map(Number).filter(Number.isInteger);
        const todas = await dbp.all(`SELECT id FROM carreras`);
        for (const c of todas) {
            if (marcadas.includes(c.id)) {
                await dbp.run(`INSERT INTO alumno_carreras (alumno_id, carrera_id, estado, fecha_inicio) VALUES (?, ?, 'activo', date('now'))
                    ON CONFLICT(alumno_id, carrera_id) DO UPDATE SET estado = 'activo'`, [id, c.id]);
            } else {
                await dbp.run(`UPDATE alumno_carreras SET estado = 'inactivo' WHERE alumno_id = ? AND carrera_id = ? AND estado = 'activo'`, [id, c.id]);
            }
        }
        res.redirect('/backoffice/alumnos?ok=editado');
    } catch (err) {
        console.error('Error editando alumno:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

// Bloquear / habilitar el acceso al portal (la cuenta pendiente de activación se maneja con el enlace)
router.post('/alumnos/:id/acceso', requireOperador, async (req, res) => {
    const u = await dbp.get(`SELECT id, activo, activation_token FROM users WHERE alumno_id = ?`, [req.params.id]);
    if (!u) return errorAlumno(res, 'Este alumno todavía no tiene usuario del portal. Generale un enlace de activación.');
    if (u.activation_token) return errorAlumno(res, 'La cuenta todavía no fue activada: el alumno tiene que usar su enlace de activación.');
    await dbp.run(`UPDATE users SET activo = 1 - activo WHERE id = ?`, [u.id]);
    res.redirect('/backoffice/alumnos?ok=' + (u.activo ? 'bloqueado' : 'habilitado'));
});

// Baja definitiva: sólo si no tiene solicitudes, cuotas ni consultas. Con historial se bloquea el acceso en su lugar.
router.post('/alumnos/:id/eliminar', requireOperador, async (req, res) => {
    const id = req.params.id;
    try {
        const h = await dbp.get(`SELECT (SELECT COUNT(*) FROM solicitudes_doc WHERE alumno_id = ?)
            + (SELECT COUNT(*) FROM cuotas WHERE alumno_id = ?) + (SELECT COUNT(*) FROM consultas WHERE alumno_id = ?) AS n`, [id, id, id]);
        if (h.n > 0) return errorAlumno(res, 'No se puede dar de baja: tiene solicitudes, cuotas o consultas registradas. Bloqueá su acceso en su lugar.');
        await dbp.run(`DELETE FROM notificaciones WHERE alumno_id = ?`, [id]);
        await dbp.run(`DELETE FROM alumno_cursos WHERE alumno_id = ?`, [id]);
        await dbp.run(`DELETE FROM alumno_carreras WHERE alumno_id = ?`, [id]);
        await dbp.run(`DELETE FROM users WHERE alumno_id = ?`, [id]);
        await dbp.run(`DELETE FROM alumnos WHERE id = ?`, [id]);
        res.redirect('/backoffice/alumnos?ok=eliminado');
    } catch (err) {
        console.error('Error eliminando alumno:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

// Alta de nuevo alumno con generación de token de activación
router.post('/alumnos/nuevo', requireOperador, (req, res) => {
    const { legajo, dni, nombre, apellido, email, telefono, carrera_id } = req.body;

    if (!legajo || !dni || !nombre || !apellido) {
        return res.redirect('/backoffice/alumnos?error=campos_requeridos');
    }

    db.run(`INSERT INTO alumnos (legajo, dni, nombre, apellido, email, telefono) VALUES (?, ?, ?, ?, ?, ?)`,
        [legajo.trim(), dni.trim(), nombre.trim(), apellido.trim(), (email || '').trim(), (telefono || '').trim()],
        function(err) {
            if (err) {
                console.error('Error insertando alumno:', err.message);
                return res.redirect('/backoffice/alumnos?error=' + encodeURIComponent(err.message.includes('UNIQUE') ? 'El legajo o DNI ya se encuentra registrado.' : 'Error al registrar alumno.'));
            }

            const alumnoId = this.lastID;

            // Inscribir a carrera si fue seleccionada
            if (carrera_id) {
                db.run(`INSERT OR IGNORE INTO alumno_carreras (alumno_id, carrera_id, estado, fecha_inicio) VALUES (?, ?, 'activo', date('now'))`,
                    [alumnoId, carrera_id]);
            }

            // Crear usuario de portal con token de activación
            const token = crypto.randomBytes(24).toString('hex');
            const expires = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
            const username = (email && email.trim()) ? email.trim() : legajo.trim();

            db.run(`INSERT INTO users (username, name, role, email, dni, legajo, alumno_id, activation_token, activation_expires, activo)
                VALUES (?, ?, 'alumno', ?, ?, ?, ?, ?, ?, 0)`,
                [username, `${nombre.trim()} ${apellido.trim()}`, (email || '').trim(), dni.trim(), legajo.trim(), alumnoId, token, expires],
                (errUser) => {
                    res.redirect(`/backoffice/alumnos?success=creado&token=${token}&alumno=${encodeURIComponent(nombre + ' ' + apellido)}`);
                }
            );
        }
    );
});

// Generar / regenerar enlace de activación para alumno existente
router.post('/alumnos/:id/activar', requireOperador, (req, res) => {
    const alumnoId = req.params.id;

    db.get(`SELECT * FROM alumnos WHERE id = ?`, [alumnoId], (err, alumno) => {
        if (err || !alumno) return res.redirect('/backoffice/alumnos?error=alumno_no_encontrado');

        const token = crypto.randomBytes(24).toString('hex');
        const expires = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');

        db.get(`SELECT id FROM users WHERE alumno_id = ?`, [alumnoId], (errUser, userRow) => {
            if (userRow) {
                // Actualizar token existente
                db.run(`UPDATE users SET activation_token = ?, activation_expires = ? WHERE id = ?`,
                    [token, expires, userRow.id],
                    () => {
                        res.redirect(`/backoffice/alumnos?success=token_generado&token=${token}&alumno=${encodeURIComponent(alumno.nombre + ' ' + alumno.apellido)}`);
                    }
                );
            } else {
                // Crear usuario si no existía
                const username = alumno.email || alumno.legajo;
                db.run(`INSERT INTO users (username, name, role, email, dni, legajo, alumno_id, activation_token, activation_expires, activo)
                    VALUES (?, ?, 'alumno', ?, ?, ?, ?, ?, ?, 0)`,
                    [username, `${alumno.nombre} ${alumno.apellido}`, alumno.email, alumno.dni, alumno.legajo, alumnoId, token, expires],
                    () => {
                        res.redirect(`/backoffice/alumnos?success=token_generado&token=${token}&alumno=${encodeURIComponent(alumno.nombre + ' ' + alumno.apellido)}`);
                    }
                );
            }
        });
    });
});

// ----------------------------------------------------------------
// ABM FAQs
// Cada FAQ/novedad indica a quién se muestra: home público, portal del alumno o ambos.
// ----------------------------------------------------------------
const AUDIENCIAS = ['publico', 'alumnos', 'ambos'];
const audiencia = (v) => AUDIENCIAS.includes(v) ? v : 'ambos';
router.get('/faqs', requireOperador, (req, res) => {
    db.all(`SELECT * FROM faqs ORDER BY orden, categoria`, [], (err, faqs) => {
        res.render('backoffice/faqs', { title: 'Preguntas Frecuentes', user: req.session.user, faqs: faqs || [] });
    });
});

router.post('/faqs/nuevo', requireOperador, (req, res) => {
    const { categoria, pregunta, respuesta, orden } = req.body;
    if (!pregunta || !pregunta.trim() || !respuesta || !respuesta.trim()) return res.redirect('/backoffice/faqs');
    db.run(`INSERT INTO faqs (categoria, pregunta, respuesta, orden, audiencia) VALUES (?, ?, ?, ?, ?)`,
        [(categoria || 'General').trim(), pregunta.trim(), respuesta.trim(), parseInt(orden) || 0, audiencia(req.body.audiencia)],
        () => res.redirect('/backoffice/faqs'));
});

router.post('/faqs/editar/:id', requireOperador, (req, res) => {
    const { categoria, pregunta, respuesta, orden, activo } = req.body;
    db.run(`UPDATE faqs SET categoria = ?, pregunta = ?, respuesta = ?, orden = ?, activo = ?, audiencia = ? WHERE id = ?`,
        [categoria, pregunta, respuesta, parseInt(orden) || 0, activo ? 1 : 0, audiencia(req.body.audiencia), req.params.id],
        () => res.redirect('/backoffice/faqs'));
});

router.post('/faqs/eliminar/:id', requireOperador, (req, res) => {
    db.run(`DELETE FROM faqs WHERE id = ?`, [req.params.id], () => res.redirect('/backoffice/faqs'));
});

// ----------------------------------------------------------------
// ABM Novedades
// ----------------------------------------------------------------
router.get('/novedades', requireOperador, (req, res) => {
    db.all(`SELECT * FROM novedades ORDER BY fecha_publicacion DESC`, [], (err, novedades) => {
        res.render('backoffice/novedades', { title: 'Novedades', user: req.session.user, novedades: novedades || [], moment });
    });
});

router.post('/novedades/nuevo', requireOperador, (req, res) => {
    const { titulo, cuerpo, destacada } = req.body;
    if (!titulo || !titulo.trim()) return res.redirect('/backoffice/novedades');
    db.run(`INSERT INTO novedades (titulo, cuerpo, destacada, audiencia) VALUES (?, ?, ?, ?)`,
        [titulo.trim(), (cuerpo || '').trim(), destacada ? 1 : 0, audiencia(req.body.audiencia)],
        () => res.redirect('/backoffice/novedades'));
});

router.post('/novedades/editar/:id', requireOperador, (req, res) => {
    const { titulo, cuerpo, destacada, activo } = req.body;
    db.run(`UPDATE novedades SET titulo = ?, cuerpo = ?, destacada = ?, activo = ?, audiencia = ? WHERE id = ?`,
        [titulo, cuerpo, destacada ? 1 : 0, activo ? 1 : 0, audiencia(req.body.audiencia), req.params.id],
        () => res.redirect('/backoffice/novedades'));
});

router.post('/novedades/eliminar/:id', requireOperador, (req, res) => {
    db.run(`DELETE FROM novedades WHERE id = ?`, [req.params.id], () => res.redirect('/backoffice/novedades'));
});

// ----------------------------------------------------------------
// ABM Tipos de Solicitud
// ----------------------------------------------------------------
const MODALIDADES_TIPO = ['emision', 'presentacion'];

const leerTipo = (b) => ({
    nombre: String(b.nombre || '').trim().slice(0, 150),
    descripcion: String(b.descripcion || '').trim().slice(0, 1000),
    modalidad: MODALIDADES_TIPO.includes(b.modalidad) ? b.modalidad : 'presentacion',
    orden: parseInt(b.orden) || 0,
    activo: b.activo ? 1 : 0
});

router.get('/tipos-solicitud', requireOperador, async (req, res) => {
    try {
        // "usos" = solicitudes que ya usan el tipo (si hay alguna, no se puede borrar: se oculta)
        const tipos = await dbp.all(`SELECT t.*,
                (SELECT COUNT(*) FROM solicitudes_doc s WHERE s.tipo_solicitud_id = t.id) AS usos
            FROM tipos_solicitud t ORDER BY t.orden, t.nombre`);
        res.render('backoffice/tipos-solicitud', {
            title: 'Tipos de Solicitud', user: req.session.user, tipos,
            ok: req.query.ok || null, error: req.query.error || null
        });
    } catch (err) {
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

router.post('/tipos-solicitud/nuevo', requireOperador, async (req, res) => {
    const t = leerTipo(req.body);
    if (!t.nombre) return res.redirect('/backoffice/tipos-solicitud?error=nombre');
    await dbp.run(`INSERT INTO tipos_solicitud (nombre, descripcion, modalidad, orden, activo) VALUES (?, ?, ?, ?, 1)`,
        [t.nombre, t.descripcion, t.modalidad, t.orden]);
    res.redirect('/backoffice/tipos-solicitud?ok=creado');
});

router.post('/tipos-solicitud/editar/:id', requireOperador, async (req, res) => {
    const t = leerTipo(req.body);
    if (!t.nombre) return res.redirect('/backoffice/tipos-solicitud?error=nombre');
    const r = await dbp.run(`UPDATE tipos_solicitud SET nombre = ?, descripcion = ?, modalidad = ?, orden = ?, activo = ? WHERE id = ?`,
        [t.nombre, t.descripcion, t.modalidad, t.orden, t.activo, req.params.id]);
    if (!r.changes) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });
    res.redirect('/backoffice/tipos-solicitud?ok=guardado');
});

// Sólo se borra si ninguna solicitud lo usó (el historial de los alumnos no puede quedar huérfano);
// si ya se usó, se desactiva y deja de ofrecerse.
router.post('/tipos-solicitud/eliminar/:id', requireOperador, async (req, res) => {
    const uso = await dbp.get(`SELECT COUNT(*) AS n FROM solicitudes_doc WHERE tipo_solicitud_id = ?`, [req.params.id]);
    if (uso.n > 0) return res.redirect('/backoffice/tipos-solicitud?error=en_uso');
    await dbp.run(`DELETE FROM tipos_solicitud WHERE id = ?`, [req.params.id]);
    res.redirect('/backoffice/tipos-solicitud?ok=eliminado');
});

// ----------------------------------------------------------------
// Consultas de alumnos: bandeja, respuesta y cierre
// ----------------------------------------------------------------
router.get('/consultas', async (req, res) => {
    const estado = ['abierta', 'respondida', 'cerrada'].includes(req.query.estado) ? req.query.estado : '';
    const search = String(req.query.search || '').trim();
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = 20;

    const where = ['1=1'];
    const params = [];
    if (estado) { where.push('c.estado = ?'); params.push(estado); }
    if (search) {
        where.push('(c.asunto LIKE ? OR a.nombre LIKE ? OR a.apellido LIKE ? OR a.dni LIKE ? OR a.legajo LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like, like);
    }
    const whereStr = where.join(' AND ');

    try {
        const [total, consultas, porEstado] = await Promise.all([
            dbp.get(`SELECT COUNT(*) AS n FROM consultas c JOIN alumnos a ON a.id = c.alumno_id WHERE ${whereStr}`, params),
            dbp.all(`SELECT c.*, a.nombre AS alumno_nombre, a.apellido AS alumno_apellido, a.legajo,
                        u.name AS asignado_nombre,
                        (SELECT COUNT(*) FROM consulta_mensajes m WHERE m.consulta_id = c.id) AS cant_mensajes
                    FROM consultas c
                    JOIN alumnos a ON a.id = c.alumno_id
                    LEFT JOIN users u ON u.id = c.asignado_a
                    WHERE ${whereStr}
                    ORDER BY CASE c.estado WHEN 'abierta' THEN 0 WHEN 'respondida' THEN 1 ELSE 2 END, c.updated_at DESC
                    LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]),
            dbp.all(`SELECT estado, COUNT(*) AS n FROM consultas GROUP BY estado`)
        ]);

        const conteo = { abierta: 0, respondida: 0, cerrada: 0 };
        porEstado.forEach(r => { conteo[r.estado] = r.n; });

        res.render('backoffice/consultas', {
            title: 'Consultas de Alumnos',
            user: req.session.user,
            consultas,
            conteo,
            estado,
            search,
            page,
            totalPages: Math.ceil(total.n / limit) || 1,
            moment
        });
    } catch (err) {
        console.error('Error listando consultas:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

router.get('/consultas/:id', async (req, res) => {
    try {
        const consulta = await dbp.get(`SELECT c.*, a.nombre AS alumno_nombre, a.apellido AS alumno_apellido,
                a.legajo, a.dni, a.email AS alumno_email, u.name AS asignado_nombre
            FROM consultas c
            JOIN alumnos a ON a.id = c.alumno_id
            LEFT JOIN users u ON u.id = c.asignado_a
            WHERE c.id = ?`, [req.params.id]);
        if (!consulta) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });

        const mensajes = await dbp.all(`SELECT * FROM consulta_mensajes WHERE consulta_id = ? ORDER BY created_at ASC, id ASC`, [consulta.id]);
        res.render('backoffice/consulta-detalle', { title: 'Consulta', user: req.session.user, consulta, mensajes, moment });
    } catch (err) {
        console.error('Error en detalle de consulta:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

router.post('/consultas/:id/responder', async (req, res) => {
    const { id } = req.params;
    const user = req.session.user;
    const mensaje = String(req.body.mensaje || '').trim().slice(0, 3000);
    if (!mensaje) return res.redirect(`/backoffice/consultas/${id}`);

    try {
        const consulta = await dbp.get(`SELECT * FROM consultas WHERE id = ?`, [id]);
        if (!consulta) return res.status(404).render('errors/404', { title: 'No encontrado', user });

        await dbp.run(`INSERT INTO consulta_mensajes (consulta_id, autor_tipo, user_id, user_name, mensaje)
            VALUES (?, 'personal', ?, ?, ?)`, [id, user.id, user.name, mensaje]);
        await dbp.run(`UPDATE consultas SET estado = 'respondida', asignado_a = COALESCE(asignado_a, ?),
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [user.id, id]);
        await dbp.run(`INSERT INTO notificaciones (alumno_id, tipo, mensaje, url) VALUES (?, 'info', ?, ?)`,
            [consulta.alumno_id, `Respondieron tu consulta: "${consulta.asunto}".`, `/alumno/consultas/${id}`]);
        res.redirect(`/backoffice/consultas/${id}`);
    } catch (err) {
        console.error('Error respondiendo consulta:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user });
    }
});

router.post('/consultas/:id/cerrar', async (req, res) => {
    await dbp.run(`UPDATE consultas SET estado = 'cerrada', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
    res.redirect(`/backoffice/consultas/${req.params.id}`);
});

router.post('/consultas/:id/reabrir', async (req, res) => {
    await dbp.run(`UPDATE consultas SET estado = 'abierta', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
    res.redirect(`/backoffice/consultas/${req.params.id}`);
});

// ----------------------------------------------------------------
// ABM Carreras y cursos (lo que ve el público en /carreras y el home)
// ----------------------------------------------------------------
const TIPOS_CARRERA = ['carrera', 'curso'];
const MODALIDADES_CARRERA = ['presencial', 'semipresencial', 'virtual'];

const leerCarrera = (b) => {
    const t = (v, max = 2000) => String(v || '').trim().slice(0, max);
    return {
        nombre: t(b.nombre, 200),
        tipo: TIPOS_CARRERA.includes(b.tipo) ? b.tipo : 'carrera',
        modalidad: MODALIDADES_CARRERA.includes(b.modalidad) ? b.modalidad : 'presencial',
        duracion: t(b.duracion, 100),
        turno: t(b.turno, 100),
        descripcion: t(b.descripcion),
        plan_estudios: t(b.plan_estudios, 5000),
        titulo: t(b.titulo, 200),
        requisitos_ingreso: t(b.requisitos_ingreso),
        aranceles: t(b.aranceles),
        fechas_inscripcion: t(b.fechas_inscripcion),
        orden: parseInt(b.orden) || 0,
        activo: b.activo ? 1 : 0
    };
};

const CAMPOS_CARRERA = ['nombre', 'tipo', 'modalidad', 'duracion', 'turno', 'descripcion', 'plan_estudios',
    'titulo', 'requisitos_ingreso', 'aranceles', 'fechas_inscripcion', 'orden', 'activo'];

router.get('/carreras', requireOperador, async (req, res) => {
    try {
        const carreras = await dbp.all(`SELECT c.*,
                (SELECT COUNT(*) FROM alumno_carreras ac WHERE ac.carrera_id = c.id) AS inscriptos,
                (SELECT COUNT(*) FROM cursos cu WHERE cu.carrera_id = c.id) AS cursos
            FROM carreras c ORDER BY c.activo DESC, c.orden, c.nombre`);
        res.render('backoffice/carreras', {
            title: 'Carreras y Cursos',
            user: req.session.user,
            carreras,
            ok: req.query.ok || null,
            error: req.query.error || null
        });
    } catch (err) {
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

router.get('/carreras/nueva', requireOperador, (req, res) => {
    res.render('backoffice/carrera-form', {
        title: 'Nueva Carrera o Curso',
        user: req.session.user,
        carrera: { tipo: 'carrera', modalidad: 'presencial', activo: 1, orden: 0 },
        esNueva: true,
        error: null
    });
});

router.post('/carreras/nueva', requireOperador, async (req, res) => {
    const c = leerCarrera(req.body);
    if (!c.nombre) {
        return res.status(400).render('backoffice/carrera-form', {
            title: 'Nueva Carrera o Curso', user: req.session.user, carrera: c, esNueva: true, error: 'El nombre es obligatorio.'
        });
    }
    try {
        await dbp.run(`INSERT INTO carreras (${CAMPOS_CARRERA.join(', ')}) VALUES (${CAMPOS_CARRERA.map(() => '?').join(', ')})`,
            CAMPOS_CARRERA.map(k => c[k]));
        res.redirect('/backoffice/carreras?ok=creada');
    } catch (err) {
        console.error('Error creando carrera:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

router.get('/carreras/:id/editar', requireOperador, async (req, res) => {
    const carrera = await dbp.get(`SELECT * FROM carreras WHERE id = ?`, [req.params.id]);
    if (!carrera) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });
    res.render('backoffice/carrera-form', { title: 'Editar Carrera o Curso', user: req.session.user, carrera, esNueva: false, error: null });
});

router.post('/carreras/:id/editar', requireOperador, async (req, res) => {
    const c = leerCarrera(req.body);
    if (!c.nombre) {
        return res.status(400).render('backoffice/carrera-form', {
            title: 'Editar Carrera o Curso', user: req.session.user, carrera: { ...c, id: req.params.id }, esNueva: false, error: 'El nombre es obligatorio.'
        });
    }
    try {
        const r = await dbp.run(`UPDATE carreras SET ${CAMPOS_CARRERA.map(k => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [...CAMPOS_CARRERA.map(k => c[k]), req.params.id]);
        if (!r.changes) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });
        res.redirect('/backoffice/carreras?ok=guardada');
    } catch (err) {
        console.error('Error editando carrera:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

// Publicar / ocultar en el sitio sin borrar
router.post('/carreras/:id/estado', requireOperador, async (req, res) => {
    await dbp.run(`UPDATE carreras SET activo = 1 - activo, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id]);
    res.redirect('/backoffice/carreras?ok=estado');
});

// Sólo se elimina si nadie la usa; si hay alumnos o cursos asociados se ofrece ocultarla
router.post('/carreras/:id/eliminar', requireOperador, async (req, res) => {
    try {
        const uso = await dbp.get(`SELECT
                (SELECT COUNT(*) FROM alumno_carreras WHERE carrera_id = ?) +
                (SELECT COUNT(*) FROM cursos WHERE carrera_id = ?) AS n`, [req.params.id, req.params.id]);
        if (uso.n > 0) return res.redirect('/backoffice/carreras?error=en_uso');
        await dbp.run(`DELETE FROM carreras WHERE id = ?`, [req.params.id]);
        res.redirect('/backoffice/carreras?ok=eliminada');
    } catch (err) {
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

// ----------------------------------------------------------------
// ABM Ventajas de la institución (sección del home público)
// ----------------------------------------------------------------
const leerVentaja = (b) => {
    const icono = String(b.icono || '').trim();
    return {
        titulo: String(b.titulo || '').trim().slice(0, 120),
        descripcion: String(b.descripcion || '').trim().slice(0, 500),
        // El ícono va dentro de un atributo class: sólo se acepta formato de FontAwesome
        icono: /^fa-[a-z0-9-]+$/.test(icono) ? icono : 'fa-star',
        orden: parseInt(b.orden) || 0,
        activo: b.activo ? 1 : 0
    };
};

router.get('/ventajas', requireOperador, async (req, res) => {
    const ventajas = await dbp.all(`SELECT * FROM ventajas ORDER BY orden, id`);
    res.render('backoffice/ventajas', { title: 'Ventajas de la Institución', user: req.session.user, ventajas });
});

router.post('/ventajas/nuevo', requireOperador, async (req, res) => {
    const v = leerVentaja(req.body);
    if (v.titulo) {
        await dbp.run(`INSERT INTO ventajas (titulo, descripcion, icono, orden, activo) VALUES (?, ?, ?, ?, 1)`,
            [v.titulo, v.descripcion, v.icono, v.orden]);
    }
    res.redirect('/backoffice/ventajas');
});

router.post('/ventajas/editar/:id', requireOperador, async (req, res) => {
    const v = leerVentaja(req.body);
    if (v.titulo) {
        await dbp.run(`UPDATE ventajas SET titulo = ?, descripcion = ?, icono = ?, orden = ?, activo = ? WHERE id = ?`,
            [v.titulo, v.descripcion, v.icono, v.orden, v.activo, req.params.id]);
    }
    res.redirect('/backoffice/ventajas');
});

router.post('/ventajas/eliminar/:id', requireOperador, async (req, res) => {
    await dbp.run(`DELETE FROM ventajas WHERE id = ?`, [req.params.id]);
    res.redirect('/backoffice/ventajas');
});

// ----------------------------------------------------------------
// Datos institucionales (contacto, horarios, textos de portada)
// ----------------------------------------------------------------
router.get('/contenido', requireOperador, (req, res) => {
    contenido.obtener((valores) => {
        res.render('backoffice/contenido', {
            title: 'Datos Institucionales',
            user: req.session.user,
            campos: contenido.CAMPOS,
            valores,
            ok: req.query.ok === '1',
            error: req.query.error === '1'
        });
    });
});

router.post('/contenido', requireOperador, (req, res) => {
    contenido.guardar(req.body, req.session.user.id, (err) => {
        if (err) console.error('Error guardando contenido institucional:', err.message);
        res.redirect('/backoffice/contenido?' + (err ? 'error=1' : 'ok=1'));
    });
});

module.exports = router;
