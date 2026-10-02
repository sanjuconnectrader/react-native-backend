import nodemailer from 'nodemailer';
const resendApiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.EMAIL_FROM || process.env.SMTP_FROM;
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 15000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
}) : null;
const smtpConfigured = Boolean(mailer && process.env.SMTP_USER && process.env.SMTP_PASS && fromAddress);
const resendConfigured = Boolean(resendApiKey && fromAddress);
export const mailConfigured = resendConfigured || smtpConfigured;
export const mailProvider = resendConfigured ? 'Resend API' : smtpConfigured ? 'Nodemailer SMTP' : null;
async function withConnectionRetry(action) {
  try { return await action(); }
  catch (error) {
    if (error.command !== 'CONN' || !['ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(error.code)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return action();
  }
}
export async function verifyMailConnection() {
  if (!mailConfigured) return false;
  if (resendConfigured) return true;
  await withConnectionRetry(() => mailer.verify());
  return true;
}
async function sendWithResend({ to, subject, text }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromAddress, to: [to], subject, text }),
  });
  if (response.ok) return;
  const details = await response.text();
  const error = new Error(`Resend email failed (${response.status}): ${details}`);
  error.code = response.status === 429 ? 'EMAIL_RATE_LIMITED' : 'EEMAILAPI';
  throw error;
}
export async function sendOtp(email, purpose, code) {
  if (!mailConfigured) throw new Error('Email service is not configured');
  const subject = {
    EMAIL_VERIFICATION: 'Verify your email', LOGIN_2FA: 'Your login code', PASSWORD_RESET: 'Reset your password',
  }[purpose];
  const message = { to: email, subject, text: `Your ${subject.toLowerCase()} is ${code}. It expires in 10 minutes.` };
  if (resendConfigured) return sendWithResend(message);
  await withConnectionRetry(() => mailer.sendMail({ from: fromAddress, ...message }));
}
