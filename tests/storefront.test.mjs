import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { PRODUCT_PAGES, pageForKind } from '../assets/storefront-pages.js';
import { PRODUCTS, money, normalizeSelection, quote } from '../assets/shop-catalog.js';
import { renderProductPage } from '../scripts/render-products.mjs';
import { initShop } from '../assets/shop.js';
import { initCatalog } from '../assets/catalog-browse.js';
import { initSavedOrderNotice, SESSION_KEY, EMAIL_SESSION_KEY } from '../assets/saved-order.js';
import { initProductGallery } from '../assets/product-page.js';

const catalogHtml = await readFile(new URL('../shop.html', import.meta.url), 'utf8');
const origin = 'https://deploy-preview-2--mini3dcreations.netlify.app/';

test('catalog is a browse-only grid and every item links to a complete, matching product page without JavaScript', async () => {
  const dom = new JSDOM(catalogHtml, { url: `${origin}shop.html` });
  const document = dom.window.document;
  assert.equal(document.querySelectorAll('.catalog-card').length, 5);
  assert.equal(document.getElementById('order-form'), null);
  assert.equal(document.getElementById('paypal-sandbox-button'), null);
  assert.equal(document.querySelector('script[src="assets/shop.js"]'), null);
  for (const page of PRODUCT_PAGES) {
    const card = document.querySelector(`[data-product-id="${page.id}"]`);
    assert.equal(card.querySelector('a').getAttribute('href'), page.path);
    assert.match(card.querySelector('.catalog-price').textContent, new RegExp(money(PRODUCTS[page.kind].cents).replace('.', '\\.')));
    const product = new JSDOM(renderProductPage(page), { url: `${origin}${page.path}` });
    const pd = product.window.document;
    assert.equal(pd.querySelector('h1').textContent, page.name);
    assert.equal(pd.body.dataset.productKind, page.kind);
    assert.equal(pd.getElementById('product-main-image').getAttribute('src'), page.image);
    assert.equal(pd.querySelector('.product-breadcrumb a').getAttribute('href'), 'shop.html');
    assert.equal(pd.querySelectorAll('h1').length, 1);
    for (const img of pd.querySelectorAll('img')) await access(new URL(`../${img.getAttribute('src')}`, import.meta.url));
    if (page.type === 'physical') {
      assert.deepEqual([...pd.getElementById('product').options].map(option => option.value), page.kinds);
      assert.equal(pd.getElementById('product').value, page.kind);
      assert.equal(pd.querySelectorAll('#paypal-sandbox-button').length, 1);
    } else {
      assert.equal(pd.getElementById('order-form'), null);
    }
    product.window.close();
  }
  dom.window.close();
});

test('filters change the visible cards and count while preserving native product links', () => {
  const dom = new JSDOM(catalogHtml, { url: `${origin}shop.html` });
  const d = dom.window.document;
  initCatalog(d);
  for (const [filter, count] of [['digital', 1], ['physical', 4], ['all', 5]]) {
    d.querySelector(`[data-filter="${filter}"]`).click();
    assert.equal(d.querySelectorAll('.catalog-card:not([hidden])').length, count);
    assert.match(d.getElementById('catalog-count').textContent, new RegExp(`^${count} `));
    assert.equal(d.querySelector('[aria-pressed="true"]').dataset.filter, filter);
    assert.ok([...d.querySelectorAll('.catalog-card a')].every(link => link.getAttribute('href').endsWith('.html')));
  }
  dom.window.close();
});

test('each physical product page opens with its own form and correct total', async () => {
  for (const page of PRODUCT_PAGES.filter(page => page.type === 'physical')) {
    const dom = new JSDOM(renderProductPage(page), { url: `${origin}${page.path}` });
    const { window } = dom;
    let rendered = 0;
    window.paypalSandbox = { Buttons: () => ({ render: async () => { rendered++; } }) };
    const result = await initShop({ document: window.document, window, fetch: async () => Response.json({ mode: 'sandbox', serverReady: true }) });
    assert.equal(result.selection().kind, page.kind);
    assert.equal(rendered, 1);
    assert.equal(window.document.getElementById('total').textContent, `$${money(PRODUCTS[page.kind].cents + 1000)} USD`);
    assert.equal(window.document.getElementById('kit-fields').hidden, page.kind !== 'kit');
    assert.equal(window.document.getElementById('business-card-fields').hidden, page.kind !== 'card');
    assert.equal(window.document.getElementById('photo-fields').hidden, !['cube', 'ornament'].includes(page.kind));
    assert.equal(window.document.getElementById('product-choice').hidden, page.kinds.length === 1);
    dom.window.close();
  }
});

test('pending checkout survives navigation and blocks a different product from starting another payment', async () => {
  const selection = normalizeSelection({ kind: 'ornament', quantity: 5, photoMode: 'same', destinationZip: '65336', customerEmail: 'buyer@example.com', photos: [{ slot: 0, name: 'photo.jpg' }] });
  const pending = { server: true, orderID: 'SAVEDORDER123', checkoutId: 'saved-checkout', token: 'private-token', selection, totals: quote(selection) };
  const catalog = new JSDOM(catalogHtml, { url: `${origin}shop.html` });
  catalog.window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(pending));
  initCatalog(catalog.window.document);
  const link = catalog.window.document.querySelector('#saved-order-notice a');
  assert.equal(link.getAttribute('href'), 'photo-ornament.html#configure');
  assert.ok(!catalog.window.document.getElementById('saved-order-notice').textContent.includes(pending.token));
  catalog.window.close();

  const dom = new JSDOM(renderProductPage(pageForKind('card')), { url: `${origin}custom-business-card.html` });
  const { window } = dom;
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(pending));
  initSavedOrderNotice(window.document, window);
  window.paypalSandbox = { Buttons() { assert.fail('Another product must not start checkout while this one is pending.'); } };
  await initShop({ document: window.document, window, fetch: async () => Response.json({ mode: 'sandbox', serverReady: true }) });
  assert.equal(window.document.getElementById('configuration-fields').disabled, true);
  assert.equal(window.document.getElementById('paypal-sandbox-button').hidden, true);
  assert.equal(window.document.getElementById('product').value, 'card');
  assert.deepEqual(JSON.parse(window.sessionStorage.getItem(SESSION_KEY)), pending);
  assert.equal(window.document.querySelector('#saved-order-notice a').getAttribute('href'), 'photo-ornament.html#configure');
  dom.window.close();
});

test('old and new saved email retries remain reachable from the catalog and unavailable digital page', () => {
  for (const kind of [undefined, 'ornament']) {
    for (const html of [catalogHtml, renderProductPage(pageForKind('stl'))]) {
      const dom = new JSDOM(html, { url: `${origin}shop.html` });
      const reference = { checkoutId: 'saved', token: 'private', orderID: 'ORDER123', ...(kind ? { kind } : {}) };
      dom.window.sessionStorage.setItem(EMAIL_SESSION_KEY, JSON.stringify([reference]));
      initSavedOrderNotice(dom.window.document, dom.window);
      assert.equal(dom.window.document.querySelector('#saved-order-notice a').getAttribute('href'), `${pageForKind(kind || 'kit').path}#order-email-status`);
      dom.window.close();
    }
  }
});

test('organizer gallery changes the selected photo and its accessible description', () => {
  const dom = new JSDOM(renderProductPage(pageForKind('kit')));
  const d = dom.window.document;
  initProductGallery(d);
  d.querySelector('[data-product-image="RTOTower3.JPG"]').click();
  assert.equal(d.getElementById('product-main-image').getAttribute('src'), 'RTOTower3.JPG');
  assert.match(d.getElementById('product-main-image').alt, /Die holder detail/);
  assert.equal(d.querySelectorAll('.product-thumbnail[aria-pressed="true"]').length, 1);
  dom.window.close();
});
