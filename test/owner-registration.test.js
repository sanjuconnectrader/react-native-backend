import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';

process.env.DB_PASSWORD = 'test-password';
process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-characters';
process.env.OTP_SECRET = 'test-otp-secret-at-least-32-characters';
process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_USER = 'test-user';
process.env.SMTP_PASS = 'test-password';
process.env.SMTP_FROM = 'ServeFlow POS <test@example.com>';

let sent;
nodemailer.createTransport = () => ({ sendMail: async (message) => { sent = message; } });

const { db } = await import('../src/config/database.js');
const { User, RefreshSession, OTPVerification } = await import('../src/models/index.js');
const { setPassword } = await import('../src/services/auth-service.js');

test('verified owner sets a password, receives a session and username email without another OTP', async (t) => {
  const user = {
    id: 'owner-1', restaurantId: 'restaurant-1', username: 'ABC1234XYZ',
    firstName: 'Asha', lastName: 'Shah', role: 'OWNER', email: 'asha@example.com',
    emailVerifiedAt: new Date(), active: false,
    async save() {},
  };
  t.mock.method(db, 'transaction', async (action) => action({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(RefreshSession, 'create', async () => ({}));
  t.mock.method(OTPVerification, 'create', async () => { throw new Error('Unexpected second OTP'); });

  const setupToken = jwt.sign({ purpose: 'PASSWORD_SETUP' }, process.env.JWT_SECRET,
    { subject: user.id, issuer: 'serveflow-pos', expiresIn: '10m', algorithm: 'HS256' });
  const result = await setPassword(user.username, 'a-long-secure-password', setupToken);

  assert.equal(user.active, true);
  assert.ok(user.passwordHash);
  assert.equal(result.user.username, user.username);
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  assert.equal(sent.to, user.email);
  assert.match(sent.text, /successfully registered/);
  assert.match(sent.text, new RegExp(user.username));
});
