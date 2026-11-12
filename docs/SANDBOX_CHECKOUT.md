# Mini3DCreations Sandbox checkout

This branch is development-only. PR #2 stays in draft. Do not merge it to enable sales.

## Current behavior

- Kit $45, tray $10, tower block $8, replacement tag $2. Shipping is $10 once per order, including multiple quantities.
- Each kit has six configured trays, matching tags, three tower blocks and hardware. Die holders have two independent tags; all other trays have one.
- Quantity is a whole number from 1 to 20. A five-digit US destination ZIP and nonempty custom text (up to 40 characters) are required for checkout.
- The preview uses the existing, fixed PayPal Sandbox client ID. There is no live API endpoint or configuration switch. Production hostnames cannot load checkout.
- Tax is explicitly not calculated. Shipping origin is 65336. Packaging, shipping eligibility and tax compliance still need verification before any future live release.

## Server setup

In the existing Netlify project's environment variables, add `PAYPAL_SANDBOX_CLIENT_SECRET` for the **Deploy Previews** context, with **Functions** scope (or all scopes if scope selection is unavailable). Its value must be the secret from the same **Sandbox** app as the public client ID in `assets/shop-catalog.js`. Enter it directly in Netlify; never put it in chat, GitHub, HTML or a committed `.env` file. Redeploy PR #2 after setting it.

`PAYPAL_ENVIRONMENT`, if present, must be `sandbox`. `PAYPAL_SANDBOX_CLIENT_ID`, if present, must match the fixed Sandbox ID. Neither variable is needed. The server also refuses `CONTEXT=production` and request hosts outside the named development preview/branch URL.

The read-only `/.netlify/functions/sandbox-checkout?action=config` response reports `serverReady`. Until the secret is configured, the repaired PayPal button remains available for **browser-only Sandbox testing** and the page explicitly says that no server record is saved. It cannot create a real payment. Once configured, the same UI uses server creation/capture and shows a stored receipt only after successful persistence. A misconfigured secret or storage failure fails closed on that server path; it does not switch to browser capture mid-checkout.

## Record lifecycle

1. The browser submits product choices, quantity, ZIP, a random checkout ID and a random 256-bit session token. It does not submit authoritative prices or payment status.
2. The function validates the selection, computes prices in integer cents, and writes an immutable draft in `mini3d-sandbox-orders-v1` before calling PayPal. Only a hash of the session token is stored.
3. PayPal creation uses a stable request ID. The resulting PayPal order ID is associated with the draft.
4. Capture requires the matching session token and saved PayPal order ID. The server reads PayPal's Sandbox API and verifies the order reference, USD amount, breakdown, approval and US shipping country. A completed capture must match the full expected amount.
5. A verified receipt is saved with a conditional create. Repeated callbacks return the same receipt. Strongly consistent reads and PayPal idempotency prevent stale state and repeated payments on retries.
6. If a capture succeeded but saving failed, **Retry test confirmation** reads the existing PayPal result and finishes saving. The pending configuration and token survive a page refresh in that tab's session storage. Never start a new payment to retry record storage.

Records are private Netlify Blobs, accessible to the project owner through **Data & Storage → Blobs → mini3d-sandbox-orders-v1**. There is no public listing or arbitrary record-reading endpoint. All records are marked `mode: sandbox` and `fulfillment: disabled`. Stored test data is limited to the selection, ZIPs, calculated amounts and PayPal reference IDs; payer names, email, full street address and raw PayPal responses are not stored. Receipts contain no token hashes. Sandbox records persist across preview deployments.

Drafts expire after three hours. Already completed PayPal captures can still be reconciled. Production release work remains: production tax and shipping validation, a protected order-management workflow, retention/cleanup rules, verified webhook reconciliation for abandoned sessions, and a separate explicit review of live payment activation. No automatic fulfillment exists.

## Verification

Run `npm ci`, `npm run validate`, then `npm run build` with Node 22 or newer. Validation checks HTML structure, JavaScript syntax, pricing, selections, receipt copying, PayPal callback flows, authoritative server totals, token checks, duplicate callbacks, failed persistence, timeout recovery, and Sandbox restrictions. Tests stub PayPal and storage; they never make payments.

`npm run dev` serves only the built public files for local visual checks. The deployment build publishes `dist/`, excluding secrets, tests and backend code; Netlify bundles `netlify/functions` separately. Netlify's build runs validation, so malformed checkout code prevents a preview deployment.

The initial validation does not establish real Netlify storage or PayPal credential connectivity. Confirm `serverReady` after setup, then inspect a verified test record before considering the integration end-to-end tested. No fresh test payment is required merely to check that the button renders.

## API references

- [PayPal Standard Checkout](https://developer.paypal.com/studio/checkout/standard/integrate)
- [PayPal REST idempotency](https://developer.paypal.com/api/rest/requests/)
- [Netlify Blobs, strong consistency and conditional writes](https://docs.netlify.com/build/data-and-storage/netlify-blobs/)
- [Netlify Functions environment variables](https://docs.netlify.com/build/functions/environment-variables/)
