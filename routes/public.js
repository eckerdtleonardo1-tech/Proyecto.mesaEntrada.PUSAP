const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const moment = require('moment');
const db = require('../db');
const { sendTicketCreatedEmail } = require('../mailer');

// Prevención de SPAM: Máximo 3 trámites por IP cada 1 hora
const apiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 3, 
    message: 'Has superado el límite de trámites permitidos. Por favor, intenta más tarde.'
});

// Configuración de Multer para archivos públicos
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-public-' + file.originalname.replace(/\\s+/g, '_'))
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // Límite de 5MB por archivo para no llenar el disco
});

const generateTrackingCode = () => 'PUSAP-' + Math.random().toString(36).substr(2, 6).toUpperCase();

router.get('/', (req, res) => {
    res.render('index', { title: 'Inicio - PUSAP' });
});

// GET: Formulario público de nuevo trámite
router.get('/nuevo-tramite', (req, res) => {
    res.render('public-new-ticket', { title: 'Iniciar Trámite', success: false });
});

// POST: Procesar alta pública de trámite
router.post('/nuevo-tramite', apiLimiter, upload.array('attachments', 10), (req, res) => {
    const { first_name, last_name, dni, cuil, phone, email, category } = req.body;
    const tracking_code = generateTrackingCode();

    // Fecha por defecto: 1 semana a partir de hoy
    const expiration_date = moment().add(7, 'days').format('YYYY-MM-DD');

    const query = `INSERT INTO tickets (tracking_code, first_name, last_name, dni, cuil, phone, email, category, status, area, expiration_date) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Iniciado', 'Mesa de Entrada', ?)`;
    
    db.run(query, [tracking_code, first_name, last_name, dni, cuil, phone, email, category, expiration_date], function(err) {
        if (err) return res.status(500).send("Error al guardar: " + err.message);
        const ticketId = this.lastID;

        // Historial automático de sistema
        db.run(`INSERT INTO ticket_history (ticket_id, user_id, user_name, old_status, new_status, old_area, new_area, comments) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                [ticketId, 0, 'Sistema Web', 'N/A', 'Iniciado', 'N/A', 'Mesa de Entrada', 'Trámite ingresado por el alumno vía web.']);

        // Insertar adjuntos
        if (req.files && req.files.length > 0) {
            const stmt = db.prepare(`INSERT INTO attachments (ticket_id, filename, original_name) VALUES (?, ?, ?)`);
            req.files.forEach(file => {
                stmt.run(ticketId, file.filename, file.originalname);
            });
            stmt.finalize();
        }

        // Enviar email de bienvenida al alumno
        sendTicketCreatedEmail(email, first_name, tracking_code);

        res.render('public-new-ticket', { title: 'Trámite Exitoso', success: true, tracking_code });
    });
});

router.get('/seguimiento', (req, res) => {
    res.render('tracking', { title: 'Seguimiento de Trámite', ticket: null, error: null });
});

router.post('/seguimiento', (req, res) => {
    const { tracking_code, dni } = req.body;
    db.get(`SELECT * FROM tickets WHERE tracking_code = ? AND dni = ?`, [tracking_code.trim(), dni.trim()], (err, row) => {
        if (err || !row) {
            return res.render('tracking', { title: 'Seguimiento de Trámite', ticket: null, error: 'No se encontró ningún trámite con ese código y DNI.' });
        }
        res.render('tracking', { title: 'Seguimiento de Trámite', ticket: row, error: null });
    });
});

// Generar PDF Comprobante Público (Solo con Tracking Code)
router.get('/comprobante/:tracking_code', (req, res) => {
    const { tracking_code } = req.params;
    db.get(`SELECT * FROM tickets WHERE tracking_code = ?`, [tracking_code], (err, ticket) => {
        if (err || !ticket) return res.status(404).send('Comprobante no encontrado');

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-disposition', `attachment; filename="Talon_Recepcion_${ticket.tracking_code}.pdf"`);
        res.setHeader('Content-type', 'application/pdf');
        doc.pipe(res);

        // Header
        doc.fontSize(20).text('Centro Universitario PUSAP', { align: 'center' });
        doc.fontSize(14).text('Talón de Recepción de Trámite (Web)', { align: 'center' });
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
        
        doc.moveDown(2);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown();
        doc.font('Helvetica-Oblique').text('Importante: Conserve este código. Puede consultar el estado de su trámite ingresando a nuestro portal web con su DNI y este código de seguimiento.', { align: 'justify' });

        doc.end();
    });
});

module.exports = router;
