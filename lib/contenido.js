/**
 * lib/contenido.js
 * Datos institucionales editables por el personal (contacto, horarios, textos de portada).
 * Se guardan en la tabla contenido_publico (seccion = 'institucional') y se cachean en
 * memoria: el footer público los lee en cada request, así que no conviene ir a la DB siempre.
 */
const db = require('../db');

const SECCION = 'institucional';

// Clave → { valor por defecto, etiqueta y ayuda para el formulario del backoffice }
const CAMPOS = {
    hero_titulo: {
        defecto: 'Formate en PUSAP',
        etiqueta: 'Título principal del inicio',
        ayuda: 'Frase grande que ven los visitantes al entrar al sitio.'
    },
    hero_subtitulo: {
        defecto: 'Carreras y cursos con salida laboral, cursada flexible y acompañamiento en cada etapa.',
        etiqueta: 'Subtítulo del inicio',
        ayuda: 'Una o dos líneas debajo del título principal.',
        largo: true
    },
    direccion: {
        defecto: 'Av. Universitaria 1250, Edificio Central, Planta Baja',
        etiqueta: 'Dirección de la sede',
        ayuda: 'Se muestra en Contacto y en el portal del alumno (para trámites presenciales).'
    },
    horario_presencial: {
        defecto: 'Lunes a Viernes de 8:00 a 14:00 hs y de 16:00 a 20:00 hs',
        etiqueta: 'Horario de atención presencial',
        ayuda: 'Los alumnos lo ven cuando deben finalizar un trámite en persona.'
    },
    telefono: {
        defecto: '0800-PUSAP-123',
        etiqueta: 'Teléfono',
        ayuda: ''
    },
    email: {
        defecto: 'mesaentrada@pusap.edu.ar',
        etiqueta: 'Email institucional',
        ayuda: ''
    },
    whatsapp: {
        defecto: '5491155557872',
        etiqueta: 'WhatsApp (sólo números, con código de país)',
        ayuda: 'Se usa para armar el enlace wa.me. Ej: 5491155557872'
    },
    whatsapp_visible: {
        defecto: '+54 9 11 5555-7872',
        etiqueta: 'WhatsApp (como se muestra)',
        ayuda: ''
    }
};

const MAX_LARGO = 500;

let cache = null;

const defaults = () => {
    const out = {};
    Object.keys(CAMPOS).forEach(k => { out[k] = CAMPOS[k].defecto; });
    return out;
};

/** Devuelve { clave: valor } con los defaults pisados por lo guardado en la DB. */
function obtener(cb) {
    if (cache) return cb(cache);
    db.all(`SELECT clave, valor FROM contenido_publico WHERE seccion = ?`, [SECCION], (err, rows) => {
        const out = defaults();
        if (!err && rows) {
            rows.forEach(r => {
                if (CAMPOS[r.clave] && r.valor !== null && r.valor !== '') out[r.clave] = r.valor;
            });
            cache = out; // sólo se cachea una lectura exitosa
        }
        cb(out);
    });
}

/** Guarda sólo las claves conocidas; ignora cualquier otra que venga en el body. */
function guardar(valores, userId, cb) {
    const claves = Object.keys(CAMPOS).filter(k => typeof valores[k] === 'string');
    if (claves.length === 0) return cb(null);

    let pendientes = claves.length;
    let fallo = null;
    claves.forEach(k => {
        const valor = valores[k].trim().slice(0, MAX_LARGO);
        db.run(`INSERT INTO contenido_publico (seccion, clave, valor, tipo, updated_by, updated_at)
                VALUES (?, ?, ?, 'texto', ?, CURRENT_TIMESTAMP)
                ON CONFLICT(seccion, clave) DO UPDATE SET
                    valor = excluded.valor, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [SECCION, k, valor, userId || null], (err) => {
                if (err && !fallo) fallo = err;
                if (--pendientes === 0) {
                    cache = null;
                    cb(fallo);
                }
            });
    });
}

module.exports = { CAMPOS, defaults, obtener, guardar };
