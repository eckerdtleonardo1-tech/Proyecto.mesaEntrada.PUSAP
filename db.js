const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'database_v2.db');

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Habilitar modo WAL para permitir lectura y escritura simultánea de alta concurrencia
    db.run('PRAGMA journal_mode = WAL');

    // Users (Staff)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        name TEXT,
        role TEXT,
        area TEXT
    )`);

    // Insert default users if not exists
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO users (username, password, name, role, area) VALUES (?, ?, ?, ?, ?)");
            stmt.run("mesa", "1234", "Operador Mesa", "operador", "Mesa de Entrada");
            stmt.run("ingresos", "1234", "Dto. Ingresos", "interno", "Dto. Ingresos");
            stmt.run("academica", "1234", "Sec. Académica", "interno", "Secretaría Académica");
            stmt.run("sistema", "1234", "Dto. Sistema", "interno", "Dto. Sistema");
            stmt.finalize();
        }
    });

    // Tickets
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracking_code TEXT UNIQUE,
        first_name TEXT,
        last_name TEXT,
        dni TEXT,
        cuil TEXT,
        phone TEXT,
        email TEXT,
        category TEXT,
        status TEXT DEFAULT 'Iniciado',
        area TEXT DEFAULT 'Mesa de Entrada',
        expiration_date DATE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Ticket History (Audit)
    db.run(`CREATE TABLE IF NOT EXISTS ticket_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER,
        user_id INTEGER,
        user_name TEXT,
        old_status TEXT,
        new_status TEXT,
        old_area TEXT,
        new_area TEXT,
        comments TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
    )`);

    // Attachments
    db.run(`CREATE TABLE IF NOT EXISTS attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER,
        filename TEXT,
        original_name TEXT,
        document_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
    )`);
});

module.exports = db;
