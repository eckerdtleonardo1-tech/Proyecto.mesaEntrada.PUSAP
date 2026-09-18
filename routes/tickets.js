const express = require('express');
const router = express.Router();
const multer = require('multer');
const PDFDocument = require('pdfkit');
const moment = require('moment');
const bcrypt = require('bcryptjs');
const db = require('../db');
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
    
    let statsQuery = `SELECT status, expiration_date, created_at FROM tickets`;
    let statsParams = [];
    if (user.role !== 'operador') {
        statsQuery += ` WHERE area = ?`;
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

        let whereClauses = [];
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

                const success_ticket = req.query.success_ticket || null;

                res.render('dashboard', { 
                    title: 'Panel de Gestión', 
                    tickets, 
                    stats, 
                    weeklyActivity, 
                    areaDistribution,
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

// API: Stats para Auto-refresh
router.get('/api/stats', (req, res) => {
    const user = req.session.user;
    let query = `SELECT * FROM tickets`;
    let params = [];
    if (user.role !== 'operador') {
        query += ` WHERE area = ?`;
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
    db.all(`SELECT id, category, status, created_at FROM tickets WHERE dni = ? ORDER BY created_at DESC LIMIT 5`, [dni], (err, rows) => {
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
        
        db.all(`SELECT * FROM areas ORDER BY name`, [], (errAreas, areas) => {
            db.all(`SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY created_at DESC`, [id], (err2, history) => {
                db.all(`SELECT * FROM attachments WHERE ticket_id = ?`, [id], (err3, attachments) => {
                    db.all(`SELECT * FROM quick_replies ORDER BY id`, [], (err4, quick_replies) => {
                        res.render('ticket-detail', { title: 'Detalle de Trámite', ticket, history, attachments, areas: areas || [], quick_replies: quick_replies || [], user: req.session.user });
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

// ====== GESTIÓN DE USUARIOS ======
router.get('/usuarios', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.all("SELECT id, username, name, role, area FROM users ORDER BY name", [], (err, users) => {
        db.all("SELECT * FROM areas ORDER BY name", [], (err2, areas) => {
            res.render('admin-users', { title: 'Gestión de Usuarios', user: req.session.user, users, areas: areas || [] });
        });
    });
});

router.post('/usuarios/nuevo', async (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    const { name, username, password, area, role } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (name, username, password, area, role) VALUES (?, ?, ?, ?, ?)", [name, username, hashed, area, role], (err) => {
        res.redirect('/panel/usuarios');
    });
});

router.post('/usuarios/eliminar/:id', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.run("DELETE FROM users WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/panel/usuarios');
    });
});

// ====== CONFIGURACIÓN ======
router.get('/config', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.all("SELECT * FROM config", [], (err, configRows) => {
        const config = {};
        if (configRows) {
            configRows.forEach(row => config[row.key] = row.value);
        }
        db.all("SELECT * FROM areas ORDER BY name", [], (err2, areas) => {
            db.all("SELECT * FROM quick_replies ORDER BY id", [], (err3, quick_replies) => {
                res.render('admin-config', { title: 'Configuración', user: req.session.user, config, areas: areas || [], quick_replies: quick_replies || [] });
            });
        });
    });
});

router.post('/config/quick-replies/nuevo', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    const { title, content } = req.body;
    db.run("INSERT INTO quick_replies (title, content) VALUES (?, ?)", [title, content], (err) => {
        res.redirect('/panel/config');
    });
});

router.post('/config/quick-replies/eliminar/:id', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.run("DELETE FROM quick_replies WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/panel/config');
    });
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

router.post('/config/areas', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    const { new_area } = req.body;
    db.run("INSERT INTO areas (name) VALUES (?)", [new_area], (err) => {
        res.redirect('/panel/config');
    });
});

router.post('/config/areas/eliminar/:id', (req, res) => {
    if (req.session.user.role !== 'operador') return res.status(403).send('Acceso denegado');
    db.run("DELETE FROM areas WHERE id = ?", [req.params.id], (err) => {
        res.redirect('/panel/config');
    });
});

// Generar PDF Comprobante
router.get('/comprobante/:id', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err || !ticket) return res.status(404).send('No encontrado');

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
        doc.fillColor('#64748b').fontSize(9).font('Helvetica-Oblique').text('Importante: Conserve este código. Puede consultar el estado de su trámite ingresando a nuestro portal web con su DNI y este código de seguimiento.', { align: 'justify' });

        doc.end();
    });
});

module.exports = router;
