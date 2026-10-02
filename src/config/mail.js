import nodemailer from 'nodemailer';
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 15000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
}) : null;
export const mailConfigured = Boolean(mailer && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
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
  await withConnectionRetry(() => mailer.verify());
  return true;
}
export async function sendOtp(email, purpose, code) {
  if (!mailConfigured) throw new Error('SMTP is not configured');
  const subject = {
    EMAIL_VERIFICATION: 'Verify your email', LOGIN_2FA: 'Your login code', PASSWORD_RESET: 'Reset your password',
  }[purpose];
  await withConnectionRetry(() => mailer.sendMail({ from: process.env.SMTP_FROM, to: email, subject,
    text: `Your ${subject.toLowerCase()} is ${code}. It expires in 10 minutes.`, }));
}
