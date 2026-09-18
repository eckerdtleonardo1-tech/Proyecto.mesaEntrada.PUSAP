const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const db = require('../db');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Demasiados intentos de inicio de sesión. Por favor, intenta de nuevo en 15 minutos.'
});

router.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/panel');
    res.render('login', { title: 'Acceso Personal', error: null });
});

router.post('/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.render('login', { title: 'Acceso Personal', error: 'Por favor, ingrese usuario y contraseña.' });
    }
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err) {
            console.error("Error en login:", err);
            return res.render('login', { title: 'Acceso Personal', error: 'Error en el servidor. Intente más tarde.' });
        }
        if (!user) {
            return res.render('login', { title: 'Acceso Personal', error: 'Credenciales inválidas' });
        }
        
        let match = false;
        if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
            match = await bcrypt.compare(password, user.password);
        } else {
            match = (password === user.password);
            if (match) {
                const hashed = await bcrypt.hash(password, 10);
                db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, user.id]);
            }
        }
        
        if (!match) {
            db.run(`INSERT INTO access_log (user_id, user_name, action, ip) VALUES (?, ?, ?, ?)`, [user.id, user.username, 'login_fail', req.ip]);
            return res.render('login', { title: 'Acceso Personal', error: 'Credenciales inválidas' });
        }
        
        req.session.user = user;
        db.run(`INSERT INTO access_log (user_id, user_name, action, ip) VALUES (?, ?, ?, ?)`, [user.id, user.username, 'login_ok', req.ip]);
        res.redirect('/panel');
    });
});

router.get('/logout', (req, res) => {
    if (req.session.user) {
        db.run(`INSERT INTO access_log (user_id, user_name, action, ip) VALUES (?, ?, ?, ?)`, [req.session.user.id, req.session.user.username, 'logout', req.ip]);
    }
    req.session.destroy();
    res.redirect('/');
});

module.exports = router;
