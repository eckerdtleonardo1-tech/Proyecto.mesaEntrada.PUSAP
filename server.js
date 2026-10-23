require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Archivos públicos (CSS, fonts, iconos, SW, manifest)
app.use(express.static(path.join(__dirname, 'public')));

// IMPORTANTE: /uploads NO se sirve de forma pública.
// Los archivos privados se sirven por rutas autenticadas (ver abajo).

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ----------------------------------------------------------------
// Sesión
// ----------------------------------------------------------------
app.use(session({
    store: new FileStore({ path: './sessions', logFn: () => {} }),
    secret: process.env.SESSION_SECRET || 'pusap_dev_fallback_secret_cambiar',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 1 semana
        httpOnly: true,
        sameSite: 'lax'
    }
}));

// ----------------------------------------------------------------
// Variables globales para todas las vistas
// ----------------------------------------------------------------
const moment = require('moment');
moment.locale('es');
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.currentPath = req.path;
    res.locals.moment = moment;

    // Determinación del layout activo
    if (req.path.startsWith('/panel') || req.path.startsWith('/backoffice')) {
        res.locals.currentLayout = 'personal';
    } else if (req.path.startsWith('/alumno')) {
        res.locals.currentLayout = 'alumno';
    } else {
        res.locals.currentLayout = 'publico';
    }

    next();
});

// ----------------------------------------------------------------
// Descarga autenticada de archivos privados
// Los uploads públicos del formulario público (comprobantes, etc.)
// siguen en uploads/ pero los archivos de solicitudes van a uploads/privado/
// ----------------------------------------------------------------
app.use('/uploads/publico', express.static(path.join(__dirname, 'uploads')));

// Ruta autenticada para archivos privados (solicitudes, documentos emitidos)
app.get('/descargas/privado/:filename', (req, res) => {
    if (!req.session.user) return res.redirect('/ingresar');
    const filename = path.basename(req.params.filename); // evitar path traversal
    const filePath = path.join(__dirname, 'uploads', 'privado', filename);
    res.sendFile(filePath, (err) => {
        if (err) res.status(404).send('Archivo no encontrado.');
    });
});

// Ruta autenticada para uploads existentes del sistema de tickets (solo personal)
app.get('/descargas/tickets/:filename', (req, res) => {
    if (!req.session.user) return res.redirect('/ingresar');
    const { role } = req.session.user;
    if (role !== 'operador' && role !== 'interno') return res.status(403).send('Acceso denegado.');
    const filename = path.basename(req.params.filename);
    const filePath = path.join(__dirname, 'uploads', filename);
    res.sendFile(filePath, (err) => {
        if (err) res.status(404).send('Archivo no encontrado.');
    });
});

// ----------------------------------------------------------------
// Rutas
// ----------------------------------------------------------------
const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const ticketRoutes = require('./routes/tickets');
const alumnoRoutes = require('./routes/alumno');
const backofficeRoutes = require('./routes/backoffice');

app.use('/', authRoutes);
app.use('/', publicRoutes);
app.use('/panel', ticketRoutes);          // Retrocompatibilidad — NO deprecar
app.use('/backoffice', backofficeRoutes); // Nuevo mount
app.use('/alumno', alumnoRoutes);         // Panel del alumno

// ----------------------------------------------------------------
// Error 404
// ----------------------------------------------------------------
app.use((req, res) => {
    res.status(404).render('errors/404', {
        title: 'Página no encontrada',
        user: req.session?.user || null
    });
});

// ----------------------------------------------------------------
// Error 500
// ----------------------------------------------------------------
app.use((err, req, res, next) => {
    console.error('Error del servidor:', err.stack);
    res.status(500).render('errors/500', {
        title: 'Error interno',
        user: req.session?.user || null
    });
});

// ----------------------------------------------------------------
// Servidor
// ----------------------------------------------------------------
let server = null;
if (process.env.NODE_ENV !== 'test') {
    server = app.listen(PORT, () => {
        console.log(`\n🏛  PUSAP — Mesa de Entrada corriendo en http://localhost:${PORT}`);
        console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}\n`);
    });
}

// ----------------------------------------------------------------
// Tarea: verificar cuotas próximas a vencer (cada 24 hs)
// ----------------------------------------------------------------
const mailer = require('./mailer');
const checkExpirations = () => {
    const targetDate = moment().add(3, 'days').format('YYYY-MM-DD');
    db.all(`SELECT * FROM tickets WHERE expiration_date = ? AND status NOT IN ('Aprobado', 'Rechazado')`,
        [targetDate], (err, tickets) => {
        if (err) { console.error('Error checking expirations:', err); return; }
        if (tickets && tickets.length > 0) {
            tickets.forEach(ticket => {
                mailer.sendExpirationReminderEmail(
                    ticket.email,
                    ticket.first_name,
                    ticket.tracking_code,
                    moment(ticket.expiration_date).format('DD/MM/YYYY')
                );
            });
        }
    });
};

if (process.env.NODE_ENV !== 'test') {
    checkExpirations();
    setInterval(checkExpirations, 24 * 60 * 60 * 1000);
}

module.exports = app;
