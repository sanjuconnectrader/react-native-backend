import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Op, UniqueConstraintError } from 'sequelize';
import { db } from '../config/database.js';
import { config } from '../config/env.js';
import { sendOtp, sendRegistrationConfirmation, sendRegistrationVerification, mailConfigured } from '../config/mail.js';
import { User, Restaurant, OTPVerification, EmailVerificationToken, RefreshSession, AuditLog } from '../models/index.js';
import { fail } from '../errors/http-error.js';
import { normalizePhone, resolveCountry } from './country-service.js';

const hash = (value) => crypto.createHmac('sha256', config.otpSecret).update(value).digest('hex');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tokenHash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const normalize = (s) => s.normalize('NFKD').replace(/[^a-zA-Z]/g, '').toUpperCase().padEnd(3, 'X').slice(0, 3);
const publicUser = (u) => ({ id: u.id, username: u.username, firstName: u.firstName, lastName: u.lastName, role: u.role, restaurantId: u.restaurantId, active: u.active });
const challenge = (user, purpose) => jwt.sign({ purpose }, config.jwtSecret, { subject: user.id, issuer: 'serveflow-pos', expiresIn: '10m', algorithm: 'HS256' });
const registrationProof = (user) => jwt.sign({ purpose: 'PENDING_REGISTRATION' }, config.jwtSecret, { subject: user.id, issuer: 'serveflow-pos', expiresIn: '30d', algorithm: 'HS256' });
function validRegistrationProof(raw, user) {
  if (!raw || !user) return false;
  try {
    const claims = jwt.verify(raw, config.jwtSecret, { algorithms: ['HS256'], issuer: 'serveflow-pos' });
    return claims.sub === user.id && claims.purpose === 'PENDING_REGISTRATION';
  } catch { return false; }
}
function verifyChallenge(raw, user, purpose) {
  try {
    const claims = jwt.verify(raw, config.jwtSecret, { algorithms: ['HS256'], issuer: 'serveflow-pos' });
    if (claims.sub !== user.id || claims.purpose !== purpose) throw new Error('Wrong challenge');
  } catch { fail(401, 'INVALID_CHALLENGE', 'Challenge expired or invalid'); }
}

async function uniqueUsername(prefix, suffix = '') {
  for (let i = 0; i < 100; i++) {
    const candidate = `${prefix}${crypto.randomInt(1000, 10000)}${suffix}`;
    if (!(await User.findOne({ where: { username: candidate } }))) return candidate;
  }
  fail(503, 'USERNAME_EXHAUSTED', 'Could not generate a username');
}
async function issueOtp(user, purpose) {
  const prior = await OTPVerification.findOne({ where: { userId: user.id, purpose, consumedAt: null }, order: [['createdAt', 'DESC']] });
  if (prior && Date.now() - prior.lastSentAt.getTime() < 60_000) fail(429, 'OTP_COOLDOWN', 'Please wait before requesting another code');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const record = await OTPVerification.create({ userId: user.id, purpose, codeHash: hash(`${user.id}:${purpose}:${code}`), expiresAt: new Date(Date.now() + 600_000), lastSentAt: new Date() });
  try { await sendOtp(user.email, purpose, code); }
  catch (error) {
    await record.destroy();
    console.error(`Email delivery failed [${error.code || error.name}]: ${error.message}`);
    fail(503, 'EMAIL_UNAVAILABLE', 'Email service is temporarily unreachable. Please retry.');
  }
  return record;
}
async function issueRegistrationVerification(user) {
  const prior = await OTPVerification.findOne({ where: { userId: user.id, purpose: 'EMAIL_VERIFICATION' }, order: [['createdAt', 'DESC']] });
  if (prior && Date.now() - prior.lastSentAt.getTime() < 60_000) fail(429, 'VERIFICATION_COOLDOWN', 'Please wait a minute before requesting another email');
  const sentInHour = await OTPVerification.count({ where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', createdAt: { [Op.gte]: new Date(Date.now() - 60 * 60_000) } } });
  if (sentInHour >= 5) fail(429, 'VERIFICATION_LIMIT', 'Please wait before requesting another verification email');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const now = new Date();
  const otp = await OTPVerification.create({ userId: user.id, purpose: 'EMAIL_VERIFICATION', codeHash: hash(`${user.id}:EMAIL_VERIFICATION:${code}`), expiresAt: new Date(now.getTime() + 600_000), lastSentAt: now });
  try {
    await sendRegistrationVerification(user.email, user.username, code);
  } catch (error) {
    await otp.destroy();
    console.error(`Email delivery failed [${error.code || error.name}]: ${error.message}`);
    fail(503, 'EMAIL_UNAVAILABLE', 'Email service is temporarily unreachable. Please retry.');
  }
  await OTPVerification.update({ consumedAt: now }, { where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', consumedAt: null, id: { [Op.ne]: otp.id } } });
}
async function verifyOtp(user, purpose, code) {
  let rejection;
  await db.transaction(async (transaction) => {
    const record = await OTPVerification.findOne({ where: { userId: user.id, purpose, consumedAt: null }, order: [['createdAt', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
    if (!record || record.expiresAt < new Date()) fail(400, 'OTP_EXPIRED', 'Code expired');
    if (record.attempts >= 5) fail(429, 'OTP_LIMIT', 'Too many attempts');
    record.attempts += 1;
    if (!safeEqual(record.codeHash, hash(`${user.id}:${purpose}:${code}`))) rejection = ['OTP_INVALID', 'Invalid code'];
    else record.consumedAt = new Date();
    await record.save({ transaction });
  });
  if (rejection) fail(400, ...rejection);
}
async function session(user, transaction) {
  const refresh = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 86400_000);
  await RefreshSession.create({ userId: user.id, tokenHash: tokenHash(refresh), expiresAt }, { transaction });
  const accessToken = jwt.sign({ restaurantId: user.restaurantId, role: user.role, type: 'access' }, config.jwtSecret,
    { subject: user.id, issuer: 'serveflow-pos', expiresIn: '15m', algorithm: 'HS256' });
  return { user: publicUser(user), accessToken, refreshToken: refresh, expiresAt };
}
export async function registerOwner(data) {
  if (!mailConfigured) fail(503, 'EMAIL_UNAVAILABLE', 'Email service is not configured');
  const { phoneCountryCode, ...owner } = data.owner;
  const { countryCode, currencyCode, locale } = resolveCountry(phoneCountryCode);
  const phone = normalizePhone(owner.phone, countryCode);
  const timezone = data.restaurant.timezone || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { fail(400, 'INVALID_TIMEZONE', 'Device timezone is invalid'); }
  const email = owner.email.toLowerCase();
  const pending = await User.findOne({ where: { email, role: 'OWNER', active: false } });
  if (pending) {
    const recent = await OTPVerification.findOne({ where: { userId: pending.id, purpose: 'EMAIL_VERIFICATION' }, order: [['createdAt', 'DESC']] });
    if (!recent || Date.now() - recent.lastSentAt.getTime() >= 60_000) await issueRegistrationVerification(pending);
    return { username: pending.username, message: 'Continue verification using the email already sent' };
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const username = await uniqueUsername(normalize(data.restaurant.name), normalize(data.owner.firstName));
    try {
      const result = await db.transaction(async (transaction) => {
        const restaurant = await Restaurant.create({ ...data.restaurant, timezone, countryCode, currencyCode, locale }, { transaction });
        return User.create({ ...owner, phone, email, username, restaurantId: restaurant.id, role: 'OWNER' }, { transaction });
      });
      await issueRegistrationVerification(result);
      return { username, recoveryToken: registrationProof(result), message: 'Verification email sent' };
    } catch (error) {
      if (error instanceof UniqueConstraintError && error.fields?.username) continue;
      throw error;
    }
  }
  fail(503, 'USERNAME_EXHAUSTED', 'Could not generate a username');
}
export async function verifyEmail(username, code) {
  const user = await User.findOne({ where: { username: username.toUpperCase(), role: 'OWNER' } });
  if (!user || user.active) fail(400, 'INVALID_STATE', 'Account is not pending verification');
  await verifyOtp(user, 'EMAIL_VERIFICATION', code);
  user.emailVerifiedAt = new Date(); await user.save();
  return { username: user.username, setupToken: challenge(user, 'PASSWORD_SETUP') };
}
export async function resendEmailVerification(username) {
  const identifier = username.trim();
  const user = await User.findOne({ where: { role: 'OWNER', active: false, [Op.or]: [{ username: identifier.toUpperCase() }, { email: identifier.toLowerCase() }] } });
  if (user) {
    try { await issueRegistrationVerification(user); }
    catch (error) {
      if (!['VERIFICATION_COOLDOWN', 'VERIFICATION_LIMIT', 'EMAIL_UNAVAILABLE'].includes(error.code)) throw error;
    }
  }
  return { message: 'If registration is pending, check your email for your username and verification code. Email requests may be limited.' };
}
export async function validateVerificationLink(rawToken) {
  const record = await EmailVerificationToken.findOne({ where: { tokenHash: tokenHash(rawToken) } });
  if (!record) fail(400, 'LINK_INVALID', 'This verification link is invalid');
  const user = await User.findByPk(record.userId);
  if (record.consumedAt || user?.active) fail(410, 'LINK_USED', 'This verification link has already been used');
  if (record.expiresAt <= new Date()) fail(410, 'LINK_EXPIRED', 'This verification link has expired');
  if (!user || user.role !== 'OWNER') fail(400, 'LINK_INVALID', 'This verification link is invalid');
  return { username: user.username, email: user.email, expiresAt: record.expiresAt };
}
export async function completeVerificationLink(rawToken, password) {
  const passwordHash = await bcrypt.hash(password, 12);
  let user;
  await db.transaction(async (transaction) => {
    const record = await EmailVerificationToken.findOne({ where: { tokenHash: tokenHash(rawToken) }, transaction, lock: transaction.LOCK.UPDATE });
    if (!record) fail(400, 'LINK_INVALID', 'This verification link is invalid');
    user = await User.findByPk(record.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (record.consumedAt || user?.active) fail(410, 'LINK_USED', 'This verification link has already been used');
    if (record.expiresAt <= new Date()) fail(410, 'LINK_EXPIRED', 'This verification link has expired');
    if (!user || user.role !== 'OWNER') fail(400, 'LINK_INVALID', 'This verification link is invalid');
    user.emailVerifiedAt ||= new Date();
    user.passwordHash = passwordHash;
    user.active = true;
    record.consumedAt = new Date();
    await user.save({ transaction });
    await record.save({ transaction });
    await EmailVerificationToken.update({ consumedAt: new Date() }, { where: { userId: user.id, consumedAt: null }, transaction });
    await OTPVerification.update({ consumedAt: new Date() }, { where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', consumedAt: null }, transaction });
  });
  try { await sendRegistrationConfirmation(user.email, user.username); }
  catch (error) { console.error(`Registration confirmation delivery failed [${error.code || error.name}]: ${error.message}`); }
  return { username: user.username };
}
export async function setPassword(username, password, setupToken) {
  const passwordHash = await bcrypt.hash(password, 12);
  const { user, loginSession } = await db.transaction(async (transaction) => {
    const user = await User.findOne({ where: { username: username.toUpperCase(), role: 'OWNER' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!user || !user.emailVerifiedAt || user.active) fail(400, 'INVALID_STATE', 'Email verification required');
    verifyChallenge(setupToken, user, 'PASSWORD_SETUP');
    user.passwordHash = passwordHash;
    user.active = true;
    await user.save({ transaction });
    await EmailVerificationToken.update({ consumedAt: new Date() }, { where: { userId: user.id, consumedAt: null }, transaction });
    return { user, loginSession: await session(user, transaction) };
  });
  try { await sendRegistrationConfirmation(user.email, user.username); }
  catch (error) { console.error(`Registration confirmation delivery failed [${error.code || error.name}]: ${error.message}`); }
  return loginSession;
}
export async function ownerLogin(username, password, recoveryToken) {
  const user = await User.findOne({ where: { username: username.toUpperCase(), role: 'OWNER' } });
  if (user && !user.active) {
    let deliveryUnavailable = false;
    try { await issueRegistrationVerification(user); }
    catch (error) {
      if (!['VERIFICATION_COOLDOWN', 'VERIFICATION_LIMIT', 'EMAIL_UNAVAILABLE'].includes(error.code)) throw error;
      deliveryUnavailable = error.code === 'EMAIL_UNAVAILABLE';
    }
    if (validRegistrationProof(recoveryToken, user)) {
      if (deliveryUnavailable) fail(503, 'EMAIL_UNAVAILABLE', 'Verification email is temporarily unavailable. Please try again later.');
      fail(403, 'ACCOUNT_UNVERIFIED', "Your account has not been verified yet. We've sent a verification code and your username to your registered email address. Please verify your account and set your password before logging in.");
    }
    fail(401, 'INVALID_CREDENTIALS', 'Invalid username or password. If registration is pending, check your email for a verification code.');
  }
  if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) fail(401, 'INVALID_CREDENTIALS', 'Invalid username or password. If registration is pending, check your email for a verification code.');
  await issueOtp(user, 'LOGIN_2FA');
  return { message: 'Login code sent', loginChallenge: challenge(user, 'LOGIN_2FA') };
}
export async function ownerLoginVerify(username, code, loginChallenge) {
  const user = await User.findOne({ where: { username: username.toUpperCase(), role: 'OWNER', active: true } });
  if (!user) fail(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  verifyChallenge(loginChallenge, user, 'LOGIN_2FA');
  await verifyOtp(user, 'LOGIN_2FA', code);
  await AuditLog.create({ restaurantId: user.restaurantId, actorUserId: user.id, action: 'OWNER_LOGIN' });
  return session(user);
}
export async function employeeLogin(username, pin) {
  const { Employee } = await import('../models/index.js');
  const user = await User.findOne({ where: { username: username.toUpperCase(), active: true, role: { [Op.ne]: 'OWNER' } } });
  const employee = user && await Employee.findOne({ where: { userId: user.id } });
  if (!employee || !(await bcrypt.compare(pin, employee.pinHash))) fail(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  await AuditLog.create({ restaurantId: user.restaurantId, actorUserId: user.id, action: 'EMPLOYEE_LOGIN' });
  return session(user);
}
export async function refreshSession(raw) {
  return db.transaction(async (transaction) => {
    const old = await RefreshSession.findOne({ where: { tokenHash: tokenHash(raw || '') }, transaction, lock: transaction.LOCK.UPDATE });
    if (!old || old.revokedAt || old.expiresAt < new Date()) fail(401, 'INVALID_SESSION', 'Invalid session');
    const user = await User.findByPk(old.userId, { transaction });
    if (!user?.active) fail(401, 'INVALID_SESSION', 'Invalid session');
    old.revokedAt = new Date(); await old.save({ transaction });
    return session(user, transaction);
  });
}
export async function logout(raw, userId, all = false) {
  const where = all ? { userId, revokedAt: null } : { userId, tokenHash: tokenHash(raw || ''), revokedAt: null };
  await RefreshSession.update({ revokedAt: new Date() }, { where });
}
export async function requestPasswordReset(usernameOrEmail) {
  const identifier = usernameOrEmail.trim();
  const user = await User.findOne({ where: { role: 'OWNER', [Op.or]: [{ username: identifier.toUpperCase() }, { email: identifier.toLowerCase() }] } });
  if (user) await issueOtp(user, 'PASSWORD_RESET');
  return { message: 'If the account exists, a code was sent' };
}
export async function resetPassword(username, code, password) {
  const user = await User.findOne({ where: { username: username.toUpperCase(), role: 'OWNER' } });
  if (!user) fail(400, 'OTP_INVALID', 'Invalid code');
  await verifyOtp(user, 'PASSWORD_RESET', code);
  await db.transaction(async (transaction) => {
    user.passwordHash = await bcrypt.hash(password, 12);
    await user.save({ transaction });
    await RefreshSession.update({ revokedAt: new Date() }, { where: { userId: user.id, revokedAt: null }, transaction });
    await AuditLog.create({ restaurantId: user.restaurantId, actorUserId: user.id, action: 'PASSWORD_RESET' }, { transaction });
  });
}
export { uniqueUsername, publicUser };
