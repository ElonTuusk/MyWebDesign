// Shared display/validation rules. The server imports its own trusted copy.
export const SANDBOX_CLIENT_ID = 'AZZE04r6w_7Jd9ncaq_De77RBwY4HZSyOdFvDyAV6mXw8ckwjJaYCxx6rCmCRkXA-L0Rzf48v7M3_DRW';
export const PRODUCTS = Object.freeze({
  kit: { name: 'Complete tower kit', cents: 6000 },
  tray: { name: 'Individual tray', cents: 1500 },
  block: { name: 'Additional tower block', cents: 800 },
  tag: { name: 'Replacement name tag', cents: 200 },
});
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
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 20) {
    fail('Quantity must be a whole number from 1 to 20.');
  }
  if (typeof input.destinationZip !== 'string' || !/^[0-9]{5}$/.test(input.destinationZip)) {
    fail('Enter a five-digit destination ZIP code.');
  }
  const result = { kind: input.kind, quantity: input.quantity, destinationZip: input.destinationZip };
  if (input.kind === 'kit') {
    if (!Array.isArray(input.trays) || input.trays.length !== 6) fail('Choose exactly six trays for the kit.');
    result.trays = input.trays.map(tray);
  } else if (input.kind === 'tray') {
    result.trays = [tray(input.trays?.[0])];
    if (input.trays.length !== 1) fail('Choose one tray configuration.');
  } else if (input.kind === 'tag') {
    result.label = label(input.label);
  }
  return result;
}
export function quote(selection) {
  const product = PRODUCTS[selection.kind];
  if (!product || !Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > 20) {
    fail('Choose a valid product and quantity.');
  }
  const subtotalCents = product.cents * selection.quantity;
  return {
    currency: 'USD', unitCents: product.cents, subtotalCents,
    shippingCents: SHIPPING_CENTS, totalCents: subtotalCents + SHIPPING_CENTS,
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
  return lines;
}
export function paypalOrder(selection, checkoutId) {
  const totals = quote(selection);
  return {
    intent: 'CAPTURE',
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
        quantity: String(selection.quantity), category: 'PHYSICAL_GOODS',
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
