const nodemailer = require('nodemailer');

// Mock transporter using Ethereal Email for dev/demo purposes
let transporter;
nodemailer.createTestAccount((err, account) => {
    if (err) {
        console.error('Failed to create a testing account. ' + err.message);
        return;
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
});

const sendStatusUpdateEmail = async (email, trackingCode, newStatus, messageInfo = '', dueDate = null) => {
    if (!transporter) return;
    
    let subject = `Actualización de Trámite PUSAP: ${trackingCode}`;
    let html = `<h3>Su trámite <strong>${trackingCode}</strong> ha sido actualizado.</h3>
                <p>Nuevo estado: <strong style="color: #1e3a8a;">${newStatus}</strong></p>`;
    
    if (newStatus === 'Pendiente de Documentación') {
        html += `<p style="color: #dc2626; font-weight: bold;">Es necesario que regularice su situación.</p>
                 <p>${messageInfo || 'Por favor, acérquese a la institución o comuníquese para conocer la documentación faltante.'}</p>`;
    } else if (messageInfo) {
        html += `<p>Comentario: ${messageInfo}</p>`;
    }

    if (dueDate) {
        html += `<p style="color: #ca8a04; font-weight: bold;">Atención: Su trámite tiene una fecha de vencimiento o límite el día ${dueDate}.</p>`;
    }
    
    html += `<hr><p>Puede consultar el estado actual en nuestro portal público ingresando su DNI y código de seguimiento.</p>`;

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
    if (!transporter) return;
    
    let subject = `Trámite Iniciado PUSAP: ${trackingCode}`;
    let html = `<h3>Hola ${first_name}, tu trámite ha sido ingresado correctamente.</h3>
                <p>Tu código de seguimiento oficial es: <strong style="color: #1e3a8a; font-size: 1.2em;">${trackingCode}</strong></p>
                <p>Guarda este código con seguridad. Podrás utilizarlo junto a tu DNI para consultar el estado de tu expediente en nuestro portal web.</p>
                <br>
                <hr>
                <p style="color: #666; font-size: 0.9em;">Este es un mensaje automático del Sistema de Mesa de Entrada Virtual del Centro Universitario PUSAP.</p>`;
    
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

module.exports = { sendStatusUpdateEmail, sendTicketCreatedEmail };
