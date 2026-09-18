const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session config para producción
app.use(session({
    store: new FileStore({ path: './sessions' }),
    secret: 'puasap_secret_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // La sesión dura 1 semana
}));

// Global variables for views
const moment = require('moment');
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.moment = moment;
    next();
});

// Import Routes
const authRoutes = require('./routes/auth');
const ticketRoutes = require('./routes/tickets');
const publicRoutes = require('./routes/public');

app.use('/', authRoutes);
app.use('/', publicRoutes);
app.use('/panel', ticketRoutes); // all staff routes under /panel

// Error 404
app.use((req, res) => {
    const user = req.session?.user || null;
    res.status(404).send(`
        <!DOCTYPE html><html lang="es">
        <head><meta charset="UTF-8"><title>Página no encontrada | PUSAP</title>
        <script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-slate-100 min-h-screen flex items-center justify-center">
        <div class="text-center bg-white p-12 rounded-2xl shadow-sm border border-slate-200 max-w-md">
            <div class="w-16 h-16 bg-blue-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <span class="text-3xl font-black text-blue-700">404</span>
            </div>
            <h1 class="text-xl font-bold text-slate-900 mb-2">Página no encontrada</h1>
            <p class="text-slate-500 text-sm mb-6">La página que buscás no existe o fue movida.</p>
            <a href="${user ? '/panel' : '/'}" class="bg-blue-700 text-white font-bold py-2.5 px-6 rounded-xl text-sm hover:bg-blue-800 transition">
                Volver al ${user ? 'Panel' : 'Inicio'}
            </a>
        </div></body></html>
    `);
});

// Error 500
app.use((err, req, res, next) => {
    console.error('Error del servidor:', err.stack);
    res.status(500).send(`
        <!DOCTYPE html><html lang="es">
        <head><meta charset="UTF-8"><title>Error del servidor | PUSAP</title>
        <script src="https://cdn.tailwindcss.com"></script></head>
        <body class="bg-slate-100 min-h-screen flex items-center justify-center">
        <div class="text-center bg-white p-12 rounded-2xl shadow-sm border border-slate-200 max-w-md">
            <div class="w-16 h-16 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <span class="text-3xl font-black text-red-600">500</span>
            </div>
            <h1 class="text-xl font-bold text-slate-900 mb-2">Error interno del servidor</h1>
            <p class="text-slate-500 text-sm mb-6">Ocurrió un error inesperado. Por favor, intentá nuevamente.</p>
            <a href="/" class="bg-blue-700 text-white font-bold py-2.5 px-6 rounded-xl text-sm hover:bg-blue-800 transition">Volver al Inicio</a>
        </div></body></html>
    `);
});

app.listen(PORT, () => {
    console.log(`Sistema de Mesa de Entrada corriendo en http://localhost:${PORT}`);
});

const mailer = require('./mailer');
const checkExpirations = () => {
    const targetDate = moment().add(3, 'days').format('YYYY-MM-DD');
    db.all(`SELECT * FROM tickets WHERE expiration_date = ? AND status NOT IN ('Aprobado', 'Rechazado')`, [targetDate], (err, tickets) => {
        if (err) {
            console.error('Error checking expirations:', err);
            return;
        }
        if (tickets && tickets.length > 0) {
            console.log(`Found ${tickets.length} tickets expiring on ${targetDate}. Sending reminders...`);
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
checkExpirations(); // Ejecutar al arrancar
setInterval(checkExpirations, 24 * 60 * 60 * 1000); // Y cada 24 horas
