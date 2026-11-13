# Resend order notifications — Sandbox preview

The preview sends the owner the stored order details and original customer photo attachments only after the server has verified the completed PayPal Sandbox capture and persisted its receipt. Every message is labeled `SANDBOX TEST` / `DO NOT FULFILL`. No customer email is sent. Live payments and production sending remain disabled.

## Netlify settings

Use Project configuration → Environment variables in the existing Mini3DCreations Netlify project. Select **Different value for each deploy context** and set values only under **Deploy Previews**. Use **Functions** scope where available; **All scopes** also includes Functions on the free plan.

| Key | Value |
| --- | --- |
| `RESEND_API_KEY` | The owner's Resend key with Sending access for the verified domain. Mark Contains secret values. |
| `ORDER_NOTIFICATION_EMAIL` | The owner's chosen inbox for the order details and actual photos. Required; no guessed or default recipient. |
| `ORDER_EMAIL_FROM` | Optional address on the verified sending domain. Defaults to `orders@mini3dcreations.com`. |

`PAYPAL_SANDBOX_CLIENT_SECRET` and Netlify Blobs must also be available for server checkout and photo uploads. Redeploy PR #2 after setting or changing environment variables; previously built functions do not receive new values retroactively. Nothing requires a Netlify plan upgrade.

Check `/.netlify/functions/sandbox-checkout?action=config`: `serverReady` indicates the Sandbox secret is present in this preview, and `emailReady` indicates the email settings are present and syntactically valid. These booleans do **not** validate the credentials, domain, or successful delivery. A completed test order and inspection of the owner inbox are required to confirm the whole flow.

## Attachments and retries

- The lamp requires five photos per item. Ornament customers choose one shared photo for every copy or a different photo per ornament. The receipt and email describe that choice and the number of copies; a shared photo is attached once. Older orders without a choice retain their original one-photo-per-ornament meaning. Only the verified receipt's private upload keys are used; filenames, product/quantity, photo choice, slot and SHA-256 digest must match.
- Photos up to 10 MiB each remain private in Netlify Blobs and are sent as actual base64 attachments, without resizing or public links. Messages contain at most five files and 15 MiB of originals (20 MiB after base64 encoding). Larger orders arrive in numbered parts with the same order reference. Uploads transfer in pieces of at most 3 MiB to stay below Netlify's binary request limit; the server verifies and reassembles the original bytes before checkout.
- Only the server environment chooses the recipient and sender. Customer inputs cannot add recipients. Contact details and personalization are plain text inside the order email.
- The private `notifications/<checkoutId>` record freezes the recipient, sender, part layout and receipt hash. Each part has a stable Resend idempotency key, a frozen payload hash and an acceptance record. Concurrent callbacks or response/storage failures reuse the same request within the deduplication window.
- Email work has a 15-second request deadline. If the provider is slow, rejects a message, or its result cannot be persisted, the verified payment receipt and photos remain saved. **Retry order email** resumes the saved checkout; it does not create or capture another payment. Pending email references survive refresh in that tab's session storage.
- The UI says **accepted by Resend**, not delivered to Gmail. Check Resend's email history and the owner's inbox for actual delivery. Incomplete sends stop automatic retries after 23 hours, within Resend's 24-hour deduplication window. The owner must then reconcile the provider history before manually resending.
- Failed retries show a fixed support code for the failing step: receipt, photo, private email record, connection, provider rejection, or saving provider acceptance. Only whitelisted descriptions reach the browser; raw exceptions, provider messages, credentials and the configured owner address are never returned. Refresh the existing shop tab and use **Retry order email** to diagnose its saved order without another payment.

This preview has no unattended email retry queue or delivery webhook. If the tab closes before an email is accepted, inspect the private receipt/notification records and Resend history. A durable retry queue and owner-only recovery interface are required before a live launch.

## Validation

`npm run validate` checks actual attachment bytes, private record binding, recipient confinement, missing configuration, production restrictions, multipart orders, partial failure, deduplicated recovery, the retry window, and UI behavior after payment/email failure. Providers and storage are stubbed in tests; the tests send no real email and make no payments.

Official references: [Resend send email](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [Netlify function environment variables](https://docs.netlify.com/build/functions/environment-variables/).
