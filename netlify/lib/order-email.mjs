import { createHash } from 'node:crypto';
import { MAX_PHOTO_BYTES, photoCount, receiptText } from '../../assets/shop-catalog.js';

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const EMAIL_PHOTO_BYTES = 15 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;

function settings(env) {
  const to = env.ORDER_NOTIFICATION_EMAIL?.trim();
  const from = env.ORDER_EMAIL_FROM?.trim() || 'orders@mini3dcreations.com';
  return env.CONTEXT !== 'production' && env.RESEND_API_KEY &&
    EMAIL.test(to || '') && EMAIL.test(from) && to.length <= 254 && from.length <= 254
    ? { from: `Mini3DCreations <${from}>`, to: [to] } : null;
}

// Only server environment settings select the recipient. Customer form input cannot
// redirect photos, change headers, or send email before a verified stored payment.
export function createOrderNotifier({ env, getStore, fetch: request = fetch, now = () => new Date() }) {
  async function notify(receiptReference) {
    const config = settings(env);
    if (!config) return { status: 'not_configured', acceptedParts: 0 };
    let acceptedParts = 0;
    try {
      if (!UUID.test(receiptReference?.checkoutId || '')) throw new Error('Invalid receipt');
      const store = getStore();
      const receipt = await store.get(`receipts/${receiptReference.checkoutId}`, { type: 'json' });
      if (!receipt || receipt.mode !== 'sandbox' || receipt.fulfillment !== 'disabled' ||
          receipt.stored !== true || !receipt.captureId || !receipt.paypalOrderId ||
          receipt.checkoutId !== receiptReference.checkoutId) throw new Error('Unverified receipt');
      const { checkoutId } = receipt;
      const photos = receipt.selection.photos || [];
      const keys = receipt.uploads || [];
      if (keys.length !== photoCount(receipt.selection) || keys.length !== photos.length ||
          keys.some((key, slot) => key !== `photos/${checkoutId}/${slot}`)) throw new Error('Invalid photo references');
      const jobKey = `notifications/${checkoutId}`;
      let job = await store.get(jobKey, { type: 'json' });
      if (!job) {
        const age = +now() - timestamp(receipt.completedAt);
        if (!Number.isFinite(age) || age < 0 || age >= RETRY_WINDOW_MS) return { status: 'needs_review', acceptedParts };
        // Keep originals below 20 MB after base64 encoding, with room for email text.
        const parts = [];
        let current = []; let currentBytes = 0;
        for (const key of keys) {
          const meta = (await store.getMetadata(key))?.metadata;
          const size = meta?.size ?? 3 * 1024 * 1024; // Older originals were capped at 3 MB.
          if (!Number.isInteger(size) || size < 1 || size > MAX_PHOTO_BYTES) throw new Error('Invalid photo size');
          if (current.length && (current.length === 5 || currentBytes + size > EMAIL_PHOTO_BYTES)) {
            parts.push(current); current = []; currentBytes = 0;
          }
          current.push(key); currentBytes += size;
        }
        if (current.length) parts.push(current);
        if (!parts.length) parts.push([]);
        const candidate = {
          version: 1, ...config, parts, createdAt: now().toISOString(),
          receiptDigest: digest(JSON.stringify(receipt)),
        };
        await store.setJSON(jobKey, candidate, { onlyIfNew: true });
        job = await store.get(jobKey, { type: 'json' });
      }
      if (!job || job.receiptDigest !== digest(JSON.stringify(receipt))) throw new Error('Changed receipt');
      const totalParts = job.parts.length;
      // Bound this stage so a delayed email cannot hold payment confirmation open.
      const signal = AbortSignal.timeout(15000);
      for (let part = 0; part < totalParts; part++) {
        const partKey = `${jobKey}/parts/${part}`;
        if (await store.get(partKey, { type: 'json' })) { acceptedParts++; continue; }
        const age = +now() - timestamp(job.createdAt);
        // Resend deduplicates for 24 hours. Never blindly resend an uncertain
        // attempt beyond that window; an owner must reconcile it in Resend.
        if (!Number.isFinite(age) || age < 0 || age >= RETRY_WINDOW_MS) return { status: 'needs_review', acceptedParts, totalParts };
        const attachments = [];
        let attachmentBytes = 0;
        for (const key of job.parts[part]) {
          const slot = Number(key.split('/').at(-1));
          const entry = await store.getMetadata(key);
          const meta = entry?.metadata;
          if (!meta || meta.slot !== slot || meta.name !== photos[slot]?.name ||
              meta.kind !== receipt.selection.kind || meta.quantity !== receipt.selection.quantity ||
              (meta.photoMode ?? 'different') !== (receipt.selection.photoMode ?? 'different') ||
              !['image/jpeg', 'image/png', 'image/webp'].includes(meta.type)) throw new Error('Photo metadata mismatch');
          const raw = await store.get(key, { type: 'arrayBuffer' });
          if (!raw) throw new Error('Photo unavailable');
          const bytes = Buffer.from(raw);
          if (!bytes.length || bytes.length > MAX_PHOTO_BYTES || digest(bytes) !== meta.digest) throw new Error('Photo integrity mismatch');
          attachmentBytes += bytes.length;
          if (attachmentBytes > EMAIL_PHOTO_BYTES) throw new Error('Email attachment size exceeded');
          attachments.push({ filename: `${String(slot + 1).padStart(2, '0')}-${meta.name}`, content: bytes.toString('base64') });
        }
        const payload = {
          from: job.from, to: job.to,
          subject: `[SANDBOX TEST] Mini3DCreations order ${checkoutId.slice(0, 8)}${totalParts > 1 ? ` (${part + 1}/${totalParts})` : ''}`,
          text: [
            'TEST ONLY — DO NOT FULFILL. No real payment or shipment.',
            `Checkout reference: ${checkoutId}`,
            `Recorded: ${receipt.completedAt}`,
            `Email part ${part + 1} of ${totalParts}.`,
            attachments.length ? `Original customer photos attached: ${attachments.map(file => file.filename).join(', ')}` : 'This product has no photo attachments.',
            '', receiptText(receipt),
          ].join('\n'),
          ...(attachments.length ? { attachments } : {}),
        };
        const payloadDigest = digest(JSON.stringify(payload));
        const attemptKey = `${partKey}/attempt`;
        await store.setJSON(attemptKey, { payloadDigest }, { onlyIfNew: true });
        const attempt = await store.get(attemptKey, { type: 'json' });
        if (attempt?.payloadDigest !== payloadDigest) throw new Error('Email payload changed');
        const response = await request('https://api.resend.com/emails', {
          method: 'POST', signal,
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json',
            'Idempotency-Key': `sandbox-order/${checkoutId}/part/${part}`,
          },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok || typeof result.id !== 'string' || !result.id) throw new Error('Email not accepted');
        await store.setJSON(partKey, { providerId: result.id, acceptedAt: now().toISOString() }, { onlyIfNew: true });
        if (!(await store.get(partKey, { type: 'json' }))?.providerId) throw new Error('Email result not saved');
        acceptedParts++;
      }
      // API acceptance is not proof of delivery to Gmail; the UI says so.
      return { status: 'accepted', acceptedParts, totalParts };
    } catch {
      // Preserve the payment receipt and private uploads. Never expose a provider
      // error body, secret, owner address, or customer photo in an error response.
      return { status: 'retryable', acceptedParts };
    }
  }
  notify.ready = Boolean(settings(env));
  return notify;
}
