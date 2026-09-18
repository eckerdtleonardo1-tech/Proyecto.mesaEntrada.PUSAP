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
            const defaultPass = "$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi";
            stmt.run("mesa", defaultPass, "Operador Mesa", "operador", "Mesa de Entrada");
            stmt.run("ingresos", defaultPass, "Dto. Ingresos", "interno", "Dto. Ingresos");
            stmt.run("academica", defaultPass, "Sec. Académica", "interno", "Secretaría Académica");
            stmt.run("sistema", defaultPass, "Dto. Sistema", "interno", "Dto. Sistema");
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

    // Config
    db.run(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    // Areas
    db.run(`CREATE TABLE IF NOT EXISTS areas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE
    )`);

    // Insert default areas if not exists
    db.get("SELECT COUNT(*) as count FROM areas", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO areas (name) VALUES (?)");
            stmt.run("Mesa de Entrada");
            stmt.run("Dto. Ingresos");
            stmt.run("Secretaría Académica");
            stmt.run("Dto. Sistema");
            stmt.finalize();
        }
    });

    // Modificando history para soporte de notas internas
    db.run("ALTER TABLE ticket_history ADD COLUMN type TEXT DEFAULT 'historial'", (err) => {
        // Ignorar si existe
    });

    // Nuevas columnas (try/catch a través de error callback)
    db.run("ALTER TABLE tickets ADD COLUMN notes TEXT", (err) => {
        // Ignorar error si la columna ya existe
    });
    db.run("ALTER TABLE tickets ADD COLUMN priority TEXT DEFAULT 'normal'", (err) => {
        // Ignorar error si la columna ya existe
    });
    db.run("ALTER TABLE tickets ADD COLUMN student_notes TEXT", (err) => {
        // Ignorar error si la columna ya existe
    });
    db.run("ALTER TABLE tickets ADD COLUMN assigned_to INTEGER", (err) => {
        // Ignorar error si la columna ya existe
    });

    // Tags
    db.run(`CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        color TEXT
    )`);

    db.get("SELECT COUNT(*) as count FROM tags", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO tags (name, color) VALUES (?, ?)");
            stmt.run("Urgente", "red");
            stmt.run("Falta Firma", "yellow");
            stmt.run("Revisar", "blue");
            stmt.finalize();
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS ticket_tags (
        ticket_id INTEGER,
        tag_id INTEGER,
        PRIMARY KEY(ticket_id, tag_id)
    )`);
    db.run("ALTER TABLE tickets ADD COLUMN deleted_at DATETIME DEFAULT NULL", (err) => {
        // Ignorar error si la columna ya existe
    });

    // Quick Replies
    db.run(`CREATE TABLE IF NOT EXISTS quick_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        content TEXT
    )`);

    db.get("SELECT COUNT(*) as count FROM quick_replies", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO quick_replies (title, content) VALUES (?, ?)");
            stmt.run("En análisis", "Trámite en proceso de análisis de la documentación adjunta.");
            stmt.run("Espera de firma", "Trámite procesado correctamente. Queda a la espera de firma de autoridad.");
            stmt.run("Falta doc.", "Falta documentación adjunta o no es legible. Por favor, verifique los requisitos y envíe lo faltante.");
            stmt.run("Aprobado", "Trámite finalizado y aprobado satisfactoriamente.");
            stmt.finalize();
        }
    });

    // Log de auditoria
    db.run(`CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        action TEXT,
        ip TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

module.exports = db;
