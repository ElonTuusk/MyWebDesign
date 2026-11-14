import { getStore } from '@netlify/blobs';
import { createCheckoutHandler, paypalClient } from '../lib/checkout.mjs';
import { createOrderNotifier } from '../lib/order-email.mjs';

export const config = {
  rateLimit: { action: 'rate_limit', aggregateBy: ['ip', 'domain'], windowSize: 60, windowLimit: 30 },
};

export default async function handler(request) {
  const env = process.env;
  const store = () => getStore({ name: 'mini3d-sandbox-orders-v1', consistency: 'strong' });
  return createCheckoutHandler({
    env,
    getStore: store,
    paypal: paypalClient({ secret: env.PAYPAL_SANDBOX_CLIENT_SECRET }),
    notify: createOrderNotifier({ env, getStore: store }),
  })(request);
}
