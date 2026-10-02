import { db } from '../config/database.js';
import { Order, OrderItem, MenuItem, DiningTable, AuditLog } from '../models/index.js';
import { fail } from '../errors/http-error.js';
import { cents, decimal, percentOf } from '../utils/money.js';
import { emitRestaurant } from '../sockets/index.js';

const editable = ['DRAFT', 'CONFIRMED', 'PREPARING', 'READY', 'SERVED'];
export async function recalculate(order, transaction) {
  const items = await OrderItem.findAll({ where: { orderId: order.id, restaurantId: order.restaurantId, status: 'ACTIVE' }, transaction });
  let subtotal = 0, tax = 0, discount = 0;
  for (const item of items) {
    const line = cents(item.unitPriceSnapshot) * item.quantity;
    const lineDiscount = cents(item.discount);
    subtotal += line;
    discount += lineDiscount;
    tax += percentOf(line - lineDiscount, item.taxBasisPointsSnapshot);
  }
  Object.assign(order, { subtotal: decimal(subtotal), tax: decimal(tax), discount: decimal(discount), total: decimal(subtotal - discount + tax) });
  await order.save({ transaction });
  return order;
}
export async function createOrder(auth, data) {
  const order = await db.transaction(async (transaction) => {
    let table;
    if (data.type === 'DINE_IN') {
      if (!data.tableId) fail(400, 'TABLE_REQUIRED', 'Dine-in orders require a table');
      table = await DiningTable.findOne({ where: { id: data.tableId, restaurantId: auth.restaurantId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!table) fail(404, 'TABLE_NOT_FOUND', 'Table not found');
      if (table.status !== 'AVAILABLE') fail(409, 'TABLE_OCCUPIED', 'Table is unavailable');
    } else if (data.tableId) fail(400, 'INVALID_TABLE', 'Table is only allowed for dine-in orders');
    const created = await Order.create({ restaurantId: auth.restaurantId, tableId: table?.id || null, createdByUserId: auth.userId, type: data.type, status: 'DRAFT' }, { transaction });
    if (table) { table.status = 'OCCUPIED'; await table.save({ transaction }); }
    await AuditLog.create({ restaurantId: auth.restaurantId, actorUserId: auth.userId, action: 'ORDER_CREATED', subjectType: 'ORDER', subjectId: created.id }, { transaction });
    return created;
  });
  emitRestaurant(auth.restaurantId, 'order:created', { orderId: order.id, tableId: order.tableId });
  if (order.tableId) emitRestaurant(auth.restaurantId, 'table:updated', { tableId: order.tableId, status: 'OCCUPIED' });
  return order;
}
export async function addItem(auth, orderId, data) {
  const order = await db.transaction(async (transaction) => {
    const target = await Order.findOne({ where: { id: orderId, restaurantId: auth.restaurantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!target) fail(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (!editable.includes(target.status)) fail(409, 'INVALID_ORDER_STATE', 'Order cannot be edited');
    const menu = await MenuItem.findOne({ where: { id: data.menuItemId, restaurantId: auth.restaurantId, active: true, available: true }, transaction });
    if (!menu) fail(404, 'MENU_ITEM_NOT_FOUND', 'Menu item unavailable');
    await OrderItem.create({ restaurantId: auth.restaurantId, orderId, menuItemId: menu.id, itemNameSnapshot: menu.name,
      quantity: data.quantity, unitPriceSnapshot: menu.price, taxBasisPointsSnapshot: menu.taxBasisPoints,
      notes: data.notes || null }, { transaction });
    return recalculate(target, transaction);
  });
  emitRestaurant(auth.restaurantId, 'order:item-added', { orderId, total: order.total });
  return order;
}
export async function transition(auth, orderId, action) {
  const next = { confirm: ['DRAFT', 'CONFIRMED'], preparing: ['CONFIRMED', 'PREPARING'], ready: ['PREPARING', 'READY'], served: ['READY', 'SERVED'], bill: ['CONFIRMED', 'BILL_REQUESTED'] }[action];
  if (!next) fail(400, 'INVALID_ACTION', 'Invalid order action');
  const order = await db.transaction(async (transaction) => {
    const row = await Order.findOne({ where: { id: orderId, restaurantId: auth.restaurantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) fail(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (action === 'bill' && !['CONFIRMED','PREPARING','READY','SERVED'].includes(row.status) || action !== 'bill' && row.status !== next[0]) fail(409, 'INVALID_ORDER_STATE', 'Invalid order transition');
    if (action === 'bill' && cents(row.total) <= 0) fail(400, 'EMPTY_ORDER', 'Order has no payable items');
    row.status = next[1]; await row.save({ transaction });
    if (action === 'bill' && row.tableId) {
      await DiningTable.update({ status: 'BILL_REQUESTED' }, { where: { id: row.tableId, restaurantId: auth.restaurantId }, transaction });
    }
    return row;
  });
  emitRestaurant(auth.restaurantId, action === 'bill' ? 'order:bill-requested' : 'order:updated', { orderId, status: order.status });
  if (action === 'bill' && order.tableId) emitRestaurant(auth.restaurantId, 'table:updated', { tableId: order.tableId, status: 'BILL_REQUESTED' });
  return order;
}
export async function voidItem(auth, orderId, itemId, reason) {
  const order = await db.transaction(async (transaction) => {
    const row = await Order.findOne({ where: { id: orderId, restaurantId: auth.restaurantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row || !editable.includes(row.status)) fail(409, 'INVALID_ORDER_STATE', 'Order cannot be changed');
    const item = await OrderItem.findOne({ where: { id: itemId, orderId, restaurantId: auth.restaurantId, status: 'ACTIVE' }, transaction });
    if (!item) fail(404, 'ITEM_NOT_FOUND', 'Item not found');
    item.status = 'VOIDED'; item.voidReason = reason; await item.save({ transaction });
    await AuditLog.create({ restaurantId: auth.restaurantId, actorUserId: auth.userId, action: 'ITEM_VOIDED', subjectType: 'ORDER_ITEM', subjectId: item.id, details: { reason } }, { transaction });
    return recalculate(row, transaction);
  });
  emitRestaurant(auth.restaurantId, 'order:item-voided', { orderId, itemId, total: order.total });
  return order;
}
export async function cancelOrder(auth, orderId) {
  const order = await db.transaction(async (transaction) => {
    const row = await Order.findOne({ where: { id: orderId, restaurantId: auth.restaurantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row) fail(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (!editable.includes(row.status) && row.status !== 'BILL_REQUESTED') fail(409, 'INVALID_ORDER_STATE', 'Order cannot be cancelled');
    row.status = 'CANCELLED'; await row.save({ transaction });
    if (row.tableId) await DiningTable.update({ status: 'AVAILABLE' }, { where: { id: row.tableId, restaurantId: auth.restaurantId }, transaction });
    await AuditLog.create({ restaurantId: auth.restaurantId, actorUserId: auth.userId, action: 'ORDER_CANCELLED', subjectType: 'ORDER', subjectId: row.id }, { transaction });
    return row;
  });
  emitRestaurant(auth.restaurantId, 'order:updated', { orderId, status: 'CANCELLED' });
  if (order.tableId) emitRestaurant(auth.restaurantId, 'table:updated', { tableId: order.tableId, status: 'AVAILABLE' });
  return order;
}
