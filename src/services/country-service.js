import { countries } from 'countries-list';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { fail } from '../errors/http-error.js';

const entries = Object.entries(countries).filter(([, item]) => item.phone?.length && item.currency?.length);

export const countryOptions = entries.map(([countryCode, item]) => ({
  countryCode,
  name: item.name,
  dialCode: `+${item.phone[0]}`,
})).sort((a, b) => a.name.localeCompare(b.name));

export function resolveCountry(input) {
  const countryCode = String(input || '').toUpperCase();
  const item = countries[countryCode];
  if (!item?.phone?.length || !item.currency?.length) fail(400, 'INVALID_COUNTRY', 'Select a supported country');
  const language = item.languages.includes('en') ? 'en' : item.languages[0] || 'en';
  return {
    countryCode,
    currencyCode: item.currency[0],
    locale: `${language}-${countryCode}`,
    dialCode: `+${item.phone[0]}`,
  };
}

export function normalizePhone(input, countryCode) {
  const raw = String(input || '').trim();
  if (!raw) fail(400, 'INVALID_PHONE', 'Enter a mobile number');
  const selected = countryCode ? resolveCountry(countryCode).countryCode : undefined;
  const number = parsePhoneNumberFromString(raw, selected);
  if (!number?.isValid()) fail(400, 'INVALID_PHONE', 'Enter a valid mobile number for the selected country');
  if (selected && number.country && number.country !== selected) fail(400, 'PHONE_COUNTRY_MISMATCH', 'Phone number does not match the selected country');
  return number.number;
}

export function normalizeOptionalPhone(input, countryCode) {
  return input ? normalizePhone(input, countryCode) : null;
}
