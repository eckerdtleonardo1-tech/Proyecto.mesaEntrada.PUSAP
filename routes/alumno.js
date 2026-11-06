/**
 * routes/alumno.js
 * Panel privado del alumno. Todas las rutas requieren rol 'alumno'.
 * Autorización a nivel objeto: siempre filtra por req.session.user.alumno_id.
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const moment = require('moment');
const db = require('../db');
const dbp = require('../lib/dbp');
const { requireAlumno } = require('../middleware/auth');

// Aplicar guard a todas las rutas de este router
router.use(requireAlumno);

// Multer para adjuntos de solicitudes (destino privado, no público)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/privado/'),
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, Date.now() + '-' + safeName);
    }
});
const fileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF, JPG y PNG.'), false);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Helper: obtiene alumno_id del usuario en sesión
const getAlumnoId = (req) => req.session.user.alumno_id;

// ----------------------------------------------------------------
// Dashboard del alumno
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
    const alumnoId = getAlumnoId(req);
    if (!alumnoId) {
        return res.status(400).render('errors/403', { title: 'Sin perfil', user: req.session.user });
    }

    try {
        const hoy = moment().format('YYYY-MM-DD');
        const alumno = await dbp.get(`SELECT a.*,
            GROUP_CONCAT(c.nombre, ' / ') as carreras_nombres
            FROM alumnos a
            LEFT JOIN alumno_carreras ac ON ac.alumno_id = a.id AND ac.estado = 'activo'
            LEFT JOIN carreras c ON c.id = ac.carrera_id
            WHERE a.id = ?
            GROUP BY a.id`, [alumnoId]);
        if (!alumno) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });

        const [cuotasVencidas, solicitudesObservadas, pendientesPresencial, notifs, cursos, novedades, consultasRespondidas, faqs] = await Promise.all([
            dbp.all(`SELECT * FROM cuotas WHERE alumno_id = ? AND estado = 'pendiente' AND vencimiento < ?`, [alumnoId, hoy]),
            dbp.all(`SELECT sd.*, ts.nombre as tipo_nombre FROM solicitudes_doc sd
                JOIN tipos_solicitud ts ON ts.id = sd.tipo_solicitud_id
                WHERE sd.alumno_id = ? AND sd.estado = 'observada'`, [alumnoId]),
            // Trámites aprobados que el alumno debe cerrar yendo a la institución
            dbp.all(`SELECT sd.*, ts.nombre as tipo_nombre FROM solicitudes_doc sd
                JOIN tipos_solicitud ts ON ts.id = sd.tipo_solicitud_id
                WHERE sd.alumno_id = ? AND sd.estado IN ('aprobada', 'emitida')
                ORDER BY sd.updated_at DESC`, [alumnoId]),
            dbp.all(`SELECT * FROM notificaciones WHERE alumno_id = ? AND leida = 0 ORDER BY created_at DESC LIMIT 5`, [alumnoId]),
            dbp.all(`SELECT cu.*, c.nombre as carrera_nombre
                FROM alumno_cursos ac
                JOIN cursos cu ON cu.id = ac.curso_id
                LEFT JOIN carreras c ON c.id = cu.carrera_id
                WHERE ac.alumno_id = ? AND ac.estado_cursada = 'cursando'
                ORDER BY cu.nombre`, [alumnoId]),
            // Novedades dirigidas a alumnos (las administra el personal)
            dbp.all(`SELECT * FROM novedades WHERE activo = 1 AND audiencia IN ('alumnos', 'ambos')
                ORDER BY destacada DESC, fecha_publicacion DESC LIMIT 4`),
            dbp.get(`SELECT COUNT(*) AS n FROM consultas WHERE alumno_id = ? AND estado = 'respondida'`, [alumnoId]),
            dbp.all(`SELECT * FROM faqs WHERE activo = 1 AND audiencia IN ('alumnos', 'ambos') ORDER BY orden, categoria`)
        ]);

        res.render('alumno/index', {
            title: 'Mi Panel',
            user: req.session.user,
            alumno,
            cuotasVencidas,
            solicitudesObservadas,
            pendientesPresencial,
            notifs,
            cursos,
            novedades,
            faqs,
            consultasRespondidas: consultasRespondidas ? consultasRespondidas.n : 0,
            moment
        });
    } catch (err) {
        console.error('Error en dashboard de alumno:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

// ----------------------------------------------------------------
// Cursos
// ----------------------------------------------------------------
router.get('/cursos', (req, res) => {
    const alumnoId = getAlumnoId(req);
    db.all(`SELECT cu.*, ac.estado_cursada, c.nombre as carrera_nombre
        FROM alumno_cursos ac
        JOIN cursos cu ON cu.id = ac.curso_id
        LEFT JOIN carreras c ON c.id = cu.carrera_id
        WHERE ac.alumno_id = ?
        ORDER BY ac.estado_cursada, cu.nombre`, [alumnoId], (err, cursos) => {
        if (err) return res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
        res.render('alumno/cursos', { title: 'Mis Cursos', user: req.session.user, cursos: cursos || [], moment });
    });
});

// ----------------------------------------------------------------
// Cuotas
// ----------------------------------------------------------------
router.get('/cuotas', (req, res) => {
    const alumnoId = getAlumnoId(req);
    const filtro = req.query.filtro || 'todas';
    const hoy = moment().format('YYYY-MM-DD');

    let whereExtra = '';
    if (filtro === 'pendientes') whereExtra = ` AND estado = 'pendiente' AND vencimiento >= '${hoy}'`;
    else if (filtro === 'vencidas') whereExtra = ` AND estado = 'pendiente' AND vencimiento < '${hoy}'`;
    else if (filtro === 'pagadas') whereExtra = ` AND estado = 'pagada'`;
    else if (filtro === 'activas') whereExtra = ` AND estado NOT IN ('pagada', 'anulada', 'becada_exenta')`;

    db.all(`SELECT * FROM cuotas WHERE alumno_id = ?${whereExtra} ORDER BY vencimiento DESC`,
        [alumnoId], (err, cuotas) => {
        if (err) return res.status(500).render('errors/500', { title: 'Error', user: req.session.user });

        // Deuda total: pendientes + vencidas sin recargo (para UI)
        db.get(`SELECT COALESCE(SUM(monto + recargo), 0) as deuda_total
            FROM cuotas WHERE alumno_id = ? AND estado = 'pendiente'`,
            [alumnoId], (err, row) => {
            res.render('alumno/cuotas', {
                title: 'Mis Cuotas',
                user: req.session.user,
                cuotas: cuotas || [],
                filtro,
                deudaTotal: row ? row.deuda_total : 0,
                hoy,
                success: req.query.success || null,
                error: req.query.error || null,
                moment
            });
        });
    });
});

// Subir comprobante de pago de una cuota
router.post('/cuotas/:id/comprobante', upload.single('comprobante'), (req, res) => {
    const alumnoId = getAlumnoId(req);
    const { id } = req.params;

    if (!req.file) {
        return res.redirect('/alumno/cuotas?error=archivo_requerido');
    }

    db.get(`SELECT * FROM cuotas WHERE id = ? AND alumno_id = ?`, [id, alumnoId], (err, cuota) => {
        if (err || !cuota) {
            return res.status(404).render('errors/404', { title: 'Cuota no encontrada', user: req.session.user });
        }

        db.run(`UPDATE cuotas SET 
            comprobante_filename = ?, 
            comprobante_original_name = ?, 
            estado = 'pago_informado', 
            fecha_pago = COALESCE(fecha_pago, date('now')),
            updated_at = CURRENT_TIMESTAMP 
            WHERE id = ? AND alumno_id = ?`,
            [req.file.filename, req.file.originalname, id, alumnoId],
            (errUpdate) => {
                if (errUpdate) return res.status(500).render('errors/500', { title: 'Error', user: req.session.user });

                // Notificar al alumno
                db.run(`INSERT INTO notificaciones (alumno_id, tipo, mensaje, url) VALUES (?, 'info', ?, ?)`,
                    [alumnoId, `Informaste el comprobante de pago para: ${cuota.concepto}. Queda pendiente de verificación contable.`, '/alumno/cuotas']);

                res.redirect('/alumno/cuotas?success=comprobante_enviado');
            }
        );
    });
});

// ----------------------------------------------------------------
// Solicitudes de documentación
// ----------------------------------------------------------------
router.get('/solicitudes', (req, res) => {
    const alumnoId = getAlumnoId(req);
    db.all(`SELECT sd.*, ts.nombre as tipo_nombre, ts.modalidad as tipo_modalidad
        FROM solicitudes_doc sd
        JOIN tipos_solicitud ts ON ts.id = sd.tipo_solicitud_id
        WHERE sd.alumno_id = ?
        ORDER BY sd.updated_at DESC`, [alumnoId], (err, solicitudes) => {
        if (err) return res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
        res.render('alumno/solicitudes', {
            title: 'Mis Solicitudes',
            user: req.session.user,
            solicitudes: solicitudes || [],
            moment
        });
    });
});

router.get('/solicitudes/nueva', (req, res) => {
    db.all(`SELECT * FROM tipos_solicitud WHERE activo = 1 ORDER BY orden, nombre`, [], (err, tipos) => {
        if (err) return res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
        res.render('alumno/solicitud-nueva', {
            title: 'Nueva Solicitud',
            user: req.session.user,
            tipos: tipos || [],
            error: null
        });
    });
});

router.post('/solicitudes', upload.array('adjuntos', 5), async (req, res) => {
    const alumnoId = getAlumnoId(req);
    const { tipo_solicitud_id, accion } = req.body;

    // El tipo debe existir y estar activo (el catálogo lo administra el personal)
    const tipo = tipo_solicitud_id
        ? await dbp.get(`SELECT id FROM tipos_solicitud WHERE id = ? AND activo = 1`, [tipo_solicitud_id]).catch(() => null)
        : null;

    if (!tipo) {
        return db.all(`SELECT * FROM tipos_solicitud WHERE activo = 1 ORDER BY orden`, [], (err, tipos) => {
            res.render('alumno/solicitud-nueva', {
                title: 'Nueva Solicitud',
                user: req.session.user,
                tipos: tipos || [],
                error: 'Seleccioná un tipo de solicitud.'
            });
        });
    }

    const estado = (accion === 'enviar') ? 'enviada' : 'borrador';

    db.run(`INSERT INTO solicitudes_doc (alumno_id, tipo_solicitud_id, estado) VALUES (?, ?, ?)`,
        [alumnoId, tipo_solicitud_id, estado], function(err) {
        if (err) return res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
        const solicitudId = this.lastID;

        // Historial
        db.run(`INSERT INTO solicitud_historia (solicitud_id, user_id, user_name, estado_anterior, estado_nuevo, comentario)
            VALUES (?, ?, ?, 'nueva', ?, ?)`,
            [solicitudId, req.session.user.id, req.session.user.name, estado,
             estado === 'enviada' ? 'Solicitud enviada por el alumno.' : 'Solicitud guardada como borrador.']);

        // Adjuntos
        if (req.files && req.files.length > 0) {
            const stmt = db.prepare(`INSERT INTO solicitud_adjuntos (solicitud_id, filename, original_name) VALUES (?, ?, ?)`);
            req.files.forEach(f => stmt.run(solicitudId, f.filename, f.originalname));
            stmt.finalize();
        }

        // Notificación si se envió
        if (estado === 'enviada') {
            db.run(`INSERT INTO notificaciones (alumno_id, tipo, mensaje, url)
                VALUES (?, 'info', ?, ?)`,
                [alumnoId, 'Tu solicitud fue enviada y está en revisión.', `/alumno/solicitudes/${solicitudId}`]);
        }

        res.redirect(`/alumno/solicitudes/${solicitudId}`);
    });
});

router.get('/solicitudes/:id', (req, res) => {
    const alumnoId = getAlumnoId(req);
    const { id } = req.params;

    // Autorización a nivel objeto: solo el propio alumno
    db.get(`SELECT sd.*, ts.nombre as tipo_nombre, ts.modalidad as tipo_modalidad, ts.descripcion as tipo_descripcion
        FROM solicitudes_doc sd
        JOIN tipos_solicitud ts ON ts.id = sd.tipo_solicitud_id
        WHERE sd.id = ? AND sd.alumno_id = ?`, [id, alumnoId], (err, solicitud) => {
        if (err || !solicitud) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });

        db.all(`SELECT * FROM solicitud_historia WHERE solicitud_id = ? ORDER BY created_at ASC`, [id], (err, historia) => {
            db.all(`SELECT * FROM solicitud_adjuntos WHERE solicitud_id = ? ORDER BY created_at ASC`, [id], (err, adjuntos) => {
                res.render('alumno/solicitud-detalle', {
                    title: 'Detalle de Solicitud',
                    user: req.session.user,
                    solicitud,
                    historia: historia || [],
                    adjuntos: adjuntos || [],
                    moment
                });
            });
        });
    });
});

// Enviar al personal una solicitud que quedó guardada como borrador
router.post('/solicitudes/:id/enviar', (req, res) => {
    const alumnoId = getAlumnoId(req);
    const { id } = req.params;

    db.get(`SELECT * FROM solicitudes_doc WHERE id = ? AND alumno_id = ? AND estado = 'borrador'`,
        [id, alumnoId], (err, solicitud) => {
        if (err || !solicitud) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });

        db.run(`UPDATE solicitudes_doc SET estado = 'enviada', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id], () => {
            db.run(`INSERT INTO solicitud_historia (solicitud_id, user_id, user_name, estado_anterior, estado_nuevo, comentario)
                VALUES (?, ?, ?, 'borrador', 'enviada', 'Solicitud enviada por el alumno.')`,
                [id, req.session.user.id, req.session.user.name]);
            db.run(`INSERT INTO notificaciones (alumno_id, tipo, mensaje, url) VALUES (?, 'info', ?, ?)`,
                [alumnoId, 'Tu solicitud fue enviada y está en revisión.', `/alumno/solicitudes/${id}`]);
            res.redirect(`/alumno/solicitudes/${id}`);
        });
    });
});

// Reenviar solicitud observada con nuevos adjuntos
router.post('/solicitudes/:id/adjuntar', upload.array('adjuntos', 5), (req, res) => {
    const alumnoId = getAlumnoId(req);
    const { id } = req.params;

    db.get(`SELECT * FROM solicitudes_doc WHERE id = ? AND alumno_id = ? AND estado = 'observada'`,
        [id, alumnoId], (err, solicitud) => {
        if (err || !solicitud) return res.status(403).render('errors/403', { title: 'Acceso denegado', user: req.session.user });

        // Guardar adjuntos
        if (req.files && req.files.length > 0) {
            const stmt = db.prepare(`INSERT INTO solicitud_adjuntos (solicitud_id, filename, original_name) VALUES (?, ?, ?)`);
            req.files.forEach(f => stmt.run(id, f.filename, f.originalname));
            stmt.finalize();
        }

        // Cambiar estado a enviada
        db.run(`UPDATE solicitudes_doc SET estado = 'enviada', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id], (err) => {
            db.run(`INSERT INTO solicitud_historia (solicitud_id, user_id, user_name, estado_anterior, estado_nuevo, comentario)
                VALUES (?, ?, ?, 'observada', 'enviada', 'Alumno corrigió y reenvió la solicitud.')`,
                [id, req.session.user.id, req.session.user.name]);
            res.redirect(`/alumno/solicitudes/${id}`);
        });
    });
});

// ----------------------------------------------------------------
// Consultas al personal (hilo de mensajes)
// ----------------------------------------------------------------
const CATEGORIAS_CONSULTA = ['Académica', 'Administrativa', 'Pagos y cuotas', 'Trámites', 'Otra'];
const MAX_ASUNTO = 150;
const MAX_MENSAJE = 3000;

router.get('/consultas', async (req, res) => {
    try {
        const consultas = await dbp.all(`SELECT c.*,
                (SELECT COUNT(*) FROM consulta_mensajes m WHERE m.consulta_id = c.id) AS cant_mensajes
            FROM consultas c WHERE c.alumno_id = ?
            ORDER BY c.updated_at DESC`, [getAlumnoId(req)]);
        res.render('alumno/consultas', { title: 'Mis Consultas', user: req.session.user, consultas, moment });
    } catch (err) {
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

router.get('/consultas/nueva', (req, res) => {
    res.render('alumno/consulta-nueva', {
        title: 'Nueva Consulta',
        user: req.session.user,
        categorias: CATEGORIAS_CONSULTA,
        error: null,
        valores: {}
    });
});

router.post('/consultas', async (req, res) => {
    const alumnoId = getAlumnoId(req);
    const asunto = String(req.body.asunto || '').trim().slice(0, MAX_ASUNTO);
    const mensaje = String(req.body.mensaje || '').trim().slice(0, MAX_MENSAJE);
    const categoria = CATEGORIAS_CONSULTA.includes(req.body.categoria) ? req.body.categoria : 'Otra';

    if (!asunto || !mensaje) {
        return res.status(400).render('alumno/consulta-nueva', {
            title: 'Nueva Consulta',
            user: req.session.user,
            categorias: CATEGORIAS_CONSULTA,
            error: 'Completá el asunto y el mensaje.',
            valores: { asunto, mensaje, categoria }
        });
    }

    try {
        const { lastID } = await dbp.run(`INSERT INTO consultas (alumno_id, categoria, asunto) VALUES (?, ?, ?)`,
            [alumnoId, categoria, asunto]);
        await dbp.run(`INSERT INTO consulta_mensajes (consulta_id, autor_tipo, user_id, user_name, mensaje)
            VALUES (?, 'alumno', ?, ?, ?)`, [lastID, req.session.user.id, req.session.user.name, mensaje]);
        res.redirect(`/alumno/consultas/${lastID}`);
    } catch (err) {
        console.error('Error creando consulta:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

// Autorización a nivel objeto: la consulta tiene que ser del alumno en sesión
const cargarConsultaPropia = (req, res, next) => {
    db.get(`SELECT * FROM consultas WHERE id = ? AND alumno_id = ?`, [req.params.id, getAlumnoId(req)], (err, consulta) => {
        if (err || !consulta) return res.status(404).render('errors/404', { title: 'No encontrado', user: req.session.user });
        req.consulta = consulta;
        next();
    });
};

router.get('/consultas/:id', cargarConsultaPropia, async (req, res) => {
    try {
        const mensajes = await dbp.all(`SELECT * FROM consulta_mensajes WHERE consulta_id = ? ORDER BY created_at ASC, id ASC`, [req.consulta.id]);
        res.render('alumno/consulta-detalle', { title: 'Consulta', user: req.session.user, consulta: req.consulta, mensajes, moment });
    } catch (err) {
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

router.post('/consultas/:id/responder', cargarConsultaPropia, async (req, res) => {
    const mensaje = String(req.body.mensaje || '').trim().slice(0, MAX_MENSAJE);
    if (!mensaje || req.consulta.estado === 'cerrada') return res.redirect(`/alumno/consultas/${req.consulta.id}`);

    try {
        await dbp.run(`INSERT INTO consulta_mensajes (consulta_id, autor_tipo, user_id, user_name, mensaje)
            VALUES (?, 'alumno', ?, ?, ?)`, [req.consulta.id, req.session.user.id, req.session.user.name, mensaje]);
        // Vuelve a la bandeja del personal
        await dbp.run(`UPDATE consultas SET estado = 'abierta', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.consulta.id]);
        res.redirect(`/alumno/consultas/${req.consulta.id}`);
    } catch (err) {
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

router.post('/consultas/:id/cerrar', cargarConsultaPropia, async (req, res) => {
    try {
        await dbp.run(`UPDATE consultas SET estado = 'cerrada', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.consulta.id]);
        res.redirect(`/alumno/consultas/${req.consulta.id}`);
    } catch (err) {
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
    }
});

// ----------------------------------------------------------------
// Mis trámites de mesa de entrada
// ----------------------------------------------------------------
router.get('/tramites', (req, res) => {
    const user = req.session.user;
    // Filtra por DNI del alumno para ligar con tickets existentes
    if (!user.dni) {
        return res.render('alumno/tramites', { title: 'Mis Trámites', user, tramites: [], moment });
    }
    db.all(`SELECT * FROM tickets WHERE dni = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
        [user.dni], (err, tramites) => {
        if (err) return res.status(500).render('errors/500', { title: 'Error', user });
        res.render('alumno/tramites', { title: 'Mis Trámites', user, tramites: tramites || [], moment });
    });
});

// ----------------------------------------------------------------
// Perfil
// ----------------------------------------------------------------
router.get('/perfil', (req, res) => {
    const success = req.query.success === '1';
    const error = req.query.error;
    res.render('alumno/perfil', { title: 'Mi Perfil', user: req.session.user, success, error });
});

router.post('/perfil/password', async (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    const user = req.session.user;

    if (new_password !== confirm_password) return res.redirect('/alumno/perfil?error=mismatch');
    if (new_password.length < 8) return res.redirect('/alumno/perfil?error=short');

    db.get(`SELECT password FROM users WHERE id = ?`, [user.id], async (err, row) => {
        if (err || !row) return res.redirect('/alumno/perfil?error=invalid');
        const match = await require('bcryptjs').compare(current_password, row.password);
        if (!match) return res.redirect('/alumno/perfil?error=invalid');
        const hashed = await require('bcryptjs').hash(new_password, 10);
        db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashed, user.id], (err) => {
            if (err) return res.redirect('/alumno/perfil?error=server');
            res.redirect('/alumno/perfil?success=1');
        });
    });
});

// ----------------------------------------------------------------
// Notificaciones
// ----------------------------------------------------------------
router.get('/notificaciones', (req, res) => {
    const alumnoId = getAlumnoId(req);
    db.all(`SELECT * FROM notificaciones WHERE alumno_id = ? ORDER BY created_at DESC LIMIT 50`,
        [alumnoId], (err, notifs) => {
        // Marcar todas como leídas
        db.run(`UPDATE notificaciones SET leida = 1 WHERE alumno_id = ?`, [alumnoId]);
        res.render('alumno/notificaciones', { title: 'Notificaciones', user: req.session.user, notifs: notifs || [], moment });
    });
});

router.post('/notificaciones/:id/leer', (req, res) => {
    const alumnoId = getAlumnoId(req);
    db.run(`UPDATE notificaciones SET leida = 1 WHERE id = ? AND alumno_id = ?`, [req.params.id, alumnoId]);
    res.json({ ok: true });
});

// API: conteo de notificaciones no leídas (para badge en navbar)
router.get('/api/notificaciones/count', (req, res) => {
    const alumnoId = getAlumnoId(req);
    db.get(`SELECT COUNT(*) as count FROM notificaciones WHERE alumno_id = ? AND leida = 0`, [alumnoId], (err, row) => {
        res.json({ count: row ? row.count : 0 });
    });
});

module.exports = router;
