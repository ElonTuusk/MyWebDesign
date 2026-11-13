import { sandboxAllowed } from '../lib/checkout.mjs';
import { recoveryRuntime } from '../lib/recovery-runtime.mjs';
import { createPayPalWebhook } from '../lib/paypal-webhook.mjs';

export default async function handler(request, context) {
  const env = { ...process.env, CONTEXT: context?.deploy?.context };
  const runtime = recoveryRuntime(env, context);
  if (!runtime) return new Response(null, { status: 503 });
  return createPayPalWebhook({
    ...runtime, allowed: req => sandboxAllowed(req, env), webhookId: env.PAYPAL_SANDBOX_WEBHOOK_ID,
  })(request);
}
