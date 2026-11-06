/**
 * lib/dbp.js
 * Versión con promesas de db.all / db.get / db.run para las vistas que juntan varias consultas
 * (dashboards, portadas) sin anidar callbacks. `run` resuelve con { lastID, changes }.
 */
const db = require('../db');

const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
});

const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
});

const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
    });
});

module.exports = { all, get, run };
