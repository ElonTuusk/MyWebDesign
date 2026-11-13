import { randomUUID } from 'node:crypto';
import { OrderError, saveCompletedOrder, verifyOrder } from './order-records.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['accepted', 'needs_review', 'unpaid']);
const DAY = 24 * 60 * 60 * 1000;

// Written before contacting PayPal: a lost tab or capture response cannot lose
// the server's pointer to this order. Neither queue nor history contains tokens.
export async function enqueueRecovery(store, checkoutId, now = () => new Date()) {
  if (!UUID.test(checkoutId)) throw new Error('Invalid recovery reference');
  const key = `recovery/${checkoutId}`;
  await store.setJSON(key, {
    version: 1, checkoutId, status: 'waiting_payment', attempts: 0,
    createdAt: now().toISOString(), nextAttemptAt: +now() + 60000,
  }, { onlyIfNew: true });
  const state = await store.get(key, { type: 'json' });
  if (!TERMINAL.has(state?.status)) {
    await store.setJSON(`recovery-queue/${checkoutId}`, { checkoutId }, { onlyIfNew: true });
  }
}

async function recover({ store, checkoutId, paypal, notify, now }) {
  const draft = await store.get(`drafts/${checkoutId}`, { type: 'json' });
  if (!draft || draft.checkoutId !== checkoutId || draft.mode !== 'sandbox' || draft.fulfillment !== 'disabled') {
    return { status: 'needs_review', reason: 'DRAFT_CHECK' };
  }
  let receipt = await store.get(`receipts/${checkoutId}`, { type: 'json' });
  if (!receipt) {
    const link = await store.get(`orders/${checkoutId}`, { type: 'json' });
    const age = +now() - Date.parse(draft.createdAt);
    if (!link?.paypalOrderId) return { status: age > DAY ? 'unpaid' : 'waiting_payment' };
    let order;
    try { order = await paypal.get(link.paypalOrderId); }
    catch { return { status: age > 7 * DAY ? 'needs_review' : 'waiting_payment', reason: 'PAYPAL_CONNECTION' }; }
    const captures = order?.purchase_units?.[0]?.payments?.captures || [];
    if (captures.some(capture => capture.status === 'PENDING')) {
      return { status: age > 7 * DAY ? 'needs_review' : 'waiting_payment', reason: 'PAYPAL_PENDING' };
    }
    if (order.status !== 'COMPLETED') {
      // Never capture an approved but unpaid order from a timer or webhook.
      return { status: age > DAY && !captures.length ? 'unpaid' : 'waiting_payment' };
    }
    try { verifyOrder(order, draft, link.paypalOrderId); }
    catch { return { status: 'needs_review', reason: 'PAYPAL_ORDER_CHECK' }; }
    try { receipt = await saveCompletedOrder({ store, draft, order, orderID: link.paypalOrderId, now }); }
    catch (error) { return { status: error instanceof OrderError && error.status < 500 ? 'needs_review' : 'waiting_payment', reason: 'RECEIPT_RECOVERY' }; }
  }
  if (!receipt.stored || receipt.checkoutId !== checkoutId || receipt.mode !== 'sandbox' || receipt.fulfillment !== 'disabled') {
    return { status: 'needs_review', reason: 'RECEIPT_CHECK' };
  }
  const notification = notify ? await notify(receipt) : { status: 'not_configured' };
  return {
    status: notification.status === 'accepted' ? 'accepted' : notification.status === 'needs_review' ? 'needs_review' : 'retrying_email',
    ...(notification.reason ? { reason: notification.reason } : {}),
    acceptedParts: notification.acceptedParts || 0,
    ...(notification.totalParts ? { totalParts: notification.totalParts } : {}),
  };
}

export async function runOrderRecovery({ getStore, paypal, notify, now = () => new Date(),
  maxJobs = 3, budgetMs = 21000, onlyCheckoutId }) {
  const store = getStore();
  const started = Date.now();
  const summary = { processed: 0, accepted: 0, waiting: 0, review: 0, skipped: 0 };
  const cursorKey = 'recovery-control/cursor';
  const previous = onlyCheckoutId ? null : await store.get(cursorKey, { type: 'json' });
  const cursor = UUID.test(previous?.checkoutId || '') ? previous.checkoutId : null;
  let lastVisited;
  try {
    // Rotate through the queue so a few slow/unapproved orders cannot occupy
    // every scheduled batch and starve newer, paid orders.
    for (const wrap of cursor ? [false, true] : [false]) {
      const pages = onlyCheckoutId
        ? [{ blobs: UUID.test(onlyCheckoutId) ? [{ key: `recovery-queue/${onlyCheckoutId}` }] : [] }]
        : store.list({ prefix: 'recovery-queue/', paginate: true });
      for await (const page of pages) {
        for (const blob of page.blobs.toSorted((a, b) => a.key.localeCompare(b.key))) {
          const checkoutId = blob.key.slice('recovery-queue/'.length);
          if (!UUID.test(checkoutId)) continue;
          if (cursor && (wrap ? checkoutId > cursor : checkoutId <= cursor)) continue;
          if (Date.now() - started >= budgetMs || summary.processed >= maxJobs) return summary;
          lastVisited = checkoutId;
          const key = `recovery/${checkoutId}`;
          const current = await store.getWithMetadata(key, { type: 'json' });
          if (!current?.data || !current.etag) continue;
          const state = current.data;
          if (TERMINAL.has(state.status)) { await store.delete(blob.key); continue; }
          if (state.leaseUntil > +now() || (!onlyCheckoutId && state.nextAttemptAt > +now())) { summary.skipped++; continue; }
          const owner = randomUUID();
          const claimed = { ...state, leaseOwner: owner, leaseUntil: +now() + 90000 };
          const lease = await store.setJSON(key, claimed, { onlyIfMatch: current.etag });
          if (!lease.modified || !lease.etag) { summary.skipped++; continue; }
          let result;
          try { result = await recover({ store, checkoutId, paypal, notify, now }); }
          catch { result = { status: 'retrying_email', reason: 'RECOVERY_TEMPORARY_FAILURE' }; }
          const attempts = (state.attempts || 0) + 1;
          const nextAttemptAt = +now() + (result.status === 'waiting_payment' ? 300000 : Math.min(1800000, 60000 * 2 ** Math.min(attempts - 1, 5)));
          const final = { ...claimed, ...result, attempts, updatedAt: now().toISOString(), nextAttemptAt, leaseUntil: 0 };
          delete final.leaseOwner;
          const saved = await store.setJSON(key, final, { onlyIfMatch: lease.etag });
          if (!saved.modified) { summary.skipped++; continue; }
          // Persist the outcome before removing the queue marker. A crash between
          // these operations is harmless: the next run removes a terminal marker.
          if (TERMINAL.has(final.status)) await store.delete(blob.key);
          summary.processed++;
          if (final.status === 'accepted') summary.accepted++;
          else if (final.status === 'needs_review') summary.review++;
          else summary.waiting++;
        }
      }
    }
  } finally {
    if (lastVisited && !onlyCheckoutId) {
      // This is only a fairness bookmark; jobs and their leases are authoritative.
      try { await store.setJSON(cursorKey, { checkoutId: lastVisited }); } catch { /* Try again next run. */ }
    }
  }
  return summary;
}
