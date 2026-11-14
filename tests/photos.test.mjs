import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoHandler, verifyPhotos } from '../netlify/lib/photos.mjs';
import { createCheckoutHandler } from '../netlify/lib/checkout.mjs';
import { checkoutId, token, orderID } from './fixtures.mjs';
import { MAX_PHOTO_BYTES, PHOTO_CHUNK_BYTES } from '../assets/shop-catalog.js';

const origin = 'https://deploy-preview-2--mini3dcreations.netlify.app';
function setup({ now } = {}) {
  const records = new Map(); const metadata = new Map();
  const store = {
    async get(key) { return records.get(key) || null; },
    async getMetadata(key) { return metadata.has(key) ? { metadata: metadata.get(key) } : null; },
    async setJSON(key, value, options) { if (!options?.onlyIfNew || !records.has(key)) records.set(key, value); },
    async set(key, value, options) { if (!options?.onlyIfNew || !records.has(key)) { records.set(key, value); metadata.set(key, options.metadata); } },
    async delete(key) { records.delete(key); metadata.delete(key); },
  };
  const handler = createPhotoHandler({ allowed: () => true, getStore: () => store, now });
  const upload = async (overrides = {}, extra = {}) => {
    const values = { checkoutId, token, kind: 'ornament', quantity: 1, slot: 0, ...overrides };
    const form = new FormData();
    for (const [key, value] of Object.entries(values)) form.append(key, String(value));
    form.append('file', new File([extra.bytes || new Uint8Array([255, 216, 255, 225, 0, 1])], extra.name || 'photo.jpg', { type: extra.type || 'image/jpeg' }));
    const encoded = new Request(`${origin}/.netlify/functions/order-photos`, { method: 'POST', body: form });
    return handler(new Request(encoded.url, { method: 'POST', headers: { origin: extra.origin || origin, 'content-type': encoded.headers.get('content-type') }, body: await encoded.arrayBuffer() }));
  };
  return { records, metadata, store, handler, upload };
}

test('photo upload is private, immutable, and bound to an order token', async () => {
  const app = setup();
  assert.equal((await app.upload()).status, 201);
  const selection = { kind: 'ornament', quantity: 1, photos: [{ slot: 0, name: 'photo.jpg' }] };
  assert.deepEqual(await verifyPhotos(app.store, selection, checkoutId, token), [`photos/${checkoutId}/0`]);
  await assert.rejects(() => verifyPhotos(app.store, selection, checkoutId, 'b'.repeat(64)));
  assert.equal((await app.upload({ token: 'b'.repeat(64) })).status, 403);
  assert.equal((await app.upload({}, { bytes: new Uint8Array([255, 216, 255, 2]) })).status, 409);
  assert.equal((await app.handler(new Request(`${origin}/.netlify/functions/order-photos`))).status, 405);
  app.records.set(`drafts/${checkoutId}`, { frozen: true });
  assert.equal((await app.upload()).status, 409);
});

test('photo API rejects wrong origins, invalid files, oversize files, and invalid slots', async () => {
  const app = setup();
  assert.equal((await app.upload({}, { origin: 'https://other.example' })).status, 403);
  assert.equal((await app.upload({}, { bytes: '<svg></svg>', type: 'image/svg+xml' })).status, 415);
  assert.equal((await app.upload({}, { bytes: new Uint8Array(4 * 1024 * 1024) })).status, 413);
  assert.equal((await app.upload({ slot: 1 })).status, 400);
  assert.equal((await app.upload({ kind: 'cube', quantity: 5 })).status, 400);
  assert.equal(app.records.size, 0);
});

test('photo session expires without exposing files', async () => {
  let clock = 0;
  const app = setup({ now: () => clock });
  await app.upload(); clock = 4 * 60 * 60 * 1000;
  assert.equal((await app.upload()).status, 410);
});

test('payment creation requires every uploaded photo and records their private storage keys', async () => {
  const app = setup(); let calls = 0;
  const handler = createCheckoutHandler({ env: { PAYPAL_SANDBOX_CLIENT_SECRET: 'TEST' }, getStore: () => app.store, paypal: { async create() { calls++; return { id: orderID, status: 'CREATED' }; } } });
  const selection = { kind: 'cube', quantity: 1, destinationZip: '65336', customerEmail: 'customer@example.com', personalization: { notes: 'In order' }, photos: Array.from({ length: 5 }, (_, slot) => ({ slot, name: 'photo.jpg' })) };
  const create = () => handler(new Request(`${origin}/.netlify/functions/sandbox-checkout`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', checkoutId, token, selection }) }));
  assert.equal((await create()).status, 400); assert.equal(calls, 0);
  for (let slot = 0; slot < 5; slot++) assert.equal((await app.upload({ kind: 'cube', slot })).status, 201);
  const response = await create();
  assert.equal(response.status, 201); assert.equal(calls, 1);
  assert.equal((await response.json()).totals.totalCents, 5500);
  assert.equal(app.records.get(`drafts/${checkoutId}`).uploads.length, 5);
});

test('a 10 MB original uploads in bounded pieces and is reassembled without changing a byte', async () => {
  const app = setup();
  const original = Buffer.alloc(MAX_PHOTO_BYTES, 71); original.set([255, 216, 255]);
  const chunkCount = Math.ceil(original.length / PHOTO_CHUNK_BYTES);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const result = await app.upload({ quantity: 5, photoMode: 'same', chunkIndex, chunkCount, totalSize: original.length }, {
      bytes: original.subarray(chunkIndex * PHOTO_CHUNK_BYTES, (chunkIndex + 1) * PHOTO_CHUNK_BYTES),
    });
    assert.equal(result.status, chunkIndex === chunkCount - 1 ? 201 : 202);
    assert.equal((await result.json()).saved, chunkIndex === chunkCount - 1);
    if (chunkIndex < chunkCount - 1) assert.equal(app.records.has(`photos/${checkoutId}/0`), false);
  }
  assert.deepEqual(app.records.get(`photos/${checkoutId}/0`), original);
  assert.equal([...app.records.keys()].some(key => key.startsWith('photo-parts/')), false);
  const retry = await app.upload({ quantity: 5, photoMode: 'same', chunkIndex: chunkCount - 1, chunkCount, totalSize: original.length }, { bytes: original.subarray((chunkCount - 1) * PHOTO_CHUNK_BYTES) });
  assert.equal(retry.status, 201);
  const selection = { kind: 'ornament', quantity: 5, photoMode: 'same', photos: [{ slot: 0, name: 'photo.jpg' }] };
  assert.deepEqual(await verifyPhotos(app.store, selection, checkoutId, token), [`photos/${checkoutId}/0`]);
  await assert.rejects(() => verifyPhotos(app.store, { ...selection, photoMode: 'different' }, checkoutId, token));
});

test('partial, oversized, altered and cross-session upload pieces cannot become a finished photo', async () => {
  const app = setup();
  const piece = Buffer.alloc(PHOTO_CHUNK_BYTES); piece.set([255, 216, 255]);
  const fields = { chunkIndex: 0, chunkCount: 2, totalSize: PHOTO_CHUNK_BYTES + 1 };
  assert.equal((await app.upload({ ...fields, totalSize: MAX_PHOTO_BYTES + 1 }, { bytes: piece })).status, 400);
  assert.equal((await app.upload({ ...fields, chunkIndex: 1 }, { bytes: new Uint8Array([1]) })).status, 409);
  assert.equal(app.records.has(`photos/${checkoutId}/0`), false);
  assert.equal((await app.upload(fields, { bytes: piece })).status, 202);
  assert.equal((await app.upload({ ...fields, token: 'b'.repeat(64) }, { bytes: piece })).status, 403);
  const altered = Buffer.from(piece); altered[10] = 9;
  assert.equal((await app.upload(fields, { bytes: altered })).status, 409);
  assert.equal((await app.upload({ ...fields, totalSize: PHOTO_CHUNK_BYTES + 2 }, { bytes: piece })).status, 409);
  assert.equal(app.records.has(`photos/${checkoutId}/0`), false);
});

test('five same-photo ornaments create a five-item payment after only one original is saved', async () => {
  const app = setup(); let paidSelection;
  assert.equal((await app.upload({ quantity: 5, photoMode: 'same' })).status, 201);
  assert.equal((await app.upload({ quantity: 5, photoMode: 'same', slot: 1 })).status, 400);
  const handler = createCheckoutHandler({ env: { PAYPAL_SANDBOX_CLIENT_SECRET: 'TEST' }, getStore: () => app.store, paypal: { async create(selection) { paidSelection = selection; return { id: orderID, status: 'CREATED' }; } } });
  const selection = { kind: 'ornament', quantity: 5, photoMode: 'same', destinationZip: '65336', customerEmail: 'customer@example.com', photos: [{ slot: 0, name: 'photo.jpg' }] };
  const result = await handler(new Request(`${origin}/.netlify/functions/sandbox-checkout`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', checkoutId, token, selection }) }));
  assert.equal(result.status, 201);
  assert.equal((await result.json()).totals.totalCents, 7000);
  assert.equal(paidSelection.quantity, 5);
  assert.equal(app.records.get(`drafts/${checkoutId}`).uploads.length, 1);
});
