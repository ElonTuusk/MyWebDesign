import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initShop } from '../assets/shop.js';
import { normalizeSelection, quote } from '../assets/shop-catalog.js';
import { approvedOrder, orderID } from './fixtures.mjs';

const html = await readFile(new URL('../shop.html', import.meta.url), 'utf8');
async function setup({ server = false, fetch: api, pending, pendingEmails, denyStorage = false, url = 'https://deploy-preview-2--mini3dcreations.netlify.app/shop.html' } = {}) {
  const dom = new JSDOM(html, { url });
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
  return { dom, window, $, input, callbacks, rendered, start };
}

test('shop initializes six tray rows, one PayPal container and $70 default total', async () => {
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
      notification: { status: confirmations === 1 ? 'retryable' : 'accepted' },
    });
  } });
  await app.start(); await app.callbacks.onApprove({ orderID }, {});
  assert.equal(app.$('sandbox-receipt').hidden, false);
  assert.equal(app.$('configuration-fields').disabled, false);
  assert.equal(app.$('retry-order-email').hidden, false);
  assert.match(app.$('order-email-status').textContent, /will not repeat the payment/);
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
test('catalog purchases remain on-site and preserve business card details through checkout', async () => {
  const app = await setup();
  assert.equal(app.window.document.querySelectorAll('#catalog-grid a[href*="etsy.com"]').length, 0);
  app.window.document.querySelector('.catalog-action[data-shop-product="card"]').click();
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
  const app = await setup();
  app.input('product', 'stl');
  assert.equal(app.$('paypal-sandbox-button').hidden, true);
  assert.equal(app.$('shipping-fields').hidden, true);
  assert.equal(app.$('total').textContent, '$4.00 USD');
  await assert.rejects(() => app.callbacks.createOrder({}, {}), /not available/);
  app.input('product', 'cube');
  assert.equal(app.$('photo-fields').hidden, false);
  assert.equal(app.$('paypal-sandbox-button').hidden, false);
  assert.match(app.$('photo-instructions').textContent, /5 photos/);
  app.input('quantity', '2');
  assert.match(app.$('photo-instructions').textContent, /10 photos/);
  app.input('product', 'ornament');
  assert.match(app.$('photo-instructions').textContent, /2 photos/);
  app.dom.window.close();
});
