import test from 'node:test';
import assert from 'node:assert/strict';
import { cents, decimal, percentOf } from '../src/utils/money.js';

test('cash change and insufficient cash use exact minor units', () => {
  const total = cents('43.20');
  assert.equal(decimal(cents('50.00') - total), '6.80');
  assert.equal(cents('40.00') < total, true);
});

test('tax rounding and amount validation are stable', () => {
  assert.equal(percentOf(cents('19.99'), 825), 165);
  assert.throws(() => cents('1.001'));
  assert.throws(() => cents('-1.00'));
});
