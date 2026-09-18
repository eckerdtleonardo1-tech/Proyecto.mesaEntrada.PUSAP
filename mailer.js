const nodemailer = require('nodemailer');
const db = require('./db');

let transporter;

const initTransporter = async () => {
    return new Promise((resolve) => {
        db.all("SELECT * FROM config", [], (err, rows) => {
            if (!err && rows && rows.length > 0) {
                const config = {};
                rows.forEach(r => config[r.key] = r.value);
                if (config.smtp_host && config.smtp_user && config.smtp_pass) {
                    transporter = nodemailer.createTransport({
                        host: config.smtp_host,
                        port: parseInt(config.smtp_port) || 465,
                        secure: (parseInt(config.smtp_port) === 465),
                        auth: {
                            user: config.smtp_user,
                            pass: config.smtp_pass
                        }
                    });
                    console.log('Using SMTP configuration from DB.');
                    return resolve(true);
                }
            }
            
            // Fallback to Ethereal
            nodemailer.createTestAccount((err, account) => {
                if (err) {
                    console.error('Failed to create a testing account. ' + err.message);
                    return resolve(false);
                }
                transporter = nodemailer.createTransport({
                    host: account.smtp.host,
                    port: account.smtp.port,
                    secure: account.smtp.secure,
                    auth: {
                        user: account.user,
                        pass: account.pass
                    }
                });
                console.log('Ethereal Email account created for notifications.');
                resolve(true);
            });
        });
    });
};

const getEmailTemplate = (title, preheader, content, trackingCode) => {
    return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
            .header { background: #1e3a8a; padding: 30px; text-align: center; color: white; }
            .content { padding: 40px 30px; color: #333; line-height: 1.6; }
            .footer { background: #f8fafc; padding: 20px; text-align: center; color: #64748b; font-size: 13px; border-top: 1px solid #e2e8f0; }
            .btn { display: inline-block; background: #2563eb; color: white; text-decoration: none; padding: 12px 25px; border-radius: 8px; font-weight: 600; margin-top: 20px; }
            .tracking-box { background: #f0fdfa; border: 1px solid #ccfbf1; padding: 15px; border-radius: 8px; text-align: center; margin: 20px 0; }
            .code { font-size: 24px; font-weight: 800; color: #0f766e; letter-spacing: 2px; }
        </style>
    </head>
    <body>
        <div style="display:none;">${preheader}</div>
        <div class="container">
            <div class="header">
                <h1 style="margin: 0; font-size: 24px;">Centro Universitario PUSAP</h1>
                <p style="margin: 5px 0 0; opacity: 0.8;">Sistema de Mesa de Entrada Virtual</p>
            </div>
            <div class="content">
                <h2 style="margin-top: 0; color: #1e293b;">${title}</h2>
                ${content}
                
                <div class="tracking-box">
                    <p style="margin: 0 0 5px; color: #0f766e; font-weight: bold;">CÓDIGO DE SEGUIMIENTO</p>
                    <div class="code">${trackingCode}</div>
                </div>
                
                <div style="text-align: center;">
                    <a href="http://localhost:3000/seguimiento" class="btn">Consultar Estado Online</a>
                </div>
            </div>
            <div class="footer">
                <p style="margin: 0;">Este es un correo generado automáticamente. Por favor no responda a esta dirección.</p>
                <p style="margin: 10px 0 0;">&copy; ${new Date().getFullYear()} PUSAP. Todos los derechos reservados.</p>
            </div>
        </div>
    </body>
    </html>
    `;
};

const sendStatusUpdateEmail = async (email, trackingCode, newStatus, messageInfo = '', dueDate = null) => {
    await initTransporter();
    if (!transporter) return;
    
    let subject = `Actualización de Trámite PUSAP: ${trackingCode}`;
    
    let color = '#333';
    if (newStatus === 'En Revisión') color = '#7c3aed';
    if (newStatus === 'Pendiente de Documentación') color = '#ea580c';
    if (newStatus === 'Aprobado') color = '#16a34a';
    if (newStatus === 'Rechazado') color = '#dc2626';

    let contentHtml = `
        <p>Le informamos que su trámite ha registrado una actualización en nuestro sistema.</p>
        <p>Nuevo estado: <strong style="color: ${color}; font-size: 18px;">${newStatus}</strong></p>
    `;
    
    if (newStatus === 'Pendiente de Documentación') {
        contentHtml += `
            <div style="background: #fff7ed; border-left: 4px solid #ea580c; padding: 15px; margin: 20px 0;">
                <p style="margin: 0 0 10px; color: #9a3412; font-weight: bold;">Acción Requerida</p>
                <p style="margin: 0; color: #78350f;">${messageInfo || 'Por favor, acérquese a la institución o comuníquese para conocer la documentación faltante.'}</p>
            </div>
        `;
    } else if (messageInfo) {
        contentHtml += `
            <div style="background: #f8fafc; border-left: 4px solid #94a3b8; padding: 15px; margin: 20px 0;">
                <p style="margin: 0;"><strong>Comentario del área:</strong><br>${messageInfo}</p>
            </div>
        `;
    }

    if (dueDate) {
        contentHtml += `<p style="color: #ca8a04; font-weight: bold;">Atención: Su trámite tiene una fecha de vencimiento el día ${dueDate}.</p>`;
    }

    const html = getEmailTemplate('Actualización de Trámite', 'Su trámite ha cambiado de estado', contentHtml, trackingCode);

    try {
        let info = await transporter.sendMail({
            from: '"Mesa de Entrada PUSAP" <no-reply@puasap.edu.ar>',
            to: email,
            subject: subject,
            html: html
        });
        console.log(`Email sent to ${email} - Preview URL: %s`, nodemailer.getTestMessageUrl(info));
    } catch (e) {
        console.error('Error sending email:', e);
    }
};

const sendTicketCreatedEmail = async (email, first_name, trackingCode) => {
    await initTransporter();
    if (!transporter) return;
    
    let subject = `Trámite Iniciado PUSAP: ${trackingCode}`;
    
    let contentHtml = `
        <p>Hola <strong>${first_name}</strong>,</p>
        <p>Hemos recibido exitosamente tu solicitud. Tu trámite ya ha sido ingresado a nuestro sistema y se encuentra en estado <strong>Iniciado</strong>.</p>
        <p>A continuación te proporcionamos tu código oficial de seguimiento. Por favor, guárdalo en un lugar seguro, ya que lo necesitarás junto con tu DNI para consultar el avance de tu gestión.</p>
    `;

    const html = getEmailTemplate('¡Trámite Ingresado con Éxito!', 'Tu trámite ha sido registrado en PUSAP', contentHtml, trackingCode);

    try {
        let info = await transporter.sendMail({
            from: '"Mesa de Entrada PUSAP" <no-reply@puasap.edu.ar>',
            to: email,
            subject: subject,
            html: html
        });
        console.log(`[NUEVO TICKET] Email sent to ${email} - Preview URL: %s`, nodemailer.getTestMessageUrl(info));
    } catch (e) {
        console.error('Error sending welcome email:', e);
    }
};

const sendExpirationReminderEmail = async (email, first_name, trackingCode, dueDate) => {
    await initTransporter();
    if (!transporter) return;
    
    let subject = `Recordatorio de Vencimiento PUSAP: ${trackingCode}`;
    
    let contentHtml = `
        <p>Hola <strong>${first_name}</strong>,</p>
        <p>Te recordamos que tu trámite con código <strong>${trackingCode}</strong> está próximo a vencer en 3 días (Vencimiento: <strong>${dueDate}</strong>).</p>
        <p>Por favor, revisá el estado del mismo y acercate a la institución si es necesario presentar documentación o retirar una resolución.</p>
    `;

    const html = getEmailTemplate('¡Atención! Trámite por Vencer', 'Recordatorio de vencimiento de trámite', contentHtml, trackingCode);

    try {
        let info = await transporter.sendMail({
            from: '"Mesa de Entrada PUSAP" <no-reply@puasap.edu.ar>',
            to: email,
            subject: subject,
            html: html
        });
        console.log(`[RECORDATORIO] Email sent to ${email} - Preview URL: %s`, nodemailer.getTestMessageUrl(info));
    } catch (e) {
        console.error('Error sending reminder email:', e);
    }
};

module.exports = { sendStatusUpdateEmail, sendTicketCreatedEmail, sendExpirationReminderEmail };
