import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutHandler, paypalClient, PAYPAL_BASE } from '../netlify/lib/checkout.mjs';
import { kit, checkoutId, token, orderID, approvedOrder } from './fixtures.mjs';

const origin = 'https://deploy-preview-2--mini3dcreations.netlify.app';
const endpoint = `${origin}/.netlify/functions/sandbox-checkout`;
function setup(options = {}) {
  const records = new Map();
  const calls = { create: 0, capture: 0, get: 0 };
  let order = approvedOrder();
  const store = {
    async get(key) { return structuredClone(records.get(key) || null); },
    async setJSON(key, value, settings) {
      if (options.failWrite?.(key)) throw new Error('Storage failure');
      if (settings?.onlyIfNew && records.has(key)) return { modified: false };
      records.set(key, structuredClone(value)); return { modified: true };
    },
  };
  const paypal = {
    async create(selection, id) {
      calls.create++; assert.equal(id, checkoutId); assert.equal(selection.quantity, 1);
      return { id: orderID, status: 'CREATED' };
    },
    async get() { calls.get++; return structuredClone(order); },
    async capture(id, key) {
      calls.capture++; assert.equal(id, orderID); assert.equal(key, checkoutId);
      order = approvedOrder('COMPLETED');
      if (options.pending) order.purchase_units[0].payments.captures[0].status = 'PENDING';
      if (options.captureTimeout) throw new Error('Response lost after PayPal captured');
      return structuredClone(order);
    },
  };
  const handler = createCheckoutHandler({ env: { PAYPAL_SANDBOX_CLIENT_SECRET: 'TEST_ONLY', ...options.env }, getStore: () => store, paypal, now: options.now, notify: options.notify });
  const send = (body, extra = {}) => handler(new Request(extra.url || endpoint, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra.headers }, body: JSON.stringify(body),
  }));
  const create = (overrides = {}, extra) => send({ action: 'create', checkoutId, token, selection: kit(), ...overrides }, extra);
  const capture = (overrides = {}) => send({ action: 'capture', checkoutId, token, orderID, ...overrides });
  return { handler, records, calls, create, capture, setOrder: value => { order = value; } };
}

test('server stores authoritative $70 configuration then one verified receipt', async () => {
  const app = setup();
  const response = await app.create({ selection: { ...kit(), total: '0.01' } });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).totals.totalCents, 7000);
  const draft = app.records.get(`drafts/${checkoutId}`);
  assert.equal(draft.totals.totalCents, 7000);
  assert.ok(!JSON.stringify(draft).includes(token));
  assert.equal(app.records.has(`receipts/${checkoutId}`), false);
  const confirmed = await app.capture();
  const receipt = (await confirmed.json()).receipt;
  assert.equal(confirmed.status, 200);
  assert.equal(receipt.fulfillment, 'disabled');
  assert.equal(receipt.stored, true);
  assert.equal(receipt.totals.totalCents, 7000);
  assert.ok(!('tokenHash' in receipt));
});
test('duplicate create/capture callbacks return the same order and receipt', async () => {
  const app = setup();
  await app.create(); await app.create();
  const first = await (await app.capture()).json();
  const second = await (await app.capture()).json();
  assert.deepEqual(first, second);
  assert.equal(app.calls.create, 1);
  assert.equal(app.calls.capture, 1);
  assert.equal([...app.records.keys()].filter(key => key.startsWith('receipts/')).length, 1);
});
test('concurrent capture requests converge on one immutable receipt', async () => {
  const app = setup(); await app.create();
  const responses = await Promise.all([app.capture(), app.capture()]);
  assert.equal(responses[0].status, 200); assert.equal(responses[1].status, 200);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal([...app.records.keys()].filter(key => key.startsWith('receipts/')).length, 1);
});
test('failed storage prevents creation/capture and never claims successful persistence', async () => {
  const blocked = setup({ failWrite: () => true });
  assert.equal((await blocked.create()).status, 503);
  assert.equal(blocked.calls.create, 0);
  let failReceipt = true;
  const app = setup({ failWrite: key => failReceipt && key.startsWith('receipts/') });
  await app.create();
  assert.equal((await app.capture()).status, 503);
  assert.equal(app.calls.capture, 1);
  failReceipt = false;
  assert.equal((await app.capture()).status, 200);
  assert.equal(app.calls.capture, 1, 'retry reconciles the existing PayPal capture');
});
test('capture response timeout is recovered from PayPal without a second payment', async () => {
  const app = setup({ captureTimeout: true }); await app.create();
  assert.equal((await app.capture()).status, 200);
  assert.equal(app.calls.capture, 1);
});
test('capture requires possession of the checkout token and its matching order', async () => {
  const app = setup(); await app.create();
  assert.equal((await app.capture({ token: 'b'.repeat(64) })).status, 404);
  assert.equal((await app.capture({ orderID: 'OTHERORDER12345' })).status, 409);
  assert.equal((await app.capture({ checkoutId: '61cdb567-5530-4e50-9eb6-ab7c82b161ee' })).status, 404);
  assert.equal(app.calls.capture, 0);
});
test('reusing a checkout ID cannot change the configuration or price', async () => {
  const app = setup(); await app.create();
  assert.equal((await app.create({ selection: { ...kit(), quantity: 2 } })).status, 409);
});
test('forged or non-US PayPal order is rejected before capture', async () => {
  for (const mutate of [
    order => { order.purchase_units[0].amount.value = '1.00'; },
    order => { order.purchase_units[0].custom_id = 'another-checkout'; },
    order => { order.purchase_units[0].shipping.address.country_code = 'CA'; },
  ]) {
    const app = setup(); await app.create(); const order = approvedOrder(); mutate(order); app.setOrder(order);
    assert.ok((await app.capture()).status >= 400);
    assert.equal(app.calls.capture, 0);
  }
});
test('pending captures are never recorded as completed', async () => {
  const app = setup({ pending: true }); await app.create();
  assert.equal((await app.capture()).status, 409);
  assert.equal(app.records.has(`receipts/${checkoutId}`), false);
});
test('production/live environment, missing secrets and cross-origin requests fail closed', async () => {
  for (const env of [{ CONTEXT: 'production' }, { PAYPAL_ENVIRONMENT: 'live' }, { PAYPAL_SANDBOX_CLIENT_SECRET: '' }, { PAYPAL_SANDBOX_CLIENT_ID: 'different-client' }]) {
    const app = setup({ env }); assert.equal((await app.create()).status, 503); assert.equal(app.calls.create, 0);
  }
  const app = setup();
  assert.equal((await app.create({}, { headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await app.create({}, { url: 'https://mini3dcreations.com/.netlify/functions/sandbox-checkout' })).status, 503);
});
test('config endpoint exposes no credentials or stored order data', async () => {
  const app = setup();
  const response = await app.handler(new Request(`${endpoint}?action=config`));
  assert.deepEqual(await response.json(), { mode: 'sandbox', livePaymentsEnabled: false, disabled: false, serverReady: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await app.handler(new Request(endpoint))).status, 405);
});
test('expired unapproved drafts cannot be captured', async () => {
  let clock = new Date('2026-11-12T00:00:00Z');
  const app = setup({ now: () => clock }); await app.create(); clock = new Date('2026-11-12T04:00:00Z');
  assert.equal((await app.capture()).status, 410); assert.equal(app.calls.capture, 0);
});
test('PayPal client uses only sandbox URLs and stable, distinct request IDs', async () => {
  const requests = [];
  const client = paypalClient({ secret: 'TEST_ONLY', fetch: async (url, options) => {
    requests.push({ url, options });
    assert.ok(url.startsWith(`${PAYPAL_BASE}/`));
    return Response.json(url.endsWith('/token') ? { access_token: 'TEST_TOKEN' } : { id: orderID });
  } });
  await client.create(kit(), checkoutId);
  await client.capture(orderID, checkoutId); await client.capture(orderID, checkoutId);
  const operations = requests.filter(value => !value.url.endsWith('/token'));
  assert.equal(operations[0].options.headers['PayPal-Request-Id'], checkoutId);
  assert.notEqual(operations[1].options.headers['PayPal-Request-Id'], checkoutId);
  assert.equal(operations[1].options.headers['PayPal-Request-Id'], operations[2].options.headers['PayPal-Request-Id']);
  assert.equal(JSON.parse(operations[0].options.body).purchase_units[0].amount.value, '70.00');
});

test('email runs only after a verified receipt is persisted; an email failure does not invalidate payment', async () => {
  let notified = 0;
  const app = setup({ notify: async receipt => {
    assert.deepEqual(app.records.get(`receipts/${checkoutId}`), receipt);
    notified++;
    throw new Error('Provider failed');
  } });
  await app.create(); assert.equal(notified, 0);
  const response = await app.capture();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.receipt.stored, true);
  assert.equal(result.notification.status, 'retryable');
  await app.capture();
  assert.equal(notified, 2);
  assert.equal(app.calls.capture, 1, 'retrying email must not repeat the payment');
  const failed = setup({ pending: true, notify: () => assert.fail('Must not email a pending capture') });
  await failed.create(); assert.equal((await failed.capture()).status, 409);
  const blocked = setup({ failWrite: key => key.startsWith('receipts/'), notify: () => assert.fail('Must not email an unrecorded capture') });
  await blocked.create(); assert.equal((await blocked.capture()).status, 503);
});
