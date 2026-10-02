import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { Router } from 'express';
import Joi from 'joi';
import { Op } from 'sequelize';
import { db } from '../config/database.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { Restaurant, User, Employee, Category, MenuItem, DiningTable, Reservation, Order, OrderItem, Payment, Refund, Receipt, AuditLog, Role, Permission, RolePermission, RestaurantSetting, Shift } from '../models/index.js';
import { uniqueUsername, publicUser } from '../services/auth-service.js';
import { createOrder, addItem, transition, voidItem, cancelOrder } from '../services/order-service.js';
import { confirmPayment, confirmRefund } from '../services/payment-service.js';
import { cents } from '../utils/money.js';
import { ok } from '../utils/response.js';
import { fail } from '../errors/http-error.js';
import { emitRestaurant } from '../sockets/index.js';
import { ALL_PERMISSIONS } from '../constants/permissions.js';
import { normalizeOptionalPhone } from '../services/country-service.js';

const router = Router();
router.use(authenticate);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const check = (schema) => (req, _res, next) => {
  const { error, value } = schema.validate(req.body, { stripUnknown: true, abortEarly: false });
  if (error) return next(Object.assign(new Error(error.details.map((e) => e.message).join('; ')), { status: 400, code: 'VALIDATION_ERROR' }));
  req.body = value; next();
};
const uuid = Joi.string().uuid().required();
const amount = Joi.string().pattern(/^(0|[1-9]\d{0,10})(\.\d{1,2})?$/).required();
const tenant = (req) => ({ restaurantId: req.auth.restaurantId });

function crud(path, model, permissionView, permissionManage, schema, event) {
  router.get(path, requirePermission(permissionView), wrap(async (req, res) => ok(res, await model.findAll({ where: tenant(req), order: [['createdAt', 'DESC']] }))));
  router.get(`${path}/:id`, requirePermission(permissionView), wrap(async (req, res) => {
    const row = await model.findOne({ where: { id: req.params.id, ...tenant(req) } });
    if (!row) fail(404, 'NOT_FOUND', 'Record not found'); ok(res, row);
  }));
  router.post(path, requirePermission(permissionManage), check(schema), wrap(async (req, res) => {
    if (model === MenuItem && !await Category.findOne({ where: { id: req.body.categoryId, ...tenant(req) } })) fail(404, 'CATEGORY_NOT_FOUND', 'Category not found');
    const row = await model.create({ ...req.body, ...tenant(req) });
    if (event) emitRestaurant(req.auth.restaurantId, event, { id: row.id, status: row.status });
    ok(res, row, 'Created', 201);
  }));
  router.patch(`${path}/:id`, requirePermission(permissionManage), check(schema.min(1).fork(Object.keys(schema.describe().keys), (s) => s.optional())), wrap(async (req, res) => {
    const row = await model.findOne({ where: { id: req.params.id, ...tenant(req) } });
    if (!row) fail(404, 'NOT_FOUND', 'Record not found');
    if (model === MenuItem && req.body.categoryId && !await Category.findOne({ where: { id: req.body.categoryId, ...tenant(req) } })) fail(404, 'CATEGORY_NOT_FOUND', 'Category not found');
    await row.update(req.body);
    if (event) emitRestaurant(req.auth.restaurantId, event, { id: row.id, status: row.status });
    ok(res, row);
  }));
  router.delete(`${path}/:id`, requirePermission(permissionManage), wrap(async (req, res) => {
    const row = await model.findOne({ where: { id: req.params.id, ...tenant(req) } });
    if (!row) fail(404, 'NOT_FOUND', 'Record not found');
    if ('active' in row) await row.update({ active: false }); else fail(409, 'DELETE_UNSUPPORTED', 'Deactivate or update this record instead');
    ok(res, { id: row.id });
  }));
}

crud('/categories', Category, 'VIEW_MENU', 'MANAGE_MENU', Joi.object({ name: Joi.string().max(255).required(), description: Joi.string().allow('', null), displayOrder: Joi.number().integer().min(0), active: Joi.boolean() }), null);
crud('/menu-items', MenuItem, 'VIEW_MENU', 'MANAGE_MENU', Joi.object({ categoryId: uuid, name: Joi.string().required(), description: Joi.string().allow('', null), price: amount, taxBasisPoints: Joi.number().integer().min(0).max(10000), available: Joi.boolean(), active: Joi.boolean(), kitchenStation: Joi.string().allow('', null) }), null);
crud('/tables', DiningTable, 'VIEW_TABLES', 'MANAGE_TABLES', Joi.object({ tableNumber: Joi.string().required(), name: Joi.string().allow('', null), section: Joi.string().allow('', null), capacity: Joi.number().integer().min(1).required() }), 'table:updated');

router.post('/employees', requirePermission('MANAGE_EMPLOYEES'), check(Joi.object({ firstName: Joi.string().required(), lastName: Joi.string().required(), email: Joi.string().email().allow('', null), phone: Joi.string().allow('', null), phoneCountryCode: Joi.string().length(2), designation: Joi.string().trim().max(255).required(), role: Joi.string().valid('MANAGER','CASHIER','WAITER','KITCHEN').required() })), wrap(async (req, res) => {
  const username = await uniqueUsername(req.body.firstName.normalize('NFKD').replace(/[^a-z]/gi, '').toUpperCase().padEnd(3, 'X').slice(0, 3));
  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const user = await db.transaction(async (transaction) => {
    const { phoneCountryCode, ...fields } = req.body;
    const row = await User.create({ ...fields, phone: normalizeOptionalPhone(req.body.phone, phoneCountryCode), email: req.body.email?.toLowerCase() || `${username.toLowerCase()}@employee.invalid`, username, restaurantId: req.auth.restaurantId, active: true }, { transaction });
    await Employee.create({ restaurantId: req.auth.restaurantId, userId: row.id, designation: req.body.designation, pinHash: await bcrypt.hash(pin, 12) }, { transaction });
    await AuditLog.create({ restaurantId: req.auth.restaurantId, actorUserId: req.auth.userId, action: 'EMPLOYEE_CREATED', subjectType: 'USER', subjectId: row.id }, { transaction });
    return row;
  });
  ok(res, { user: publicUser(user), initialPin: pin }, 'Employee created; show PIN once', 201);
}));
router.get('/employees', requirePermission('VIEW_EMPLOYEES'), wrap(async (req, res) => {
  const [users, employees] = await Promise.all([
    User.findAll({ where: { ...tenant(req), role: { [Op.ne]: 'OWNER' } } }),
    Employee.findAll({ where: tenant(req), attributes: ['userId', 'designation'] }),
  ]);
  const designations = new Map(employees.map((employee) => [employee.userId, employee.designation]));
  ok(res, users.map((user) => ({ ...publicUser(user), designation: designations.get(user.id) || '' })));
}));
router.get('/owners/me', wrap(async (req, res) => {
  if (req.auth.role !== 'OWNER') fail(403, 'FORBIDDEN', 'Owner access required');
  ok(res, publicUser(await User.findByPk(req.auth.userId)));
}));
router.post('/employees/:id/reset-pin', requirePermission('MANAGE_EMPLOYEES'), wrap(async (req, res) => {
  const user = await User.findOne({ where: { id: req.params.id, ...tenant(req), role: { [Op.ne]: 'OWNER' } } });
  if (!user) fail(404, 'NOT_FOUND', 'Employee not found');
  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await Employee.update({ pinHash: await bcrypt.hash(pin, 12) }, { where: { userId: user.id, ...tenant(req) } });
  await AuditLog.create({ restaurantId: req.auth.restaurantId, actorUserId: req.auth.userId, action: 'PIN_RESET', subjectType: 'USER', subjectId: user.id });
  ok(res, { initialPin: pin });
}));
router.patch('/employees/:id', requirePermission('MANAGE_EMPLOYEES'), check(Joi.object({ active: Joi.boolean(), role: Joi.string().valid('MANAGER','CASHIER','WAITER','KITCHEN') }).min(1)), wrap(async (req, res) => {
  const user = await User.findOne({ where: { id: req.params.id, ...tenant(req), role: { [Op.ne]: 'OWNER' } } });
  if (!user) fail(404, 'NOT_FOUND', 'Employee not found');
  await user.update(req.body); ok(res, publicUser(user));
}));

router.post('/orders', requirePermission('CREATE_ORDER'), check(Joi.object({ type: Joi.string().valid('DINE_IN','TAKEAWAY','PHONE_ORDER').required(), tableId: Joi.string().uuid() })), wrap(async (req, res) => ok(res, await createOrder(req.auth, req.body), 'Created', 201)));
router.get('/orders', requirePermission('VIEW_ORDER'), wrap(async (req, res) => ok(res, await Order.findAll({ where: { ...tenant(req), ...(req.query.status ? { status: String(req.query.status) } : {}) }, order: [['createdAt', 'DESC']], limit: 100 }))));
router.get('/orders/:id', requirePermission('VIEW_ORDER'), wrap(async (req, res) => {
  const row = await Order.findOne({ where: { id: req.params.id, ...tenant(req) }, include: [{ model: OrderItem, as: 'items' }] });
  if (!row) fail(404, 'ORDER_NOT_FOUND', 'Order not found'); ok(res, row);
}));
router.post('/orders/:id/items', requirePermission('UPDATE_ORDER'), check(Joi.object({ menuItemId: uuid, quantity: Joi.number().integer().min(1).max(100).required(), notes: Joi.string().max(1000).allow('', null) })), wrap(async (req, res) => ok(res, await addItem(req.auth, req.params.id, req.body), 'Item added', 201)));
router.post('/orders/:id/items/:itemId/void', requirePermission('VOID_ORDER_ITEM'), check(Joi.object({ reason: Joi.string().valid('CUSTOMER_CHANGED_MIND','WRONG_ITEM','EMPLOYEE_ERROR','KITCHEN_UNAVAILABLE','OTHER').required() })), wrap(async (req, res) => ok(res, await voidItem(req.auth, req.params.id, req.params.itemId, req.body.reason))));
router.post('/orders/:id/cancel', requirePermission('CANCEL_ORDER'), wrap(async (req, res) => ok(res, await cancelOrder(req.auth, req.params.id))));
for (const action of ['confirm','served','bill']) router.post(`/orders/:id/${action}`, requirePermission('UPDATE_ORDER'), wrap(async (req, res) => ok(res, await transition(req.auth, req.params.id, action))));
for (const action of ['preparing','ready']) router.post(`/orders/:id/${action}`, requirePermission('MANAGE_KITCHEN_STATUS'), wrap(async (req, res) => ok(res, await transition(req.auth, req.params.id, action))));
router.post('/orders/:id/payments', requirePermission('COMPLETE_PAYMENT'), check(Joi.object({ method: Joi.string().valid('CASH','CARD_MANUAL','UPI_MANUAL','OTHER').required(), cashReceived: Joi.when('method', { is: 'CASH', then: amount, otherwise: Joi.forbidden() }),
  idempotencyKey: Joi.string().uuid().required(), externalReference: Joi.string().max(255).allow('', null), notes: Joi.string().max(1000).allow('', null), confirmed: Joi.boolean().valid(true).required() })), wrap(async (req, res) => ok(res, await confirmPayment(req.auth, req.params.id, req.body), 'Payment confirmed', 201)));
router.get('/receipts', requirePermission('PRINT_RECEIPT'), wrap(async (req, res) => ok(res, await Receipt.findAll({ where: tenant(req), order: [['createdAt', 'DESC']], limit: 100 }))));
router.get('/receipts/order/:orderId', requirePermission('PRINT_RECEIPT'), wrap(async (req, res) => {
  const receipt = await Receipt.findOne({ where: { orderId: req.params.orderId, ...tenant(req) } });
  if (!receipt) fail(404, 'NOT_FOUND', 'Receipt not found'); ok(res, receipt);
}));
router.get('/receipts/:id', requirePermission('PRINT_RECEIPT'), wrap(async (req, res) => {
  const receipt = await Receipt.findOne({ where: { id: req.params.id, ...tenant(req) } });
  if (!receipt) fail(404, 'NOT_FOUND', 'Receipt not found'); ok(res, receipt.snapshot);
}));
router.get('/payments/:id', requirePermission('TAKE_PAYMENT'), wrap(async (req, res) => {
  const payment = await Payment.findOne({ where: { id: req.params.id, ...tenant(req) }, attributes: { exclude: ['idempotencyKey'] } });
  if (!payment) fail(404, 'NOT_FOUND', 'Payment not found'); ok(res, payment);
}));
router.post('/payments/:id/refunds', requirePermission('PROCESS_REFUND'), check(Joi.object({ amount, reason: Joi.string().min(3).required(), confirmed: Joi.boolean().valid(true).required() })), wrap(async (req, res) => ok(res, await confirmRefund(req.auth, req.params.id, req.body), 'Refund recorded', 201)));
router.get('/refunds', requirePermission('PROCESS_REFUND'), wrap(async (req, res) => ok(res, await Refund.findAll({ where: tenant(req), order: [['createdAt', 'DESC']], limit: 100 }))));

router.get('/reservations', requirePermission('VIEW_TABLES'), wrap(async (req, res) => ok(res, await Reservation.findAll({ where: tenant(req), order: [['startAt', 'ASC']], limit: 100 }))));
router.post('/reservations', requirePermission('MANAGE_TABLES'), check(Joi.object({ tableId: Joi.string().uuid().allow(null), customerName: Joi.string().required(), phone: Joi.string().allow('', null), phoneCountryCode: Joi.string().length(2), guestCount: Joi.number().integer().min(1).required(), startAt: Joi.date().iso().required(), notes: Joi.string().allow('', null) })), wrap(async (req, res) => {
  if (req.body.tableId && !await DiningTable.findOne({ where: { id: req.body.tableId, ...tenant(req) } })) fail(404, 'TABLE_NOT_FOUND', 'Table not found');
  const { phoneCountryCode, ...fields } = req.body;
  const row = await Reservation.create({ ...fields, phone: normalizeOptionalPhone(req.body.phone, phoneCountryCode), ...tenant(req) }); emitRestaurant(req.auth.restaurantId, 'reservation:updated', { id: row.id }); ok(res, row, 'Created', 201);
}));
router.patch('/reservations/:id', requirePermission('MANAGE_TABLES'), check(Joi.object({ status: Joi.string().valid('CONFIRMED','CANCELLED','NO_SHOW','COMPLETED'), tableId: Joi.string().uuid().allow(null), customerName: Joi.string(), phone: Joi.string().allow('', null), phoneCountryCode: Joi.string().length(2), guestCount: Joi.number().integer().min(1), startAt: Joi.date().iso(), notes: Joi.string().allow('', null) }).min(1)), wrap(async (req, res) => {
  const row = await Reservation.findOne({ where: { id: req.params.id, ...tenant(req) } }); if (!row) fail(404, 'NOT_FOUND', 'Reservation not found');
  if (req.body.tableId && !await DiningTable.findOne({ where: { id: req.body.tableId, ...tenant(req) } })) fail(404, 'TABLE_NOT_FOUND', 'Table not found');
  const { phoneCountryCode, ...fields } = req.body;
  await row.update({ ...fields, ...(Object.hasOwn(req.body, 'phone') ? { phone: normalizeOptionalPhone(req.body.phone, phoneCountryCode) } : {}) }); emitRestaurant(req.auth.restaurantId, 'reservation:updated', { id: row.id, status: row.status }); ok(res, row);
}));
router.post('/reservations/:id/seat', requirePermission('CREATE_ORDER'), wrap(async (req, res) => {
  const result = await db.transaction(async (transaction) => {
    const reservation = await Reservation.findOne({ where: { id: req.params.id, ...tenant(req) }, transaction, lock: transaction.LOCK.UPDATE });
    if (!reservation) fail(404, 'NOT_FOUND', 'Reservation not found');
    if (!reservation.tableId || !['PENDING','CONFIRMED'].includes(reservation.status)) fail(409, 'INVALID_RESERVATION', 'Reservation cannot be seated');
    const table = await DiningTable.findOne({ where: { id: reservation.tableId, ...tenant(req) }, transaction, lock: transaction.LOCK.UPDATE });
    if (!table || !['AVAILABLE','RESERVED'].includes(table.status)) fail(409, 'TABLE_OCCUPIED', 'Table is unavailable');
    const order = await Order.create({ ...tenant(req), tableId: table.id, type: 'DINE_IN', createdByUserId: req.auth.userId, status: 'DRAFT' }, { transaction });
    reservation.status = 'SEATED'; await reservation.save({ transaction });
    table.status = 'OCCUPIED'; await table.save({ transaction });
    return { reservation, order, table };
  });
  emitRestaurant(req.auth.restaurantId, 'reservation:updated', { id: result.reservation.id, status: 'SEATED' });
  emitRestaurant(req.auth.restaurantId, 'order:created', { orderId: result.order.id, tableId: result.table.id });
  emitRestaurant(req.auth.restaurantId, 'table:updated', { tableId: result.table.id, status: 'OCCUPIED' });
  ok(res, { reservation: result.reservation, order: result.order }, 'Reservation seated', 201);
}));

router.get('/restaurants/me', requirePermission('MANAGE_RESTAURANT'), wrap(async (req, res) => ok(res, await Restaurant.findByPk(req.auth.restaurantId))));
router.patch('/restaurants/me', requirePermission('MANAGE_RESTAURANT'), check(Joi.object({ name: Joi.string(), businessType: Joi.string(), address: Joi.string(), city: Joi.string(), state: Joi.string(), postalCode: Joi.string(), phone: Joi.string().allow('', null), phoneCountryCode: Joi.string().length(2), timezone: Joi.string() }).min(1)), wrap(async (req, res) => {
  const restaurant = await Restaurant.findByPk(req.auth.restaurantId);
  const { phoneCountryCode, ...fields } = req.body;
  await restaurant.update({ ...fields, ...(Object.hasOwn(req.body, 'phone') ? { phone: normalizeOptionalPhone(req.body.phone, phoneCountryCode) } : {}) });
  await AuditLog.create({ restaurantId: req.auth.restaurantId, actorUserId: req.auth.userId, action: 'SETTINGS_CHANGED', subjectType: 'RESTAURANT', subjectId: restaurant.id });
  ok(res, restaurant);
}));
router.get('/permissions', requirePermission('MANAGE_SETTINGS'), (_req, res) => ok(res, ALL_PERMISSIONS));
router.get('/roles', requirePermission('MANAGE_SETTINGS'), wrap(async (req, res) => ok(res, await Role.findAll({ where: tenant(req) }))));
router.put('/roles/:name/permissions', requirePermission('MANAGE_SETTINGS'), check(Joi.object({ permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)).unique().required() })), wrap(async (req, res) => {
  if (req.params.name === 'OWNER') fail(400, 'OWNER_FIXED', 'Owner permissions cannot be changed');
  await db.transaction(async (transaction) => {
    const [role] = await Role.findOrCreate({ where: { ...tenant(req), name: req.params.name }, defaults: { ...tenant(req), name: req.params.name }, transaction });
    await RolePermission.destroy({ where: { roleId: role.id }, transaction });
    for (const code of req.body.permissions) {
      const [permission] = await Permission.findOrCreate({ where: { code }, defaults: { code }, transaction });
      await RolePermission.create({ roleId: role.id, permissionId: permission.id }, { transaction });
    }
  }); ok(res, { name: req.params.name, permissions: req.body.permissions });
}));
router.get('/settings', requirePermission('MANAGE_SETTINGS'), wrap(async (req, res) => ok(res, await RestaurantSetting.findAll({ where: tenant(req) }))));
router.put('/settings/:key', requirePermission('MANAGE_SETTINGS'), check(Joi.object({ value: Joi.any().required() })), wrap(async (req, res) => {
  const [row] = await RestaurantSetting.upsert({ ...tenant(req), key: req.params.key, value: req.body.value }); ok(res, row);
}));
router.post('/shifts/start', wrap(async (req, res) => {
  const active = await Shift.findOne({ where: { ...tenant(req), userId: req.auth.userId, endedAt: null } });
  if (active) fail(409, 'SHIFT_ACTIVE', 'A shift is already active');
  ok(res, await Shift.create({ ...tenant(req), userId: req.auth.userId, startedAt: new Date() }), 'Shift started', 201);
}));
router.post('/shifts/:id/end', wrap(async (req, res) => {
  const shift = await Shift.findOne({ where: { id: req.params.id, ...tenant(req), userId: req.auth.userId, endedAt: null } });
  if (!shift) fail(404, 'NOT_FOUND', 'Active shift not found');
  await shift.update({ endedAt: new Date() }); ok(res, shift);
}));
router.get('/shifts', requirePermission('VIEW_EMPLOYEES'), wrap(async (req, res) => ok(res, await Shift.findAll({ where: tenant(req), order: [['startedAt', 'DESC']], limit: 100 }))));
router.get('/dashboard', requirePermission('VIEW_REVENUE'), wrap(async (req, res) => {
  const start = new Date(); start.setHours(0,0,0,0);
  const payments = await Payment.findAll({ where: { ...tenant(req), status: { [Op.in]: ['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'] }, confirmedAt: { [Op.gte]: start } } });
  const refunds = await Refund.findAll({ where: { ...tenant(req), createdAt: { [Op.gte]: start } } });
  const grossCents = payments.reduce((sum, p) => sum + cents(p.amount), 0);
  const refundCents = refunds.reduce((sum, r) => sum + cents(r.amount), 0);
  ok(res, { grossSales: (grossCents / 100).toFixed(2), refunds: (refundCents / 100).toFixed(2), netSales: ((grossCents - refundCents) / 100).toFixed(2), completedOrders: payments.length });
}));
router.get('/reports', requirePermission('VIEW_REPORTS'), wrap(async (req, res) => {
  const from = new Date(String(req.query.from || '')); const to = new Date(String(req.query.to || ''));
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) fail(400, 'INVALID_RANGE', 'Valid from and to dates required');
  const payments = await Payment.findAll({ where: { ...tenant(req), status: { [Op.in]: ['COMPLETED','PARTIALLY_REFUNDED','REFUNDED'] }, confirmedAt: { [Op.between]: [from, to] } } });
  const refunds = await Refund.findAll({ where: { ...tenant(req), createdAt: { [Op.between]: [from, to] } } });
  const gross = payments.reduce((sum, p) => sum + cents(p.amount), 0), returned = refunds.reduce((sum, r) => sum + cents(r.amount), 0);
  ok(res, { grossSales: (gross / 100).toFixed(2), refunds: (returned / 100).toFixed(2), netSales: ((gross - returned) / 100).toFixed(2), completedOrders: payments.length });
}));
export default router;
