import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyPhotos } from './photos.mjs';
import {
  SANDBOX_CLIENT_ID, normalizeSelection, quote, paypalOrder, completedCapture, money,
} from '../../assets/shop-catalog.js';

// Intentionally no live endpoint, environment switch, or arbitrary merchant ID.
export const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const ORDER_ID = /^[A-Z0-9]{8,32}$/;
const TTL_MS = 3 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');

export class CheckoutError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function authorize(draft, token) {
  if (!draft || !timingSafeEqual(Buffer.from(draft.tokenHash, 'hex'), Buffer.from(hash(token), 'hex'))) {
    throw new CheckoutError('Sandbox checkout was not found.', 404);
  }
}
export function sandboxAllowed(request, env) {
  const hostname = new URL(request.url).hostname;
  const preview = hostname === 'deploy-preview-2--mini3dcreations.netlify.app' ||
    hostname === 'feature-paypal-sandbox-checkout--mini3dcreations.netlify.app';
  const local = ['localhost', '127.0.0.1'].includes(hostname) && env.NETLIFY_DEV === 'true';
  return (preview || local) && env.CONTEXT !== 'production' &&
    (!env.PAYPAL_ENVIRONMENT || env.PAYPAL_ENVIRONMENT === 'sandbox') &&
    (!env.PAYPAL_SANDBOX_CLIENT_ID || env.PAYPAL_SANDBOX_CLIENT_ID === SANDBOX_CLIENT_ID);
}

export function paypalClient({ secret, fetch: request = fetch }) {
  async function accessToken() {
    const response = await request(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${SANDBOX_CLIENT_ID}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new CheckoutError('Sandbox credentials could not be verified.', 503);
    return data.access_token;
  }
  async function call(path, { method = 'GET', body, requestId } = {}) {
    const token = await accessToken();
    const response = await request(`${PAYPAL_BASE}${path}`, {
      method, signal: AbortSignal.timeout(12000),
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new CheckoutError('PayPal Sandbox could not confirm this request. Retry the same test confirmation.', 502);
    return response.json();
  }
  return {
    create: (selection, id) => call('/v2/checkout/orders', { method: 'POST', requestId: id, body: paypalOrder(selection, id) }),
    get: id => call(`/v2/checkout/orders/${id}`),
    capture: (id, checkoutId) => call(`/v2/checkout/orders/${id}/capture`, {
      method: 'POST', requestId: hash(`capture:${checkoutId}`).slice(0, 32), body: {},
    }),
  };
}

function verifyOrder(order, draft, orderID) {
  const units = order?.purchase_units;
  const unit = units?.[0];
  if (order?.id !== orderID || order.intent !== 'CAPTURE' || units?.length !== 1 ||
      unit.custom_id !== draft.checkoutId || unit.amount?.currency_code !== 'USD' ||
      unit.amount.value !== money(draft.totals.totalCents) ||
      unit.amount.breakdown?.item_total?.value !== money(draft.totals.subtotalCents) ||
      unit.amount.breakdown?.shipping?.value !== money(draft.totals.shippingCents)) {
    throw new CheckoutError('The Sandbox order does not match the saved configuration and total.', 409);
  }
  if (unit.shipping?.address?.country_code !== 'US') {
    throw new CheckoutError('Choose a US shipping address in PayPal Sandbox.', 422);
  }
}

export function createCheckoutHandler({ env, getStore, paypal, notify, now = () => new Date() }) {
  async function receiptResponse(receipt) {
    if (!notify) return json({ receipt });
    let notification;
    try { notification = await notify(receipt); }
    catch { notification = { status: 'retryable', acceptedParts: 0 }; }
    return json({ receipt, notification });
  }
  return async request => {
    try {
      const allowed = sandboxAllowed(request, env);
      const ready = allowed && Boolean(env.PAYPAL_SANDBOX_CLIENT_SECRET);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.searchParams.get('action') === 'config') {
        return json({ mode: 'sandbox', livePaymentsEnabled: false, disabled: !allowed, serverReady: ready,
          ...(notify ? { emailReady: ready && notify.ready === true } : {}) });
      }
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      if (!ready) throw new CheckoutError('Server-side Sandbox checkout is not configured for this preview.', 503);
      if (request.headers.get('origin') !== url.origin) throw new CheckoutError('Request origin is not allowed.', 403);
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        throw new CheckoutError('Send an application/json request.', 415);
      }
      const text = await request.text();
      if (Buffer.byteLength(text, 'utf8') > 12000) throw new CheckoutError('Checkout request is too large.', 413);
      let input;
      try { input = JSON.parse(text); } catch { throw new CheckoutError('Invalid JSON.'); }
      if (!input || !UUID.test(input.checkoutId) || !TOKEN.test(input.token)) throw new CheckoutError('Invalid checkout reference.');
      if (!['create', 'capture'].includes(input.action)) throw new CheckoutError('Unknown checkout action.');
      const store = getStore();
      const draftKey = `drafts/${input.checkoutId}`;
      const orderKey = `orders/${input.checkoutId}`;
      const receiptKey = `receipts/${input.checkoutId}`;
      let draft = await store.get(draftKey, { type: 'json' });

      if (input.action === 'create') {
        let selection;
        try { selection = normalizeSelection(input.selection); }
        catch (error) { throw new CheckoutError(error.message); }
        const selectionHash = hash(JSON.stringify(selection));
        if (!draft) {
          let uploads;
          try { uploads = await verifyPhotos(store, selection, input.checkoutId, input.token); }
          catch (error) { throw new CheckoutError(error.message); }
          // Persist the frozen configuration BEFORE contacting PayPal. Storage failure fails closed.
          const createdAt = now();
          const candidate = {
            version: 1, mode: 'sandbox', fulfillment: 'disabled', checkoutId: input.checkoutId,
            tokenHash: hash(input.token), selectionHash, selection, totals: quote(selection),
            uploads,
            createdAt: createdAt.toISOString(), expiresAt: new Date(+createdAt + TTL_MS).toISOString(),
          };
          await store.setJSON(draftKey, candidate, { onlyIfNew: true });
          draft = await store.get(draftKey, { type: 'json' });
        }
        authorize(draft, input.token);
        if (draft.selectionHash !== selectionHash) throw new CheckoutError('This checkout reference already belongs to a different configuration.', 409);
        const existing = await store.get(orderKey, { type: 'json' });
        if (existing) return json({ id: existing.paypalOrderId, totals: draft.totals });
        if (+now() > Date.parse(draft.expiresAt)) throw new CheckoutError('This test checkout has expired. Start a new configuration.', 410);
        const order = await paypal.create(draft.selection, input.checkoutId);
        if (!ORDER_ID.test(order?.id || '') || !['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) {
          throw new CheckoutError('PayPal did not create a valid Sandbox order.', 502);
        }
        await store.setJSON(orderKey, { paypalOrderId: order.id }, { onlyIfNew: true });
        const saved = await store.get(orderKey, { type: 'json' });
        if (saved?.paypalOrderId !== order.id) throw new CheckoutError('Sandbox order persistence needs verification.', 409);
        return json({ id: order.id, totals: draft.totals }, 201);
      }

      authorize(draft, input.token);
      const savedOrder = await store.get(orderKey, { type: 'json' });
      if (!ORDER_ID.test(input.orderID || '') || savedOrder?.paypalOrderId !== input.orderID) {
        throw new CheckoutError('This order does not belong to the current Sandbox checkout.', 409);
      }
      const existingReceipt = await store.get(receiptKey, { type: 'json' });
      if (existingReceipt) return receiptResponse(existingReceipt);
      // Read PayPal before capturing. This also recovers a completed capture after a timeout or failed storage write.
      let order = await paypal.get(input.orderID);
      verifyOrder(order, draft, input.orderID);
      if (order.status !== 'COMPLETED') {
        if (+now() > Date.parse(draft.expiresAt)) throw new CheckoutError('This test checkout has expired.', 410);
        if (order.status !== 'APPROVED') throw new CheckoutError('Approve this test order in PayPal Sandbox before confirmation.', 409);
        try { order = await paypal.capture(input.orderID, input.checkoutId); }
        catch { order = await paypal.get(input.orderID); }
      }
      let capture;
      try { capture = completedCapture(order, input.orderID, draft.totals); }
      catch (error) { throw new CheckoutError(error.message, 409); }
      const receipt = {
        version: 1, mode: 'sandbox', fulfillment: 'disabled', stored: true,
        checkoutId: input.checkoutId, paypalOrderId: input.orderID, captureId: capture.id,
        selection: draft.selection, totals: draft.totals, completedAt: now().toISOString(),
        uploads: draft.uploads || [],
        paypalShippingZip: order.purchase_units[0].shipping?.address?.postal_code || null,
      };
      // Immutable completion: concurrent callbacks cannot overwrite a verified receipt or duplicate a record.
      await store.setJSON(receiptKey, receipt, { onlyIfNew: true });
      const savedReceipt = await store.get(receiptKey, { type: 'json' });
      if (!savedReceipt) throw new CheckoutError('The payment was checked but its test record was not saved. Retry confirmation.', 503);
      return receiptResponse(savedReceipt);
    } catch (error) {
      // Never return raw PayPal bodies, bearer tokens, credentials, or customer data in errors.
      return json({ error: error instanceof CheckoutError ? error.message : 'Sandbox service is temporarily unavailable. Retry confirmation for the same order.' }, error instanceof CheckoutError ? error.status : 503);
    }
  };
}
