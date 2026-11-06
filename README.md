# Mesa de Entrada Virtual - PUSAP

Sistema web del Centro Universitario PUSAP con **tres caras separadas**, cada una con su propia navegación y sus propios permisos:

| Cara | Quién entra | Qué hace |
|---|---|---|
| **Pública** (`/`) | Cualquiera | Sólo **informa**: oferta académica, ventajas de la institución, novedades, preguntas frecuentes y datos de contacto. No se puede iniciar ni consultar trámites sin ingresar. |
| **Portal del alumno** (`/alumno`) | Alumnos con cuenta activa | Ver cursos y cuotas, **hacer consultas** al personal y **solicitar trámites** que se **finalizan presencialmente** en la institución. |
| **Backoffice** (`/backoffice`) | Personal (`operador` e `interno`) | Recibe consultas y solicitudes y **controla todo el contenido** que se muestra en el sitio público y en el portal del alumno. |

Todos ingresan por el mismo formulario (`/ingresar`) y el sistema los lleva a su cara según el rol. Un alumno no puede entrar al backoffice ni el personal al portal del alumno (403).

## Cómo funciona el circuito del alumno

1. El alumno se inscribe **en persona**. El operador lo da de alta en *Padrón de Alumnos* y le entrega un enlace de activación.
2. El alumno activa su cuenta (`/activar/<token>`) e ingresa al portal.
3. Desde el portal puede:
   - **Consultar**: abre una consulta (académica, administrativa, pagos...) y conversa con el personal. Recibe una notificación cuando le responden.
   - **Solicitar un trámite** (certificado, constancia, presentación de documentación...), adjuntando archivos si hace falta.
4. El personal revisa la solicitud: la pone *en revisión*, la **observa** (el alumno corrige y reenvía), la **rechaza** (con motivo) o la **aprueba**.
5. Al aprobar, el personal escribe las **indicaciones para finalizar en persona** (qué llevar, desde qué fecha). El alumno las ve en su portal junto con la dirección y el horario de atención.
6. Cuando el alumno se presenta, el personal registra la **finalización presencial** y el trámite queda cerrado.

Estados de una solicitud: `borrador → enviada → en revisión → aprobada → [emitida] → finalizada` (también `observada` y `rechazada`). Las transiciones válidas se validan en el servidor ([lib/solicitud-estados.js](lib/solicitud-estados.js)).

## Qué administra el personal

El **operador** gestiona, desde la barra lateral del backoffice:

- **Carreras y Cursos**: alta, edición, publicar/ocultar y eliminación (sólo si no tienen alumnos).
- **Ventajas**: la sección "Ventajas de estudiar en PUSAP" del inicio público.
- **Novedades** y **Preguntas frecuentes**: cada una indica su **audiencia** (sólo público, sólo alumnos o ambos).
- **Datos institucionales**: textos de portada, dirección, horario presencial, teléfono, email y WhatsApp.
- Padrón de alumnos, tipos de trámite, usuarios, configuración, auditoría y papelera.

El personal **interno** (áreas) atiende solicitudes, consultas y expedientes de Mesa, pero no administra el contenido del sitio.

## Requisitos e instalación

*   [Node.js](https://nodejs.org/es/) instalado.

```bash
npm install
cp .env.example .env     # completar SESSION_SECRET y, opcionalmente, SMTP
npm start                # http://localhost:3000
npm run seed             # (opcional) alumno de prueba, carreras y novedades de ejemplo
npm test                 # corre toda la suite
```

La base SQLite (`database_v2.db`) se crea y migra sola al iniciar. Para usar otra base, definí `DB_PATH`.

## Usuarios de demostración

En una base nueva se crean estos usuarios de personal, todos con la contraseña **`password`** (cambiala antes de publicar el sistema):

| Usuario | Rol |
|---|---|
| `mesa` | operador (administra todo) |
| `ingresos`, `academica`, `sistema` | interno |

> Si tu `database_v2.db` viene de la primera versión del proyecto (agosto), esas mismas cuentas usan la contraseña **`1234`** en lugar de `password`.

Con `npm run seed` se crea además el alumno `alumno@test.pusap.edu.ar` / `alumno123`.

Todos ingresan por `/ingresar` (el campo "usuario" acepta el nombre de usuario o el email). Para ver las dos caras a la vez usá dos navegadores o una ventana privada: la sesión es una por navegador.

## Tecnologías

*   **Backend:** Node.js, Express 5, sesiones en archivo.
*   **Frontend:** EJS, Tailwind CSS (CDN), FontAwesome.
*   **Base de datos:** SQLite3.
*   **Tests:** `node --test`. Los de integración ([tests/portal-flow.test.js](tests/portal-flow.test.js)) recorren las tres caras sobre una base descartable.

## Estructura

```
routes/public.js      cara pública (sólo informa)
routes/alumno.js      portal del alumno (consultas, trámites, cuotas, cursos)
routes/backoffice.js  backoffice (solicitudes, consultas, contenido del sitio)
routes/tickets.js     expedientes históricos de Mesa de Entrada (/panel)
middleware/auth.js    guards por rol
lib/                  máquina de estados, datos institucionales, helpers de DB
views/                public (raíz) · alumno/ · backoffice/ · partials/
```
