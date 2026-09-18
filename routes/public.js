const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const moment = require('moment');
const db = require('../db');
const QRCode = require('qrcode');
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
    filename: (req, file, cb) => cb(null, Date.now() + '-public-' + file.originalname.replace(/\s+/g, '_'))
});

const fileFilter = (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de archivo no permitido. Solo PDF, JPG y PNG.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 } // Límite de 5MB por archivo para no llenar el disco
});

const generateTrackingCode = () => 'PUSAP-' + Math.random().toString(36).substr(2, 6).toUpperCase();

router.get('/', (req, res) => {
    db.get("SELECT value FROM config WHERE key = 'welcome_message'", [], (err, row) => {
        const welcome_message = row ? row.value : null;
        res.render('index', { title: 'Inicio - PUSAP', welcome_message });
    });
});

// GET: Formulario público de nuevo trámite
router.get('/nuevo-tramite', (req, res) => {
    res.render('public-new-ticket', { title: 'Iniciar Trámite', success: false });
});

// POST: Procesar alta pública de trámite
router.post('/nuevo-tramite', apiLimiter, upload.array('attachments', 10), (req, res) => {
    const { first_name, last_name, dni, cuil, phone, email, category, student_notes } = req.body;
    const tracking_code = generateTrackingCode();

    // Fecha por defecto: 1 semana a partir de hoy
    const expiration_date = moment().add(7, 'days').format('YYYY-MM-DD');

    const query = `INSERT INTO tickets (tracking_code, first_name, last_name, dni, cuil, phone, email, category, status, area, expiration_date, student_notes) 
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Iniciado', 'Mesa de Entrada', ?, ?)`;
    
    db.run(query, [tracking_code, first_name, last_name, dni, cuil, phone, email, category, expiration_date, student_notes], function(err) {
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
    db.get(`SELECT * FROM tickets WHERE tracking_code = ?`, [tracking_code], async (err, ticket) => {
        if (err || !ticket) return res.status(404).send('Comprobante no encontrado');

        let qrBuffer;
        try {
            qrBuffer = await QRCode.toBuffer(`https://tramites.pusap.edu.ar/seguimiento?codigo=${ticket.tracking_code}`);
        } catch (e) {}

        const doc = new PDFDocument({ margin: 50 });
        res.setHeader('Content-disposition', `attachment; filename="Talon_Recepcion_${ticket.tracking_code}.pdf"`);
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
