import { sandboxAllowed } from '../lib/checkout.mjs';
import { recoveryRuntime } from '../lib/recovery-runtime.mjs';
import { createPayPalWebhook } from '../lib/paypal-webhook.mjs';

export const config = { rateLimit: { action: 'rate_limit', aggregateBy: ['ip', 'domain'], windowSize: 60, windowLimit: 30 } };

export default async function handler(request, context) {
  const env = { ...process.env, CONTEXT: context?.deploy?.context };
  const runtime = recoveryRuntime(env, context);
  if (!runtime) return new Response(null, { status: 503 });
  return createPayPalWebhook({
    ...runtime, allowed: req => sandboxAllowed(req, env),
    // Accept the earlier setup name only inside the guarded Sandbox runtime.
    webhookId: env.PAYPAL_SANDBOX_WEBHOOK_ID?.trim() || env.PAYPAL_WEBHOOK_ID?.trim(),
  })(request);
}
