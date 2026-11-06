/**
 * lib/solicitud-estados.js
 * Máquina de estados de las solicitudes de trámite (solicitudes_doc).
 *
 * Flujo completo:
 *   borrador → enviada → en_revision → aprobada → [emitida] → finalizada
 *                            ↓  ↑
 *                         observada (el alumno corrige y reenvía)
 *                            ↓
 *                        rechazada
 *
 * 'finalizada' = el trámite se cerró presencialmente en la institución.
 * 'emitida' es opcional: sólo si el personal subió un documento digital.
 */
const TRANSICIONES_VALIDAS = {
    borrador: ['enviada'],
    enviada: ['en_revision'],
    en_revision: ['observada', 'aprobada', 'rechazada'],
    observada: ['enviada'],
    aprobada: ['emitida', 'finalizada'],
    emitida: ['finalizada'],
    rechazada: [],
    finalizada: []
};

function validarTransicion(estadoActual, estadoNuevo) {
    const permitidos = TRANSICIONES_VALIDAS[estadoActual] || [];
    return permitidos.includes(estadoNuevo);
}

module.exports = { TRANSICIONES_VALIDAS, validarTransicion };
