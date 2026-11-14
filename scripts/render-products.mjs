import { readFile } from 'node:fs/promises';
import { PRODUCT_PAGES } from '../assets/storefront-pages.js';
import { PRODUCTS, money } from '../assets/shop-catalog.js';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const template = await readFile(new URL('../templates/product.html', import.meta.url), 'utf8');
const orderForm = await readFile(new URL('../templates/product-configuration.html', import.meta.url), 'utf8');

function fill(source, values) {
  return source.replace(/@@([A-Z_]+)@@/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing product template value: ${key}`);
    return values[key];
  });
}

export function renderProductPage(page) {
  const digital = page.type === 'digital';
  const values = {
    NAME: escape(page.name), DESCRIPTION: escape(page.description), KIND: page.kind,
    CATEGORY: escape(page.category), IMAGE: escape(page.image), ALT: escape(page.alt),
    PRICE: money(PRODUCTS[page.kind].cents), UNIT: escape(page.unit),
    SHIPPING: digital ? 'Digital file · No physical shipment' : '$10 flat shipping per order · US delivery',
    DETAILS_TITLE: escape(page.detailsTitle),
    DETAILS: page.details.map(detail => `<li>${escape(detail)}</li>`).join('\n              '),
    GALLERY: page.gallery ? `<div class="product-thumbnails" role="group" aria-label="Choose a product photo">${page.gallery.map(([src, label], index) => `
              <button type="button" class="product-thumbnail" data-product-image="${escape(src)}" data-image-alt="${escape(`${page.name}: ${label}`)}" aria-label="Show ${escape(label.toLowerCase())}" aria-pressed="${index === 0}"><img src="${escape(src)}" alt="" width="100" height="100" loading="lazy"></button>`).join('')}
            </div>` : '',
    ACTION: digital
      ? '<span class="availability-label">Available soon</span><a class="text-link" href="shop.html">Browse all products <span aria-hidden="true">→</span></a>'
      : `<a class="button primary product-cta" href="#configure">${escape(page.configureTitle)} <span aria-hidden="true">↓</span></a>`,
    CONFIGURE_TITLE: escape(page.configureTitle || ''),
    CONFIGURE_INTRO: escape(page.configureIntro || ''),
    OPTIONS: page.kinds.map(kind => `<option value="${kind}">${escape(PRODUCTS[kind].name)} — $${money(PRODUCTS[kind].cents)}</option>`).join(''),
    PRODUCT_CHOICE_HIDDEN: page.kinds.length === 1 ? ' hidden' : '',
    TOTAL: money(PRODUCTS[page.kind].cents + (digital ? 0 : 1000)),
  };
  values.CONFIGURATION = digital ? `
    <section class="container digital-availability" aria-labelledby="availability-heading">
      <h2 id="availability-heading">This download is coming soon</h2>
      <p>The file is not available for purchase yet. No payment will be taken.</p>
      <a class="button" href="shop.html">Back to the catalog</a>
    </section>` : fill(orderForm, values);
  return fill(template, values).replace(/[ \t]+\n/g, '\n');
}

export const productPages = PRODUCT_PAGES;
