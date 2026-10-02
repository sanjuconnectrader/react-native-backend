import test from 'node:test';
import assert from 'node:assert/strict';
import { countryOptions, normalizePhone, resolveCountry } from '../src/services/country-service.js';

test('selected country determines calling code, currency, and locale', () => {
  assert.deepEqual(resolveCountry('IN'), { countryCode: 'IN', currencyCode: 'INR', locale: 'en-IN', dialCode: '+91' });
  assert.equal(countryOptions.find((item) => item.countryCode === 'IN')?.dialCode, '+91');
});

test('national number is validated and stored in E.164 format', () => {
  assert.equal(normalizePhone('98765 43210', 'IN'), '+919876543210');
  assert.throws(() => normalizePhone('123', 'IN'), { code: 'INVALID_PHONE' });
  assert.throws(() => normalizePhone('+14155552671', 'IN'), { code: 'PHONE_COUNTRY_MISMATCH' });
});
