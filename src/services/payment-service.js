import { db } from '../config/database.js';
import { Order, OrderItem, Payment, Receipt, Refund, DiningTable, Restaurant, RestaurantSetting, User, AuditLog } from '../models/index.js';
import { fail } from '../errors/http-error.js';
import { cents, decimal } from '../utils/money.js';
import { emitRestaurant } from '../sockets/index.js';

export async function confirmPayment(auth, orderId, input) {
  const result = await db.transaction(async (transaction) => {
    const order = await Order.findOne({ where: { id: orderId, restaurantId: auth.restaurantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) fail(404, 'ORDER_NOT_FOUND', 'Order not found');
    const prior = await Payment.findOne({ where: { restaurantId: auth.restaurantId, idempotencyKey: input.idempotencyKey }, transaction });
    if (prior) {
      if (prior.orderId !== orderId) fail(409, 'IDEMPOTENCY_CONFLICT', 'Key already used for another order');
      if (prior.method !== input.method || (prior.method === 'CASH' && cents(prior.cashReceived) !== cents(input.cashReceived))) {
        fail(409, 'IDEMPOTENCY_CONFLICT', 'Key already used with different payment details');
      }
      return { payment: prior, receipt: await Receipt.findOne({ where: { orderId, restaurantId: auth.restaurantId }, transaction }), repeated: true };
    }
    if (order.status !== 'BILL_REQUESTED') fail(409, 'INVALID_ORDER_STATE', 'Bill must be requested before payment');
    const methods = await RestaurantSetting.findOne({ where: { restaurantId: auth.restaurantId, key: 'enabledPaymentMethods' }, transaction });
    if (methods && (!Array.isArray(methods.value) || !methods.value.includes(input.method))) fail(400, 'PAYMENT_METHOD_DISABLED', 'Payment method is disabled');
    const due = cents(order.total);
    if (due <= 0) fail(400, 'INVALID_TOTAL', 'Order total must be positive');
    const cash = input.method === 'CASH' ? cents(input.cashReceived) : null;
    if (cash !== null && cash < due) fail(400, 'INSUFFICIENT_CASH', `Insufficient cash received. Remaining amount: ${decimal(due - cash)}`);
    const payment = await Payment.create({ restaurantId: auth.restaurantId, orderId, amount: order.total, method: input.method,
      status: 'COMPLETED', verificationMode: 'MANUAL', cashReceived: cash === null ? null : decimal(cash),
      changeDue: cash === null ? null : decimal(cash - due), externalReference: input.externalReference || null,
      notes: input.notes || null, confirmedByUserId: auth.userId, confirmedAt: new Date(), idempotencyKey: input.idempotencyKey }, { transaction });
    const restaurant = await Restaurant.findByPk(auth.restaurantId, { transaction });
    const employee = await User.findByPk(auth.userId, { transaction });
    const items = await OrderItem.findAll({ where: { restaurantId: auth.restaurantId, orderId }, transaction });
    const number = `R-${payment.id.toUpperCase()}`;
    const receipt = await Receipt.create({ restaurantId: auth.restaurantId, orderId, paymentId: payment.id, number,
      snapshot: { number, restaurant: { name: restaurant.name, address: restaurant.address, phone: restaurant.phone, currencyCode: restaurant.currencyCode },
        order: { id: order.id, type: order.type, tableId: order.tableId }, employee: { id: employee.id, name: `${employee.firstName} ${employee.lastName}` },
        items: items.filter((i) => i.status === 'ACTIVE').map((i) => ({ name: i.itemNameSnapshot, quantity: i.quantity, unitPrice: i.unitPriceSnapshot, taxBasisPoints: i.taxBasisPointsSnapshot, discount: i.discount })),
        totals: { subtotal: order.subtotal, tax: order.tax, discount: order.discount, total: order.total },
        payment: { method: payment.method, cashReceived: payment.cashReceived, changeDue: payment.changeDue }, at: new Date().toISOString() } }, { transaction });
    order.status = 'CLOSED'; await order.save({ transaction });
    if (order.tableId) await DiningTable.update({ status: 'AVAILABLE' }, { where: { id: order.tableId, restaurantId: auth.restaurantId }, transaction });
    await AuditLog.create({ restaurantId: auth.restaurantId, actorUserId: auth.userId, action: 'PAYMENT_CONFIRMED', subjectType: 'PAYMENT', subjectId: payment.id,
      details: { orderId, amount: payment.amount, method: payment.method, verificationMode: 'MANUAL' } }, { transaction });
    return { payment, receipt, tableId: order.tableId };
  });
  if (!result.repeated) {
    emitRestaurant(auth.restaurantId, 'order:paid', { orderId, paymentId: result.payment.id });
    emitRestaurant(auth.restaurantId, 'order:closed', { orderId });
    if (result.tableId) emitRestaurant(auth.restaurantId, 'table:updated', { tableId: result.tableId, status: 'AVAILABLE' });
  }
  return result;
}
export async function confirmRefund(auth, paymentId, input) {
  return db.transaction(async (transaction) => {
    const payment = await Payment.findOne({ where: { id: paymentId, restaurantId: auth.restaurantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!payment || !['COMPLETED', 'PARTIALLY_REFUNDED'].includes(payment.status)) fail(409, 'INVALID_REFUND', 'Payment is not refundable');
    const amount = cents(input.amount);
    const prior = await Refund.findAll({ where: { paymentId, restaurantId: auth.restaurantId }, transaction });
    const remaining = cents(payment.amount) - prior.reduce((sum, r) => sum + cents(r.amount), 0);
    if (amount <= 0 || amount > remaining) fail(400, 'INVALID_REFUND', 'Refund exceeds remaining payment');
    const refund = await Refund.create({ restaurantId: auth.restaurantId, paymentId, amount: decimal(amount), reason: input.reason,
      confirmedByUserId: auth.userId, confirmedAt: new Date() }, { transaction });
    payment.status = amount === remaining ? 'REFUNDED' : 'PARTIALLY_REFUNDED'; await payment.save({ transaction });
    await AuditLog.create({ restaurantId: auth.restaurantId, actorUserId: auth.userId, action: 'REFUND_CONFIRMED', subjectType: 'REFUND', subjectId: refund.id,
      details: { paymentId, amount: refund.amount, verificationMode: 'MANUAL' } }, { transaction });
    return refund;
  });
}
