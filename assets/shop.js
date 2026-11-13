import {
  CALIBERS, TRAY_TYPES, SANDBOX_CLIENT_ID, PRODUCTS, tagCount, quote, money,
  normalizeSelection, descriptionLines, paypalOrder, completedCapture, receiptText,
  PRINT_COLORS, MAX_PHOTO_BYTES, PHOTO_CHUNK_BYTES, photoCount, isDigital,
} from './shop-catalog.js';

const ENDPOINT = '/.netlify/functions/sandbox-checkout';
const SESSION_KEY = 'mini3d-sandbox-checkout-v1';
const EMAIL_SESSION_KEY = 'mini3d-sandbox-email-retries-v1';

export async function initShop({ document, window, fetch: request = window.fetch.bind(window) }) {
  const $ = id => document.getElementById(id);
  const status = text => { $('paypal-sandbox-status').textContent = text; };
  let active = null;
  let serverReady = false;
  let captureRunning = false;
  let retryingEmail = false;
  let pendingEmails = [];
  let buttons;
  const kitRows = [];
  let selectedFiles = [];
  let retainedPhotos = [];
  let previousKind = 'kit';
  let checkoutError = '';
  const photoName = name => name.replace(/[\u0000-\u001f\u007f<>\\/]/g, '_').slice(0, 100);

  for (const id of ['font-color', 'background-color', 'border-color']) {
    for (const color of [...PRINT_COLORS, ...(id === 'font-color' ? [] : ['Gold'])]) $(id).add(new window.Option(color, color));
  }
  $('background-color').value = 'Black';
  $('border-color').value = 'Blue';
  $('photo-files').addEventListener('change', () => {
    selectedFiles = [...$('photo-files').files];
    retainedPhotos = [];
    $('photo-list').replaceChildren();
    for (const [index, file] of selectedFiles.entries()) {
      const li = document.createElement('li');
      li.textContent = `${index + 1}. ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
      $('photo-list').append(li);
    }
    $('photo-upload-status').textContent = selectedFiles.length ? 'Photos selected on this device. They have not been uploaded yet.' : '';
    update();
  });

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
      ...(kind === 'ornament' ? { photoMode: $('ornament-photo-same').checked ? 'same' : 'different' } : {}),
      ...(kind === 'kit' ? { trays: kitRows.map(read => read()) } : {}),
      ...(kind === 'tray' ? { trays: [singleTray()] } : {}),
      ...(kind === 'tag' ? { label: replacement.value() } : {}),
      ...(['cube', 'ornament', 'card'].includes(kind) ? {
        customerEmail: $('customer-email').value.trim(),
        personalization: {
          notes: $('personalization-notes').value,
          ...(kind === 'card' ? { text: $('card-text').value, fontColor: $('font-color').value, backgroundColor: $('background-color').value, borderColor: $('border-color').value } : {}),
        },
        ...(['cube', 'ornament'].includes(kind) ? { photos: selectedFiles.length ? selectedFiles.map((file, slot) => ({ slot, name: photoName(file.name) })) : retainedPhotos } : {}),
      } : {}),
    };
  }
  function update() {
    const value = selection();
    if (previousKind !== value.kind) {
      selectedFiles = []; retainedPhotos = [];
      $('photo-files').value = '';
      $('photo-list').replaceChildren();
      $('photo-upload-status').textContent = '';
      previousKind = value.kind;
      if (value.photos) value.photos = [];
    }
    const customized = ['cube', 'ornament', 'card'].includes(value.kind);
    const photos = ['cube', 'ornament'].includes(value.kind);
    const digital = isDigital(value);
    $('quantity').max = String(PRODUCTS[value.kind]?.maxQuantity || (digital ? 1 : 20));
    $('kit-fields').hidden = value.kind !== 'kit';
    $('tray-fields').hidden = value.kind !== 'tray';
    $('tag-fields').hidden = value.kind !== 'tag';
    $('personalization-fields').hidden = !customized;
    for (const id of ['customer-email', 'personalization-notes']) $(id).disabled = !customized;
    $('customer-email').required = customized;
    $('business-card-fields').hidden = value.kind !== 'card';
    for (const id of ['card-text', 'font-color', 'background-color', 'border-color']) $(id).disabled = value.kind !== 'card';
    $('card-text').required = value.kind === 'card';
    $('photo-fields').hidden = !photos;
    $('ornament-photo-options').hidden = value.kind !== 'ornament';
    for (const id of ['ornament-photo-same', 'ornament-photo-different']) $(id).disabled = value.kind !== 'ornament';
    $('photo-files').disabled = !photos;
    $('photo-files').required = photos && !retainedPhotos.length;
    $('photo-files').multiple = !(value.kind === 'ornament' && value.photoMode === 'same');
    $('photo-instructions').textContent = value.kind === 'cube'
      ? `Select ${photoCount(value)} photos: five for each lamp, grouped in order. Maximum four lamps per order.`
      : value.photoMode === 'same'
        ? `Select one photo. We will use it for ${value.quantity === 1 ? 'your ornament' : `all ${value.quantity} ornaments`}.`
        : `Select ${photoCount(value)} photo${photoCount(value) === 1 ? '' : 's'}: one for each ornament, in the order listed below.`;
    const needed = photoCount(value);
    const count = selectedFiles.length || retainedPhotos.length;
    const mismatch = photos && Number.isInteger(needed) && needed > 0 && count !== needed;
    const invalidFile = selectedFiles.find(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > MAX_PHOTO_BYTES);
    const fileError = invalidFile ? (invalidFile.size > MAX_PHOTO_BYTES
      ? `${invalidFile.name} is ${(invalidFile.size / 1024 / 1024).toFixed(1)} MB. Maximum 10 MB per photo.`
      : `${invalidFile.name}: choose a JPG, PNG, or WebP photo up to 10 MB.`) : '';
    $('photo-selection-status').textContent = photos && Number.isInteger(needed) && needed > 0
      ? `${count} of ${needed} required photo${needed === 1 ? '' : 's'} selected.${fileError ? ` ${fileError}` : mismatch ? ` Choose exactly ${needed} to continue.` : ''}` : '';
    $('photo-selection-status').dataset.invalid = String(mismatch || Boolean(fileError));
    $('photo-files').setCustomValidity(photos ? fileError || (mismatch ? `Choose exactly ${needed} photo${needed === 1 ? '' : 's'} for this order.` : '') : '');
    $('digital-file-info').hidden = !digital;
    $('shipping-fields').hidden = digital;
    $('shipping-zip').disabled = digital;
    $('shipping-zip').required = !digital;
    $('paypal-sandbox-button').hidden = digital;
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
    if (value.kind === 'ornament') {
      $('ornament-photo-same').checked = value.photoMode === 'same';
      $('ornament-photo-different').checked = value.photoMode !== 'same';
    }
    if (value.kind === 'kit') value.trays.forEach((tray, index) => {
      set(`kit-tray-${index + 1}`, tray.type, 'change');
      tray.labels.forEach((label, tag) => restoreLabel(`kit-${index + 1}-label-${tag + 1}`, label));
    });
    if (value.kind === 'tray') {
      set('tray-type', value.trays[0].type, 'change');
      value.trays[0].labels.forEach((label, tag) => restoreLabel(`single-tray-label-${tag + 1}`, label));
    }
    if (value.kind === 'tag') restoreLabel('replacement-tag', value.label);
    if (value.customerEmail) {
      set('customer-email', value.customerEmail);
      set('personalization-notes', value.personalization?.notes || '');
    }
    if (value.kind === 'card') {
      set('card-text', value.personalization.text);
      set('font-color', value.personalization.fontColor);
      set('background-color', value.personalization.backgroundColor);
      set('border-color', value.personalization.borderColor);
    }
    if (value.photos?.length) {
      retainedPhotos = value.photos;
      $('photo-upload-status').textContent = 'Previously uploaded photos are attached to the pending checkout.';
    }
    update();
  }
  function validateFiles(value) {
    if (!photoCount(value)) return;
    if (!serverReady) throw new Error('Secure photo checkout is not connected yet. No payment has been started.');
    if (selectedFiles.length !== photoCount(value)) throw new Error(`Select ${photoCount(value)} photos for this order.`);
    for (const file of selectedFiles) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > MAX_PHOTO_BYTES) {
        throw new Error(`${file.name}: photos must be JPG, PNG, or WebP, up to 10 MB each.`);
      }
    }
  }
  async function uploadPhotos(value) {
    if (!photoCount(value)) return;
    for (const [slot, file] of selectedFiles.entries()) {
      const chunkCount = Math.ceil(file.size / PHOTO_CHUNK_BYTES);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const form = new window.FormData();
        for (const [key, data] of Object.entries({ checkoutId: active.checkoutId, token: active.token, kind: value.kind, quantity: value.quantity, slot, chunkIndex, chunkCount, totalSize: file.size })) form.append(key, String(data));
        if (value.kind === 'ornament') form.append('photoMode', value.photoMode);
        form.append('file', file.slice(chunkIndex * PHOTO_CHUNK_BYTES, (chunkIndex + 1) * PHOTO_CHUNK_BYTES, file.type), photoName(file.name));
        $('photo-upload-status').textContent = `Saving photo ${slot + 1} of ${selectedFiles.length} privately… ${Math.round(chunkIndex / chunkCount * 100)}%`;
        const response = await request('/.netlify/functions/order-photos', { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok || (chunkIndex === chunkCount - 1 ? result.saved !== true : result.accepted !== true)) throw new Error(result.error || 'Photo upload failed. No payment was started.');
      }
    }
    $('photo-upload-status').textContent = 'Photos saved privately and attached to this checkout.';
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
  function savePendingEmails() {
    try {
      if (pendingEmails.length) window.sessionStorage.setItem(EMAIL_SESSION_KEY, JSON.stringify(pendingEmails));
      else window.sessionStorage.removeItem(EMAIL_SESSION_KEY);
    } catch { /* An email retry in this tab still works when session storage is unavailable. */ }
    $('retry-order-email').hidden = !pendingEmails.length;
  }
  function showEmailResult(notification, reference) {
    if (!notification) return;
    const messages = {
      accepted: 'Order email accepted by Resend. Check the owner inbox; delivery is not yet confirmed.',
      retryable: 'The test order is saved, but its email needs another attempt. Photos remain saved. Retrying the email will not repeat the payment.',
      not_configured: 'Order email is not configured for this preview. The test order and any photos remain saved.',
      needs_review: 'The email retry window has ended. The owner must check this order in Resend before resending. The test order and photos remain saved.',
    };
    $('order-email-status').textContent = messages[notification.status] || 'Order email status could not be confirmed.';
    if (reference && ['retryable', 'not_configured'].includes(notification.status)) {
      if (!pendingEmails.some(item => item.checkoutId === reference.checkoutId)) pendingEmails.push(reference);
    } else if (reference && ['accepted', 'needs_review'].includes(notification.status)) {
      pendingEmails = pendingEmails.filter(item => item.checkoutId !== reference.checkoutId);
    }
    savePendingEmails();
  }
  $('retry-order-email').addEventListener('click', async () => {
    if (active || captureRunning || retryingEmail || !pendingEmails.length) return;
    const reference = pendingEmails[0];
    retryingEmail = true;
    $('retry-order-email').disabled = true;
    $('order-email-status').textContent = 'Retrying the saved test order email. No new payment is being made…';
    try {
      const result = await api({ action: 'capture', ...reference });
      if (!result.receipt?.stored || result.receipt.paypalOrderId !== reference.orderID) throw new Error('Unconfirmed receipt');
      showEmailResult(result.notification || { status: 'not_configured' }, reference);
    } catch { $('order-email-status').textContent = 'Order email could not be confirmed. Your saved test order and photos are unchanged; you can retry again.'; }
    finally { retryingEmail = false; $('retry-order-email').disabled = false; }
  });
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
      const reference = { checkoutId: active.checkoutId, token: active.token, orderID: active.orderID };
      const { receipt, notification } = await api({ action: 'capture', ...reference });
      if (!receipt?.stored || receipt.paypalOrderId !== active.orderID) throw new Error('The test record could not be verified.');
      showReceipt(receipt);
      showEmailResult(notification, reference);
    } catch (error) {
      status(`${error.message} Use “Retry test confirmation” for this same order. Do not start another payment.`);
      $('retry-test-record').hidden = false;
    } finally { captureRunning = false; }
  }
  $('retry-test-record').addEventListener('click', confirmServer);
  $('order-form').addEventListener('submit', event => event.preventDefault());
  for (const id of ['product', 'quantity', 'shipping-zip', 'customer-email', 'card-text', 'font-color', 'background-color', 'border-color', 'personalization-notes']) $(id).addEventListener('input', update);
  $('product').addEventListener('change', update);
  for (const id of ['ornament-photo-same', 'ornament-photo-different']) $(id).addEventListener('change', update);
  for (const link of document.querySelectorAll('[data-shop-product]')) link.addEventListener('click', event => {
    if (active) { event.preventDefault(); status('Finish or cancel the current checkout before choosing another product.'); return; }
    $('product').value = link.dataset.shopProduct;
    $('quantity').value = '1';
    update();
  });
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
      $('order-email-status').textContent = config.emailReady
        ? 'A completed test payment will email the order details and any photo attachments to the owner.'
        : 'Order email is not connected for this preview yet.';
    }
  } catch { /* A static preview can still run the explicitly labeled browser-only Sandbox flow. */ }
  $('checkout-mode').textContent = serverReady
    ? 'Sandbox test records are verified and saved securely on the server.'
    : 'Browser-only Sandbox test. Server order recording is not connected yet.';

  try {
    const saved = JSON.parse(window.sessionStorage.getItem(EMAIL_SESSION_KEY));
    if (Array.isArray(saved)) pendingEmails = saved.filter(item => item?.checkoutId && item.token && item.orderID);
    if (pendingEmails.length) {
      $('order-email-status').textContent = 'A saved test order email still needs confirmation. Use Retry order email; it will not repeat the payment.';
      $('retry-order-email').hidden = false;
    }
  } catch { /* Empty or unavailable session storage. */ }

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
        try { const value = normalizeSelection(selection()); validateFiles(value); checkoutError = ''; return actions.resolve(); }
        catch (error) { checkoutError = error.message; status(checkoutError); $('order-form').reportValidity(); return actions.reject(); }
      },
      async createOrder(_data, actions) {
        if (active) throw new Error('A Sandbox checkout is already in progress.');
        const value = normalizeSelection(selection());
        validateFiles(value);
        active = {
          server: serverReady, selection: value, totals: quote(value), checkoutId: window.crypto.randomUUID(),
          token: Array.from(window.crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
        };
        $('configuration-fields').disabled = true;
        $('sandbox-receipt').hidden = true;
        status('Creating a Sandbox test checkout…');
        try {
          if (serverReady) {
            await uploadPhotos(value);
            const created = await api({ action: 'create', checkoutId: active.checkoutId, token: active.token, selection: value });
            active.orderID = created.id;
          } else {
            active.orderID = await actions.order.create(paypalOrder(value));
          }
          saveActive();
          status('Complete or cancel the test in the PayPal Sandbox window.');
          return active.orderID;
        } catch (error) { reset(); checkoutError = error.message; status(checkoutError); throw error; }
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
        } else { reset(); status(checkoutError || 'PayPal Sandbox could not start. Your configuration is still available.'); }
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
