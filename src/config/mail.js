import nodemailer from 'nodemailer';
const fromAddress = process.env.SMTP_FROM;
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 15000,
  greetingTimeout: 30000,
  socketTimeout: 30000,
}) : null;
export const mailConfigured = Boolean(mailer && process.env.SMTP_USER && process.env.SMTP_PASS && fromAddress);
export const mailProvider = mailConfigured ? 'Nodemailer SMTP' : null;
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
async function sendMessage(message) {
  if (!mailConfigured) throw new Error('Email service is not configured');
  await withConnectionRetry(() => mailer.sendMail({ from: fromAddress, ...message }));
}
export async function sendOtp(email, purpose, code) {
  const subject = {
    EMAIL_VERIFICATION: 'Verify your email', LOGIN_2FA: 'Your login code', PASSWORD_RESET: 'Reset your password',
  }[purpose];
  const message = { to: email, subject, text: `Your ${subject.toLowerCase()} is ${code}. It expires in 10 minutes.` };
  await sendMessage(message);
}
export async function sendRegistrationVerification(email, username, code, link) {
  await sendMessage({
    to: email,
    subject: 'Verify your ServeFlow POS account',
    text: `Welcome to ServeFlow POS.\n\nYour username: ${username}\n\nEnter this code in the app: ${code}\nThe code expires in 10 minutes.\n\nOr open this secure link to verify your account and set a password: ${link}\nThe link expires in 24 hours and can be used once.\n\nIf you did not register, ignore this email.`,
  });
}
export async function sendRegistrationConfirmation(email, username) {
  await sendMessage({ to: email, subject: 'Your ServeFlow POS account is ready', text: `Your ServeFlow POS account has been successfully registered.\n\nUsername: ${username}\n\nYou can now sign in with this username and your password.` });
}
