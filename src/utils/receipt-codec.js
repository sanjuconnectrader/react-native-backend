import { gzipSync, gunzipSync } from 'node:zlib';

// Versioned bytea payloads keep the API's JSON shape without storing repeated
// receipt field names and item data as uncompressed JSONB.
const JSON_MARKER = 0;
const GZIP_MARKER = 1;

export function encodeReceipt(snapshot) {
  const json = Buffer.from(JSON.stringify(snapshot));
  const zipped = gzipSync(json);
  return Buffer.concat([Buffer.from([zipped.length < json.length ? GZIP_MARKER : JSON_MARKER]),
    zipped.length < json.length ? zipped : json]);
}

export function decodeReceipt(payload) {
  if (!payload) return null;
  const bytes = Buffer.from(payload);
  if (bytes[0] === GZIP_MARKER) return JSON.parse(gunzipSync(bytes.subarray(1)).toString());
  if (bytes[0] === JSON_MARKER) return JSON.parse(bytes.subarray(1).toString());
  throw new Error('Unsupported receipt encoding');
}
