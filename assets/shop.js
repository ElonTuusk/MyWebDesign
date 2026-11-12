import {
  CALIBERS, TRAY_TYPES, SANDBOX_CLIENT_ID, PRODUCTS, tagCount, quote, money,
  normalizeSelection, descriptionLines, paypalOrder, completedCapture, receiptText,
} from './shop-catalog.js';

const ENDPOINT = '/.netlify/functions/sandbox-checkout';
const SESSION_KEY = 'mini3d-sandbox-checkout-v1';

export async function initShop({ document, window, fetch: request = window.fetch.bind(window) }) {
  const $ = id => document.getElementById(id);
  const status = text => { $('paypal-sandbox-status').textContent = text; };
  let active = null;
  let serverReady = false;
  let captureRunning = false;
  let buttons;
  const kitRows = [];

  function labelField(id, title) {
    const root = document.createElement('div');
    root.className = 'label-field';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = title;
    const select = document.createElement('select');
    select.id = id;
    select.className = 'field caliber';
    for (const caliber of [...CALIBERS, 'Custom text']) select.add(new window.Option(caliber, caliber));
    label.append(select);
    const customLabel = document.createElement('label');
    customLabel.className = 'custom-label';
    customLabel.htmlFor = `${id}-custom`;
    customLabel.textContent = 'Custom name tag text';
    customLabel.hidden = true;
    const custom = document.createElement('input');
    custom.id = `${id}-custom`;
    custom.className = 'field custom-caliber';
    custom.maxLength = 40;
    custom.placeholder = 'Up to 40 characters';
    customLabel.append(custom);
    select.addEventListener('change', () => { customLabel.hidden = select.value !== 'Custom text'; update(); });
    custom.addEventListener('input', update);
    root.append(label, customLabel);
    return { root, select, custom, value: () => ({ caliber: select.value, text: custom.value.trim() }) };
  }
  function trayFields(select, root, id) {
    const first = labelField(`${id}-label-1`, 'Name tag');
    const second = labelField(`${id}-label-2`, 'Name tag — second die set');
    root.append(first.root, second.root);
    function toggle() {
      const dual = tagCount(select.value) === 2;
      first.root.querySelector('label').firstChild.textContent = dual ? 'Name tag — first die set' : 'Name tag';
      second.root.hidden = !dual;
      second.select.disabled = !dual;
      second.custom.disabled = !dual;
    }
    select.addEventListener('change', () => { toggle(); update(); });
    toggle();
    return () => ({ type: select.value, labels: [first, second].slice(0, tagCount(select.value)).map(item => item.value()) });
  }
  for (let i = 1; i <= 6; i++) {
    const row = document.createElement('div');
    row.className = 'tray-row';
    const label = document.createElement('label');
    label.htmlFor = `kit-tray-${i}`;
    label.textContent = `Tray ${i}`;
    const select = document.createElement('select');
    select.id = `kit-tray-${i}`;
    select.className = 'field kit-tray';
    for (const type of TRAY_TYPES) select.add(new window.Option(type, type));
    label.append(select);
    row.append(label);
    kitRows.push(trayFields(select, row, `kit-${i}`));
    $('kit-rows').append(row);
  }
  const singleTray = trayFields($('tray-type'), $('tray-label'), 'single-tray');
  const replacement = labelField('replacement-tag', 'Replacement name tag');
  $('extra-label').append(replacement.root);

  function selection() {
    const kind = $('product').value;
    return {
      kind, quantity: Number($('quantity').value), destinationZip: $('shipping-zip').value.trim(),
      ...(kind === 'kit' ? { trays: kitRows.map(read => read()) } : {}),
      ...(kind === 'tray' ? { trays: [singleTray()] } : {}),
      ...(kind === 'tag' ? { label: replacement.value() } : {}),
    };
  }
  function update() {
    const value = selection();
    $('kit-fields').hidden = value.kind !== 'kit';
    $('tray-fields').hidden = value.kind !== 'tray';
    $('tag-fields').hidden = value.kind !== 'tag';
    $('summary').textContent = descriptionLines(value).join('\n');
    try {
      const totals = quote(value);
      $('subtotal').textContent = `$${money(totals.subtotalCents)}`;
      $('shipping').textContent = `$${money(totals.shippingCents)}`;
      $('total').textContent = `$${money(totals.totalCents)} USD`;
    } catch {
      $('subtotal').textContent = '—';
      $('total').textContent = 'Enter quantity 1–20';
    }
  }
  function saveActive() {
    try {
      if (active?.server && active.orderID) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(active));
      else window.sessionStorage.removeItem(SESSION_KEY);
    } catch { /* Checkout still works when session storage is unavailable. */ }
  }
  function restoreSelection(value) {
    function set(id, value, event = 'input') {
      $(id).value = value;
      $(id).dispatchEvent(new window.Event(event));
    }
    function restoreLabel(id, label) {
      set(id, label.caliber, 'change');
      if (label.caliber === 'Custom text') set(`${id}-custom`, label.text);
    }
    set('product', value.kind); set('quantity', String(value.quantity)); set('shipping-zip', value.destinationZip);
    if (value.kind === 'kit') value.trays.forEach((tray, index) => {
      set(`kit-tray-${index + 1}`, tray.type, 'change');
      tray.labels.forEach((label, tag) => restoreLabel(`kit-${index + 1}-label-${tag + 1}`, label));
    });
    if (value.kind === 'tray') {
      set('tray-type', value.trays[0].type, 'change');
      value.trays[0].labels.forEach((label, tag) => restoreLabel(`single-tray-label-${tag + 1}`, label));
    }
    if (value.kind === 'tag') restoreLabel('replacement-tag', value.label);
    update();
  }
  function reset() {
    active = null;
    saveActive();
    $('configuration-fields').disabled = false;
    $('retry-test-record').hidden = true;
  }
  async function api(body) {
    const response = await request(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Sandbox checkout could not be confirmed.');
    return data;
  }
  function showReceipt(receipt) {
    $('sandbox-receipt-text').textContent = receiptText(receipt);
    $('sandbox-receipt').hidden = false;
    $('copy-status').textContent = '';
    status(receipt.stored ? 'Sandbox payment confirmed and test record saved. No real order was placed.' : 'Sandbox payment simulated successfully. Browser-only receipt; no order was stored.');
    reset();
  }
  async function confirmServer() {
    if (!active?.server || !active.orderID || captureRunning) return;
    captureRunning = true;
    active.captureAttempted = true;
    saveActive();
    $('retry-test-record').hidden = true;
    status('Confirming the Sandbox payment and saving its test record…');
    try {
      const { receipt } = await api({ action: 'capture', checkoutId: active.checkoutId, token: active.token, orderID: active.orderID });
      if (!receipt?.stored || receipt.paypalOrderId !== active.orderID) throw new Error('The test record could not be verified.');
      showReceipt(receipt);
    } catch (error) {
      status(`${error.message} Use “Retry test confirmation” for this same order. Do not start another payment.`);
      $('retry-test-record').hidden = false;
    } finally { captureRunning = false; }
  }
  $('retry-test-record').addEventListener('click', confirmServer);
  $('order-form').addEventListener('submit', event => event.preventDefault());
  for (const id of ['product', 'quantity', 'shipping-zip']) $(id).addEventListener('input', update);
  $('product').addEventListener('change', update);
  $('copy-test-receipt').addEventListener('click', async () => {
    try {
      if (!window.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await window.navigator.clipboard.writeText($('sandbox-receipt-text').textContent);
      $('copy-status').textContent = 'Receipt copied.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents($('sandbox-receipt-text'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      $('copy-status').textContent = 'Receipt selected. Use your device’s Copy command.';
    }
  });
  update();

  // This preview has one fixed, previously tested SANDBOX client ID. There is no live-mode switch.
  if (['mini3dcreations.com', 'www.mini3dcreations.com', 'mini3dcreations.netlify.app'].includes(window.location.hostname)) {
    $('checkout-mode').textContent = 'Checkout is available only on the development preview.';
    status('Live ordering is disabled.');
    return;
  }
  try {
    const response = await request(`${ENDPOINT}?action=config`, { cache: 'no-store' });
    if (response.ok) {
      const config = await response.json();
      if (config.mode !== 'sandbox' || config.disabled) {
        $('checkout-mode').textContent = 'Checkout is disabled for this environment.';
        status('Live ordering is disabled.');
        return;
      }
      serverReady = config.serverReady === true;
    }
  } catch { /* A static preview can still run the explicitly labeled browser-only Sandbox flow. */ }
  $('checkout-mode').textContent = serverReady
    ? 'Sandbox test records are verified and saved securely on the server.'
    : 'Browser-only Sandbox test. Server order recording is not connected yet.';

  try {
      const pending = JSON.parse(window.sessionStorage.getItem(SESSION_KEY));
      if (pending?.server && pending.orderID && pending.checkoutId && pending.token) {
        pending.selection = normalizeSelection(pending.selection);
        restoreSelection(pending.selection);
        active = pending;
        $('configuration-fields').disabled = true;
        $('retry-test-record').hidden = false;
        status('A prior Sandbox checkout needs confirmation. Retry that test confirmation before starting another.');
      }
  } catch { try { window.sessionStorage.removeItem(SESSION_KEY); } catch { /* Storage may be disabled. */ } }
  try {
    if (!window.paypalSandbox) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://www.paypal.com/sdk/js?client-id=${SANDBOX_CLIENT_ID}&currency=USD&intent=capture&components=buttons&disable-funding=credit,paylater,card`;
        script.dataset.namespace = 'paypalSandbox';
        script.onload = resolve;
        script.onerror = () => reject(new Error('PayPal Sandbox could not load. Refresh the page to retry.'));
        document.head.append(script);
      });
    }
    if (!window.paypalSandbox?.Buttons) throw new Error('PayPal Sandbox could not load.');
    buttons = window.paypalSandbox.Buttons({
      style: { layout: 'vertical', label: 'paypal', height: 45 },
      onClick(_data, actions) {
        if (active) { status('Finish or cancel the current Sandbox checkout first.'); return actions.reject(); }
        try { normalizeSelection(selection()); return actions.resolve(); }
        catch (error) { status(error.message); $('order-form').reportValidity(); return actions.reject(); }
      },
      async createOrder(_data, actions) {
        if (active) throw new Error('A Sandbox checkout is already in progress.');
        const value = normalizeSelection(selection());
        active = {
          server: serverReady, selection: value, totals: quote(value), checkoutId: window.crypto.randomUUID(),
          token: Array.from(window.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
        };
        $('configuration-fields').disabled = true;
        $('sandbox-receipt').hidden = true;
        status('Creating a Sandbox test checkout…');
        try {
          if (serverReady) {
            const created = await api({ action: 'create', checkoutId: active.checkoutId, token: active.token, selection: value });
            active.orderID = created.id;
          } else {
            active.orderID = await actions.order.create(paypalOrder(value));
          }
          saveActive();
          status('Complete or cancel the test in the PayPal Sandbox window.');
          return active.orderID;
        } catch (error) { reset(); status(error.message); throw error; }
      },
      async onApprove(data, actions) {
        if (!active || data.orderID !== active.orderID) { status('This Sandbox order does not match the current checkout.'); return; }
        if (active.server) return confirmServer();
        captureRunning = true;
        active.captureAttempted = true;
        try {
          const order = await actions.order.capture();
          const capture = completedCapture(order, active.orderID, active.totals);
          showReceipt({ selection: active.selection, totals: active.totals, paypalOrderId: active.orderID, captureId: capture.id, stored: false });
        } catch {
          status('Sandbox capture was not confirmed. No success receipt was issued. Check this test order in PayPal Sandbox before starting another.');
          // Retain the locked snapshot so a failed/ambiguous capture cannot become a second payment.
        } finally { captureRunning = false; }
      },
      onCancel() { if (!captureRunning && !active?.captureAttempted) { reset(); status('Sandbox checkout canceled. You can edit your configuration.'); } },
      onError() {
        if (active?.orderID) {
          status('Sandbox confirmation is incomplete. Check the existing test before starting another.');
          $('retry-test-record').hidden = !active.server;
        } else { reset(); status('PayPal Sandbox could not start. Your configuration is still available.'); }
      },
    });
    await buttons.render('#paypal-sandbox-button');
    if (!active) status('Ready for a Sandbox test checkout. Enter your destination ZIP before continuing.');
  } catch (error) { status(error.message); }
  return { buttons, selection, update };
}

if (typeof document !== 'undefined') {
  initShop({ document, window }).catch(() => {
    document.getElementById('paypal-sandbox-status').textContent = 'Checkout could not initialize. Please refresh the page.';
  });
}
