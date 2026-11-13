import { getStore } from '@netlify/blobs';
import { sandboxAllowed } from '../lib/checkout.mjs';
import { createPhotoHandler } from '../lib/photos.mjs';

export const config = { rateLimit: { action: 'rate_limit', aggregateBy: ['ip', 'domain'], windowSize: 60, windowLimit: 120 } };
export default async function handler(request) {
  const env = process.env;
  return createPhotoHandler({
    allowed: req => sandboxAllowed(req, env) && Boolean(env.PAYPAL_SANDBOX_CLIENT_SECRET),
    getStore: () => getStore({ name: 'mini3d-sandbox-orders-v1', consistency: 'strong' }),
  })(request);
}
