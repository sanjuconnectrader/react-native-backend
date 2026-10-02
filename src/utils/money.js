import { fail } from '../errors/http-error.js';

export function cents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') fail(400, 'INVALID_MONEY', 'Invalid amount');
  const raw = String(value);
  if (!/^(0|[1-9]\d{0,10})(\.\d{1,2})?$/.test(raw)) fail(400, 'INVALID_MONEY', 'Amount must have at most two decimal places');
  const [whole, decimal = ''] = raw.split('.');
  return Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
}
export const decimal = (minor) => (minor / 100).toFixed(2);
export const percentOf = (minor, basisPoints) => Math.round(minor * basisPoints / 10000);
