import { getStore } from '@netlify/blobs';
import { paypalClient } from './checkout.mjs';
import { createOrderNotifier } from './order-email.mjs';

export function recoveryRuntime(env, context) {
  // A timer must not gain access to live payments through a copied credential.
  // Use Netlify's trusted function context; build-only env vars may be absent.
  const deployContext = context?.deploy?.context || (env.NETLIFY_DEV === 'true' ? 'dev' : null);
  if (!['deploy-preview', 'branch-deploy', 'dev'].includes(deployContext) || !env.PAYPAL_SANDBOX_CLIENT_SECRET ||
      (env.PAYPAL_ENVIRONMENT && env.PAYPAL_ENVIRONMENT !== 'sandbox')) return null;
  const deadline = AbortSignal.timeout(24000);
  const boundedFetch = (url, options = {}) => fetch(url, {
    ...options, signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
  });
  const getOrderStore = () => getStore({
    name: 'mini3d-sandbox-orders-v1', consistency: 'strong', fetch: boundedFetch,
  });
  return {
    getStore: getOrderStore,
    paypal: paypalClient({ secret: env.PAYPAL_SANDBOX_CLIENT_SECRET, fetch: boundedFetch, timeoutMs: 4000 }),
    notify: createOrderNotifier({ env: { ...env, CONTEXT: deployContext }, getStore: getOrderStore, fetch: boundedFetch, timeoutMs: 8000, maxParts: 1 }),
  };
}
