import { DataTypes as D } from 'sequelize';
import { db } from '../config/database.js';
import { encodeReceipt, decodeReceipt } from '../utils/receipt-codec.js';

const id = () => ({ type: D.UUID, primaryKey: true, defaultValue: D.UUIDV4 });
const ref = (table, allowNull = false) => ({ type: D.UUID, allowNull, references: { model: table, key: 'id' } });
const money = (defaultValue = '0.00') => ({ type: D.DECIMAL(14, 2), allowNull: false, defaultValue });
const text = (allowNull = false) => ({ type: D.STRING(255), allowNull });
const define = (name, fields, options = {}) => db.define(name, { id: id(), ...fields }, { tableName: name, ...options });

export const Restaurant = define('restaurants', {
  name: text(), businessType: text(), address: text(), city: text(), state: text(), postalCode: text(),
  countryCode: { type: D.STRING(2), allowNull: false }, currencyCode: { type: D.STRING(3), allowNull: false },
  timezone: text(), locale: text(), phone: text(true), active: { type: D.BOOLEAN, defaultValue: true, allowNull: false },
});
export const User = define('users', {
  restaurantId: ref('restaurants'), firstName: text(), lastName: text(), email: text(), phone: text(true),
  username: text(), passwordHash: text(true), role: { type: D.STRING(20), allowNull: false },
  emailVerifiedAt: D.DATE, active: { type: D.BOOLEAN, defaultValue: false, allowNull: false },
}, { indexes: [{ unique: true, fields: ['username'] }, { unique: true, fields: ['email'] }, { fields: ['restaurant_id'] }] });
export const Employee = define('employees', {
  restaurantId: ref('restaurants'), userId: ref('users'), designation: text(), pinHash: text(),
}, { indexes: [{ unique: true, fields: ['user_id'] }, { fields: ['restaurant_id'] }] });
export const Role = define('roles', { restaurantId: ref('restaurants'), name: text() }, { indexes: [{ unique: true, fields: ['restaurant_id', 'name'] }] });
export const Permission = define('permissions', { code: text() }, { indexes: [{ unique: true, fields: ['code'] }] });
export const RolePermission = define('role_permissions', { roleId: ref('roles'), permissionId: ref('permissions') }, { indexes: [{ unique: true, fields: ['role_id', 'permission_id'] }] });
export const Category = define('categories', {
  restaurantId: ref('restaurants'), name: text(), description: D.TEXT, displayOrder: { type: D.INTEGER, defaultValue: 0, allowNull: false },
  active: { type: D.BOOLEAN, defaultValue: true, allowNull: false },
}, { indexes: [{ fields: ['restaurant_id'] }] });
export const MenuItem = define('menu_items', {
  restaurantId: ref('restaurants'), categoryId: ref('categories'), name: text(), description: D.TEXT,
  price: money(), taxBasisPoints: { type: D.INTEGER, defaultValue: 0, allowNull: false },
  available: { type: D.BOOLEAN, defaultValue: true, allowNull: false }, active: { type: D.BOOLEAN, defaultValue: true, allowNull: false }, kitchenStation: text(true),
}, { indexes: [{ fields: ['restaurant_id', 'category_id'] }] });
export const DiningTable = define('dining_tables', {
  restaurantId: ref('restaurants'), tableNumber: text(), name: text(true), section: text(true),
  capacity: { type: D.INTEGER, allowNull: false }, status: { type: D.STRING(30), defaultValue: 'AVAILABLE', allowNull: false },
}, { indexes: [{ unique: true, fields: ['restaurant_id', 'table_number'] }] });
export const Reservation = define('reservations', {
  restaurantId: ref('restaurants'), tableId: ref('dining_tables', true), customerName: text(), phone: text(true),
  guestCount: { type: D.INTEGER, allowNull: false }, startAt: { type: D.DATE, allowNull: false }, notes: D.TEXT,
  status: { type: D.STRING(30), defaultValue: 'PENDING', allowNull: false },
}, { indexes: [{ fields: ['restaurant_id', 'start_at'] }] });
export const Order = define('orders', {
  restaurantId: ref('restaurants'), tableId: ref('dining_tables', true), createdByUserId: ref('users'),
  type: { type: D.STRING(20), allowNull: false }, status: { type: D.STRING(30), defaultValue: 'DRAFT', allowNull: false },
  subtotal: money(), tax: money(), discount: money(), total: money(),
}, { indexes: [{ fields: ['restaurant_id', 'status'] }, { fields: ['table_id', 'status'] }] });
export const OrderItem = define('order_items', {
  restaurantId: ref('restaurants'), orderId: ref('orders'), menuItemId: ref('menu_items'), itemNameSnapshot: text(),
  quantity: { type: D.INTEGER, allowNull: false }, unitPriceSnapshot: money(), taxBasisPointsSnapshot: { type: D.INTEGER, allowNull: false },
  discount: money(), status: { type: D.STRING(20), defaultValue: 'ACTIVE', allowNull: false }, notes: D.TEXT, voidReason: text(true),
}, { indexes: [{ fields: ['restaurant_id', 'order_id'] }] });
export const Payment = define('payments', {
  restaurantId: ref('restaurants'), orderId: ref('orders'), amount: money(), method: text(),
  status: { type: D.STRING(30), allowNull: false }, verificationMode: { type: D.STRING(20), allowNull: false },
  cashReceived: { ...money(), allowNull: true, defaultValue: null }, changeDue: { ...money(), allowNull: true, defaultValue: null },
  externalReference: text(true), notes: D.TEXT, confirmedByUserId: ref('users'), confirmedAt: D.DATE,
  idempotencyKey: text(),
}, { indexes: [{ unique: true, fields: ['restaurant_id', 'idempotency_key'] }, { unique: true, fields: ['order_id'], where: { status: 'COMPLETED' } }] });
export const Refund = define('refunds', {
  restaurantId: ref('restaurants'), paymentId: ref('payments'), amount: money(), reason: text(),
  verificationMode: { type: D.STRING(20), defaultValue: 'MANUAL', allowNull: false },
  confirmedByUserId: ref('users'), confirmedAt: { type: D.DATE, allowNull: false },
}, { indexes: [{ fields: ['restaurant_id', 'payment_id'] }] });
export const Receipt = define('receipts', {
  restaurantId: ref('restaurants'), orderId: ref('orders'), paymentId: ref('payments'),
  number: text(), snapshotCompressed: { type: D.BLOB, allowNull: false },
  snapshot: { type: D.VIRTUAL, get() { return decodeReceipt(this.getDataValue('snapshotCompressed')); },
    set(value) { this.setDataValue('snapshotCompressed', encodeReceipt(value)); } },
}, { indexes: [{ unique: true, fields: ['order_id'] }, { unique: true, fields: ['restaurant_id', 'number'] }] });
Receipt.prototype.toJSON = function () {
  const value = this.get({ plain: true });
  delete value.snapshotCompressed;
  return value;
};
export const OTPVerification = define('otp_verifications', {
  userId: ref('users'), purpose: text(), codeHash: text(), expiresAt: { type: D.DATE, allowNull: false },
  consumedAt: D.DATE, attempts: { type: D.INTEGER, defaultValue: 0, allowNull: false }, lastSentAt: { type: D.DATE, allowNull: false },
});
export const RefreshSession = define('refresh_sessions', {
  userId: ref('users'), tokenHash: text(), expiresAt: { type: D.DATE, allowNull: false }, revokedAt: D.DATE,
}, { indexes: [{ unique: true, fields: ['token_hash'] }, { fields: ['user_id'] }] });
export const Shift = define('shifts', { restaurantId: ref('restaurants'), userId: ref('users'), startedAt: { type: D.DATE, allowNull: false }, endedAt: D.DATE });
export const RestaurantSetting = define('restaurant_settings', {
  restaurantId: ref('restaurants'), key: text(), value: { type: D.JSONB, allowNull: false },
}, { indexes: [{ unique: true, fields: ['restaurant_id', 'key'] }] });
export const AuditLog = define('audit_logs', {
  restaurantId: ref('restaurants'), actorUserId: ref('users', true), action: text(), subjectType: text(true), subjectId: { type: D.UUID, allowNull: true },
  details: { type: D.JSONB, allowNull: false, defaultValue: {} },
}, { indexes: [{ fields: ['restaurant_id', 'created_at'] }] });

Restaurant.hasMany(User, { foreignKey: 'restaurantId' });
Restaurant.hasMany(Category, { foreignKey: 'restaurantId' });
Category.hasMany(MenuItem, { foreignKey: 'categoryId' });
Order.hasMany(OrderItem, { foreignKey: 'orderId', as: 'items' });
Order.hasMany(Payment, { foreignKey: 'orderId' });
Order.hasOne(Receipt, { foreignKey: 'orderId' });
Payment.hasMany(Refund, { foreignKey: 'paymentId' });

export const migrationOrder = [Restaurant, User, Employee, Role, Permission, RolePermission, Category, MenuItem, DiningTable, Reservation, Order, OrderItem, Payment, Refund, Receipt, OTPVerification, RefreshSession, Shift, RestaurantSetting, AuditLog];
