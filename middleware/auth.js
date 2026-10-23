/**
 * middleware/auth.js
 * Guards de autenticación y autorización reutilizables.
 * Uso: const { requireAlumno, requirePersonal, requireOperador, requireGuest } = require('../middleware/auth');
 */

/**
 * Redirige al panel correspondiente si el usuario ya tiene sesión.
 * Útil en /ingresar para evitar que alguien logueado entre a la pantalla de login.
 */
const requireGuest = (req, res, next) => {
    if (!req.session.user) return next();
    const { role } = req.session.user;
    if (role === 'alumno') return res.redirect('/alumno');
    return res.redirect('/backoffice');
};

/**
 * Requiere sesión activa con rol 'alumno'.
 * Si no hay sesión → redirige a /ingresar conservando la URL de destino.
 * Si hay sesión pero no es alumno → 403.
 */
const requireAlumno = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/ingresar?next=' + encodeURIComponent(req.originalUrl));
    }
    if (req.session.user.role !== 'alumno') {
        return res.status(403).render('errors/403', {
            title: 'Acceso denegado',
            user: req.session.user
        });
    }
    next();
};

/**
 * Requiere sesión activa con rol de personal (operador o interno).
 * Si no hay sesión → redirige a /ingresar conservando la URL.
 * Si hay sesión pero es alumno → 403.
 */
const requirePersonal = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/ingresar?next=' + encodeURIComponent(req.originalUrl));
    }
    const { role } = req.session.user;
    if (role !== 'operador' && role !== 'interno') {
        return res.status(403).render('errors/403', {
            title: 'Acceso denegado',
            user: req.session.user
        });
    }
    next();
};

/**
 * Requiere rol 'operador' (administrador total).
 * Debe usarse DESPUÉS de requirePersonal o dentro de rutas ya protegidas.
 */
const requireOperador = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/ingresar?next=' + encodeURIComponent(req.originalUrl));
    }
    if (req.session.user.role !== 'operador') {
        return res.status(403).render('errors/403', {
            title: 'Acceso denegado',
            user: req.session.user
        });
    }
    next();
};

module.exports = { requireGuest, requireAlumno, requirePersonal, requireOperador };
