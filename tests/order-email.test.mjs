import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createOrderNotifier } from '../netlify/lib/order-email.mjs';
import { normalizeSelection, quote } from '../assets/shop-catalog.js';
import { kit, checkoutId, orderID } from './fixtures.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function setup({ count = 0 } = {}) {
  let clock = new Date('2026-11-13T22:00:00Z');
  let failPart = -1;
  let failMarker = false;
  const env = { CONTEXT: 'deploy-preview', RESEND_API_KEY: 'TEST_SECRET', ORDER_NOTIFICATION_EMAIL: 'owner@example.com' };
  const selection = normalizeSelection(count ? {
    kind: 'ornament', quantity: count, destinationZip: '65336', customerEmail: 'customer@example.com',
    photos: Array.from({ length: count }, (_, slot) => ({ slot, name: `original-${slot}.jpg` })),
    personalization: { notes: 'Keep the original photos.' },
  } : kit());
  const receipt = {
    version: 1, mode: 'sandbox', fulfillment: 'disabled', stored: true, checkoutId,
    paypalOrderId: orderID, captureId: 'TESTCAPTURE123456', selection, totals: quote(selection),
    completedAt: clock.toISOString(), uploads: Array.from({ length: count }, (_, slot) => `photos/${checkoutId}/${slot}`),
  };
  const records = new Map([[`receipts/${checkoutId}`, receipt]]);
  const metadata = new Map();
  for (const [slot, key] of receipt.uploads.entries()) {
    const bytes = Buffer.from([255, 216, 255, slot]);
    records.set(key, bytes);
    metadata.set(key, { slot, name: selection.photos[slot].name, type: 'image/jpeg', kind: selection.kind, quantity: count, digest: hash(bytes) });
  }
  const store = {
    async get(key) { return records.has(key) ? structuredClone(records.get(key)) : null; },
    async getMetadata(key) { return metadata.has(key) ? { metadata: metadata.get(key) } : null; },
    async setJSON(key, value, options) {
      if (failMarker && /\/parts\/\d+$/.test(key)) throw new Error('Storage unavailable');
      if (options?.onlyIfNew && records.has(key)) return { modified: false };
      records.set(key, structuredClone(value)); return { modified: true };
    },
  };
  const requests = [];
  const deliveries = new Map();
  const fetch = async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails');
    const key = options.headers['Idempotency-Key'];
    const body = JSON.parse(options.body);
    requests.push({ key, body });
    if (Number(key.split('/').at(-1)) === failPart) return Response.json({ message: 'PRIVATE_PROVIDER_ERROR' }, { status: 429 });
    if (!deliveries.has(key)) deliveries.set(key, { id: `email-${deliveries.size + 1}`, payload: options.body });
    assert.equal(deliveries.get(key).payload, options.body, 'a retry must preserve the complete payload');
    return Response.json({ id: deliveries.get(key).id });
  };
  const makeNotifier = (overrides = {}) => createOrderNotifier({ env, getStore: () => store, fetch, now: () => clock, ...overrides });
  return { env, receipt, records, metadata, requests, deliveries, makeNotifier,
    setClock: value => { clock = value; }, setFailPart: value => { failPart = value; }, setFailMarker: value => { failMarker = value; } };
}

test('email is disabled without owner configuration and on production', async () => {
  for (const override of [{ ORDER_NOTIFICATION_EMAIL: '' }, { RESEND_API_KEY: '' }, { CONTEXT: 'production' }, { ORDER_NOTIFICATION_EMAIL: 'a@example.com,b@example.com' }, { ORDER_EMAIL_FROM: 'orders@example.com\r\nBcc: stranger@example.com' }]) {
    const app = setup(); Object.assign(app.env, override);
    const notify = app.makeNotifier();
    assert.equal(notify.ready, false);
    assert.equal((await notify(app.receipt)).status, 'not_configured');
    assert.equal(app.requests.length, 0);
  }
});

test('only a persisted verified Sandbox receipt can trigger an order email', async () => {
  const app = setup();
  app.records.delete(`receipts/${checkoutId}`);
  assert.equal((await app.makeNotifier()(app.receipt)).status, 'retryable');
  assert.equal(app.requests.length, 0);
  app.records.set(`receipts/${checkoutId}`, { ...app.receipt, mode: 'live' });
  assert.equal((await app.makeNotifier()(app.receipt)).status, 'retryable');
  assert.equal(app.requests.length, 0);
});

test('the owner receives the stored order and actual unchanged photos, never a customer-selected recipient', async () => {
  const app = setup({ count: 1 });
  const result = await app.makeNotifier()({ ...app.receipt, to: ['stranger@example.com'] });
  assert.equal(result.status, 'accepted');
  const { body } = app.requests[0];
  assert.deepEqual(body.to, ['owner@example.com']);
  assert.equal(body.from, 'Mini3DCreations <orders@mini3dcreations.com>');
  assert.match(body.subject, /SANDBOX TEST/);
  assert.match(body.text, /DO NOT FULFILL/);
  assert.match(body.text, /customer@example.com/);
  assert.match(body.text, /Keep the original photos/);
  assert.deepEqual(Buffer.from(body.attachments[0].content, 'base64'), Buffer.from([255, 216, 255, 0]));
  assert.equal(body.attachments[0].filename, '01-original-0.jpg');
  assert.ok(!body.attachments[0].path, 'private photos must not be exposed as public links');
  assert.ok(!JSON.stringify(result).includes('owner@example.com'));
  assert.ok(!JSON.stringify([...app.records.values()]).includes('TEST_SECRET'));
});

test('large photo orders split into numbered emails with no more than five attachments each', async () => {
  const app = setup({ count: 20 });
  assert.deepEqual(await app.makeNotifier()(app.receipt), { status: 'accepted', acceptedParts: 4, totalParts: 4 });
  assert.equal(app.deliveries.size, 4);
  const filenames = app.requests.flatMap(item => item.body.attachments.map(file => file.filename));
  assert.equal(new Set(filenames).size, 20);
  for (const [part, item] of app.requests.entries()) {
    assert.equal(item.body.attachments.length, 5);
    assert.ok(item.body.subject.endsWith(`(${part + 1}/4)`));
  }
});

test('bounded background attempts resume multipart attachments without changing the payload', async () => {
  const app = setup({ count: 6 });
  const notify = app.makeNotifier({ maxParts: 1 });
  assert.deepEqual(await notify(app.receipt), { status: 'retryable', acceptedParts: 1, totalParts: 2, reason: 'EMAIL_MORE_PARTS' });
  assert.deepEqual(await notify(app.receipt), { status: 'accepted', acceptedParts: 2, totalParts: 2 });
  assert.equal(app.deliveries.size, 2); assert.equal(app.requests.length, 2);
});

test('a shared ornament photo is attached once with the number of copies in the owner email', async () => {
  const app = setup({ count: 1 });
  app.receipt.selection = normalizeSelection({ ...app.receipt.selection, quantity: 5, photoMode: 'same' });
  app.receipt.totals = quote(app.receipt.selection);
  Object.assign(app.metadata.get(app.receipt.uploads[0]), { quantity: 5, photoMode: 'same' });
  assert.equal((await app.makeNotifier()(app.receipt)).status, 'accepted');
  const body = app.requests[0].body;
  assert.equal(body.attachments.length, 1);
  assert.match(body.text, /same photo on all 5 ornaments/);
  assert.match(body.text, /Sandbox total: \$70\.00/);
});

test('large originals are split by byte size and retain their exact content', async () => {
  const app = setup({ count: 3 });
  const sizes = [10, 10, 5].map(n => n * 1024 * 1024);
  for (const [slot, key] of app.receipt.uploads.entries()) {
    const bytes = Buffer.alloc(sizes[slot], slot + 1); bytes.set([255, 216, 255]);
    app.records.set(key, bytes);
    Object.assign(app.metadata.get(key), { size: bytes.length, digest: hash(bytes) });
  }
  assert.deepEqual(await app.makeNotifier()(app.receipt), { status: 'accepted', acceptedParts: 2, totalParts: 2 });
  const attached = app.requests.flatMap(r => r.body.attachments);
  assert.equal(attached.length, 3);
  for (const [slot, file] of attached.entries()) assert.equal(hash(Buffer.from(file.content, 'base64')), app.metadata.get(app.receipt.uploads[slot]).digest);
  for (const r of app.requests) assert.ok(r.body.attachments.reduce((sum, file) => sum + Buffer.from(file.content, 'base64').length, 0) <= 15 * 1024 * 1024);
});

test('email retries resume remaining parts and freeze recipient/configuration', async () => {
  const app = setup({ count: 6 }); app.setFailPart(1);
  const first = await app.makeNotifier()(app.receipt);
  assert.deepEqual(first, { status: 'retryable', acceptedParts: 1, reason: 'RESEND_RATE_LIMIT' });
  assert.ok(!JSON.stringify(first).includes('PRIVATE_PROVIDER_ERROR'));
  app.env.ORDER_NOTIFICATION_EMAIL = 'another@example.com';
  app.env.ORDER_EMAIL_FROM = 'different@example.com';
  app.setFailPart(-1);
  assert.equal((await app.makeNotifier()(app.receipt)).status, 'accepted');
  assert.equal(app.requests.filter(item => item.key.endsWith('/0')).length, 1);
  assert.deepEqual(app.requests.at(-1).body.to, ['owner@example.com']);
  assert.equal(app.requests.at(-1).body.from, 'Mini3DCreations <orders@mini3dcreations.com>');
  assert.equal(app.deliveries.size, 2);
});

test('concurrent requests and a lost acceptance write do not duplicate delivered email', async () => {
  const app = setup({ count: 1 }); app.setFailMarker(true);
  assert.equal((await app.makeNotifier()(app.receipt)).status, 'retryable');
  assert.equal(app.deliveries.size, 1);
  app.setFailMarker(false);
  const results = await Promise.all([app.makeNotifier()(app.receipt), app.makeNotifier()(app.receipt)]);
  assert.ok(results.every(value => value.status === 'accepted'));
  assert.equal(app.deliveries.size, 1);
  const count = app.requests.length;
  assert.equal((await app.makeNotifier()(app.receipt)).status, 'accepted');
  assert.equal(app.requests.length, count);
});

test('an uncertain email is not resent outside the provider deduplication window', async () => {
  const app = setup(); app.setFailMarker(true);
  await app.makeNotifier()(app.receipt);
  app.setFailMarker(false);
  app.setClock(new Date('2026-11-15T22:00:00Z'));
  assert.equal((await app.makeNotifier()(app.receipt)).status, 'needs_review');
  assert.equal(app.requests.length, 1);
});

test('missing, altered, or cross-order photos cannot be emailed', async () => {
  for (const change of [
    app => app.records.delete(app.receipt.uploads[0]),
    app => app.records.set(app.receipt.uploads[0], Buffer.from('changed')),
    app => { app.receipt.uploads[0] = 'photos/another-order/0'; },
    app => { app.metadata.get(app.receipt.uploads[0]).name = 'different.jpg'; },
    app => { app.metadata.get(app.receipt.uploads[0]).photoMode = 'same'; },
  ]) {
    const app = setup({ count: 1 }); change(app);
    assert.equal((await app.makeNotifier()(app.receipt)).status, 'retryable');
    assert.equal(app.requests.length, 0);
  }
});

test('email failure codes identify the step without exposing secrets or provider messages', async () => {
  const cases = [
    [401, 'validation_error', 'RESEND_AUTH'],
    [403, 'validation_error', 'RESEND_PERMISSION'],
    [409, 'invalid_idempotent_request', 'RESEND_CONFLICT'],
    [422, 'invalid_attachment', 'RESEND_VALIDATION'],
    [429, 'rate_limit_exceeded', 'RESEND_RATE_LIMIT'],
    [429, 'daily_quota_exceeded', 'RESEND_QUOTA'],
    [503, 'service_unavailable', 'RESEND_UNAVAILABLE'],
  ];
  for (const [status, name, reason] of cases) {
    const app = setup();
    const result = await app.makeNotifier({ fetch: async () => Response.json({ name, message: 'PRIVATE owner@example.com TEST_SECRET' }, { status }) })(app.receipt);
    assert.deepEqual(result, { status: 'retryable', acceptedParts: 0, reason });
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.ok(!JSON.stringify(result).includes('TEST_SECRET'));
    assert.ok(!JSON.stringify(result).includes('owner@example.com'));
  }
  const app = setup({ count: 1 });
  assert.equal((await app.makeNotifier({ fetch: async () => { throw new TypeError('PRIVATE NETWORK DETAILS'); } })(app.receipt)).reason, 'RESEND_CONNECTION');
  assert.equal((await app.makeNotifier({ fetch: async () => { throw new DOMException('PRIVATE TIMEOUT', 'TimeoutError'); } })(app.receipt)).reason, 'RESEND_TIMEOUT');
  app.setFailMarker(true);
  assert.equal((await app.makeNotifier()(app.receipt)).reason, 'EMAIL_ACCEPTANCE_SAVE');
  app.setFailMarker(false);
  app.metadata.get(app.receipt.uploads[0]).digest = 'changed';
  assert.equal((await app.makeNotifier()(app.receipt)).reason, 'PHOTO_CHECK');
});

test('surrounding whitespace is removed from the key only for the provider request', async () => {
  const app = setup(); app.env.RESEND_API_KEY = '  TEST_SECRET\n';
  const result = await app.makeNotifier({ fetch: async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer TEST_SECRET');
    return Response.json({ id: 'accepted-test' });
  } })(app.receipt);
  assert.equal(result.status, 'accepted');
});
