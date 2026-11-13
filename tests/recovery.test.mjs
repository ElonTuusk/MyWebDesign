import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutHandler, paypalClient } from '../netlify/lib/checkout.mjs';
import { enqueueRecovery, runOrderRecovery } from '../netlify/lib/order-recovery.mjs';
import { createOrderNotifier } from '../netlify/lib/order-email.mjs';
import { createPayPalWebhook } from '../netlify/lib/paypal-webhook.mjs';
import { recoveryRuntime } from '../netlify/lib/recovery-runtime.mjs';
import { receiptText } from '../assets/shop-catalog.js';
import { kit, checkoutId, token, orderID, approvedOrder } from './fixtures.mjs';

const origin = 'https://deploy-preview-2--mini3dcreations.netlify.app';
function setup() {
  let clock = new Date('2026-11-13T22:00:00Z');
  let revision = 0;
  let failingPrefix = '';
  let providerFails = false;
  let verification = 'SUCCESS';
  let order = approvedOrder();
  const records = new Map();
  const etags = new Map();
  const calls = { create: 0, capture: 0, get: 0, verify: 0, email: 0 };
  const deliveries = new Map();
  const store = {
    async get(key) { return structuredClone(records.get(key) || null); },
    async getWithMetadata(key) { return records.has(key) ? { data: await this.get(key), etag: etags.get(key), metadata: {} } : null; },
    async getMetadata() { return null; },
    async setJSON(key, value, options = {}) {
      if (typeof failingPrefix === 'function' ? failingPrefix(key) : failingPrefix && key.startsWith(failingPrefix)) throw new Error('PRIVATE storage failure');
      if ((options.onlyIfNew && records.has(key)) || (options.onlyIfMatch && etags.get(key) !== options.onlyIfMatch)) return { modified: false };
      const etag = String(++revision);
      records.set(key, structuredClone(value)); etags.set(key, etag);
      return { modified: true, etag };
    },
    async delete(key) { records.delete(key); etags.delete(key); },
    async *list({ prefix }) { yield { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
  };
  const paypal = {
    async create() { calls.create++; return { id: orderID, status: 'CREATED' }; },
    async get() { calls.get++; return structuredClone(order); },
    async capture() { calls.capture++; order = approvedOrder('COMPLETED'); return structuredClone(order); },
    async verifyWebhook() { calls.verify++; return { verification_status: verification }; },
  };
  const env = { CONTEXT: 'deploy-preview', PAYPAL_SANDBOX_CLIENT_SECRET: 'TEST_ONLY',
    RESEND_API_KEY: 'TEST_ONLY', ORDER_NOTIFICATION_EMAIL: 'owner@example.com' };
  const notify = createOrderNotifier({ env, getStore: () => store, now: () => clock, fetch: async (_url, options) => {
    calls.email++;
    if (providerFails) return Response.json({ name: 'application_error' }, { status: 503 });
    const key = options.headers['Idempotency-Key'];
    const previous = deliveries.get(key);
    if (previous) assert.equal(previous.body, options.body);
    else deliveries.set(key, { id: `email-${deliveries.size}`, body: options.body });
    return Response.json({ id: deliveries.get(key).id });
  } });
  const runtime = { getStore: () => store, paypal, notify, now: () => clock };
  const handler = createCheckoutHandler({ env, ...runtime });
  const send = body => handler(new Request(`${origin}/.netlify/functions/sandbox-checkout`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const webhook = createPayPalWebhook({ ...runtime, allowed: () => true, webhookId: 'TEST_WEBHOOK_ID' });
  const event = () => ({ id: 'WH-TEST', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {
    id: 'TESTCAPTURE123456', supplementary_data: { related_ids: { order_id: orderID } },
  } });
  const eventRequest = (value = event()) => new Request(`${origin}/.netlify/functions/paypal-webhook`, {
    method: 'POST', body: JSON.stringify(value), headers: {
      'content-type': 'application/json', 'paypal-transmission-id': 'TRANSMISSION_TEST',
      'paypal-transmission-time': clock.toISOString(), 'paypal-transmission-sig': 'TEST_SIGNATURE',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/TEST', 'paypal-auth-algo': 'SHA256withRSA',
    },
  });
  return { store, records, paypal, calls, deliveries, runtime, webhook, eventRequest,
    create: () => send({ action: 'create', checkoutId, token, selection: kit() }),
    capture: extra => send({ action: 'capture', checkoutId, token, orderID, ...extra }),
    run: extra => runOrderRecovery({ ...runtime, ...extra }),
    advance: ms => { clock = new Date(+clock + ms); },
    failWrites: value => { failingPrefix = value; },
    failEmail: value => { providerFails = value; },
    setOrder: value => { order = value; },
    setVerification: value => { verification = value; },
  };
}

test('new orders store the complete PayPal shipping address and include it in the owner email', async () => {
  const app = setup(); await app.create();
  const result = await (await app.capture({ shippingAddress: { name: 'FORGED', addressLine1: 'FORGED' } })).json();
  assert.equal(result.receipt.shippingAddress.name, 'Sandbox Buyer');
  assert.equal(result.receipt.shippingAddress.addressLine1, '123 Test Street');
  assert.equal(result.receipt.shippingAddress.addressLine2, 'Unit 2');
  assert.equal(result.receipt.shippingAddress.city, 'Knob Noster');
  assert.equal(result.receipt.shippingAddress.region, 'MO');
  assert.equal(result.receipt.shippingAddress.postalCode, '65336');
  assert.match(receiptText(result.receipt), /Sandbox Buyer\n123 Test Street\nUnit 2\nKnob Noster, MO 65336\nUS/);
  const email = JSON.parse([...app.deliveries.values()][0].body);
  assert.match(email.text, /123 Test Street/);
  assert.doesNotMatch(JSON.stringify([...app.records.values()]), /FORGED|TEST_ONLY/);
});

test('an incomplete PayPal shipping address is rejected before payment capture', async () => {
  const app = setup(); await app.create();
  const bad = approvedOrder(); delete bad.purchase_units[0].shipping.address.address_line_1;
  app.setOrder(bad);
  assert.equal((await app.capture()).status, 422);
  assert.equal(app.calls.capture, 0); assert.equal(app.calls.email, 0);
});

test('queue persistence fails closed before creating a PayPal order', async () => {
  const app = setup(); app.failWrites('recovery-queue/');
  assert.equal((await app.create()).status, 503);
  assert.equal(app.calls.create, 0);
  app.failWrites(''); assert.equal((await app.create()).status, 201);
  assert.equal(app.records.get(`paypal-orders/${orderID}`).checkoutId, checkoutId);
});

test('server recovery finishes a paid order after receipt storage fails and the tab closes', async () => {
  const app = setup(); await app.create(); app.failWrites('receipts/');
  assert.equal((await app.capture()).status, 503);
  assert.equal(app.calls.capture, 1);
  app.advance(61000);
  await app.run();
  assert.equal(app.records.get(`recovery/${checkoutId}`).status, 'waiting_payment', 'storage failure remains retryable');
  app.failWrites(''); app.advance(301000);
  const recovered = await app.run();
  assert.equal(recovered.accepted, 1);
  assert.equal(app.calls.capture, 1, 'worker never repeats payment');
  assert.equal(app.records.get(`receipts/${checkoutId}`).shippingAddress.name, 'Sandbox Buyer');
  assert.equal(app.deliveries.size, 1);
  assert.equal(app.records.has(`recovery-queue/${checkoutId}`), false);
});

test('waiting and approved orders are polled without ever capturing payment', async () => {
  const app = setup(); await app.create();
  const created = approvedOrder('CREATED'); delete created.purchase_units[0].shipping;
  app.setOrder(created); app.advance(61000);
  await app.run();
  assert.equal(app.records.get(`recovery/${checkoutId}`).status, 'waiting_payment');
  app.setOrder(approvedOrder()); app.advance(301000); await app.run();
  assert.equal(app.calls.capture, 0); assert.equal(app.calls.email, 0);
  app.setOrder(approvedOrder('COMPLETED')); app.advance(301000);
  assert.equal((await app.run()).accepted, 1);
  assert.equal(app.calls.capture, 0);
});

test('failed email is retried from private storage without the customer or a second payment', async () => {
  const app = setup(); await app.create(); app.failEmail(true);
  const first = await (await app.capture()).json();
  assert.equal(first.notification.status, 'retryable');
  app.advance(61000); await app.run();
  assert.equal(app.records.get(`recovery/${checkoutId}`).status, 'retrying_email');
  app.failEmail(false); app.advance(61000);
  assert.equal((await app.run()).accepted, 1);
  assert.equal(app.deliveries.size, 1); assert.equal(app.calls.capture, 1);
});

test('concurrent recovery invocations share an atomic lease and send once', async () => {
  const app = setup(); await app.create(); app.setOrder(approvedOrder('COMPLETED')); app.advance(61000);
  await Promise.all([app.run(), app.run()]);
  assert.equal(app.calls.email, 1); assert.equal(app.deliveries.size, 1);
  assert.equal(app.records.get(`recovery/${checkoutId}`).status, 'accepted');
  assert.equal(app.calls.capture, 0);
});

test('a crashed worker lease expires; uncertainty after provider acceptance remains deduplicated', async () => {
  const app = setup(); await app.create(); app.setOrder(approvedOrder('COMPLETED')); app.advance(61000);
  // Simulate losing the provider-acceptance storage write after delivery.
  app.failWrites(key => key === `notifications/${checkoutId}/parts/0`);
  await app.run();
  assert.equal(app.deliveries.size, 1, 'provider accepted before the result write failed');
  app.failWrites('');
  const stateKey = `recovery/${checkoutId}`;
  const state = app.records.get(stateKey);
  await app.store.setJSON(stateKey, { ...state, leaseUntil: Date.parse('2026-11-13T22:03:00Z') });
  assert.equal((await app.run()).processed, 0);
  app.advance(121000); await app.run();
  assert.equal(app.deliveries.size, 1); assert.equal(app.calls.capture, 0);
  assert.equal(app.calls.email, 2, 'retry reuses the provider idempotency key');
});

test('scheduled batches rotate past older unapproved orders rather than starving the queue', async () => {
  const app = setup(); await app.create();
  const ids = [checkoutId, checkoutId.slice(0, -1) + 'e', checkoutId.slice(0, -1) + 'f'];
  const draft = app.records.get(`drafts/${checkoutId}`);
  for (const id of ids.slice(1)) {
    await app.store.setJSON(`drafts/${id}`, { ...draft, checkoutId: id });
    await app.store.setJSON(`orders/${id}`, { paypalOrderId: orderID });
    await enqueueRecovery(app.store, id, () => new Date('2026-11-13T22:00:00Z'));
  }
  for (let i = 0; i < 3; i++) { app.advance(301000); await app.run({ maxJobs: 1 }); }
  for (const id of ids) assert.equal(app.records.get(`recovery/${id}`).attempts, 1);
  assert.equal(app.calls.capture, 0);
});

test('pending and forged captures never produce an order email', async () => {
  const pending = setup(); await pending.create(); pending.setOrder(approvedOrder('COMPLETED', 'PENDING')); pending.advance(61000);
  await pending.run(); assert.equal(pending.calls.email, 0);
  assert.equal(pending.records.has(`receipts/${checkoutId}`), false);
  pending.setOrder(approvedOrder('COMPLETED')); pending.advance(301000);
  assert.equal((await pending.run()).accepted, 1);
  const forged = setup(); await forged.create(); const bad = approvedOrder('COMPLETED');
  bad.purchase_units[0].amount.value = '0.01'; forged.setOrder(bad); forged.advance(61000);
  assert.equal((await forged.run()).review, 1); assert.equal(forged.calls.email, 0);
});

test('emails past the deduplication window move to owner review instead of sending again', async () => {
  const app = setup(); await app.create(); app.failEmail(true); await app.capture();
  app.advance(24 * 60 * 60 * 1000); app.failEmail(false);
  const before = app.calls.email;
  assert.equal((await app.run()).review, 1);
  assert.equal(app.calls.email, before);
  assert.equal(app.records.get(`recovery/${checkoutId}`).status, 'needs_review');
});

test('a verified completed-payment webhook recovers a closed-tab order; duplicates are harmless', async () => {
  const app = setup(); await app.create(); app.setOrder(approvedOrder('COMPLETED'));
  assert.equal((await app.webhook(app.eventRequest())).status, 204);
  assert.equal((await app.webhook(app.eventRequest())).status, 204);
  assert.equal(app.calls.verify, 2); assert.equal(app.calls.capture, 0);
  assert.equal(app.deliveries.size, 1); assert.equal(app.calls.email, 1);
  assert.equal(app.records.get(`receipts/${checkoutId}`).stored, true);
});

test('unverified webhooks cannot read payment details or trigger an email', async () => {
  const app = setup(); await app.create(); app.setOrder(approvedOrder('COMPLETED')); app.setVerification('FAILURE');
  assert.equal((await app.webhook(app.eventRequest())).status, 401);
  assert.equal(app.calls.get, 0); assert.equal(app.calls.email, 0);
  assert.equal(app.records.has(`receipts/${checkoutId}`), false);
  const malformed = new Request(`${origin}/.netlify/functions/paypal-webhook`, { method: 'POST', body: '{}' });
  assert.equal((await app.webhook(malformed)).status, 415);
});

test('transient webhook email failures retain the queue and ask PayPal to redeliver', async () => {
  const app = setup(); await app.create(); app.setOrder(approvedOrder('COMPLETED')); app.failEmail(true);
  assert.equal((await app.webhook(app.eventRequest())).status, 503);
  assert.equal(app.records.has(`recovery-queue/${checkoutId}`), true);
  app.failEmail(false);
  assert.equal((await app.webhook(app.eventRequest())).status, 204);
  assert.equal(app.deliveries.size, 1); assert.equal(app.calls.capture, 0);
});

test('PayPal postback preserves the original webhook JSON and uses the configured ID', async () => {
  const raw = '{ "id" : "WH-TEST", "event_type" : "PAYMENT.CAPTURE.COMPLETED" }';
  let verificationBody;
  const client = paypalClient({ secret: 'TEST_ONLY', fetch: async (url, options) => {
    if (url.endsWith('/token')) return Response.json({ access_token: 'TEST_ACCESS_TOKEN' });
    verificationBody = options.body;
    return Response.json({ verification_status: 'SUCCESS' });
  } });
  await client.verifyWebhook({ eventText: raw, headers: new Headers({ 'paypal-transmission-id': 'TRANSMISSION_TEST' }), webhookId: 'TEST_WEBHOOK_ID' });
  assert.ok(verificationBody.includes(`"webhook_event":${raw}`));
  assert.equal(JSON.parse(verificationBody).webhook_id, 'TEST_WEBHOOK_ID');
  assert.equal(recoveryRuntime({ CONTEXT: 'production', PAYPAL_SANDBOX_CLIENT_SECRET: 'TEST_ONLY' }), null);
  assert.equal(recoveryRuntime({ PAYPAL_ENVIRONMENT: 'live', PAYPAL_SANDBOX_CLIENT_SECRET: 'TEST_ONLY' }), null);
  assert.equal(recoveryRuntime({ CONTEXT: 'deploy-preview', PAYPAL_SANDBOX_CLIENT_SECRET: 'TEST_ONLY' }, { deploy: { context: 'production' } }), null);
  assert.ok(recoveryRuntime({ PAYPAL_SANDBOX_CLIENT_SECRET: 'TEST_ONLY' }, { deploy: { context: 'deploy-preview' } }));
});
