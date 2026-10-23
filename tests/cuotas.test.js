const test = require('node:test');
const assert = require('node:assert');
const moment = require('moment');

function calcularEstadoCuota(cuota, hoy) {
    if (cuota.estado === 'pendiente' && moment(cuota.vencimiento).isBefore(hoy, 'day')) {
        return 'vencida';
    }
    return cuota.estado;
}

function filtrarCuotas(cuotas, filtro, hoy) {
    return cuotas.filter(c => {
        const estadoReal = calcularEstadoCuota(c, hoy);
        if (filtro === 'todas') return true;
        if (filtro === 'pendientes') return c.estado === 'pendiente' && !moment(c.vencimiento).isBefore(hoy, 'day');
        if (filtro === 'vencidas') return estadoReal === 'vencida';
        if (filtro === 'pagadas') return c.estado === 'pagada';
        if (filtro === 'activas') return !['pagada', 'anulada', 'becada_exenta'].includes(c.estado);
        return true;
    });
}

function calcularDeudaTotal(cuotas) {
    return cuotas
        .filter(c => c.estado === 'pendiente')
        .reduce((sum, c) => sum + (c.monto || 0) + (c.recargo || 0), 0);
}

test('Lógica y Estados de Cuotas', async (t) => {
    const hoy = moment('2026-10-23');

    const cuotasEjemplo = [
        { id: 1, concepto: 'Cuota Marzo', monto: 10000, recargo: 0, vencimiento: '2026-03-10', estado: 'pagada' },
        { id: 2, concepto: 'Cuota Septiembre', monto: 10000, recargo: 1500, vencimiento: '2026-09-10', estado: 'pendiente' }, // vencida
        { id: 3, concepto: 'Cuota Noviembre', monto: 10000, recargo: 0, vencimiento: '2026-11-10', estado: 'pendiente' },  // pendiente futura
        { id: 4, concepto: 'Cuota Diciembre', monto: 10000, recargo: 0, vencimiento: '2026-12-10', estado: 'becada_exenta' },
        { id: 5, concepto: 'Matrícula', monto: 15000, recargo: 0, vencimiento: '2026-02-10', estado: 'anulada' },
        { id: 6, concepto: 'Pago parcial Octubre', monto: 5000, recargo: 0, vencimiento: '2026-10-10', estado: 'pago_parcial' }
    ];

    await t.test('Calcula estado "vencida" cuando vencimiento es anterior a hoy y estado es pendiente', () => {
        const estado = calcularEstadoCuota(cuotasEjemplo[1], hoy);
        assert.strictEqual(estado, 'vencida');
    });

    await t.test('Mantiene estado "pendiente" cuando vencimiento es futuro', () => {
        const estado = calcularEstadoCuota(cuotasEjemplo[2], hoy);
        assert.strictEqual(estado, 'pendiente');
    });

    await t.test('Una cuota pagada anterior a hoy NO se marca como vencida', () => {
        const estado = calcularEstadoCuota(cuotasEjemplo[0], hoy);
        assert.strictEqual(estado, 'pagada');
    });

    await t.test('Filtro "vencidas" devuelve únicamente cuotas vencidas', () => {
        const vencidas = filtrarCuotas(cuotasEjemplo, 'vencidas', hoy);
        assert.strictEqual(vencidas.length, 1);
        assert.strictEqual(vencidas[0].id, 2);
    });

    await t.test('Filtro "pendientes" devuelve cuotas pendientes con vencimiento futuro', () => {
        const pendientes = filtrarCuotas(cuotasEjemplo, 'pendientes', hoy);
        assert.strictEqual(pendientes.length, 1);
        assert.strictEqual(pendientes[0].id, 3);
    });

    await t.test('Filtro "pagadas" devuelve cuotas pagadas', () => {
        const pagadas = filtrarCuotas(cuotasEjemplo, 'pagadas', hoy);
        assert.strictEqual(pagadas.length, 1);
        assert.strictEqual(pagadas[0].id, 1);
    });

    await t.test('Filtro "activas" excluye pagadas, anuladas y becadas', () => {
        const activas = filtrarCuotas(cuotasEjemplo, 'activas', hoy);
        const ids = activas.map(c => c.id);
        assert.deepStrictEqual(ids, [2, 3, 6]);
    });

    await t.test('Cálculo de deuda total suma montos y recargos de cuotas pendientes', () => {
        // Cuota 2 (10000 + 1500) + Cuota 3 (10000 + 0) = 21500
        const total = calcularDeudaTotal(cuotasEjemplo);
        assert.strictEqual(total, 21500);
    });
});
