// Shared display/validation rules. The server imports its own trusted copy.
export const SANDBOX_CLIENT_ID = 'AZZE04r6w_7Jd9ncaq_De77RBwY4HZSyOdFvDyAV6mXw8ckwjJaYCxx6rCmCRkXA-L0Rzf48v7M3_DRW';
export const PRODUCTS = Object.freeze({
  kit: { name: 'Complete tower kit', cents: 6000 },
  tray: { name: 'Individual tray', cents: 1500 },
  block: { name: 'Additional tower block', cents: 800 },
  tag: { name: 'Replacement name tag', cents: 200 },
  cube: { name: '5-Photo Lithophane Cube Lamp', cents: 4500, maxQuantity: 4 },
  ornament: { name: 'Light-Up Photo Ornament', cents: 1200 },
  card: { name: 'Custom 3D-Printed Business Card', cents: 200 },
  stl: { name: 'Hormone Monster Figurine STL', cents: 400, digital: true, available: false },
});
export const PRINT_COLORS = ['Jade White', 'Beige', 'Gray', 'Pink', 'Pumpkin Orange', 'Bambu Green', 'Red', 'Blue', 'Purple', 'Black', 'Mistletoe Green', 'Coca Brown', 'Bright Green'];
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const PHOTO_CHUNK_BYTES = 3 * 1024 * 1024;
// Older saved orders without a choice used one photo for each ornament.
export const photoCount = selection => selection.kind === 'cube' ? selection.quantity * 5 : selection.kind === 'ornament' ? (selection.photoMode === 'same' ? 1 : selection.quantity) : 0;
export const isDigital = selection => PRODUCTS[selection.kind]?.digital === true;
export const TRAY_TYPES = ['Cartridge loading block', 'Reloading die holder', 'Divided accessory tray'];
export const CALIBERS = [
  '9mm Luger', '.223 Remington', '5.56 NATO', '.300 AAC Blackout', '.308 Winchester',
  '7.62x51 NATO', '.45 ACP', '.40 S&W', '.380 ACP', '.38 Special', '.357 Magnum',
  '.44 Magnum', '10mm Auto', '6.5 Creedmoor', '.30-06 Springfield', '.270 Winchester',
  '.243 Winchester', '7mm Remington Magnum', '7mm-08 Remington', '.22-250 Remington',
  '.300 Winchester Magnum', '6mm ARC', '6.5 Grendel', '7.62x39', '5.7x28',
];
export const SHIPPING_CENTS = 1000;
export const ORIGIN_ZIP = '65336';
export const money = cents => (cents / 100).toFixed(2);
export const tagCount = type => type === 'Reloading die holder' ? 2 : 1;

function fail(message) { throw new Error(message); }
function plainText(value, title, max, required = false) {
  if (typeof value !== 'string') value = '';
  const text = value.trim();
  if ((required && !text) || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/u.test(text)) fail(`${title} needs ${required ? '1' : '0'}–${max} characters without markup.`);
  return text;
}
function label(value) {
  if (!value || typeof value !== 'object') fail('Choose a name tag.');
  if (value.caliber === 'Custom text') {
    if (typeof value.text !== 'string') fail('Enter custom name tag text.');
    const text = value.text.trim();
    if (!text || text.length > 40 || /[\u0000-\u001f\u007f<>]/u.test(text)) {
      fail('Custom tags need 1–40 characters, without markup or line breaks.');
    }
    return { caliber: 'Custom text', text };
  }
  if (!CALIBERS.includes(value.caliber)) fail('Choose a supported caliber or custom text.');
  return { caliber: value.caliber, text: value.caliber };
}
function tray(value) {
  if (!value || !TRAY_TYPES.includes(value.type)) fail('Choose a valid tray type.');
  if (!Array.isArray(value.labels) || value.labels.length !== tagCount(value.type)) {
    fail('Die holders require two name tags; other trays require one.');
  }
  return { type: value.type, labels: value.labels.map(label) };
}
export function normalizeSelection(input) {
  if (!input || !Object.hasOwn(PRODUCTS, input.kind)) fail('Choose a valid product.');
  if (PRODUCTS[input.kind].available === false) fail('This digital file is not available for purchase yet.');
  const maximum = PRODUCTS[input.kind].maxQuantity || 20;
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > maximum) {
    fail(`Quantity must be a whole number from 1 to ${maximum}.`);
  }
  if (typeof input.destinationZip !== 'string' || !/^[0-9]{5}$/.test(input.destinationZip)) {
    fail('Enter a five-digit destination ZIP code.');
  }
  const result = { kind: input.kind, quantity: input.quantity, destinationZip: input.destinationZip };
  if (input.kind === 'ornament' && input.photoMode !== undefined) {
    if (!['same', 'different'].includes(input.photoMode)) fail('Choose how to use your ornament photos.');
    result.photoMode = input.photoMode;
  }
  if (input.kind === 'kit') {
    if (!Array.isArray(input.trays) || input.trays.length !== 6) fail('Choose exactly six trays for the kit.');
    result.trays = input.trays.map(tray);
  } else if (input.kind === 'tray') {
    result.trays = [tray(input.trays?.[0])];
    if (input.trays.length !== 1) fail('Choose one tray configuration.');
  } else if (input.kind === 'tag') {
    result.label = label(input.label);
  }
  if (['cube', 'ornament', 'card'].includes(input.kind)) {
    const email = plainText(input.customerEmail, 'Contact email', 254, true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid contact email.');
    result.customerEmail = email;
    result.personalization = { notes: plainText(input.personalization?.notes, 'Personalization notes', 500) };
    if (input.kind === 'card') {
      const config = input.personalization || {};
      result.personalization.text = plainText(config.text, 'Business card wording', 500, true);
      for (const field of ['fontColor', 'backgroundColor', 'borderColor']) {
        const allowed = field === 'fontColor' ? PRINT_COLORS : [...PRINT_COLORS, 'Gold'];
        if (!allowed.includes(config[field])) fail('Choose the lettering, background, and border colors.');
        result.personalization[field] = config[field];
      }
    }
    const required = photoCount(result);
    if (required) {
      if (!Array.isArray(input.photos) || input.photos.length !== required) fail(`Choose exactly ${required} photo${required === 1 ? '' : 's'} for this order.`);
      result.photos = input.photos.map((photo, slot) => {
        if (photo?.slot !== slot) fail('Photo order is invalid. Select the photos again.');
        return { slot, name: plainText(photo.name, 'Photo filename', 100, true) };
      });
    }
  }
  return result;
}
export function quote(selection) {
  const product = PRODUCTS[selection.kind];
  if (!product || !Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 20) {
    fail('Choose a valid product and quantity.');
  }
  const subtotalCents = product.cents * selection.quantity;
  const shippingCents = isDigital(selection) ? 0 : SHIPPING_CENTS;
  return {
    currency: 'USD', unitCents: product.cents, subtotalCents,
    shippingCents, totalCents: subtotalCents + shippingCents,
    taxStatus: 'not_calculated_sandbox', originZip: ORIGIN_ZIP,
  };
}
export function descriptionLines(selection) {
  const lines = [`${selection.quantity} × ${PRODUCTS[selection.kind].name}`];
  if (selection.kind === 'kit') lines.push('Per kit: six selected trays, matching tags, three tower blocks and assembly hardware.');
  for (const [index, value] of (selection.trays || []).entries()) {
    lines.push(`Tray ${index + 1}: ${value.type} — ${value.labels.map(item => item.text || item.caliber).join(' + ')}`);
  }
  if (selection.kind === 'tag') lines.push(`Name tag: ${selection.label.text || selection.label.caliber}`);
  if (selection.customerEmail) lines.push(`Contact: ${selection.customerEmail}`);
  if (selection.personalization?.text) lines.push(`Card wording: ${selection.personalization.text}`);
  if (selection.kind === 'card' && selection.personalization) {
    const p = selection.personalization;
    lines.push(`Lettering: ${p.fontColor}; background: ${p.backgroundColor}; border: ${p.borderColor}`);
  }
  if (selection.personalization?.notes) lines.push(`Notes: ${selection.personalization.notes}`);
  if (selection.kind === 'ornament' && selection.photoMode) {
    lines.push(selection.photoMode === 'same'
      ? `Photo use: Print the same photo on ${selection.quantity === 1 ? 'this ornament' : `all ${selection.quantity} ornaments`}.`
      : 'Photo use: One photo per ornament, in the order listed below.');
  }
  for (const photo of selection.photos || []) lines.push(`Photo ${photo.slot + 1}: ${photo.name}`);
  if (isDigital(selection)) lines.push('Digital download only. No physical shipment.');
  return lines;
}
export function paypalOrder(selection, checkoutId) {
  const totals = quote(selection);
  return {
    intent: 'CAPTURE',
    ...(isDigital(selection) ? { payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING' } } } } : {}),
    purchase_units: [{
      reference_id: 'organizer',
      ...(checkoutId ? { custom_id: checkoutId } : {}),
      description: `SANDBOX TEST ONLY: ${selection.quantity} × ${PRODUCTS[selection.kind].name}`,
      amount: {
        currency_code: 'USD', value: money(totals.totalCents),
        breakdown: {
          item_total: { currency_code: 'USD', value: money(totals.subtotalCents) },
          shipping: { currency_code: 'USD', value: money(totals.shippingCents) },
        },
      },
      items: [{
        name: PRODUCTS[selection.kind].name, sku: `organizer-${selection.kind}`,
        quantity: String(selection.quantity), category: isDigital(selection) ? 'DIGITAL_GOODS' : 'PHYSICAL_GOODS',
        unit_amount: { currency_code: 'USD', value: money(totals.unitCents) },
      }],
    }],
  };
}
export function completedCapture(order, expectedOrderId, totals) {
  const units = order?.purchase_units;
  const captures = units?.[0]?.payments?.captures;
  const capture = captures?.[0];
  if (order?.id !== expectedOrderId || order.status !== 'COMPLETED' || units?.length !== 1 ||
      captures?.length !== 1 || capture?.status !== 'COMPLETED' || !capture.id ||
      capture.amount?.currency_code !== 'USD' || capture.amount.value !== money(totals.totalCents)) {
    fail('PayPal has not confirmed a completed Sandbox payment for the expected total.');
  }
  return capture;
}
export function receiptText(receipt) {
  const { selection, totals } = receipt;
  return [
    'SANDBOX TEST — NOT A REAL ORDER',
    `PayPal test order ID: ${receipt.paypalOrderId}`,
    `PayPal test capture ID: ${receipt.captureId}`,
    ...descriptionLines(selection),
    `Items subtotal: $${money(totals.subtotalCents)} USD`,
    `Shipping and handling: $${money(totals.shippingCents)} USD`,
    `Sandbox total: $${money(totals.totalCents)} USD`,
    `Ships from: ${ORIGIN_ZIP}`,
    `Destination ZIP: ${selection.destinationZip}`,
    'Sales tax: not calculated in Sandbox',
    receipt.stored ? 'Test record saved securely on the server. No fulfillment.' : 'Browser-only test receipt. No order stored on the server.',
  ].join('\n');
}
