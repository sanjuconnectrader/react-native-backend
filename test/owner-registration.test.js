import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
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
const { User, Restaurant, RefreshSession, OTPVerification, EmailVerificationToken, AuditLog } = await import('../src/models/index.js');
const { registerOwner, setPassword, validateVerificationLink, completeVerificationLink, resendEmailVerification, verifyEmail, ownerLogin, ownerLoginVerify } = await import('../src/services/auth-service.js');

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
  t.mock.method(EmailVerificationToken, 'update', async () => [0]);

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

test('a valid email link sets the password once and marks the owner verified', async (t) => {
  const raw = 'a'.repeat(43);
  const user = { id: 'owner-2', restaurantId: 'restaurant-2', username: 'XYZ1234ABC', email: 'owner@example.com', role: 'OWNER', active: false, emailVerifiedAt: null, async save() {} };
  const record = { userId: user.id, expiresAt: new Date(Date.now() + 86_400_000), consumedAt: null, async save() {} };
  t.mock.method(db, 'transaction', async (action) => action({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(User, 'findByPk', async () => user);
  t.mock.method(EmailVerificationToken, 'findOne', async () => record);
  t.mock.method(EmailVerificationToken, 'update', async () => [1]);
  t.mock.method(OTPVerification, 'update', async () => [1]);
  const details = await validateVerificationLink(raw);
  assert.equal(details.username, user.username);
  const result = await completeVerificationLink(raw, 'a-long-secure-password');
  assert.equal(result.username, user.username);
  assert.equal(user.active, true);
  assert.ok(user.emailVerifiedAt);
  assert.ok(user.passwordHash);
  assert.ok(record.consumedAt);
  await assert.rejects(() => completeVerificationLink(raw, 'another-long-password'), { code: 'LINK_USED' });
});

test('expired email links cannot be completed', async (t) => {
  const record = { userId: 'owner-3', expiresAt: new Date(Date.now() - 1), consumedAt: null };
  t.mock.method(db, 'transaction', async (action) => action({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(EmailVerificationToken, 'findOne', async () => record);
  t.mock.method(User, 'findByPk', async () => ({ id: 'owner-3', role: 'OWNER', active: false }));
  await assert.rejects(() => validateVerificationLink('b'.repeat(43)), { code: 'LINK_EXPIRED' });
  await assert.rejects(() => completeVerificationLink('b'.repeat(43), 'a-long-secure-password'), { code: 'LINK_EXPIRED' });
});

test('resending to a pending owner sends a fresh OTP and username without a link', async (t) => {
  const user = { id: 'owner-4', username: 'NEW1234OWN', email: 'new@example.com', role: 'OWNER', active: false };
  let otp;
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(OTPVerification, 'findOne', async () => null);
  t.mock.method(OTPVerification, 'count', async () => 0);
  t.mock.method(OTPVerification, 'create', async (data) => { otp = data; return { id: 'otp-4', destroy: async () => {} }; });
  t.mock.method(EmailVerificationToken, 'create', async () => { throw new Error('New emails must not create links'); });
  t.mock.method(OTPVerification, 'update', async () => [0]);
  t.mock.method(EmailVerificationToken, 'update', async () => [0]);
  await resendEmailVerification(user.email);
  assert.equal(otp.purpose, 'EMAIL_VERIFICATION');
  assert.ok(otp.expiresAt.getTime() - Date.now() <= 600_000);
  assert.equal(sent.to, user.email);
  assert.match(sent.text, new RegExp(user.username));
  assert.match(sent.text, /\b\d{6}\b/);
  assert.doesNotMatch(sent.text, /https?:\/\/|verify-email#token|localhost/);
});

test('OTP verification still returns a password setup challenge', async (t) => {
  const user = { id: 'owner-5', username: 'OTP1234OWN', role: 'OWNER', active: false, async save() {} };
  const record = { codeHash: crypto.createHmac('sha256', process.env.OTP_SECRET).update(`${user.id}:EMAIL_VERIFICATION:123456`).digest('hex'), expiresAt: new Date(Date.now() + 600_000), attempts: 0, consumedAt: null, async save() {} };
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(db, 'transaction', async (action) => action({ LOCK: { UPDATE: 'UPDATE' } }));
  t.mock.method(OTPVerification, 'findOne', async () => record);
  const result = await verifyEmail(user.username, '123456');
  assert.equal(result.username, user.username);
  assert.equal(jwt.verify(result.setupToken, process.env.JWT_SECRET).purpose, 'PASSWORD_SETUP');
  assert.equal(record.attempts, 1);
  assert.ok(record.consumedAt);
  assert.ok(user.emailVerifiedAt);
});

test('pending login sends a new code and keeps the public failure indistinguishable from an unknown username', async (t) => {
  const pending = { id: 'owner-5a', username: 'NEW1234OWN', email: 'new@example.com', role: 'OWNER', active: false };
  let found = pending;
  t.mock.method(User, 'findOne', async () => found);
  t.mock.method(OTPVerification, 'findOne', async () => null);
  t.mock.method(OTPVerification, 'count', async () => 0);
  t.mock.method(OTPVerification, 'create', async () => ({ id: 'otp-5a', destroy: async () => {} }));
  t.mock.method(EmailVerificationToken, 'create', async () => { throw new Error('New emails must not create links'); });
  t.mock.method(OTPVerification, 'update', async () => [0]);
  t.mock.method(EmailVerificationToken, 'update', async () => [0]);
  t.mock.method(Restaurant, 'create', async () => { throw new Error('Login must not create a restaurant'); });
  sent = null;
  const pendingFailure = await ownerLogin(pending.username, 'anything').catch((error) => error);
  assert.equal(sent.to, pending.email);
  assert.match(sent.text, /\b\d{6}\b/);
  assert.doesNotMatch(sent.text, /https?:\/\/|verify-email#token|localhost/);
  assert.match(sent.text, new RegExp(pending.username));
  found = null;
  sent = null;
  const unknownFailure = await ownerLogin(pending.username, 'anything').catch((error) => error);
  assert.equal(pendingFailure.status, 401);
  assert.equal(pendingFailure.code, unknownFailure.code);
  assert.equal(pendingFailure.message, unknownFailure.message);
  assert.equal(sent, null);
});

test('a registration proof allows the exact pending message without disclosing other accounts', async (t) => {
  const pending = { id: 'owner-5b', username: 'NEW1234OWN', email: 'new@example.com', role: 'OWNER', active: false };
  t.mock.method(User, 'findOne', async () => pending);
  t.mock.method(OTPVerification, 'findOne', async () => ({ lastSentAt: new Date() }));
  t.mock.method(OTPVerification, 'create', async () => { throw new Error('Cooldown should block a second email'); });
  const proof = jwt.sign({ purpose: 'PENDING_REGISTRATION' }, process.env.JWT_SECRET, { subject: pending.id, issuer: 'serveflow-pos', expiresIn: '30d', algorithm: 'HS256' });
  await assert.rejects(() => ownerLogin(pending.username, 'anything', proof), { code: 'ACCOUNT_UNVERIFIED', message: "Your account has not been verified yet. We've sent a verification code and your username to your registered email address. Please verify your account and set your password before logging in." });
  const wrongOwnerProof = jwt.sign({ purpose: 'PENDING_REGISTRATION' }, process.env.JWT_SECRET, { subject: 'another-owner', issuer: 'serveflow-pos', expiresIn: '30d', algorithm: 'HS256' });
  await assert.rejects(() => ownerLogin(pending.username, 'anything', wrongOwnerProof), { code: 'INVALID_CREDENTIALS' });
});

test('registration email requests stop at five per account per hour', async (t) => {
  const pending = { id: 'owner-5c', username: 'NEW1234OWN', email: 'new@example.com', role: 'OWNER', active: false };
  t.mock.method(User, 'findOne', async () => pending);
  t.mock.method(OTPVerification, 'findOne', async () => null);
  t.mock.method(OTPVerification, 'count', async () => 5);
  t.mock.method(OTPVerification, 'create', async () => { throw new Error('Hourly limit should block a sixth email'); });
  const proof = jwt.sign({ purpose: 'PENDING_REGISTRATION' }, process.env.JWT_SECRET, { subject: pending.id, issuer: 'serveflow-pos', expiresIn: '30d', algorithm: 'HS256' });
  await assert.rejects(() => ownerLogin(pending.username, 'anything', proof), { code: 'ACCOUNT_UNVERIFIED' });
});

test('registering a pending email resumes the existing account', async (t) => {
  const pending = { id: 'owner-6', username: 'OLD1234OWN', email: 'pending@example.com', role: 'OWNER', active: false };
  t.mock.method(User, 'findOne', async () => pending);
  t.mock.method(OTPVerification, 'findOne', async () => ({ lastSentAt: new Date() }));
  t.mock.method(Restaurant, 'create', async () => { throw new Error('Unexpected duplicate restaurant'); });
  const result = await registerOwner({ owner: { firstName: 'Asha', lastName: 'Shah', email: pending.email, phoneCountryCode: 'IN', phone: '9876543210' }, restaurant: { name: 'Test Restaurant', businessType: 'Cafe', address: 'Main St', city: 'Mumbai', state: 'Maharashtra', postalCode: '400001', timezone: 'UTC' } });
  assert.equal(result.username, pending.username);
});

test('new registration returns a limited proof for its own pending login', async (t) => {
  let created;
  t.mock.method(User, 'findOne', async () => null);
  t.mock.method(Restaurant, 'create', async () => ({ id: 'restaurant-8' }));
  t.mock.method(User, 'create', async (data) => { created = { id: 'owner-8', ...data, active: false }; return created; });
  t.mock.method(db, 'transaction', async (action) => action({}));
  t.mock.method(OTPVerification, 'findOne', async () => null);
  t.mock.method(OTPVerification, 'count', async () => 0);
  t.mock.method(OTPVerification, 'create', async () => ({ id: 'otp-8', destroy: async () => {} }));
  t.mock.method(EmailVerificationToken, 'create', async () => { throw new Error('New emails must not create links'); });
  t.mock.method(OTPVerification, 'update', async () => [0]);
  t.mock.method(EmailVerificationToken, 'update', async () => [0]);
  const result = await registerOwner({ owner: { firstName: 'Asha', lastName: 'Shah', email: 'newowner@example.com', phoneCountryCode: 'IN', phone: '9876543210' }, restaurant: { name: 'Test Restaurant', businessType: 'Cafe', address: 'Main St', city: 'Mumbai', state: 'Maharashtra', postalCode: '400001', timezone: 'UTC' } });
  assert.equal(result.username, created.username);
  const claims = jwt.verify(result.recoveryToken, process.env.JWT_SECRET);
  assert.equal(claims.sub, created.id);
  assert.equal(claims.purpose, 'PENDING_REGISTRATION');
});

test('email-only resend gives the same response for pending and unknown addresses', async (t) => {
  let found = { id: 'owner-9', email: 'pending@example.com', active: false };
  t.mock.method(User, 'findOne', async () => found);
  t.mock.method(OTPVerification, 'findOne', async () => ({ lastSentAt: new Date() }));
  const pending = await resendEmailVerification('pending@example.com');
  found = null;
  const unknown = await resendEmailVerification('unknown@example.com');
  assert.deepEqual(pending, unknown);
});

test('pending login OTP completes setup and permits password login', async (t) => {
  const password = 'a-long-secure-password';
  const user = { id: 'owner-10', restaurantId: 'restaurant-10', username: 'TEN1234OWN', email: 'ten@example.com', firstName: 'Asha', lastName: 'Shah', role: 'OWNER', active: false, emailVerifiedAt: null, async save() {} };
  let otp;
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(OTPVerification, 'findOne', async ({ where }) => where.purpose === 'EMAIL_VERIFICATION' ? otp || null : null);
  t.mock.method(OTPVerification, 'count', async () => 0);
  t.mock.method(OTPVerification, 'create', async (data) => { otp = { id: crypto.randomUUID(), ...data, attempts: 0, consumedAt: null, async save() {}, async destroy() {} }; return otp; });
  t.mock.method(OTPVerification, 'update', async () => [1]);
  t.mock.method(EmailVerificationToken, 'create', async () => { throw new Error('New emails must not create links'); });
  t.mock.method(EmailVerificationToken, 'update', async () => [1]);
  t.mock.method(RefreshSession, 'create', async () => ({}));
  t.mock.method(db, 'transaction', async (action) => action({ LOCK: { UPDATE: 'UPDATE' } }));
  const proof = jwt.sign({ purpose: 'PENDING_REGISTRATION' }, process.env.JWT_SECRET, { subject: user.id, issuer: 'serveflow-pos', expiresIn: '30d', algorithm: 'HS256' });
  await assert.rejects(() => ownerLogin(user.username, password, proof), { code: 'ACCOUNT_UNVERIFIED' });
  const code = sent.text.match(/\b\d{6}\b/)[0];
  assert.doesNotMatch(sent.text, /https?:\/\/|verify-email#token|localhost/);
  const verification = await verifyEmail(user.username, code);
  assert.ok(otp.consumedAt);
  await setPassword(user.username, password, verification.setupToken);
  await assert.rejects(() => verifyEmail(user.username, code), { code: 'INVALID_STATE' });
  const login = await ownerLogin(user.username, password);
  assert.ok(login.loginChallenge);
});

test('an activated owner can complete password login and email 2FA', async (t) => {
  const password = 'a-long-secure-password';
  const user = { id: 'owner-7', restaurantId: 'restaurant-7', username: 'YES1234OWN', email: 'yes@example.com', firstName: 'Asha', lastName: 'Shah', role: 'OWNER', active: true, passwordHash: await bcrypt.hash(password, 4) };
  let otp;
  t.mock.method(User, 'findOne', async () => user);
  t.mock.method(OTPVerification, 'findOne', async () => otp || null);
  t.mock.method(OTPVerification, 'create', async (data) => { otp = { ...data, attempts: 0, consumedAt: null, async save() {} }; return otp; });
  t.mock.method(RefreshSession, 'create', async () => ({}));
  t.mock.method(AuditLog, 'create', async () => ({}));
  t.mock.method(db, 'transaction', async (action) => action({ LOCK: { UPDATE: 'UPDATE' } }));
  const start = await ownerLogin(user.username, password);
  const code = sent.text.match(/\b\d{6}\b/)[0];
  const session = await ownerLoginVerify(user.username, code, start.loginChallenge);
  assert.equal(session.user.username, user.username);
  assert.ok(session.accessToken);
  assert.ok(otp.consumedAt);
});
