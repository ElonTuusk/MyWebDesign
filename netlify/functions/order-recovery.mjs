import { recoveryRuntime } from '../lib/recovery-runtime.mjs';
import { runOrderRecovery } from '../lib/order-recovery.mjs';

// Netlify protects scheduled functions from direct public URL invocation.
// In Deploy Previews, the owner can use Functions → order-recovery → Run now.
export const config = { schedule: '*/5 * * * *' };

export default async function handler(_request, context) {
  const runtime = recoveryRuntime(process.env, context);
  if (!runtime) { console.log('Order recovery is disabled for this environment.'); return; }
  try {
    const summary = await runOrderRecovery(runtime);
    console.log('Order recovery counts:', JSON.stringify(summary));
  } catch {
    // No addresses, photos, tokens, provider responses, or credentials in logs.
    console.log('Order recovery will resume on its next invocation.');
  }
}
