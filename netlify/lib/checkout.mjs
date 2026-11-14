import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyPhotos } from './photos.mjs';
import { OrderError, verifyOrder, saveCompletedOrder } from './order-records.mjs';
import { enqueueRecovery } from './order-recovery.mjs';
import {
  SANDBOX_CLIENT_ID, normalizeSelection, quote, paypalOrder,
} from '../../assets/shop-catalog.js';

// Intentionally no live endpoint, environment switch, or arbitrary merchant ID.
export const PAYPAL_BASE = 'https://api-m.sandbox.paypal.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const ORDER_ID = /^[A-Z0-9]{8,32}$/;
const TTL_MS = 3 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');

export class CheckoutError extends OrderError {}
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

export function paypalClient({ secret, fetch: request = fetch, timeoutMs = 12000 }) {
  async function accessToken() {
    const response = await request(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
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
      method, signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
      },
      ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
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
    verifyWebhook: ({ eventText, headers, webhookId }) => {
      const envelope = {
        transmission_id: headers.get('paypal-transmission-id'),
        transmission_time: headers.get('paypal-transmission-time'),
        cert_url: headers.get('paypal-cert-url'),
        auth_algo: headers.get('paypal-auth-algo'),
        transmission_sig: headers.get('paypal-transmission-sig'),
        webhook_id: webhookId,
      };
      // Preserve the event's original JSON bytes inside the verification request.
      const body = `${JSON.stringify(envelope).slice(0, -1)},"webhook_event":${eventText}}`;
      return call('/v1/notifications/verify-webhook-signature', { method: 'POST', body });
    },
  };
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
            version: 2, mode: 'sandbox', fulfillment: 'disabled', checkoutId: input.checkoutId,
            tokenHash: hash(input.token), selectionHash, selection, totals: quote(selection),
            uploads,
            createdAt: createdAt.toISOString(), expiresAt: new Date(+createdAt + TTL_MS).toISOString(),
          };
          await store.setJSON(draftKey, candidate, { onlyIfNew: true });
          draft = await store.get(draftKey, { type: 'json' });
        }
        authorize(draft, input.token);
        if (draft.selectionHash !== selectionHash) throw new CheckoutError('This checkout reference already belongs to a different configuration.', 409);
        await enqueueRecovery(store, input.checkoutId, now);
        const existing = await store.get(orderKey, { type: 'json' });
        if (existing) {
          await store.setJSON(`paypal-orders/${existing.paypalOrderId}`, { checkoutId: input.checkoutId }, { onlyIfNew: true });
          return json({ id: existing.paypalOrderId, totals: draft.totals });
        }
        if (+now() > Date.parse(draft.expiresAt)) throw new CheckoutError('This test checkout has expired. Start a new configuration.', 410);
        const order = await paypal.create(draft.selection, input.checkoutId);
        if (!ORDER_ID.test(order?.id || '') || !['CREATED', 'APPROVED', 'PAYER_ACTION_REQUIRED'].includes(order.status)) {
          throw new CheckoutError('PayPal did not create a valid Sandbox order.', 502);
        }
        await store.setJSON(orderKey, { paypalOrderId: order.id }, { onlyIfNew: true });
        const saved = await store.get(orderKey, { type: 'json' });
        if (saved?.paypalOrderId !== order.id) throw new CheckoutError('Sandbox order persistence needs verification.', 409);
        await store.setJSON(`paypal-orders/${order.id}`, { checkoutId: input.checkoutId }, { onlyIfNew: true });
        return json({ id: order.id, totals: draft.totals }, 201);
      }

      authorize(draft, input.token);
      const savedOrder = await store.get(orderKey, { type: 'json' });
      if (!ORDER_ID.test(input.orderID || '') || savedOrder?.paypalOrderId !== input.orderID) {
        throw new CheckoutError('This order does not belong to the current Sandbox checkout.', 409);
      }
      await enqueueRecovery(store, input.checkoutId, now);
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
      // Capture responses can contain payment details without the complete
      // order representation. Re-read it rather than dropping the paid receipt
      // or weakening the identity, amount, and shipping checks.
      try { verifyOrder(order, draft, input.orderID); }
      catch { order = await paypal.get(input.orderID); }
      const savedReceipt = await saveCompletedOrder({ store, draft, order, orderID: input.orderID, now });
      return receiptResponse(savedReceipt);
    } catch (error) {
      // Never return raw PayPal bodies, bearer tokens, credentials, or customer data in errors.
      return json({ error: error instanceof OrderError ? error.message : 'Sandbox service is temporarily unavailable. Retry confirmation for the same order.' }, error instanceof OrderError ? error.status : 503);
    }
  };
}
