/**
 * modules/emailAlerts/mailer.js
 *
 * Sends one email. Works with ANY email service that gives SMTP details
 * (Google Workspace / Gmail, Resend, Brevo, SendGrid, Amazon SES, Zoho...).
 * Change service = change the .env values only, never this code.
 *
 * .env:
 *   SMTP_HOST=smtp.example.com
 *   SMTP_PORT=587               (465 = SSL)
 *   SMTP_USER=...
 *   SMTP_PASS=...
 *   EMAIL_FROM=InsideMarkets <alerts@yourdomain.com>
 */

const nodemailer = require('nodemailer');

let transport = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_FROM);
}

function getTransport() {
  if (!isConfigured()) {
    throw new Error('Email is not set up yet: add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and EMAIL_FROM to .env');
  }
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      pool: true,          // one connection for many emails
      maxConnections: 2,
      rateDelta: 1000,
      rateLimit: 5,        // max 5 emails per second (providers block faster sending)
    });
  }
  return transport;
}

/** @returns {Promise<string>} the provider's message id */
async function sendEmail({ to, subject, html, text }) {
  const info = await getTransport().sendMail({ from: process.env.EMAIL_FROM, to, subject, html, text });
  return info.messageId;
}

module.exports = { sendEmail, isConfigured };