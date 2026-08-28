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

app.listen(PORT, () => {
    console.log(`Sistema de Mesa de Entrada corriendo en http://localhost:${PORT}`);
});
