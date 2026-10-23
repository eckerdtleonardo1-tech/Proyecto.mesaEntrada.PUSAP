const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'database_v2.db');

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Habilitar modo WAL para permitir lectura y escritura simultánea de alta concurrencia
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');

    // =============================================
    // TABLAS ORIGINALES (sin modificar)
    // =============================================

    // Users (Staff + Alumnos)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        name TEXT,
        role TEXT,
        area TEXT
    )`);

    // Nuevas columnas en users (se ignora error si ya existen)
    db.run("ALTER TABLE users ADD COLUMN email TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN dni TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN legajo TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN alumno_id INTEGER", () => {});
    db.run("ALTER TABLE users ADD COLUMN activation_token TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN activation_expires TEXT", () => {});
    db.run("ALTER TABLE users ADD COLUMN activo INTEGER DEFAULT 1", () => {});

    // Insert default users if not exists
    db.get("SELECT COUNT(*) as count FROM users WHERE role != 'alumno'", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO users (username, password, name, role, area, activo) VALUES (?, ?, ?, ?, ?, 1)");
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

    // Columnas extras en tickets (ya existentes, solo por compatibilidad)
    db.run("ALTER TABLE tickets ADD COLUMN notes TEXT", () => {});
    db.run("ALTER TABLE tickets ADD COLUMN priority TEXT DEFAULT 'normal'", () => {});
    db.run("ALTER TABLE tickets ADD COLUMN student_notes TEXT", () => {});
    db.run("ALTER TABLE tickets ADD COLUMN assigned_to INTEGER", () => {});
    db.run("ALTER TABLE tickets ADD COLUMN deleted_at DATETIME DEFAULT NULL", () => {});

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
    db.run("ALTER TABLE ticket_history ADD COLUMN type TEXT DEFAULT 'historial'", () => {});

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

    // Log de auditoría
    db.run(`CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        action TEXT,
        ip TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // =============================================
    // TABLAS NUEVAS - FASE 1
    // =============================================

    // Alumnos (perfil académico independiente del usuario de login)
    db.run(`CREATE TABLE IF NOT EXISTS alumnos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        legajo TEXT UNIQUE NOT NULL,
        dni TEXT UNIQUE NOT NULL,
        nombre TEXT NOT NULL,
        apellido TEXT NOT NULL,
        email TEXT,
        telefono TEXT,
        direccion TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Carreras (oferta académica)
    db.run(`CREATE TABLE IF NOT EXISTS carreras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        tipo TEXT DEFAULT 'carrera',
        modalidad TEXT DEFAULT 'presencial',
        duracion TEXT,
        turno TEXT,
        descripcion TEXT,
        plan_estudios TEXT,
        titulo TEXT,
        requisitos_ingreso TEXT,
        aranceles TEXT,
        fechas_inscripcion TEXT,
        activo INTEGER DEFAULT 1,
        orden INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Relación alumno ↔ carrera (N:M, soporta multi-carrera)
    db.run(`CREATE TABLE IF NOT EXISTS alumno_carreras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alumno_id INTEGER NOT NULL,
        carrera_id INTEGER NOT NULL,
        estado TEXT DEFAULT 'activo',
        fecha_inicio DATE,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (carrera_id) REFERENCES carreras(id),
        UNIQUE(alumno_id, carrera_id)
    )`);

    // Cursos / Materias
    db.run(`CREATE TABLE IF NOT EXISTS cursos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        carrera_id INTEGER,
        nombre TEXT NOT NULL,
        comision TEXT,
        docente TEXT,
        dias_horarios TEXT,
        modalidad TEXT DEFAULT 'presencial',
        aula TEXT,
        anio_lectivo TEXT,
        activo INTEGER DEFAULT 1,
        FOREIGN KEY (carrera_id) REFERENCES carreras(id)
    )`);

    // Relación alumno ↔ curso
    db.run(`CREATE TABLE IF NOT EXISTS alumno_cursos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alumno_id INTEGER NOT NULL,
        curso_id INTEGER NOT NULL,
        estado_cursada TEXT DEFAULT 'cursando',
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (curso_id) REFERENCES cursos(id),
        UNIQUE(alumno_id, curso_id)
    )`);

    // Cuotas
    db.run(`CREATE TABLE IF NOT EXISTS cuotas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alumno_id INTEGER NOT NULL,
        concepto TEXT NOT NULL,
        periodo TEXT,
        monto REAL NOT NULL DEFAULT 0,
        vencimiento DATE NOT NULL,
        estado TEXT DEFAULT 'pendiente',
        recargo REAL DEFAULT 0,
        fecha_pago DATE,
        comprobante_filename TEXT,
        comprobante_original_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id)
    )`);

    // Tipos de solicitud de documentación (catálogo configurable)
    db.run(`CREATE TABLE IF NOT EXISTS tipos_solicitud (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        modalidad TEXT DEFAULT 'presentacion',
        activo INTEGER DEFAULT 1,
        orden INTEGER DEFAULT 0
    )`);

    db.get("SELECT COUNT(*) as count FROM tipos_solicitud", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO tipos_solicitud (nombre, descripcion, modalidad, orden) VALUES (?, ?, ?, ?)");
            stmt.run("Certificado de Alumno Regular", "Constancia que acredita la condición de alumno regular.", "emision", 1);
            stmt.run("Analítico Parcial", "Constancia de materias aprobadas hasta la fecha.", "emision", 2);
            stmt.run("Programas de Materias", "Programas oficiales de las materias cursadas.", "emision", 3);
            stmt.run("Presentación de DNI", "Copia del Documento Nacional de Identidad.", "presentacion", 4);
            stmt.run("Presentación de Título Secundario", "Original o copia legalizada del título secundario.", "presentacion", 5);
            stmt.run("Presentación de Analítico Secundario", "Analítico del nivel secundario.", "presentacion", 6);
            stmt.finalize();
        }
    });

    // Solicitudes de documentación (flujo alumno ↔ personal)
    db.run(`CREATE TABLE IF NOT EXISTS solicitudes_doc (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alumno_id INTEGER NOT NULL,
        tipo_solicitud_id INTEGER NOT NULL,
        estado TEXT DEFAULT 'borrador',
        motivo_observacion TEXT,
        documento_emitido_filename TEXT,
        documento_emitido_original_name TEXT,
        asignado_a INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id),
        FOREIGN KEY (tipo_solicitud_id) REFERENCES tipos_solicitud(id),
        FOREIGN KEY (asignado_a) REFERENCES users(id)
    )`);

    // Historial de estados de solicitudes
    db.run(`CREATE TABLE IF NOT EXISTS solicitud_historia (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        solicitud_id INTEGER NOT NULL,
        user_id INTEGER,
        user_name TEXT,
        estado_anterior TEXT,
        estado_nuevo TEXT,
        comentario TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (solicitud_id) REFERENCES solicitudes_doc(id)
    )`);

    // Adjuntos de solicitudes (separados de los adjuntos de tickets)
    db.run(`CREATE TABLE IF NOT EXISTS solicitud_adjuntos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        solicitud_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT,
        document_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (solicitud_id) REFERENCES solicitudes_doc(id)
    )`);

    // Notificaciones para alumnos
    db.run(`CREATE TABLE IF NOT EXISTS notificaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alumno_id INTEGER NOT NULL,
        tipo TEXT DEFAULT 'info',
        mensaje TEXT NOT NULL,
        url TEXT,
        leida INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (alumno_id) REFERENCES alumnos(id)
    )`);

    // Contenido público editable (secciones: becas, calendario, medios_pago, etc.)
    db.run(`CREATE TABLE IF NOT EXISTS contenido_publico (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seccion TEXT NOT NULL,
        clave TEXT NOT NULL,
        valor TEXT,
        tipo TEXT DEFAULT 'texto',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by INTEGER,
        UNIQUE(seccion, clave),
        FOREIGN KEY (updated_by) REFERENCES users(id)
    )`);

    // FAQs
    db.run(`CREATE TABLE IF NOT EXISTS faqs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        categoria TEXT DEFAULT 'General',
        pregunta TEXT NOT NULL,
        respuesta TEXT NOT NULL,
        orden INTEGER DEFAULT 0,
        activo INTEGER DEFAULT 1
    )`);

    db.get("SELECT COUNT(*) as count FROM faqs", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO faqs (categoria, pregunta, respuesta, orden) VALUES (?, ?, ?, ?)");
            stmt.run("Inscripción", "¿Cómo me inscribo en una carrera?", "Podés iniciar tu inscripción desde la sección 'Inscripción' del portal o presentarte personalmente en la Mesa de Entrada con la documentación requerida.", 1);
            stmt.run("Inscripción", "¿Qué documentación necesito para inscribirme?", "Necesitás: DNI original y copia, título secundario (original y copia legalizada), analítico secundario, 2 fotos 4x4 y el formulario de inscripción completo.", 2);
            stmt.run("Pagos", "¿Cuáles son los medios de pago disponibles?", "Aceptamos transferencia bancaria, depósito y efectivo en ventanilla. Consultá la sección 'Pagos' para ver los datos bancarios actualizados.", 3);
            stmt.run("Pagos", "¿Qué pasa si pago fuera de término?", "Las cuotas abonadas fuera del vencimiento generan un recargo. Consultá el arancel vigente en la sección de Pagos.", 4);
            stmt.run("Trámites", "¿Cómo hago seguimiento de mi trámite?", "Usá el código de seguimiento que te enviamos por email junto con tu DNI en la sección 'Seguimiento' del portal.", 5);
            stmt.finalize();
        }
    });

    // Novedades institucionales
    db.run(`CREATE TABLE IF NOT EXISTS novedades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titulo TEXT NOT NULL,
        cuerpo TEXT,
        destacada INTEGER DEFAULT 0,
        fecha_publicacion DATE DEFAULT (date('now')),
        activo INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Normativas / reglamentos descargables
    db.run(`CREATE TABLE IF NOT EXISTS normativas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        titulo TEXT NOT NULL,
        descripcion TEXT,
        filename TEXT,
        original_name TEXT,
        fecha_vigencia DATE,
        activo INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

module.exports = db;
