import { getStore } from '@netlify/blobs';
import { createCheckoutHandler, paypalClient } from '../lib/checkout.mjs';

export const config = {
  rateLimit: { action: 'rate_limit', aggregateBy: ['ip', 'domain'], windowSize: 60, windowLimit: 30 },
};

export default async function handler(request) {
  const env = process.env;
  return createCheckoutHandler({
    env,
    getStore: () => getStore({ name: 'mini3d-sandbox-orders-v1', consistency: 'strong' }),
    paypal: paypalClient({ secret: env.PAYPAL_SANDBOX_CLIENT_SECRET }),
  })(request);
}
