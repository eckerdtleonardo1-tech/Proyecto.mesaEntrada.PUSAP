const express = require('express');
const router = express.Router();
const multer = require('multer');
const PDFDocument = require('pdfkit');
const moment = require('moment');
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
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\\s+/g, '_'))
});
const upload = multer({ storage });

// Generador de Códigos
const generateTrackingCode = () => 'PUSAP-' + Math.random().toString(36).substr(2, 6).toUpperCase();

// Dashboard (Estadísticas y Tabla)
router.get('/', (req, res) => {
    const user = req.session.user;
    let query = `SELECT * FROM tickets`;
    let params = [];
    
    // Si no es operador general de Mesa de Entrada, solo ve los de su área
    if (user.role !== 'operador') {
        query += ` WHERE area = ?`;
        params.push(user.area);
    }
    query += ` ORDER BY created_at DESC`;

    db.all(query, params, (err, tickets) => {
        if (err) return res.status(500).send("Error");
        
        // Calcular estadísticas
        const stats = {
            total: tickets.length,
            iniciados: tickets.filter(t => t.status === 'Iniciado').length,
            en_revision: tickets.filter(t => t.status === 'En Revisión').length,
            pendientes_doc: tickets.filter(t => t.status === 'Pendiente de Documentación').length,
            aprobados: tickets.filter(t => t.status === 'Aprobado').length,
            rechazados: tickets.filter(t => t.status === 'Rechazado').length,
            por_vencer: tickets.filter(t => t.expiration_date && moment(t.expiration_date).diff(moment(), 'days') <= 7 && !['Aprobado', 'Rechazado'].includes(t.status)).length
        };

        const success_ticket = req.query.success_ticket || null;

        res.render('dashboard', { title: 'Panel de Gestión', tickets, stats, user, success_ticket });
    });
});

// Formulario de Alta de Trámite
router.get('/nuevo', (req, res) => {
    res.render('new-ticket', { title: 'Nuevo Trámite', user: req.session.user });
});

// Procesar Alta
router.post('/nuevo', requireAuth, upload.array('attachments', 10), (req, res) => {
    let { first_name, last_name, dni, cuil, phone, email, category, expiration_date } = req.body;
    const user = req.session.user;
    
    // Generar tracking code único
    const tracking_code = 'PUSAP-' + Math.random().toString(36).substr(2, 6).toUpperCase();

    // Si el operador no pone fecha, forzar 1 semana (7 días) por defecto
    if (!expiration_date) {
        expiration_date = moment().add(7, 'days').format('YYYY-MM-DD');
    }

    const query = `INSERT INTO tickets (tracking_code, first_name, last_name, dni, cuil, phone, email, category, status, area, expiration_date) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Iniciado', 'Mesa de Entrada', ?)`;
    
    db.run(query, [tracking_code, first_name, last_name, dni, cuil, phone, email, category, expiration_date], function(err) {
        if (err) return res.status(500).send(err.message);
        const ticketId = this.lastID;

        // Insertar Auditoría
        db.run(`INSERT INTO ticket_history (ticket_id, user_id, user_name, old_status, new_status, old_area, new_area, comments) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                [ticketId, user.id, user.name, 'N/A', 'Iniciado', 'N/A', 'Mesa de Entrada', 'Trámite ingresado al sistema.']);

        // Insertar Adjuntos
        if (req.files && req.files.length > 0) {
            const stmt = db.prepare(`INSERT INTO attachments (ticket_id, filename, original_name) VALUES (?, ?, ?)`);
            req.files.forEach(file => {
                stmt.run(ticketId, file.filename, file.originalname);
            });
            stmt.finalize();
        }

        // Enviar email de bienvenida al alumno
        sendTicketCreatedEmail(email, first_name, tracking_code);

        res.redirect(`/panel?success_ticket=${ticketId}`);
    });
});

// Ver Detalle del Trámite
router.get('/tramite/:id', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err || !ticket) return res.status(404).send('No encontrado');
        
        db.all(`SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY created_at DESC`, [id], (err2, history) => {
            db.all(`SELECT * FROM attachments WHERE ticket_id = ?`, [id], (err3, attachments) => {
                res.render('ticket-detail', { title: 'Detalle de Trámite', ticket, history, attachments, user: req.session.user });
            });
        });
    });
});

// Actualizar Estado / Área / Vencimiento
router.post('/tramite/:id', (req, res) => {
    const { id } = req.params;
    const { status, area, comments, expiration_date } = req.body;
    const user = req.session.user;

    db.get(`SELECT * FROM tickets WHERE id = ?`, [id], (err, ticket) => {
        if (err || !ticket) return res.status(404).send('Error');

        db.run(`UPDATE tickets SET status = ?, area = ?, expiration_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, 
               [status, area, expiration_date || null, id], function(err2) {
            if (err2) return res.status(500).send('Error actualizando');

            // Historial
            db.run(`INSERT INTO ticket_history (ticket_id, user_id, user_name, old_status, new_status, old_area, new_area, comments) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                    [id, user.id, user.name, ticket.status, status, ticket.area, area, comments]);

            // Enviar Email si cambió el estado o el comentario
            if (ticket.status !== status || status === 'Pendiente de Documentación' || comments.trim() !== '') {
                sendStatusUpdateEmail(ticket.email, ticket.tracking_code, status, comments, expiration_date || ticket.expiration_date);
            }

            res.redirect(`/panel/tramite/${id}`);
        });
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

        // Header
        doc.fontSize(20).text('Centro Universitario PUSAP', { align: 'center' });
        doc.fontSize(14).text('Talón de Recepción de Trámite', { align: 'center' });
        doc.moveDown();
        doc.moveTo(50, 110).lineTo(550, 110).stroke();
        doc.moveDown(2);

        // Details
        doc.fontSize(12).font('Helvetica-Bold').text(`Código de Seguimiento: ${ticket.tracking_code}`);
        doc.moveDown();
        doc.font('Helvetica').text(`Fecha de Ingreso: ${moment.utc(ticket.created_at).local().format('DD/MM/YYYY HH:mm')}`);
        doc.text(`Solicitante: ${ticket.first_name} ${ticket.last_name}`);
        doc.text(`DNI: ${ticket.dni}`);
        doc.text(`Tipo de Trámite: ${ticket.category}`);
        if (ticket.expiration_date) {
            doc.text(`Fecha de Vencimiento: ${moment(ticket.expiration_date).format('DD/MM/YYYY')}`);
        }
        
        doc.moveDown(2);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown();
        doc.font('Helvetica-Oblique').text('Importante: Conserve este código. Puede consultar el estado de su trámite ingresando a nuestro portal web con su DNI y este código de seguimiento.', { align: 'justify' });

        doc.end();
    });
});

module.exports = router;
