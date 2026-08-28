const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/login', (req, res) => {
    res.render('login', { title: 'Acceso Personal', error: null });
});

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
        if (err || !user) {
            return res.render('login', { title: 'Acceso Personal', error: 'Credenciales inválidas' });
        }
        req.session.user = user;
        res.redirect('/panel');
    });
});

router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

module.exports = router;
