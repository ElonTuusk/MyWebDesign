# Etsy catalog sources

Verified on November 13, 2026 against the public shop at https://www.etsy.com/shop/Mini3DCreationsLLC. The shop identifies Christopher in Knob Noster, Missouri and links to mini3dcreations.com.

The catalog adds these four active listings alongside the existing organizer. Prices are USD, excluding any applicable shipping and tax. Product photos are copied unchanged from the seller's own public listings into `assets/products/`.

| Listing | Price | Type | Source |
| --- | ---: | --- | --- |
| Personalized 5-Photo Lithophane Cube Lamp with LED Bulb | $45.00 | Physical | https://www.etsy.com/listing/908821246/lithophane-cube |
| Personalized Light-Up Photo Ornament with Replaceable Batteries | $12.00 | Physical | https://www.etsy.com/listing/908259150/holiday-ornaments |
| Custom 3D-Printed Business Card with Text and Optional Logo | $2.00 | Physical | https://www.etsy.com/listing/4459025713/ad-tag-calling-card |
| Hormone Monster Figurine STL for Resin 3D Printing | $4.00 | Digital: STL in one ZIP | https://www.etsy.com/listing/947305648/horomone-monster-stl |

The Etsy shop also lists the modular reloading station (listing 4615139827) at $45.00. It is not duplicated as a new product. The website's newer $60 complete kit and $15 individual tray prices, existing configuration, and Sandbox-only checkout are preserved. No Etsy changes were made.

The physical products use the website's own product selection and PayPal checkout, with a flat $10 shipping charge. There are no Etsy purchase links in the storefront. The cube accepts five photos per lamp. Ornament customers choose one shared photo for all copies (the default) or a different photo per ornament. The business card collects exact wording, lettering/background/border colors and notes. The digital card remains visible at $4 but cannot be purchased until the owner supplies the actual ZIP. This is a verified catalog snapshot, not an automatic marketplace sync.

## Customer photos

Customers choose photos in the order form before checkout. JPG, PNG and WebP files are limited to 10 MiB each, shown as 10 MB in the UI. Count and size errors appear beside the upload field before PayPal opens. The cube permits up to four lamps (20 photos) per order; ornaments permit up to 20 copies with either one shared photo or 20 individual photos. Selected files are not described as uploaded until the server confirms each save.

`order-photos` stores files privately in the same Netlify Blobs store as Sandbox orders, under `photos/<checkoutId>/<slot>`. The browser transfers pieces no larger than 3 MiB; the server verifies each piece and reassembles the unchanged original, then removes temporary pieces. The upload session and immutable per-photo manifest bind the token, filename, type, total size, quantity, photo choice, slot and piece count. Incomplete uploads cannot start payment. Expiry and same-origin requests are validated; uploads lock once the checkout draft exists. No public download endpoint is exposed. The upload route permits 120 requests per minute so one maximum-sized order (80 pieces) can complete.

The payment endpoint checks every expected photo exists and belongs to the same checkout before contacting PayPal. Paid test receipts include the private storage keys for owner retrieval. Review `receipts/` and the corresponding `photos/` entries in **Netlify → project → Data & Storage → Blobs → mini3d-sandbox-orders-v1**. A photo upload alone is not proof of payment. Abandoned upload sessions should be removed as part of storage maintenance.

Photo checkout requires the server's Sandbox secret and working Blobs storage. If unavailable, it fails before payment rather than pretending to store files. Resend can notify the configured owner with order details and the original photo attachments after a verified test capture is stored. Setup and recovery are documented in [ORDER_EMAIL.md](ORDER_EMAIL.md). No live payments or fulfillment are enabled.

The storefront uses static HTML so product details and purchase links work without JavaScript. `assets/catalog-browse.js` progressively enables the All items / Physical items / Digital files filters. No eBay items or links are included.
