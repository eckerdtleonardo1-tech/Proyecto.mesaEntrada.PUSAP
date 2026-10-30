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
// Dashboard de backoffice (redirige al panel de tickets existente)
// ----------------------------------------------------------------
router.get('/', (req, res) => {
    res.redirect('/panel');
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
                        moment
                    });
                });
            });
        });
    });
});

// Acción sobre solicitud (aprobar / observar / rechazar / en_revision)
router.post('/solicitudes/:id/accion', (req, res) => {
    const { id } = req.params;
    const { accion, motivo, asignado_a } = req.body;
    const user = req.session.user;

    const estadosValidos = ['en_revision', 'observada', 'aprobada', 'rechazada'];
    if (!estadosValidos.includes(accion)) return res.redirect(`/backoffice/solicitudes/${id}`);

    db.get(`SELECT * FROM solicitudes_doc WHERE id = ?`, [id], (err, sol) => {
        if (err || !sol) return res.status(404).render('errors/404', { title: 'No encontrado', user });

        db.run(`UPDATE solicitudes_doc SET estado = ?, motivo_observacion = ?, asignado_a = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [accion, motivo || null, asignado_a || sol.asignado_a, id], (err2) => {

            db.run(`INSERT INTO solicitud_historia (solicitud_id, user_id, user_name, estado_anterior, estado_nuevo, comentario)
                VALUES (?, ?, ?, ?, ?, ?)`,
                [id, user.id, user.name, sol.estado, accion, motivo || null]);

            // Notificar al alumno
            let msg = '';
            if (accion === 'en_revision') msg = 'Tu solicitud está siendo revisada por el personal.';
            else if (accion === 'observada') msg = `Tu solicitud fue observada. Motivo: ${motivo || 'Ver detalle'}. Por favor, corregí y reenviá.`;
            else if (accion === 'aprobada') msg = 'Tu solicitud fue aprobada.';
            else if (accion === 'rechazada') msg = `Tu solicitud fue rechazada. Motivo: ${motivo || 'Ver detalle'}.`;

            if (msg) {
                db.run(`INSERT INTO notificaciones (alumno_id, tipo, mensaje, url) VALUES (?, ?, ?, ?)`,
                    [sol.alumno_id, accion === 'rechazada' ? 'error' : 'info', msg, `/alumno/solicitudes/${id}`]);
            }

            res.redirect(`/backoffice/solicitudes/${id}`);
        });
    });
});

// Subir documento emitido
router.post('/solicitudes/:id/emitir', upload.single('documento'), (req, res) => {
    const { id } = req.params;
    const user = req.session.user;

    if (!req.file) return res.redirect(`/backoffice/solicitudes/${id}`);

    db.run(`UPDATE solicitudes_doc SET 
        estado = 'emitida',
        documento_emitido_filename = ?,
        documento_emitido_original_name = ?,
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [req.file.filename, req.file.originalname, id], (err) => {

        db.get(`SELECT alumno_id FROM solicitudes_doc WHERE id = ?`, [id], (err, row) => {
            if (row) {
                db.run(`INSERT INTO solicitud_historia (solicitud_id, user_id, user_name, estado_anterior, estado_nuevo, comentario)
                    VALUES (?, ?, ?, 'aprobada', 'emitida', 'Documento emitido subido por el personal.')`,
                    [id, user.id, user.name]);

                db.run(`INSERT INTO notificaciones (alumno_id, tipo, mensaje, url) VALUES (?, 'success', ?, ?)`,
                    [row.alumno_id, 'El documento solicitado fue emitido y está disponible para descargar.', `/alumno/solicitudes/${id}`]);
            }
            res.redirect(`/backoffice/solicitudes/${id}`);
        });
    });
});

// ----------------------------------------------------------------
// Asignar responsable a solicitud
// ----------------------------------------------------------------
router.post('/solicitudes/:id/asignar', (req, res) => {
    const { id } = req.params;
    const { asignado_a } = req.body;
    db.run(`UPDATE solicitudes_doc SET asignado_a = ? WHERE id = ?`, [asignado_a || null, id], () => {
        res.redirect(`/backoffice/solicitudes/${id}`);
    });
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
    db.all(`SELECT a.*, u.id as user_id, u.username as user_email, u.activo as cuenta_activa, u.activation_token,
        GROUP_CONCAT(c.nombre, ' / ') as carreras
        FROM alumnos a
        LEFT JOIN users u ON u.alumno_id = a.id
        LEFT JOIN alumno_carreras ac ON ac.alumno_id = a.id AND ac.estado = 'activo'
        LEFT JOIN carreras c ON c.id = ac.carrera_id
        WHERE ${where}
        GROUP BY a.id
        ORDER BY a.apellido, a.nombre`, params, (err, alumnos) => {
        db.all(`SELECT id, nombre FROM carreras WHERE activo = 1 ORDER BY nombre`, [], (errCarreras, carreras) => {
            res.render('backoffice/alumnos', {
                title: 'Gestión de Alumnos',
                user: req.session.user,
                alumnos: alumnos || [],
                carreras: carreras || [],
                query: req.query,
                success: req.query.success || null,
                token: req.query.token || null,
                alumnoNombre: req.query.alumno || null,
                error: req.query.error || null
            });
        });
    });
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
// ----------------------------------------------------------------
router.get('/faqs', requireOperador, (req, res) => {
    db.all(`SELECT * FROM faqs ORDER BY orden, categoria`, [], (err, faqs) => {
        res.render('backoffice/faqs', { title: 'Preguntas Frecuentes', user: req.session.user, faqs: faqs || [] });
    });
});

router.post('/faqs/nuevo', requireOperador, (req, res) => {
    const { categoria, pregunta, respuesta, orden } = req.body;
    db.run(`INSERT INTO faqs (categoria, pregunta, respuesta, orden) VALUES (?, ?, ?, ?)`,
        [categoria, pregunta, respuesta, parseInt(orden) || 0], () => res.redirect('/backoffice/faqs'));
});

router.post('/faqs/editar/:id', requireOperador, (req, res) => {
    const { categoria, pregunta, respuesta, orden, activo } = req.body;
    db.run(`UPDATE faqs SET categoria = ?, pregunta = ?, respuesta = ?, orden = ?, activo = ? WHERE id = ?`,
        [categoria, pregunta, respuesta, parseInt(orden) || 0, activo ? 1 : 0, req.params.id],
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
    db.run(`INSERT INTO novedades (titulo, cuerpo, destacada) VALUES (?, ?, ?)`,
        [titulo, cuerpo, destacada ? 1 : 0], () => res.redirect('/backoffice/novedades'));
});

router.post('/novedades/editar/:id', requireOperador, (req, res) => {
    const { titulo, cuerpo, destacada, activo } = req.body;
    db.run(`UPDATE novedades SET titulo = ?, cuerpo = ?, destacada = ?, activo = ? WHERE id = ?`,
        [titulo, cuerpo, destacada ? 1 : 0, activo ? 1 : 0, req.params.id],
        () => res.redirect('/backoffice/novedades'));
});

router.post('/novedades/eliminar/:id', requireOperador, (req, res) => {
    db.run(`DELETE FROM novedades WHERE id = ?`, [req.params.id], () => res.redirect('/backoffice/novedades'));
});

// ----------------------------------------------------------------
// ABM Tipos de Solicitud
// ----------------------------------------------------------------
router.get('/tipos-solicitud', requireOperador, (req, res) => {
    db.all(`SELECT * FROM tipos_solicitud ORDER BY orden, nombre`, [], (err, tipos) => {
        res.render('backoffice/tipos-solicitud', { title: 'Tipos de Solicitud', user: req.session.user, tipos: tipos || [] });
    });
});

router.post('/tipos-solicitud/nuevo', requireOperador, (req, res) => {
    const { nombre, descripcion, modalidad, orden } = req.body;
    db.run(`INSERT INTO tipos_solicitud (nombre, descripcion, modalidad, orden) VALUES (?, ?, ?, ?)`,
        [nombre, descripcion, modalidad, parseInt(orden) || 0], () => res.redirect('/backoffice/tipos-solicitud'));
});

router.post('/tipos-solicitud/editar/:id', requireOperador, (req, res) => {
    const { nombre, descripcion, modalidad, orden, activo } = req.body;
    db.run(`UPDATE tipos_solicitud SET nombre = ?, descripcion = ?, modalidad = ?, orden = ?, activo = ? WHERE id = ?`,
        [nombre, descripcion, modalidad, parseInt(orden) || 0, activo ? 1 : 0, req.params.id],
        () => res.redirect('/backoffice/tipos-solicitud'));
});

module.exports = router;
