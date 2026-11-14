# Order recovery and shipping addresses

This change prepares reliable order handling in the existing Sandbox preview. It does not enable live payments, production sending, or fulfillment.

## Completed behavior

- New checkouts require the complete shipping recipient/address returned by PayPal before capture. The server stores only those shipping fields, not the raw payer response, and includes the address in the owner notification and private receipt. Older receipts are unchanged.
- A recovery job is persisted before contacting PayPal. If the customer closes the page after capture, the server can read the existing completed payment and finish recording it. Recovery never creates or captures a payment.
- Pending payments are polled but never treated as completed. Unapproved checkouts are not charged by the worker. Amounts, currency, order identity, shipping address, and completed capture are verified before an order email can send.
- A private durable queue, atomic expiring leases, backoff, and a rotating scan cursor support concurrent invocations and prevent slow unpaid orders from blocking later orders. Terminal states remove only queue markers; receipts, photos, and audit state are retained.
- Email retries use the existing immutable outbox and provider idempotency keys. A worker sends at most one email part per attempt, with a 24-second overall network deadline under Netlify's 30-second scheduled-function limit. Uncertain sends outside the 23-hour retry window move to owner review.
- The PayPal completion listener verifies the original event with PayPal, resolves only an existing server-recorded order, and then fetches that order from PayPal. An event alone cannot fabricate an order, address, amount, or payment. Transient failures retain the queue and ask PayPal to redeliver.

## Connect the Sandbox webhook

Use the same **Sandbox REST app** that supplied the existing checkout credentials. In PayPal Developer Dashboard → Apps & Credentials → Sandbox → that app → Webhooks, add:

| Setting | Value |
| --- | --- |
| Webhook URL | `https://deploy-preview-2--mini3dcreations.netlify.app/.netlify/functions/paypal-webhook` |
| Event | `PAYMENT.CAPTURE.COMPLETED` |

Save its webhook ID as `PAYPAL_SANDBOX_WEBHOOK_ID` in Netlify's **Deploy Previews** context, then redeploy. This is a webhook ID, not a new client secret. Do not change existing payment credentials. The listener returns 503 while this setting is absent. Configuration is not complete until an actual Sandbox event verifies and reconciles successfully; PayPal's mock simulator does not support this postback-verification method.

The earlier setup instruction used `PAYPAL_WEBHOOK_ID`. The guarded Sandbox listener accepts that name as a fallback so the owner does not need to re-enter an already saved value; `PAYPAL_SANDBOX_WEBHOOK_ID` takes precedence. This fallback cannot activate production processing. A future live listener must use a separate live webhook setting.

After redeployment, `GET /.netlify/functions/paypal-webhook?action=readiness` uses the existing Sandbox app credentials to check that PayPal recognizes the configured ID, its callback URL matches this listener, and its subscription includes `PAYMENT.CAPTURE.COMPLETED`. The response contains booleans only, not IDs or credentials, and sends no payment/event/email. Passing this check validates subscription setup, not event delivery.

## Owner-only recovery

Netlify → the preview deploy's **Functions → order-recovery → Run now** invokes recovery without a customer tab. It logs counts only. It does not expose an unauthenticated retry URL or list customer data in logs. No separate admin password is needed.

Netlify schedules this function every five minutes only on published deploys. **Deploy Previews do not run it automatically.** In this Sandbox branch the production guard also blocks the worker, so publication alone cannot enable real payments or silently start sending test emails from production. The production implementation must select live credentials and separate storage before activation.

In **Data & Storage → Blobs → mini3d-sandbox-orders-v1**, authenticated owners can inspect:

| Prefix | Purpose |
| --- | --- |
| `receipts/` | Immutable completed orders, shipping address, and original photo references |
| `recovery/` | Recovery status, last safe failure code, attempts, and next retry |
| `recovery-queue/` | Jobs awaiting processing |
| `notifications/` | Frozen email payload identity and accepted email parts |

If a job says `needs_review`, inspect the saved receipt and the provider's payment/email history. Do not start another checkout or delete idempotency records to resend an uncertain email. A separate manual resolution flow after provider reconciliation is still needed for live operation.

## Verification

Automated tests cover complete address persistence, forged/incomplete addresses, queue write failures before payment creation, lost receipt writes after capture, page closure, duplicate callbacks, concurrent workers, expired leases, pending captures, queue fairness, multipart notifications, deduplication expiry, and invalid webhook signatures. They use simulated providers and do not charge or email anyone.

The earlier real Sandbox test confirmed checkout, original-photo attachment, and inbox delivery. The newly added worker and webhook still need a provider-connected validation after the subscription is configured. Use an existing saved test order or a new Sandbox order; never use a real payment to test this branch.

References: [Netlify scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/), [Netlify Blobs conditional writes](https://docs.netlify.com/build/data-and-storage/netlify-blobs/), [PayPal webhook verification](https://developer.paypal.com/api/rest/webhooks/rest/).
