const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireGuest } = require('../middleware/auth');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Demasiados intentos de inicio de sesión. Por favor, intenta de nuevo en 15 minutos.'
});

// ----------------------------------------------------------------
// /ingresar — Login unificado (reemplaza /login)
// ----------------------------------------------------------------
router.get('/ingresar', requireGuest, (req, res) => {
    const next = req.query.next || '';
    res.render('ingresar', { title: 'Ingresar', error: null, next });
});

router.post('/ingresar', loginLimiter, (req, res) => {
    const { username, password, next } = req.body;
    const nextUrl = (next && next.startsWith('/')) ? next : '';

    if (!username || !password) {
        return res.render('ingresar', { title: 'Ingresar', error: 'Ingresá usuario y contraseña.', next: nextUrl });
    }

    db.get(`SELECT * FROM users WHERE (username = ? OR email = ?) AND activo = 1`, [username, username], async (err, user) => {
        if (err) {
            console.error('Error en login:', err);
            return res.render('ingresar', { title: 'Ingresar', error: 'Error en el servidor. Intentá más tarde.', next: nextUrl });
        }
        if (!user) {
            return res.render('ingresar', { title: 'Ingresar', error: 'Credenciales inválidas.', next: nextUrl });
        }

        let match = false;
        if (user.password && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$'))) {
            match = await bcrypt.compare(password, user.password);
        } else if (user.password) {
            match = (password === user.password);
            if (match) {
                const hashed = await bcrypt.hash(password, 10);
                db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, user.id]);
            }
        }

        if (!match) {
            db.run(`INSERT INTO access_log (user_id, user_name, action, ip) VALUES (?, ?, ?, ?)`,
                [user.id, user.username, 'login_fail', req.ip]);
            return res.render('ingresar', { title: 'Ingresar', error: 'Credenciales inválidas.', next: nextUrl });
        }

        req.session.user = user;
        db.run(`INSERT INTO access_log (user_id, user_name, action, ip) VALUES (?, ?, ?, ?)`,
            [user.id, user.username || user.email, 'login_ok', req.ip]);

        // Redirigir según rol
        if (nextUrl) return res.redirect(nextUrl);
        if (user.role === 'alumno') return res.redirect('/alumno');
        return res.redirect('/backoffice');
    });
});

// Retrocompatibilidad: /login → /ingresar (301)
router.get('/login', (req, res) => {
    const qs = req.query.next ? `?next=${encodeURIComponent(req.query.next)}` : '';
    res.redirect(301, '/ingresar' + qs);
});

// POST /login legacy: redirigir también
router.post('/login', (req, res) => {
    res.redirect(307, '/ingresar');
});

// ----------------------------------------------------------------
// Activación de cuenta de alumno
// ----------------------------------------------------------------
router.get('/activar/:token', (req, res) => {
    const { token } = req.params;
    db.get(`SELECT * FROM users WHERE activation_token = ? AND activation_expires > datetime('now')`, [token], (err, user) => {
        if (err || !user) {
            return res.render('activar', { title: 'Activar cuenta', error: 'El enlace de activación no es válido o expiró.', success: false });
        }
        res.render('activar', { title: 'Activar cuenta', error: null, success: false, token });
    });
});

router.post('/activar/:token', async (req, res) => {
    const { token } = req.params;
    const { password, password2 } = req.body;

    if (!password || password !== password2) {
        return res.render('activar', { title: 'Activar cuenta', error: 'Las contraseñas no coinciden.', success: false, token });
    }
    if (password.length < 8) {
        return res.render('activar', { title: 'Activar cuenta', error: 'La contraseña debe tener al menos 8 caracteres.', success: false, token });
    }

    db.get(`SELECT * FROM users WHERE activation_token = ? AND activation_expires > datetime('now')`, [token], async (err, user) => {
        if (err || !user) {
            return res.render('activar', { title: 'Activar cuenta', error: 'El enlace expiró. Solicitá uno nuevo.', success: false, token });
        }
        const hashed = await bcrypt.hash(password, 10);
        db.run(`UPDATE users SET password = ?, activation_token = NULL, activation_expires = NULL, activo = 1 WHERE id = ?`,
            [hashed, user.id], (err2) => {
                if (err2) return res.render('activar', { title: 'Activar cuenta', error: 'Error al activar. Intentá más tarde.', success: false, token });
                res.render('activar', { title: 'Activar cuenta', error: null, success: true, token: null });
            });
    });
});

// ----------------------------------------------------------------
// Logout
// ----------------------------------------------------------------
router.get('/logout', (req, res) => {
    if (req.session.user) {
        db.run(`INSERT INTO access_log (user_id, user_name, action, ip) VALUES (?, ?, ?, ?)`,
            [req.session.user.id, req.session.user.username || req.session.user.email, 'logout', req.ip]);
    }
    req.session.destroy();
    res.redirect('/');
});

module.exports = router;
