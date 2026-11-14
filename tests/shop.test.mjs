import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initShop } from '../assets/shop.js';
import { normalizeSelection, quote } from '../assets/shop-catalog.js';
import { approvedOrder, orderID } from './fixtures.mjs';
import { renderProductPage } from '../scripts/render-products.mjs';
import { pageForKind } from '../assets/storefront-pages.js';

const catalogHtml = await readFile(new URL('../shop.html', import.meta.url), 'utf8');
async function setup({ server = false, fetch: api, pending, pendingEmails, denyStorage = false, url, product = 'kit' } = {}) {
  const page = pageForKind(product);
  const dom = new JSDOM(renderProductPage(page), { url: url || `https://deploy-preview-2--mini3dcreations.netlify.app/${page.path}` });
  const { window } = dom;
  if (pending) window.sessionStorage.setItem('mini3d-sandbox-checkout-v1', JSON.stringify(pending));
  if (pendingEmails) window.sessionStorage.setItem('mini3d-sandbox-email-retries-v1', JSON.stringify(pendingEmails));
  if (denyStorage) Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Storage blocked'); } });
  let callbacks;
  let rendered = false;
  window.paypalSandbox = { Buttons(options) { callbacks = options; return { async render(selector) {
    rendered = true; window.document.querySelector(selector).textContent = 'Sandbox PayPal button fixture';
  } }; } };
  await initShop({ document: window.document, window, fetch: async (url, options) => {
    if (!options?.method) return Response.json({ mode: 'sandbox', disabled: false, serverReady: server });
    return api(url, options);
  } });
  const $ = id => window.document.getElementById(id);
  function input(id, value, event = 'input') { $(id).value = value; $(id).dispatchEvent(new window.Event(event, { bubbles: true })); }
  const start = async () => {
    input('shipping-zip', '65336');
    return callbacks.createOrder({}, { order: { async create(order) { assert.equal(order.purchase_units[0].amount.value, '70.00'); return orderID; } } });
  };
  function files(values) {
    Object.defineProperty($('photo-files'), 'files', { configurable: true, value: values });
    $('photo-files').dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  return { dom, window, $, input, files, callbacks, rendered, start };
}

test('organizer page initializes six tray rows, one PayPal container and $70 default total', async () => {
  const app = await setup();
  assert.equal(app.window.document.querySelectorAll('.kit-tray').length, 6);
  assert.equal(app.window.document.querySelectorAll('#paypal-sandbox-button').length, 1);
  assert.equal(app.$('subtotal').textContent, '$60.00');
  assert.equal(app.$('shipping').textContent, '$10.00');
  assert.equal(app.$('total').textContent, '$70.00 USD');
  assert.equal(app.rendered, true);
  app.dom.window.close();
});
test('every product and quantity refreshes pricing without a blur event', async () => {
  const app = await setup();
  for (const [kind, expected] of [['kit', '$130.00 USD'], ['tray', '$40.00 USD'], ['block', '$26.00 USD'], ['tag', '$14.00 USD']]) {
    app.input('product', kind); app.input('quantity', '2');
    assert.equal(app.$('total').textContent, expected);
  }
  app.input('quantity', '1.5');
  assert.equal(app.$('total').textContent, 'Enter quantity 1–20');
  app.dom.window.close();
});
test('kit and individual die holders each show two independent labels', async () => {
  const app = await setup();
  app.input('kit-tray-1', 'Reloading die holder', 'change');
  app.input('kit-1-label-1', '.223 Remington', 'change');
  app.input('kit-1-label-2', 'Custom text', 'change'); app.input('kit-1-label-2-custom', 'Second die set');
  assert.match(app.$('summary').textContent, /\.223 Remington \+ Second die set/);
  assert.equal(app.$('kit-1-label-2').closest('.label-field').hidden, false);
  app.input('kit-tray-1', 'Divided accessory tray', 'change');
  assert.equal(app.$('kit-1-label-2').closest('.label-field').hidden, true);
  assert.ok(!app.$('summary').textContent.includes('Second die set'));
  app.input('product', 'tray'); app.input('tray-type', 'Reloading die holder', 'change');
  app.input('single-tray-label-1', '.308 Winchester', 'change');
  app.input('single-tray-label-2', '.300 AAC Blackout', 'change');
  assert.match(app.$('summary').textContent, /\.308 Winchester \+ \.300 AAC Blackout/);
  app.dom.window.close();
});
test('missing ZIP or empty custom name tag prevents checkout creation', async () => {
  const app = await setup();
  let rejected = 0;
  const actions = { reject: () => { rejected++; }, resolve: () => assert.fail('Must reject') };
  app.callbacks.onClick({}, actions);
  app.input('shipping-zip', '65336'); app.input('kit-1-label-1', 'Custom text', 'change');
  app.callbacks.onClick({}, actions);
  assert.equal(rejected, 2);
  app.dom.window.close();
});
test('receipt uses original frozen configuration and Copy Receipt works', async () => {
  const app = await setup();
  app.input('kit-tray-1', 'Reloading die holder', 'change');
  app.input('kit-1-label-1', '.223 Remington', 'change');
  app.input('kit-1-label-2', '.300 AAC Blackout', 'change');
  await app.start();
  assert.equal(app.$('configuration-fields').disabled, true);
  app.input('quantity', '2'); // Even a programmatic mutation cannot rewrite the captured snapshot.
  await app.callbacks.onApprove({ orderID }, { order: { capture: async () => approvedOrder('COMPLETED') } });
  const receipt = app.$('sandbox-receipt-text').textContent;
  assert.match(receipt, /1 × Complete tower kit/);
  assert.match(receipt, /\.223 Remington \+ \.300 AAC Blackout/);
  assert.match(receipt, /Sandbox total: \$70\.00 USD/);
  assert.equal(app.$('sandbox-receipt').hidden, false);
  assert.equal(app.$('configuration-fields').disabled, false);
  let copied;
  Object.defineProperty(app.window.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
  app.$('copy-test-receipt').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(copied, receipt);
  assert.equal(app.$('copy-status').textContent, 'Receipt copied.');
  app.dom.window.close();
});
test('single-tray and replacement tag custom text remain in their receipts', async () => {
  for (const kind of ['tray', 'tag']) {
    const app = await setup(); app.input('product', kind); app.input('shipping-zip', '65336');
    const id = kind === 'tray' ? 'single-tray-label-1' : 'replacement-tag';
    app.input(id, 'Custom text', 'change'); app.input(`${id}-custom`, 'My custom tag');
    let amount;
    await app.callbacks.createOrder({}, { order: { create: async order => { amount = order.purchase_units[0].amount.value; return orderID; } } });
    const order = approvedOrder('COMPLETED'); order.purchase_units[0].payments.captures[0].amount.value = amount;
    await app.callbacks.onApprove({ orderID }, { order: { capture: async () => order } });
    assert.match(app.$('sandbox-receipt-text').textContent, /My custom tag/);
    app.dom.window.close();
  }
});
test('cancellation unlocks configuration; a pending capture does not show success', async () => {
  const app = await setup(); await app.start(); app.callbacks.onCancel();
  assert.equal(app.$('configuration-fields').disabled, false);
  await app.start();
  await app.callbacks.onApprove({ orderID }, { order: { capture: async () => approvedOrder('COMPLETED', 'PENDING') } });
  assert.equal(app.$('sandbox-receipt').hidden, true);
  assert.match(app.$('paypal-sandbox-status').textContent, /not confirmed/);
  assert.equal(app.$('configuration-fields').disabled, true);
  app.callbacks.onCancel();
  assert.equal(app.$('configuration-fields').disabled, true, 'ambiguous capture must not be cleared by a later cancel callback');
  app.dom.window.close();
});
test('server create and capture use one frozen checkout and support confirmation retry', async () => {
  let created; let attempts = 0;
  const app = await setup({ server: true, fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'create') { created = body; return Response.json({ id: orderID }); }
    assert.equal(body.checkoutId, created.checkoutId); assert.equal(body.token, created.token);
    if (++attempts === 1) return Response.json({ error: 'Temporary storage failure.' }, { status: 503 });
    const selection = normalizeSelection(created.selection);
    return Response.json({ receipt: { stored: true, selection, totals: quote(selection), paypalOrderId: orderID, captureId: 'TESTCAPTURE' } });
  } });
  await app.start(); await app.callbacks.onApprove({ orderID }, {});
  assert.equal(app.$('sandbox-receipt').hidden, true);
  assert.equal(app.$('retry-test-record').hidden, false);
  assert.ok(app.window.sessionStorage.getItem('mini3d-sandbox-checkout-v1'));
  app.callbacks.onCancel();
  assert.equal(app.$('retry-test-record').hidden, false, 'failed server persistence must retain the existing order');
  app.$('retry-test-record').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.$('sandbox-receipt').hidden, false);
  assert.equal(app.window.sessionStorage.getItem('mini3d-sandbox-checkout-v1'), null);
  assert.match(app.$('sandbox-receipt-text').textContent, /saved securely/);
  app.dom.window.close();
});
test('production homepage host cannot initialize checkout', async () => {
  const app = await setup({ url: 'https://mini3dcreations.com/shop.html' });
  assert.equal(app.rendered, false);
  assert.match(app.$('paypal-sandbox-status').textContent, /disabled/);
  app.dom.window.close();
});

test('email failure keeps the paid receipt visible and retries the same order without creating another payment', async () => {
  let created; let creates = 0; let confirmations = 0;
  const app = await setup({ server: true, fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.action === 'create') { creates++; created = body; return Response.json({ id: orderID }); }
    confirmations++;
    assert.equal(body.checkoutId, created.checkoutId); assert.equal(body.token, created.token);
    const selection = normalizeSelection(created.selection);
    return Response.json({
      receipt: { stored: true, selection, totals: quote(selection), paypalOrderId: orderID, captureId: 'TESTCAPTURE' },
      notification: confirmations === 1 ? { status: 'retryable', reason: 'RESEND_AUTH' } : { status: 'accepted' },
    });
  } });
  await app.start(); await app.callbacks.onApprove({ orderID }, {});
  assert.equal(app.$('sandbox-receipt').hidden, false);
  assert.equal(app.$('configuration-fields').disabled, false);
  assert.equal(app.$('retry-order-email').hidden, false);
  assert.match(app.$('order-email-status').textContent, /will not repeat the payment/);
  assert.match(app.$('order-email-status').textContent, /Resend did not accept the configured API key/);
  assert.match(app.$('order-email-status').textContent, /Support code: RESEND_AUTH/);
  assert.equal(app.window.sessionStorage.getItem('mini3d-sandbox-checkout-v1'), null);
  assert.ok(app.window.sessionStorage.getItem('mini3d-sandbox-email-retries-v1'));
  app.$('retry-order-email').click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates, 1); assert.equal(confirmations, 2);
  assert.equal(app.$('retry-order-email').hidden, true);
  assert.match(app.$('order-email-status').textContent, /delivery is not yet confirmed/);
  assert.equal(app.window.sessionStorage.getItem('mini3d-sandbox-email-retries-v1'), null);
  app.dom.window.close();
});

test('an email retry survives refresh without resuming or locking a payment', async () => {
  const app = await setup({ pendingEmails: [{ checkoutId: 'saved-id', token: 'saved-token', orderID }] });
  assert.equal(app.$('retry-order-email').hidden, false);
  assert.equal(app.$('configuration-fields').disabled, false);
  assert.equal(app.$('retry-test-record').hidden, true);
  assert.match(app.$('order-email-status').textContent, /will not repeat the payment/);
  app.dom.window.close();
});
test('refresh restores the pending configuration even if server setup is temporarily unavailable', async () => {
  const selection = normalizeSelection({ kind: 'tag', quantity: 3, destinationZip: '90210', label: { caliber: 'Custom text', text: 'Saved tag' } });
  const app = await setup({ pending: { server: true, selection, totals: quote(selection), orderID, checkoutId: 'saved-checkout', token: 'saved-token' } });
  assert.equal(app.$('product').value, 'tag');
  assert.equal(app.$('quantity').value, '3');
  assert.equal(app.$('replacement-tag-custom').value, 'Saved tag');
  assert.equal(app.$('total').textContent, '$16.00 USD');
  assert.equal(app.$('configuration-fields').disabled, true);
  assert.equal(app.$('retry-test-record').hidden, false);
  await assert.rejects(() => app.callbacks.createOrder({}, {}), /already in progress/);
  app.dom.window.close();
});
test('blocked session storage does not prevent the Sandbox button from rendering', async () => {
  const app = await setup({ denyStorage: true, server: true });
  assert.equal(app.rendered, true);
  app.dom.window.close();
});
test('business card catalog link opens its product page and preserves personalization through checkout', async () => {
  const catalog = new JSDOM(catalogHtml);
  assert.equal(catalog.window.document.querySelector('[data-product-id="card"] a').getAttribute('href'), pageForKind('card').path);
  catalog.window.close();
  const app = await setup({ product: 'card' });
  assert.equal(app.$('product').value, 'card');
  assert.equal(app.$('business-card-fields').hidden, false);
  app.input('customer-email', 'customer@example.com');
  app.input('shipping-zip', '65336');
  app.input('card-text', 'Mini Business\nContact details');
  app.input('personalization-notes', 'Small cube logo');
  let paid;
  await app.callbacks.createOrder({}, { order: { create: async order => { paid = order; return orderID; } } });
  assert.equal(paid.purchase_units[0].amount.value, '12.00');
  const captured = approvedOrder('COMPLETED');
  captured.purchase_units[0].payments.captures[0].amount.value = '12.00';
  await app.callbacks.onApprove({ orderID }, { order: { capture: async () => captured } });
  assert.match(app.$('sandbox-receipt-text').textContent, /Mini Business\nContact details/);
  assert.match(app.$('sandbox-receipt-text').textContent, /Small cube logo/);
  app.dom.window.close();
});
test('digital file has no payment button and photo products show their upload requirements', async () => {
  const digital = new JSDOM(renderProductPage(pageForKind('stl')));
  assert.equal(digital.window.document.getElementById('order-form'), null);
  assert.equal(digital.window.document.getElementById('paypal-sandbox-button'), null);
  assert.match(digital.window.document.getElementById('product-display-price').textContent, /\$4.00/);
  assert.match(digital.window.document.querySelector('.digital-availability').textContent, /not available for purchase/);
  digital.window.close();
  const app = await setup({ product: 'cube' });
  assert.equal(app.$('photo-fields').hidden, false);
  assert.equal(app.$('paypal-sandbox-button').hidden, false);
  assert.match(app.$('photo-instructions').textContent, /5 photos/);
  app.input('quantity', '2');
  assert.match(app.$('photo-instructions').textContent, /10 photos/);
  app.dom.window.close();
  const ornament = await setup({ product: 'ornament' });
  ornament.input('quantity', '2');
  assert.match(ornament.$('photo-instructions').textContent, /one photo.*all 2 ornaments/);
  ornament.$('ornament-photo-different').click();
  assert.match(ornament.$('photo-instructions').textContent, /2 photos/);
  ornament.dom.window.close();
});

test('ornament photo choices change upload requirements and preserve a selected photo when quantity changes', async () => {
  const app = await setup({ server: true, product: 'ornament' });
  app.input('product', 'ornament'); app.input('quantity', '5');
  app.input('shipping-zip', '65336'); app.input('customer-email', 'customer@example.com');
  app.files([new app.window.File(['picture'], 'photo.jpg', { type: 'image/jpeg' })]);
  assert.equal(app.$('photo-files').multiple, false);
  assert.match(app.$('photo-selection-status').textContent, /1 of 1/);
  let allowed = false;
  app.callbacks.onClick({}, { resolve() { allowed = true; }, reject() { assert.fail('One shared photo must work'); } });
  assert.equal(allowed, true);
  assert.match(app.$('summary').textContent, /same photo on all 5 ornaments/);
  app.$('ornament-photo-different').click();
  assert.equal(app.$('photo-files').multiple, true);
  assert.match(app.$('photo-selection-status').textContent, /1 of 5/);
  app.callbacks.onClick({}, { resolve() { assert.fail('Missing photos must block checkout'); }, reject() {} });
  app.callbacks.onError();
  assert.match(app.$('paypal-sandbox-status').textContent, /exactly 5/);
  app.$('ornament-photo-same').click(); app.input('quantity', '3');
  assert.match(app.$('photo-selection-status').textContent, /1 of 1/);
  assert.equal(app.$('photo-files').validity.customError, false);
  app.dom.window.close();
});

test('file-size errors show beside uploads and survive the PayPal error callback', async () => {
  const app = await setup({ server: true, product: 'ornament' });
  app.input('product', 'ornament'); app.input('shipping-zip', '65336'); app.input('customer-email', 'customer@example.com');
  app.files([new app.window.File([new Uint8Array(10 * 1024 * 1024 + 1)], 'too-large.jpg', { type: 'image/jpeg' })]);
  assert.match(app.$('photo-selection-status').textContent, /Maximum 10 MB/);
  assert.equal(app.$('photo-selection-status').dataset.invalid, 'true');
  app.callbacks.onClick({}, { resolve() { assert.fail('Too large'); }, reject() {} });
  app.callbacks.onError();
  assert.match(app.$('paypal-sandbox-status').textContent, /up to 10 MB/);
  app.dom.window.close();
});

test('a 4.4 MB shared photo is uploaded in smaller requests before creating the five-ornament order', async () => {
  const calls = [];
  const app = await setup({ server: true, product: 'ornament', fetch: async (url, options) => {
    if (url.endsWith('order-photos')) {
      const f = options.body;
      calls.push({ index: Number(f.get('chunkIndex')), count: Number(f.get('chunkCount')), size: f.get('file').size });
      assert.equal(f.get('photoMode'), 'same'); assert.equal(f.get('quantity'), '5');
      return Response.json({ accepted: true, saved: Number(f.get('chunkIndex')) === Number(f.get('chunkCount')) - 1 });
    }
    const body = JSON.parse(options.body);
    assert.equal(calls.length, 2); assert.equal(body.selection.photos.length, 1); assert.equal(body.selection.quantity, 5);
    return Response.json({ id: orderID });
  } });
  app.input('product', 'ornament'); app.input('quantity', '5'); app.input('shipping-zip', '65336'); app.input('customer-email', 'customer@example.com');
  app.files([new app.window.File([new Uint8Array(Math.floor(4.4 * 1024 * 1024))], 'phone-photo.jpg', { type: 'image/jpeg' })]);
  assert.equal(app.$('photo-files').validity.customError, false);
  await app.callbacks.createOrder({}, {});
  assert.ok(calls.every(item => item.size <= 3 * 1024 * 1024));
  const pending = JSON.parse(app.window.sessionStorage.getItem('mini3d-sandbox-checkout-v1'));
  const restored = await setup({ server: true, pending, product: 'ornament' });
  assert.equal(restored.$('ornament-photo-same').checked, true);
  assert.match(restored.$('summary').textContent, /same photo on all 5 ornaments/);
  assert.equal(restored.$('configuration-fields').disabled, true);
  app.dom.window.close(); restored.dom.window.close();
});
