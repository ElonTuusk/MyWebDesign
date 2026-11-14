import { pageForKind } from './storefront-pages.js';

export const SESSION_KEY = 'mini3d-sandbox-checkout-v1';
export const EMAIL_SESSION_KEY = 'mini3d-sandbox-email-retries-v1';

// Keep existing preview orders reachable after the catalog and product pages split.
export function initSavedOrderNotice(document, window) {
  const notice = document.getElementById('saved-order-notice');
  if (!notice) return;
  notice.hidden = true;
  let pending;
  let emails;
  try {
    pending = JSON.parse(window.sessionStorage.getItem(SESSION_KEY));
    emails = JSON.parse(window.sessionStorage.getItem(EMAIL_SESSION_KEY));
  } catch { return; }
  const page = pageForKind(pending?.selection?.kind);
  const hasPending = page && pending?.server && pending.orderID && pending.checkoutId && pending.token;
  const email = Array.isArray(emails) && emails.find(item => item?.checkoutId && item.token && item.orderID);
  if (!hasPending && !email) return;
  if (hasPending && page.kinds.includes(document.body.dataset.productKind)) return;
  if (!hasPending && document.getElementById('order-form')) return;
  const destination = hasPending ? page : pageForKind(email.kind) || pageForKind('kit');
  const text = document.createElement('p');
  text.textContent = hasPending ? 'A saved Sandbox checkout needs confirmation.' : 'A saved test-order email needs another attempt.';
  const link = document.createElement('a');
  link.className = 'text-link';
  link.href = `${destination.path}#${hasPending ? 'configure' : 'order-email-status'}`;
  link.textContent = hasPending ? 'Return to your saved checkout →' : 'Retry the saved order email →';
  notice.replaceChildren(text, link);
  notice.hidden = false;
}
