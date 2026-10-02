import { Router } from 'express';
import Joi from 'joi';
import * as auth from '../services/auth-service.js';
import { authenticate } from '../middleware/auth.js';
import { User, Restaurant } from '../models/index.js';
import { ok } from '../utils/response.js';
const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const check = (schema) => (req, _res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(Object.assign(new Error(error.details.map((e) => e.message).join('; ')), { status: 400, code: 'VALIDATION_ERROR' }));
  req.body = value; next();
};
const username = Joi.string().trim().min(7).max(20).required();
const code = Joi.string().pattern(/^\d{6}$/).required();
const password = Joi.string().min(12).max(128).required();
router.post('/owner/register', check(Joi.object({ owner: Joi.object({ firstName: Joi.string().required(), lastName: Joi.string().required(), email: Joi.string().email().required(), phoneCountryCode: Joi.string().length(2).uppercase().required(), phone: Joi.string().required() }).required(),
  restaurant: Joi.object({ name: Joi.string().required(), businessType: Joi.string().required(), address: Joi.string().required(), city: Joi.string().required(), state: Joi.string().required(), postalCode: Joi.string().required(),
    timezone: Joi.string().max(100).optional() }).required() })),
  wrap(async (req, res) => ok(res, await auth.registerOwner(req.body), 'Registration started', 201)));
router.post('/owner/verify-email', check(Joi.object({ username, code })), wrap(async (req, res) => ok(res, await auth.verifyEmail(req.body.username, req.body.code))));
router.post('/owner/resend-code', check(Joi.object({ username })), wrap(async (req, res) => ok(res, await auth.resendEmailVerification(req.body.username))));
router.post('/owner/set-password', check(Joi.object({ username, password, setupToken: Joi.string().required() })), wrap(async (req, res) => ok(res, await auth.setPassword(req.body.username, req.body.password, req.body.setupToken))));
router.post('/owner/activate', check(Joi.object({ username, code, activationChallenge: Joi.string().required() })), wrap(async (req, res) => ok(res, await auth.activateOwner(req.body.username, req.body.code, req.body.activationChallenge))));
router.post('/owner/login', check(Joi.object({ username, password: Joi.string().required() })), wrap(async (req, res) => ok(res, await auth.ownerLogin(req.body.username, req.body.password))));
router.post('/owner/verify-login', check(Joi.object({ username, code, loginChallenge: Joi.string().required() })), wrap(async (req, res) => ok(res, await auth.ownerLoginVerify(req.body.username, req.body.code, req.body.loginChallenge))));
router.post('/employee/login', check(Joi.object({ username, pin: Joi.string().pattern(/^\d{4,8}$/).required() })), wrap(async (req, res) => ok(res, await auth.employeeLogin(req.body.username, req.body.pin))));
router.post('/refresh', check(Joi.object({ refreshToken: Joi.string().required() })), wrap(async (req, res) => ok(res, await auth.refreshSession(req.body.refreshToken))));
router.post('/logout', authenticate, check(Joi.object({ refreshToken: Joi.string().required() })), wrap(async (req, res) => { await auth.logout(req.body.refreshToken, req.auth.userId); ok(res, {}); }));
router.post('/logout-all', authenticate, wrap(async (req, res) => { await auth.logout('', req.auth.userId, true); ok(res, {}); }));
router.get('/me', authenticate, wrap(async (req, res) => {
  const [user, restaurant] = await Promise.all([
    User.findByPk(req.auth.userId),
    Restaurant.findByPk(req.auth.restaurantId),
  ]);
  ok(res, {
    user: auth.publicUser(user),
    permissions: req.auth.permissions,
    restaurant: { id: restaurant.id, name: restaurant.name, countryCode: restaurant.countryCode, currencyCode: restaurant.currencyCode, locale: restaurant.locale, timezone: restaurant.timezone },
  });
}));
router.post('/owner/forgot-password', check(Joi.object({ usernameOrEmail: Joi.string().required() })), wrap(async (req, res) => ok(res, await auth.requestPasswordReset(req.body.usernameOrEmail))));
router.post('/owner/reset-password', check(Joi.object({ username, code, password })), wrap(async (req, res) => { await auth.resetPassword(req.body.username, req.body.code, req.body.password); ok(res, {}); }));
export default router;
