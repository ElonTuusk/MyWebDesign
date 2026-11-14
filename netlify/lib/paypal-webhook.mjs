import { enqueueRecovery, runOrderRecovery } from './order-recovery.mjs';

const ORDER_ID = /^[A-Z0-9]{8,32}$/;
const reply = (status = 204) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

export function createPayPalWebhook({ allowed, webhookId, getStore, paypal, notify, now }) {
  return async request => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.get('action') === 'readiness') {
      const report = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
      if (!allowed(request) || !webhookId) return report({ configured: false, subscriptionMatches: false }, 503);
      try {
        const details = await paypal.getWebhook(webhookId);
        const checks = {
          idMatches: details?.id === webhookId,
          urlMatches: details?.url === `${url.origin}${url.pathname}`,
          eventEnabled: Array.isArray(details?.event_types) && details.event_types.some(event =>
            ['PAYMENT.CAPTURE.COMPLETED', '*'].includes(event.name)),
        };
        // Only booleans leave the server. This does not send an event, capture a
        // payment, access an order, or expose the configured ID/credentials.
        return report({ configured: true, subscriptionMatches: Object.values(checks).every(Boolean), ...checks });
      } catch { return report({ configured: true, subscriptionMatches: false, reason: 'PAYPAL_LOOKUP_FAILED' }, 503); }
    }
    if (request.method !== 'POST') return reply(405);
    if (!allowed(request) || !webhookId) return reply(503);
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply(415);
    if (Number(request.headers.get('content-length') || 0) > 131072) return reply(413);
    for (const key of ['paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo']) {
      if (!request.headers.get(key) || request.headers.get(key).length > 4096) return reply(400);
    }
    try {
      const eventText = await request.text();
      if (Buffer.byteLength(eventText, 'utf8') > 131072) return reply(413);
      let event;
      try { event = JSON.parse(eventText); } catch { return reply(400); }
      const verification = await paypal.verifyWebhook({ eventText, headers: request.headers, webhookId });
      if (verification?.verification_status !== 'SUCCESS') return reply(401);
      if (event?.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return reply();
      const orderID = event.resource?.supplementary_data?.related_ids?.order_id;
      if (!ORDER_ID.test(orderID || '')) return reply(400);
      const store = getStore();
      const link = await store.get(`paypal-orders/${orderID}`, { type: 'json' });
      // Ignore payments from other applications. Never create an order from an event.
      if (!link?.checkoutId) return reply();
      const order = await store.get(`orders/${link.checkoutId}`, { type: 'json' });
      if (order?.paypalOrderId !== orderID) return reply(409);
      await enqueueRecovery(store, link.checkoutId, now);
      const summary = await runOrderRecovery({ getStore, paypal, notify, now, onlyCheckoutId: link.checkoutId, maxJobs: 1 });
      // Ask PayPal to redeliver transient failures as well as retaining our queue.
      // This also enables recovery while preview timers are not automatic.
      return reply(summary.waiting || summary.skipped ? 503 : 204);
    } catch { return reply(503); }
  };
}
