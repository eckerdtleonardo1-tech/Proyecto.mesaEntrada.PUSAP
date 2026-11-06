const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const moment = require('moment');
const QRCode = require('qrcode');
const db = require('../db');
const dbp = require('../lib/dbp');

/**
 * Cara PÚBLICA: sólo informa (oferta académica, ventajas, contacto).
 * Nadie inicia ni consulta trámites sin ingresar: eso vive en /alumno.
 */

router.get('/', async (req, res) => {
    try {
        const [cfgRows, novedades, faqs, carreras, ventajas] = await Promise.all([
            dbp.all("SELECT key, value FROM config WHERE key IN ('welcome_message', 'public_announcement', 'announcement_type')"),
            dbp.all("SELECT * FROM novedades WHERE activo = 1 AND audiencia IN ('publico', 'ambos') ORDER BY destacada DESC, fecha_publicacion DESC LIMIT 6"),
            dbp.all("SELECT * FROM faqs WHERE activo = 1 AND audiencia IN ('publico', 'ambos') ORDER BY orden, categoria"),
            dbp.all("SELECT * FROM carreras WHERE activo = 1 ORDER BY orden, nombre LIMIT 4"),
            dbp.all("SELECT * FROM ventajas WHERE activo = 1 ORDER BY orden, id")
        ]);

        const cfg = {};
        cfgRows.forEach(r => { cfg[r.key] = r.value; });

        res.render('index', {
            title: 'Inicio - PUSAP',
            welcome_message: cfg.welcome_message || null,
            announcement: cfg.public_announcement || null,
            announcement_type: cfg.announcement_type || 'amber',
            novedades,
            faqs,
            carreras,
            ventajas,
            moment
        });
    } catch (err) {
        console.error('Error cargando el home público:', err.message);
        res.status(500).render('errors/500', { title: 'Error', user: req.session.user || null });
    }
});

// GET: Oferta Académica (Carreras y Cursos)
router.get('/carreras', (req, res) => {
    db.all("SELECT * FROM carreras WHERE activo = 1 ORDER BY orden, nombre", [], (err, carreras) => {
        if (err) return res.status(500).render('errors/500', { title: 'Error', user: req.session.user });
        res.render('carreras', {
            title: 'Oferta Académica - PUSAP',
            carreras: carreras || [],
            tipoFiltro: req.query.tipo || 'todas'
        });
    });
});

// GET: Contacto e información institucional (los datos salen de res.locals.contenido)
router.get('/contacto', (req, res) => {
    res.render('contacto', {
        title: 'Contacto y Atención - PUSAP'
    });
});

// Rutas de la versión anterior: iniciar y seguir trámites ya no es público.
// Se redirigen (en vez de 404) para no romper enlaces viejos, correos o marcadores.
const haciaElPortal = (destinoAlumno) => (req, res) => {
    const u = req.session.user;
    if (u && u.role === 'alumno') return res.redirect(destinoAlumno);
    if (u) return res.redirect('/backoffice');
    res.redirect('/ingresar');
};
router.all('/nuevo-tramite', haciaElPortal('/alumno/solicitudes/nueva'));
router.all('/seguimiento', haciaElPortal('/alumno/solicitudes'));

// Generar PDF Comprobante Público (Solo con Tracking Code)
// Se mantiene sólo para los expedientes históricos que ya entregaron este código.
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
        doc.fillColor('#64748b').fontSize(9).font('Helvetica-Oblique').text('Importante: Conserve este código. Para conocer el estado de su trámite consulte en Mesa de Entrada con este código, o ingrese al portal del alumno.', { align: 'justify' });

        doc.end();
    });
});

module.exports = router;
