# Mesa de Entrada Virtual - PUSAP

Este es un sistema completo de "Mesa de Entrada Virtual" para el Centro Universitario PUSAP. Permite a los estudiantes y aspirantes ingresar trámites (certificados, equivalencias, inscripciones), realizar un seguimiento con un código único, y a los administrativos gestionar dichos trámites desde un panel de control.

## Características Principales

*   **Portal de Estudiantes:** 
    *   Formulario de ingreso de nuevos trámites.
    *   Generación automática de códigos únicos de seguimiento (Ej: `PUSAP-ABC123`).
    *   Módulo de consulta de estado de trámite en tiempo real.
*   **Panel Administrativo:**
    *   Sistema de acceso seguro (Login).
    *   Dashboard interactivo con estadísticas en tiempo real (Pendientes, En Proceso, Resueltos).
    *   Tabla de gestión para actualizar el estado de los trámites.
*   **Base de Datos Integrada:** Utiliza SQLite, lo que significa que no requiere instalación de un motor de base de datos externo (MySQL/PostgreSQL). Todo se guarda localmente en un archivo `.db`.
*   **Diseño Responsivo:** Interfaz moderna y adaptable a celulares construida con Tailwind CSS y FontAwesome.

## Requisitos Previos

*   [Node.js](https://nodejs.org/es/) instalado en la computadora donde se ejecutará.

## Instalación y Ejecución

1.  Abrir una terminal o consola de comandos en esta misma carpeta.
2.  Instalar las dependencias (si no se instalaron previamente):
    ```bash
    npm install
    ```
3.  Iniciar el servidor web:
    ```bash
    npm start
    ```
4.  Abrir el navegador web y acceder a: **http://localhost:3000**

## Datos de Acceso al Panel de Administración

*   **URL:** http://localhost:3000/login
*   **Usuario:** `admin`
*   **Contraseña:** `puasap2024`

## Tecnologías Utilizadas

*   **Backend:** Node.js, Express.
*   **Frontend:** HTML5, EJS (Motor de Plantillas), Tailwind CSS (Framework CSS).
*   **Base de Datos:** SQLite3.
