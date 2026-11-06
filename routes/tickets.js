const express = require('express');
const router = express.Router();
const multer = require('multer');
const PDFDocument = require('pdfkit');
const moment = require('moment');
const bcrypt = require('bcryptjs');
const db = require('../db');
const dbp = require('../lib/dbp');
const QRCode = require('qrcode');
const { sendStatusUpdateEmail, sendTicketCreatedEmail } = require('../mailer');

// Middleware de Autenticación
const requireAuth = (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    next();
};
router.use(requireAuth);

// Configurar Multer para archivos
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const fileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de archivo no permitido. Solo PDF, JPG y PNG.'), false);
    }
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// Dashboard (Estadísticas y Tabla)
router.get('/', (req, res) => {
    const user = req.session.user;
    
    // "area" hace falta para el gráfico "Trámites por Área" (sin ella todos quedaban bajo "undefined")
    let statsQuery = `SELECT status, expiration_date, created_at, area FROM tickets WHERE deleted_at IS NULL`;
    let statsParams = [];
    if (user.role !== 'operador') {
        statsQuery += ` AND area = ?`;
        statsParams.push(user.area);
    }
    
    db.all(statsQuery, statsParams, (err, allTickets) => {
        if (err) return res.status(500).send("Error");
        
        const stats = {
            total: allTickets.length,
            iniciados: allTickets.filter(t => t.status === 'Iniciado').length,
            en_revision: allTickets.filter(t => t.status === 'En Revisión').length,
            pendientes_doc: allTickets.filter(t => t.status === 'Pendiente de Documentación').length,
            aprobados: allTickets.filter(t => t.status === 'Aprobado').length,
            rechazados: allTickets.filter(t => t.status === 'Rechazado').length,
            por_vencer: allTickets.filter(t => t.expiration_date && moment(t.expiration_date).diff(moment(), 'days') <= 7 && !['Aprobado', 'Rechazado'].includes(t.status)).length
        };

        const weeklyActivity = {};
        for(let i=6; i>=0; i--) {
            weeklyActivity[moment().subtract(i, 'days').format('YYYY-MM-DD')] = 0;
        }
        
        const areaDistribution = {};
        
        allTickets.forEach(t => {
            const d = moment.utc(t.created_at).local().format('YYYY-MM-DD');
            if (weeklyActivity[d] !== undefined) {
                weeklyActivity[d]++;
            }
            if (!areaDistribution[t.area]) {
                areaDistribution[t.area] = 0;
            }
            areaDistribution[t.area]++;
        });

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const { search, status, area, priority } = req.query;

        let whereClauses = ['deleted_at IS NULL'];
        let queryParams = [];

        if (user.role !== 'operador') {
            whereClauses.push(`area = ?`);
            queryParams.push(user.area);
        } else if (area) {
            whereClauses.push(`area = ?`);
            queryParams.push(area);
        }

        if (status) {
            whereClauses.push(`status = ?`);
            queryParams.push(status);
        }
        
        if (priority) {
            whereClauses.push(`priority = ?`);
            queryParams.push(priority);
        }

        if (search) {
            whereClauses.push(`(tracking_code LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR dni LIKE ? OR category LIKE ?)`);
            const likeSearch = `%${search}%`;
            queryParams.push(likeSearch, likeSearch, likeSearch, likeSearch, likeSearch);
        }

        let whereStr = whereClauses.length > 0 ? ` WHERE ` + whereClauses.join(' AND ') : '';

        db.get(`SELECT COUNT(*) as count FROM tickets` + whereStr, queryParams, (err, countRow) => {
            if (err) return res.status(500).send("Error");
            
            const total = countRow.count;
            const totalPages = Math.ceil(total / limit) || 1;

            let paginatedQuery = `SELECT * FROM tickets` + whereStr + ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            
            db.all(paginatedQuery, [...queryParams, limit, offset], (err, tickets) => {
                if (err) return res.status(500).send("Error");

                db.all(`SELECT tt.ticket_id, t.id as tag_id, t.name, t.color FROM ticket_tags tt JOIN tags t ON tt.tag_id = t.id`, [], (err, allTags) => {
                    db.all(`SELECT id, name FROM users`, [], (err, allUsers) => {
                      // El filtro de áreas sale de la tabla de áreas (se administran en Configuración)
                      db.all(`SELECT name FROM areas ORDER BY name`, [], (errAreas, areas) => {
                        const userMap = {};
                        if(allUsers) allUsers.forEach(u => userMap[u.id] = u.name);

                        tickets.forEach(ticket => {
                            ticket.tags = allTags ? allTags.filter(tg => tg.ticket_id === ticket.id) : [];
                            ticket.assigned_to_name = userMap[ticket.assigned_to] || null;
                        });

                        const success_ticket = req.query.success_ticket || null;

                        res.render('dashboard', {
                            title: 'Panel de Gestión',
                            tickets,
                            stats,
                            weeklyActivity,
                            areaDistribution,
                            areas: areas || [],
                            user,
                            success_ticket,
                            page,
                            totalPages,
                            total,
                            query: req.query
                        });
                      });
                    });
                });
            });
        });
    });
});

// API: Stats para Auto-refresh
router.get('/api/stats', (req, res) => {
    const user = req.session.user;
    let query = `SELECT * FROM tickets WHERE deleted_at IS NULL`;
    let params = [];
    if (user.role !== 'operador') {
        query += ` AND area = ?`;
        params.push(user.area);
    }
    db.all(query, params, (err, tickets) => {
        if (err) return res.status(500).json({ error: "Error de DB" });
        const stats = {
            total: tickets.length,
            iniciados: tickets.filter(t => t.status === 'Iniciado').length,
            en_revision: tickets.filter(t => t.status === 'En Revisión').length,
            pendientes_doc: tickets.filter(t => t.status === 'Pendiente de Documentación').length,
            aprobados: tickets.filter(t => t.status === 'Aprobado').length,
            rechazados: tickets.filter(t => t.status === 'Rechazado').length,
            por_vencer: tickets.filter(t => t.expiration_date && moment(t.expiration_date).diff(moment(), 'days') <= 7 && !['Aprobado', 'Rechazado'].includes(t.status)).length
        };
        res.json(stats);
    });
});

// API: Buscar DNI
router.get('/api/buscar-dni', (req, res) => {
    const dni = req.query.dni;
    if (!dni) return res.json({ existe: false });
    db.all(`SELECT id, category, status, created_at FROM tickets WHERE dni = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`, [dni], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error de DB" });
        if (rows && rows.length > 0) {
            res.json({ existe: true, tramites: rows });
        } else {
            res.json({ existe: false });
        }
    });
});

// API: Actividad reciente
router.get('/api/actividad-reciente', (req, res) => {
    db.all(`SELECT t.tracking_code, t.first_name, t.last_name, h.new_status, h.created_at, t.id as ticket_id 
            FROM ticket_history h 
            JOIN tickets t ON h.ticket_id = t.id 
            WHERE t.deleted_at IS NULL
            ORDER BY h.created_at DESC LIMIT 8`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: "Error" });
        res.json(rows);
    });
});

// Auditoria
router.get('/auditoria', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.all(`SELECT * FROM access_log ORDER BY created_at DESC LIMIT 100`, [], (err, logs) => {
        if (err) return res.status(500).send("Error de DB");
        res.render('admin-audit', { title: 'Auditoría', user: req.session.user, logs });
    });
});

// Formulario de Alta de Trámite
router.get('/nuevo', (req, res) => {
    res.render('new-ticket', { title: 'Nuevo Trámite', user: req.session.user });
});

// Mi Perfil
router.get('/mi-perfil', (req, res) => {
    const success = req.query.success === '1';
    const error = req.query.error;
    res.render('mi-perfil', { title: 'Mi Perfil', user: req.session.user, success, error });
});

router.post('/mi-perfil/cambiar-password', async (req, res) => {
    const { current_password, new_password, confirm_password } = req.body;
    const user = req.session.user;

    if (new_password !== confirm_password) {
        return res.redirect('/panel/mi-perfil?error=mismatch');
    }

    db.get(`SELECT password FROM users WHERE id = ?`, [user.id], async (err, row) => {
        if (err || !row) return res.redirect('/panel/mi-perfil?error=invalid');
        
        const match = await bcrypt.compare(current_password, row.password);
        if (!match) {
            return res.redirect('/panel/mi-perfil?error=invalid');
        }

        const hashed = await bcrypt.hash(new_password, 10);
        db.run(`UPDATE users SET password = ? WHERE id = ?`, [hashed, user.id], (err) => {
            if (err) return res.redirect('/panel/mi-perfil?error=invalid');
            res.redirect('/panel/mi-perfil?success=1');
        });
    });
});

// Procesar Alta
router.post('/nuevo', requireAuth, upload.array('attachments', 10), (req, res) => {
    let { first_name, last_name, dni, cuil, phone, email, category, expiration_date, priority } = req.body;
    const user = req.session.user;
    
    priority = priority || 'normal';
    const tracking_code = 'PUSAP-' + Math.random().toString(36).substr(2, 6).toUpperCase();

    if (!expiration_date) {
        expiration_date = moment().add(7, 'days').format('YYYY-MM-DD');
    }

    const query = `INSERT INTO tickets (tracking_code, first_name, last_name, dni, cuil, phone, email, category, status, area, expiration_date, priority) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Iniciado', 'Mesa de Entrada', ?, ?)`;
    
    db.run(query, [tracking_code, first_name, last_name, dni, cuil, phone, email, category, expiration_date, priority], function(err) {
        if (err) return res.status(500).send(err.message);
        const ticketId = this.lastID;

        db.run(`INSERT INTO ticket_history (ticket_id, user_id, user_name, old_status, new_status, old_area, new_area, comments, type) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'historial')`, 
                [ticketId, user.id, user.name, 'N/A', 'Iniciado', 'N/A', 'Mesa de Entrada', 'Trámite ingresado al sistema.']);

        if (req.files && req.files.length > 0) {
            const stmt = db.prepare(`INSERT INTO attachments (ticket_id, filename, original_name) VALUES (?, ?, ?)`);
            req.files.forEach(file => {
                stmt.run(ticketId, file.filename, file.originalname);
            });
            stmt.finalize();
        }

        sendTicketCreatedEmail(email, first_name, tracking_code);

        res.redirect(`/panel?success_ticket=${ticketId}`);
    });
});

// Ver Detalle del Trámite
router.get('/tramite/:id', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err || !ticket) return res.status(404).send('No encontrado');
        
        if (req.session.user.role !== 'operador' && ticket.area !== req.session.user.area) {
            return res.status(403).send('Acceso denegado: El trámite no pertenece a tu área.');
        }
        
        db.all(`SELECT * FROM tickets WHERE dni = ? AND id != ? AND deleted_at IS NULL`, [ticket.dni, id], (errOtros, otrosTramites) => {
            db.all(`SELECT * FROM areas ORDER BY name`, [], (errAreas, areas) => {
                db.all(`SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY created_at DESC`, [id], (err2, history) => {
                    db.all(`SELECT * FROM attachments WHERE ticket_id = ?`, [id], (err3, attachments) => {
                        db.all(`SELECT * FROM quick_replies ORDER BY id`, [], (err4, quick_replies) => {
                            db.all(`SELECT id, name FROM users WHERE area = ?`, [ticket.area], (err5, employees) => {
                                db.all(`SELECT * FROM tags ORDER BY name`, [], (err6, allTags) => {
                                    db.all(`SELECT tag_id FROM ticket_tags WHERE ticket_id = ?`, [id], (err7, ticketTags) => {
                                        const assignedTagIds = ticketTags ? ticketTags.map(t => t.tag_id) : [];
                                        res.render('ticket-detail', { 
                                            title: 'Detalle de Trámite', ticket, history, attachments, 
                                            areas: areas || [], quick_replies: quick_replies || [], 
                                            employees: employees || [], allTags: allTags || [], assignedTagIds,
                                            otrosTramites: otrosTramites || [],
                                            user: req.session.user 
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

// Actualizar Estado / Área / Vencimiento / Notas
router.post('/tramite/:id', (req, res) => {
    const { id } = req.params;
    const { status, area, comments, expiration_date, notes } = req.body;
    const user = req.session.user;

    db.get(`SELECT * FROM tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err || !ticket) return res.status(404).send('Error');

        if (user.role !== 'operador' && ticket.area !== user.area) {
            return res.status(403).send('Acceso denegado: No tienes permisos para modificar este trámite.');
        }

        db.run(`UPDATE tickets SET status = ?, area = ?, expiration_date = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, 
               [status, area, expiration_date || null, notes || null, id], function(err2) {
            if (err2) return res.status(500).send('Error actualizando');

            // Log status update
            db.run(`INSERT INTO ticket_history (ticket_id, user_id, user_name, old_status, new_status, old_area, new_area, comments, type) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'historial')`, 
                    [id, user.id, user.name, ticket.status, status, ticket.area, area, comments]);

            // Log internal note if modified/added
            if (notes && notes !== ticket.notes) {
                db.run(`INSERT INTO ticket_history (ticket_id, user_id, user_name, old_status, new_status, old_area, new_area, comments, type) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'nota_interna')`, 
                        [id, user.id, user.name, status, status, area, area, notes]);
            }

            if (ticket.status !== status || status === 'Pendiente de Documentación' || (comments && comments.trim() !== '')) {
                sendStatusUpdateEmail(ticket.email, ticket.tracking_code, status, comments, expiration_date || ticket.expiration_date);
            }

            res.redirect(`/panel/tramite/${id}`);
        });
    });
});

// Asignar Empleado
router.post('/tramite/:id/asignar', (req, res) => {
    const { id } = req.params;
    const { assigned_to } = req.body;
    db.run(`UPDATE tickets SET assigned_to = ? WHERE id = ?`, [assigned_to || null, id], (err) => {
        res.redirect(`/panel/tramite/${id}`);
    });
});

// Agregar Tag
router.post('/tramite/:id/tags', (req, res) => {
    const { id } = req.params;
    const { tag_id } = req.body;
    if (!tag_id) return res.redirect(`/panel/tramite/${id}`);
    db.run(`INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?)`, [id, tag_id], (err) => {
        res.redirect(`/panel/tramite/${id}`);
    });
});

// Quitar Tag
router.post('/tramite/:id/tags/quitar', (req, res) => {
    const { id } = req.params;
    const { tag_id } = req.body;
    db.run(`DELETE FROM ticket_tags WHERE ticket_id = ? AND tag_id = ?`, [id, tag_id], (err) => {
        res.redirect(`/panel/tramite/${id}`);
    });
});

// ====== ACCIONES MASA ======
router.get('/exportar', (req, res) => {
    const ids = req.query.ids;
    if (!ids) return res.redirect('/panel');
    const idArray = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    if (idArray.length === 0) return res.redirect('/panel');

    const placeholders = idArray.map(() => '?').join(',');
    db.all(`SELECT * FROM tickets WHERE id IN (${placeholders})`, idArray, (err, tickets) => {
        if (err || !tickets) return res.redirect('/panel');

        let csv = 'Código,Nombre,DNI,Trámite,Estado,Fecha\n';
        tickets.forEach(t => {
            csv += `${t.tracking_code},"${t.first_name} ${t.last_name}",${t.dni},"${t.category}",${t.status},${moment(t.created_at).format('DD/MM/YYYY')}\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="exportacion.csv"');
        res.send(Buffer.from('\uFEFF' + csv)); // UTF-8 BOM
    });
});

router.post('/accion-masa', (req, res) => {
    const { ids, accion } = req.body;
    if (!ids || !accion) return res.redirect('/panel');
    const idArray = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    if (idArray.length === 0) return res.redirect('/panel');

    const placeholders = idArray.map(() => '?').join(',');
    
    db.run(`UPDATE tickets SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`, [accion, ...idArray], (err) => {
        idArray.forEach(id => {
            db.run(`INSERT INTO ticket_history (ticket_id, user_id, user_name, old_status, new_status, old_area, new_area, comments, type) 
                    VALUES (?, ?, ?, 'N/A', ?, 'N/A', 'N/A', ?, 'historial')`, 
                    [id, req.session.user.id, req.session.user.name, accion, 'Estado actualizado en masa']);
        });
        res.redirect('/panel');
    });
});

// ====== GESTIÓN DE USUARIOS (personal) ======
const ROLES_PERSONAL = ['operador', 'interno'];
const COLORES_ETIQUETA = ['red', 'yellow', 'blue'];   // los únicos colores que dibujan las vistas

const soloOperador = (req, res) => {
    if (req.session.user.role === 'operador') return true;
    res.status(403).send('Acceso denegado');
    return false;
};
// Vuelve a la pantalla con un mensaje (ok=... o error=...)
const volverA = (res, ruta, tipo, valor) => res.redirect(`${ruta}?${tipo}=${encodeURIComponent(valor)}`);
const texto = (v, max = 200) => String(v || '').trim().slice(0, max);

router.get('/usuarios', async (req, res) => {
    if (!soloOperador(req, res)) return;
    // Sólo personal: las cuentas de alumnos se administran desde el Padrón de Alumnos
    const [users, areas] = await Promise.all([
        dbp.all(`SELECT id, username, name, role, area FROM users WHERE role IN ('operador', 'interno') ORDER BY name`),
        dbp.all(`SELECT * FROM areas ORDER BY name`)
    ]);
    res.render('admin-users', { title: 'Gestión de Usuarios', user: req.session.user, users, areas, ok: req.query.ok || null, error: req.query.error || null });
});

const MSG_CLAVE = 'La contraseña debe tener al menos 6 caracteres.';

router.post('/usuarios/nuevo', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const name = texto(req.body.name), username = texto(req.body.username, 80), area = texto(req.body.area), role = req.body.role;
    const password = String(req.body.password || '');
    if (!name || !username || !area || !ROLES_PERSONAL.includes(role)) return volverA(res, '/panel/usuarios', 'error', 'Completá todos los campos.');
    if (password.length < 6) return volverA(res, '/panel/usuarios', 'error', MSG_CLAVE);
    if (await dbp.get(`SELECT 1 AS x FROM users WHERE username = ?`, [username])) return volverA(res, '/panel/usuarios', 'error', 'Ese nombre de usuario ya existe.');
    await dbp.run(`INSERT INTO users (name, username, password, area, role, activo) VALUES (?, ?, ?, ?, ?, 1)`,
        [name, username, await bcrypt.hash(password, 10), area, role]);
    res.redirect('/panel/usuarios?ok=creado');
});

const cantidadOperadores = async () => (await dbp.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'operador' AND activo = 1`)).n;

router.post('/usuarios/editar/:id', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const id = Number(req.params.id);
    const u = await dbp.get(`SELECT * FROM users WHERE id = ? AND role IN ('operador', 'interno')`, [id]);
    if (!u) return volverA(res, '/panel/usuarios', 'error', 'El usuario no existe.');

    const name = texto(req.body.name), username = texto(req.body.username, 80), area = texto(req.body.area), role = req.body.role;
    const password = String(req.body.password || '');   // vacía = no se cambia
    if (!name || !username || !area || !ROLES_PERSONAL.includes(role)) return volverA(res, '/panel/usuarios', 'error', 'Completá nombre, usuario, área y rol.');
    if (password && password.length < 6) return volverA(res, '/panel/usuarios', 'error', MSG_CLAVE);
    if (await dbp.get(`SELECT 1 AS x FROM users WHERE username = ? AND id != ?`, [username, id])) return volverA(res, '/panel/usuarios', 'error', 'Ese nombre de usuario ya existe.');
    // El sistema no puede quedarse sin quien lo administre
    if (u.role === 'operador' && role !== 'operador') {
        if (id === req.session.user.id) return volverA(res, '/panel/usuarios', 'error', 'No podés quitarte a vos mismo el rol de operador.');
        if (await cantidadOperadores() <= 1) return volverA(res, '/panel/usuarios', 'error', 'Tiene que quedar al menos un operador.');
    }

    if (password) {
        await dbp.run(`UPDATE users SET name = ?, username = ?, area = ?, role = ?, password = ? WHERE id = ?`, [name, username, area, role, await bcrypt.hash(password, 10), id]);
    } else {
        await dbp.run(`UPDATE users SET name = ?, username = ?, area = ?, role = ? WHERE id = ?`, [name, username, area, role, id]);
    }
    // Si se editó a sí mismo, se refleja en la sesión abierta
    if (id === req.session.user.id) Object.assign(req.session.user, { name, username, area, role });
    res.redirect('/panel/usuarios?ok=guardado');
});

router.post('/usuarios/eliminar/:id', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const id = Number(req.params.id);
    if (id === req.session.user.id) return volverA(res, '/panel/usuarios', 'error', 'No podés eliminar tu propio usuario.');
    const u = await dbp.get(`SELECT id, role FROM users WHERE id = ? AND role IN ('operador', 'interno')`, [id]);
    if (!u) return volverA(res, '/panel/usuarios', 'error', 'El usuario no existe.');
    if (u.role === 'operador' && await cantidadOperadores() <= 1) return volverA(res, '/panel/usuarios', 'error', 'Tiene que quedar al menos un operador.');
    await dbp.run(`DELETE FROM users WHERE id = ?`, [id]);
    res.redirect('/panel/usuarios?ok=eliminado');
});

// ====== CONFIGURACIÓN ======
router.get('/config', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const [configRows, areas, quick_replies, tags] = await Promise.all([
        dbp.all(`SELECT * FROM config`),
        // "usos" = expedientes y usuarios que usan el área (si se usa, no se puede borrar)
        dbp.all(`SELECT a.*, (SELECT COUNT(*) FROM tickets t WHERE t.area = a.name) + (SELECT COUNT(*) FROM users u WHERE u.area = a.name) AS usos
            FROM areas a ORDER BY a.name`),
        dbp.all(`SELECT * FROM quick_replies ORDER BY id`),
        dbp.all(`SELECT g.*, (SELECT COUNT(*) FROM ticket_tags tt WHERE tt.tag_id = g.id) AS usos FROM tags g ORDER BY g.name`)
    ]);
    const config = {};
    configRows.forEach(row => { config[row.key] = row.value; });
    res.render('admin-config', { title: 'Configuración', user: req.session.user, config, areas, quick_replies, tags, ok: req.query.ok || null, error: req.query.error || null });
});

router.post('/config/quick-replies/nuevo', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const title = texto(req.body.title, 80), content = texto(req.body.content, 1000);
    if (!title || !content) return volverA(res, '/panel/config', 'error', 'La respuesta rápida necesita título y contenido.');
    await dbp.run(`INSERT INTO quick_replies (title, content) VALUES (?, ?)`, [title, content]);
    res.redirect('/panel/config?ok=respuesta_creada');
});

router.post('/config/quick-replies/editar/:id', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const title = texto(req.body.title, 80), content = texto(req.body.content, 1000);
    if (!title || !content) return volverA(res, '/panel/config', 'error', 'La respuesta rápida necesita título y contenido.');
    await dbp.run(`UPDATE quick_replies SET title = ?, content = ? WHERE id = ?`, [title, content, req.params.id]);
    res.redirect('/panel/config?ok=respuesta_guardada');
});

router.post('/config/quick-replies/eliminar/:id', async (req, res) => {
    if (!soloOperador(req, res)) return;
    await dbp.run(`DELETE FROM quick_replies WHERE id = ?`, [req.params.id]);
    res.redirect('/panel/config?ok=respuesta_eliminada');
});

router.post('/config/smtp', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    const { smtp_host, smtp_port, smtp_user, smtp_pass } = req.body;

    const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
    stmt.run("smtp_host", smtp_host);
    stmt.run("smtp_port", smtp_port);
    stmt.run("smtp_user", smtp_user);
    stmt.run("smtp_pass", smtp_pass);
    stmt.finalize(() => {
        res.redirect('/panel/config');
    });
});

router.post('/config/general', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    const { welcome_message } = req.body;

    const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
    stmt.run("welcome_message", welcome_message);
    stmt.finalize(() => {
        res.redirect('/panel/config');
    });
});

router.post('/config/anuncio', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    const { public_announcement, announcement_type } = req.body;

    const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
    stmt.run("public_announcement", public_announcement);
    stmt.run("announcement_type", announcement_type);
    stmt.finalize(() => {
        res.redirect('/panel/config');
    });
});

// "Mesa de Entrada" es el área por defecto de todo expediente nuevo: ni se renombra ni se borra
const AREA_FIJA = 'Mesa de Entrada';

router.post('/config/areas', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const nombre = texto(req.body.new_area, 100);
    if (!nombre) return volverA(res, '/panel/config', 'error', 'Escribí el nombre del área.');
    if (await dbp.get(`SELECT 1 AS x FROM areas WHERE name = ?`, [nombre])) return volverA(res, '/panel/config', 'error', 'Ya existe un área con ese nombre.');
    await dbp.run(`INSERT INTO areas (name) VALUES (?)`, [nombre]);
    res.redirect('/panel/config?ok=area_creada');
});

// Renombrar un área también actualiza los expedientes y usuarios que la usan (se guardan por nombre)
router.post('/config/areas/editar/:id', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const nombre = texto(req.body.name, 100);
    const area = await dbp.get(`SELECT * FROM areas WHERE id = ?`, [req.params.id]);
    if (!area) return volverA(res, '/panel/config', 'error', 'El área no existe.');
    if (area.name === AREA_FIJA) return volverA(res, '/panel/config', 'error', 'El área "Mesa de Entrada" no se puede renombrar.');
    if (!nombre) return volverA(res, '/panel/config', 'error', 'Escribí el nombre del área.');
    if (await dbp.get(`SELECT 1 AS x FROM areas WHERE name = ? AND id != ?`, [nombre, area.id])) return volverA(res, '/panel/config', 'error', 'Ya existe un área con ese nombre.');
    await dbp.run(`UPDATE areas SET name = ? WHERE id = ?`, [nombre, area.id]);
    await dbp.run(`UPDATE tickets SET area = ? WHERE area = ?`, [nombre, area.name]);
    await dbp.run(`UPDATE users SET area = ? WHERE area = ?`, [nombre, area.name]);
    res.redirect('/panel/config?ok=area_guardada');
});

router.post('/config/areas/eliminar/:id', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const area = await dbp.get(`SELECT * FROM areas WHERE id = ?`, [req.params.id]);
    if (!area) return volverA(res, '/panel/config', 'error', 'El área no existe.');
    if (area.name === AREA_FIJA) return volverA(res, '/panel/config', 'error', 'El área "Mesa de Entrada" no se puede eliminar.');
    const uso = await dbp.get(`SELECT (SELECT COUNT(*) FROM tickets WHERE area = ?) + (SELECT COUNT(*) FROM users WHERE area = ?) AS n`, [area.name, area.name]);
    if (uso.n > 0) return volverA(res, '/panel/config', 'error', `No se puede eliminar: hay ${uso.n} expediente(s) o usuario(s) en esa área. Derivalos a otra antes.`);
    await dbp.run(`DELETE FROM areas WHERE id = ?`, [area.id]);
    res.redirect('/panel/config?ok=area_eliminada');
});

// Etiquetas de los expedientes
router.post('/config/tags/nuevo', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const name = texto(req.body.name, 40), color = COLORES_ETIQUETA.includes(req.body.color) ? req.body.color : 'blue';
    if (!name) return volverA(res, '/panel/config', 'error', 'Escribí el nombre de la etiqueta.');
    await dbp.run(`INSERT INTO tags (name, color) VALUES (?, ?)`, [name, color]);
    res.redirect('/panel/config?ok=etiqueta_creada');
});

router.post('/config/tags/editar/:id', async (req, res) => {
    if (!soloOperador(req, res)) return;
    const name = texto(req.body.name, 40), color = COLORES_ETIQUETA.includes(req.body.color) ? req.body.color : 'blue';
    if (!name) return volverA(res, '/panel/config', 'error', 'Escribí el nombre de la etiqueta.');
    await dbp.run(`UPDATE tags SET name = ?, color = ? WHERE id = ?`, [name, color, req.params.id]);
    res.redirect('/panel/config?ok=etiqueta_guardada');
});

// Borrar una etiqueta la quita también de los expedientes que la tenían
router.post('/config/tags/eliminar/:id', async (req, res) => {
    if (!soloOperador(req, res)) return;
    await dbp.run(`DELETE FROM ticket_tags WHERE tag_id = ?`, [req.params.id]);
    await dbp.run(`DELETE FROM tags WHERE id = ?`, [req.params.id]);
    res.redirect('/panel/config?ok=etiqueta_eliminada');
});

// ====== PAPELERA ======
router.get('/papelera', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.all(`SELECT * FROM tickets WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`, [], (err, tickets) => {
        if (err) return res.status(500).send("Error");
        res.render('admin-trash', { title: 'Papelera', user: req.session.user, tickets });
    });
});

router.post('/papelera/restaurar/:id', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.run(`UPDATE tickets SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id], (err) => {
        res.redirect('/panel/papelera');
    });
});

router.post('/tramite/eliminar/:id', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.run(`UPDATE tickets SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id], (err) => {
        res.redirect('/panel');
    });
});

// Generar PDF Comprobante
router.get('/comprobante/:id', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM tickets WHERE id = ?`, [id], async (err, ticket) => {
        if (err || !ticket) return res.status(404).send('No encontrado');

        let qrBuffer;
        try {
            qrBuffer = await QRCode.toBuffer(`https://tramites.pusap.edu.ar/seguimiento?codigo=${ticket.tracking_code}`);
        } catch (e) {}

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-disposition', `attachment; filename="Talón_Recepción_${ticket.tracking_code}.pdf"`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);
        // Header con fondo azul
        doc.rect(0, 0, 612, 100).fill('#1e3a8a');
        doc.fillColor('white').fontSize(24).font('Helvetica-Bold').text('PUSAP', 50, 25);
        doc.fontSize(11).font('Helvetica').text('Centro Universitario — Mesa de Entrada Virtual', 50, 55);
        doc.fillColor('black').fontSize(13).font('Helvetica-Bold').text('TALÓN DE RECEPCIÓN DE TRÁMITE', { align: 'center', y: 120 });

        // Código destacado
        doc.fillColor('#1e3a8a').rect(50, 150, 512, 50).stroke();
        doc.fillColor('#1e3a8a').fontSize(10).text('CÓDIGO DE SEGUIMIENTO', 60, 158);
        doc.fillColor('#1e3a8a').fontSize(22).font('Helvetica-Bold').text(ticket.tracking_code, { align: 'center', y: 165 });
        
        if (qrBuffer) {
            doc.image(qrBuffer, 490, 140, { width: 65 });
        }

        // Details
        doc.fillColor('black');
        doc.fontSize(12).font('Helvetica-Bold').text('Datos del Trámite:', 50, 230);
        doc.moveDown();
        doc.font('Helvetica').text(`Fecha de Ingreso: ${moment.utc(ticket.created_at).local().format('DD/MM/YYYY HH:mm')}`);
        doc.text(`Solicitante: ${ticket.first_name} ${ticket.last_name}`);
        doc.text(`DNI: ${ticket.dni}`);
        doc.text(`Tipo de Trámite: ${ticket.category}`);
        if (ticket.priority && ticket.priority === 'urgente') {
            doc.fillColor('#dc2626').rect(450, 150, 112, 25).fill();
            doc.fillColor('white').fontSize(11).font('Helvetica-Bold').text('⚠ URGENTE', 455, 157);
        } else if (ticket.priority && ticket.priority !== 'normal') {
            doc.fillColor('black').text(`Prioridad: ${ticket.priority.toUpperCase()}`);
        }
        if (ticket.expiration_date) {
            doc.fillColor('black').text(`Fecha de Vencimiento: ${moment(ticket.expiration_date).format('DD/MM/YYYY')}`);
        }
        
        doc.fillColor('black');
        doc.moveDown(2);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown();
        doc.fillColor('#64748b').fontSize(9).font('Helvetica-Oblique').text('Importante: Conserve este código. Para conocer el estado de su trámite consulte en Mesa de Entrada con este código, o ingrese al portal del alumno.', { align: 'justify' });

        doc.end();
    });
});

// ====== REPORTE ESTADÍSTICO MENSUAL ======
router.get('/reporte-mensual', (req, res) => {
    const user = req.session.user;
    
    // Filtros: solo mes actual
    let whereClause = `WHERE deleted_at IS NULL AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`;
    let params = [];

    if (user.role !== 'operador') {
        whereClause += ` AND area = ?`;
        params.push(user.area);
    }

    db.get(`SELECT COUNT(*) as total FROM tickets ${whereClause}`, params, (err, rowTotal) => {
        if (err) return res.status(500).send("Error de DB");

        db.all(`SELECT area, COUNT(*) as count FROM tickets ${whereClause} GROUP BY area`, params, (err, rowsArea) => {
            if (err) return res.status(500).send("Error de DB");

            db.all(`SELECT status, COUNT(*) as count FROM tickets ${whereClause} GROUP BY status`, params, (err, rowsStatus) => {
                if (err) return res.status(500).send("Error de DB");

                const doc = new PDFDocument({ margin: 50 });
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', 'attachment; filename="reporte.pdf"');
                doc.pipe(res);

                doc.fontSize(20).font('Helvetica-Bold').text('Reporte de Gestión Mensual - PUSAP', { align: 'center' });
                doc.moveDown();
                doc.fontSize(12).font('Helvetica').text(`Fecha actual: ${moment().format('DD/MM/YYYY')}`, { align: 'center' });
                doc.moveDown(2);

                doc.fontSize(14).font('Helvetica-Bold').text('Métricas Resumidas');
                doc.moveDown(0.5);
                doc.fontSize(12).font('Helvetica').text(`Total de trámites creados este mes: ${rowTotal.total}`);
                doc.moveDown(1.5);

                doc.fontSize(14).font('Helvetica-Bold').text('Agrupado por Área');
                doc.moveDown(0.5);
                if (rowsArea && rowsArea.length > 0) {
                    rowsArea.forEach(r => {
                        doc.fontSize(12).font('Helvetica').text(`• ${r.area}: ${r.count}`);
                    });
                } else {
                    doc.fontSize(12).font('Helvetica-Oblique').text('Sin datos');
                }
                doc.moveDown(1.5);

                doc.fontSize(14).font('Helvetica-Bold').text('Agrupado por Estado');
                doc.moveDown(0.5);
                if (rowsStatus && rowsStatus.length > 0) {
                    rowsStatus.forEach(r => {
                        doc.fontSize(12).font('Helvetica').text(`• ${r.status}: ${r.count}`);
                    });
                } else {
                    doc.fontSize(12).font('Helvetica-Oblique').text('Sin datos');
                }

                doc.end();
            });
        });
    });
});

// ====== EXPORTACIÓN CSV PARA EXCEL ======
router.get('/exportar-csv', (req, res) => {
    const user = req.session.user;
    let whereClause = `WHERE deleted_at IS NULL`;
    let params = [];

    if (user.role !== 'operador') {
        whereClause += ` AND area = ?`;
        params.push(user.area);
    }

    db.all(`SELECT tracking_code, first_name, last_name, dni, email, phone, category, status, area, priority, expiration_date, created_at
            FROM tickets ${whereClause} ORDER BY created_at DESC`, params, (err, rows) => {
        if (err) return res.status(500).send("Error generando exportación.");

        let csv = '\uFEFF'; // BOM UTF-8 para Excel
        csv += 'Código;Nombre;Apellido;DNI;Email;Teléfono;Trámite;Estado;Área;Prioridad;Fecha Vencimiento;Fecha Creación\r\n';

        if (rows && rows.length > 0) {
            rows.forEach(r => {
                const fila = [
                    r.tracking_code || '',
                    r.first_name || '',
                    r.last_name || '',
                    r.dni || '',
                    r.email || '',
                    r.phone || '',
                    r.category || '',
                    r.status || '',
                    r.area || '',
                    r.priority || '',
                    r.expiration_date ? moment(r.expiration_date).format('DD/MM/YYYY') : '',
                    moment.utc(r.created_at).local().format('DD/MM/YYYY HH:mm')
                ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';');
                csv += fila + '\r\n';
            });
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="expedientes_pusap_${moment().format('YYYYMMDD_HHmm')}.csv"`);
        res.send(csv);
    });
});

module.exports = router;
