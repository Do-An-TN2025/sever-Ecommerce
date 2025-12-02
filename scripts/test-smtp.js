require('dotenv').config();
const nodemailer = require('nodemailer');

(async function () {
  try {
    const isDev = process.env.NODE_ENV !== 'production';
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: isDev,
      debug: isDev,
    });

    console.log('Starting SMTP verify...');
    await new Promise((resolve, reject) => {
      transporter.verify((err, success) => {
        if (err) return reject(err);
        console.log('Verify success:', success);
        resolve(success);
      });
    });

    console.log('Sending test email to', process.env.SMTP_USER || process.env.EMAIL_FROM);
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: process.env.SMTP_USER,
      subject: 'Test SMTP from local dev',
      text: 'This is a test email from scripts/test-smtp.js',
    });

    console.log('Sent:', info && info.messageId);
    process.exit(0);
  } catch (err) {
    console.error('Test SMTP error:', err);
    process.exit(1);
  }
})();
