import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeReceipt, decodeReceipt } from '../src/utils/receipt-codec.js';
import { Receipt } from '../src/models/index.js';

test('receipt snapshots round trip and compress repeated item data', () => {
  const snapshot = { number: 'R-1', items: Array.from({ length: 20 }, (_, i) => ({
    name: `House special ${i}`, quantity: 2, unitPrice: '12.50', taxBasisPoints: 500, discount: '0.00',
  })) };
  const encoded = encodeReceipt(snapshot);
  assert.equal(encoded[0], 1);
  assert.ok(encoded.length < Buffer.byteLength(JSON.stringify(snapshot)));
  assert.deepEqual(decodeReceipt(encoded), snapshot);
});

test('short snapshots stay uncompressed when gzip would add bytes', () => {
  const snapshot = { n: 1 };
  const encoded = encodeReceipt(snapshot);
  assert.equal(encoded[0], 0);
  assert.deepEqual(decodeReceipt(encoded), snapshot);
});

test('receipt model returns JSON without exposing compressed bytes', () => {
  const snapshot = { number: 'R-2', items: [] };
  const receipt = Receipt.build({ number: 'R-2', snapshot });
  assert.deepEqual(receipt.snapshot, snapshot);
  assert.equal(receipt.toJSON().snapshotCompressed, undefined);
  assert.deepEqual(receipt.toJSON().snapshot, snapshot);
});
