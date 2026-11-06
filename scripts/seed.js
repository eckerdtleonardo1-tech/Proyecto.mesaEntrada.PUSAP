/**
 * scripts/seed.js
 * Pobla la base de datos con datos ficticios para desarrollo.
 * Uso: node scripts/seed.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');

// Esperar a que db.js termine sus CREATE TABLE (son síncronos en db.serialize)
setTimeout(async () => {
    console.log('🌱 Iniciando seed de datos ficticios...');

    const hash = await bcrypt.hash('alumno123', 10);

    // --- Carrera de ejemplo ---
    db.run(`INSERT OR IGNORE INTO carreras 
        (nombre, tipo, modalidad, duracion, turno, descripcion, titulo, requisitos_ingreso, aranceles, fechas_inscripcion, activo, orden)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        [
            'Tecnicatura en Administración de Empresas',
            'carrera',
            'presencial',
            '3 años',
            'mañana/noche',
            'Formamos profesionales capaces de gestionar organizaciones públicas y privadas con criterio estratégico.',
            'Técnico/a Superior en Administración de Empresas',
            'Título secundario completo. DNI. Analítico secundario.',
            'Matrícula: $15.000. Cuota mensual: $8.500 (10 cuotas/año).',
            'Inscripción: 01/02 al 28/02. Reinscripción: 01/07 al 31/07.'
        ], (err) => { if (err && !err.message.includes('UNIQUE')) console.error(err.message); }
    );

    db.run(`INSERT OR IGNORE INTO carreras 
        (nombre, tipo, modalidad, duracion, turno, descripcion, titulo, requisitos_ingreso, aranceles, fechas_inscripcion, activo, orden)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2)`,
        [
            'Curso de Contabilidad Básica',
            'curso',
            'virtual',
            '4 meses',
            'libre',
            'Aprendé los fundamentos de la contabilidad con enfoque práctico.',
            'Certificado de Aprobación',
            'No requiere título secundario.',
            'Cuota única: $5.000.',
            'Permanente, con inicio los primeros lunes de cada mes.'
        ], (err) => { if (err && !err.message.includes('UNIQUE')) console.error(err.message); }
    );

    // --- Alumno de prueba ---
    db.run(`INSERT OR IGNORE INTO alumnos (legajo, dni, nombre, apellido, email, telefono)
        VALUES (?, ?, ?, ?, ?, ?)`,
        ['2024-001', '30123456', 'María', 'González', 'alumno@test.pusap.edu.ar', '11-5555-1234'],
        function(err) {
            if (err) { 
                if (!err.message.includes('UNIQUE')) console.error(err.message);
                return;
            }
            const alumnoId = this.lastID;

            // Usuario de login para el alumno
            db.run(`INSERT OR IGNORE INTO users (username, password, name, role, area, email, dni, legajo, alumno_id, activo)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                ['alumno@test.pusap.edu.ar', hash, 'María González', 'alumno', null, 'alumno@test.pusap.edu.ar', '30123456', '2024-001', alumnoId],
                (err) => { if (err && !err.message.includes('UNIQUE')) console.error(err.message); }
            );

            // Inscribir al alumno en la carrera 1
            db.get("SELECT id FROM carreras WHERE nombre LIKE 'Tecnicatura%' LIMIT 1", [], (err, carrera) => {
                if (carrera) {
                    db.run(`INSERT OR IGNORE INTO alumno_carreras (alumno_id, carrera_id, estado, fecha_inicio)
                        VALUES (?, ?, 'activo', date('now', '-1 year'))`,
                        [alumnoId, carrera.id]);

                    // Cursos activos
                    const cursos = [
                        ['Matemática Financiera', '1A', 'Prof. Roberto Silva', 'Lunes y Miércoles 18:00-20:00', 'presencial', 'Aula 5', '2025'],
                        ['Administración General', '1A', 'Prof. Ana Pérez', 'Martes y Jueves 18:00-20:00', 'presencial', 'Aula 3', '2025'],
                        ['Contabilidad I', '1A', 'Prof. Carlos Ruiz', 'Viernes 17:00-21:00', 'presencial', 'Aula 7', '2025'],
                    ];
                    cursos.forEach(([nombre, comision, docente, dias, modalidad, aula, anio]) => {
                        db.run(`INSERT OR IGNORE INTO cursos (carrera_id, nombre, comision, docente, dias_horarios, modalidad, aula, anio_lectivo)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [carrera.id, nombre, comision, docente, dias, modalidad, aula, anio],
                            function(err) {
                                if (!err) {
                                    db.run(`INSERT OR IGNORE INTO alumno_cursos (alumno_id, curso_id, estado_cursada) VALUES (?, ?, 'cursando')`,
                                        [alumnoId, this.lastID]);
                                }
                            }
                        );
                    });
                }
            });

            // Cuotas del alumno
            const hoy = new Date();
            const cuotas = [
                { concepto: 'Matrícula 2025', periodo: '2025', monto: 15000, diasOffset: -90, estado: 'pagada', fecha_pago: '2025-02-10' },
                { concepto: 'Cuota 1/10 - Marzo 2025', periodo: '2025-03', monto: 8500, diasOffset: -60, estado: 'pagada', fecha_pago: '2025-03-08' },
                { concepto: 'Cuota 2/10 - Abril 2025', periodo: '2025-04', monto: 8500, diasOffset: -30, estado: 'pagada', fecha_pago: '2025-04-12' },
                { concepto: 'Cuota 3/10 - Mayo 2025', periodo: '2025-05', monto: 8500, diasOffset: -10, estado: 'pendiente', fecha_pago: null },
                { concepto: 'Cuota 4/10 - Junio 2025', periodo: '2025-06', monto: 8500, diasOffset: 20, estado: 'pendiente', fecha_pago: null },
                { concepto: 'Cuota 5/10 - Julio 2025', periodo: '2025-07', monto: 8500, diasOffset: 50, estado: 'pendiente', fecha_pago: null },
            ];
            cuotas.forEach(c => {
                const venc = new Date(hoy);
                venc.setDate(venc.getDate() + c.diasOffset);
                const vencStr = venc.toISOString().split('T')[0];
                db.run(`INSERT OR IGNORE INTO cuotas (alumno_id, concepto, periodo, monto, vencimiento, estado, fecha_pago)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [alumnoId, c.concepto, c.periodo, c.monto, vencStr, c.estado, c.fecha_pago]);
            });

            // Solicitud de ejemplo
            db.get("SELECT id FROM tipos_solicitud WHERE nombre LIKE 'Certificado%' LIMIT 1", [], (err, tipo) => {
                if (tipo) {
                    db.run(`INSERT INTO solicitudes_doc (alumno_id, tipo_solicitud_id, estado)
                        VALUES (?, ?, 'enviada')`,
                        [alumnoId, tipo.id],
                        function(err) {
                            if (!err) {
                                db.run(`INSERT INTO solicitud_historia (solicitud_id, user_id, user_name, estado_anterior, estado_nuevo, comentario)
                                    VALUES (?, 0, 'Sistema', 'borrador', 'enviada', 'Solicitud enviada por el alumno.')`,
                                    [this.lastID]);
                            }
                        }
                    );
                }
            });

            console.log(`✅ Alumno de prueba creado: María González | legajo: 2024-001 | dni: 30123456`);
            console.log(`   Login: alumno@test.pusap.edu.ar / alumno123`);
        }
    );

    // Novedades de ejemplo
    db.run(`INSERT OR IGNORE INTO novedades (titulo, cuerpo, destacada, activo)
        VALUES (?, ?, 1, 1)`,
        ['Inscripciones 2025 abiertas', 'Las inscripciones para el ciclo lectivo 2025 ya están abiertas. Acercate a la Mesa de Entrada con tu documentación.', ]);
    db.run(`INSERT OR IGNORE INTO novedades (titulo, cuerpo, destacada, activo)
        VALUES (?, ?, 0, 1)`,
        ['Actualización del Reglamento Académico', 'Informamos que el Reglamento Académico fue actualizado. Podés descargar la versión vigente en la sección Reglamentos.']);

    setTimeout(() => {
        console.log('🌱 Seed completado.');
        process.exit(0);
    }, 2000);
}, 500);
