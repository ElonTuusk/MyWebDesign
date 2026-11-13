import { completedCapture, money } from '../../assets/shop-catalog.js';

export class OrderError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Keep the fulfillment address supplied by PayPal, never an address submitted
// alongside the browser's capture request. Do not store the raw payer response.
export function shippingAddress(order, required = true) {
  const shipping = order?.purchase_units?.[0]?.shipping;
  const address = shipping?.address;
  const fields = {
    name: shipping?.name?.full_name,
    addressLine1: address?.address_line_1,
    addressLine2: address?.address_line_2 || '',
    city: address?.admin_area_2,
    region: address?.admin_area_1,
    postalCode: address?.postal_code,
    countryCode: address?.country_code,
  };
  const valid = Object.entries(fields).every(([key, value]) =>
    typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value) &&
    (key === 'addressLine2' || value.trim().length > 0)) && fields.countryCode === 'US';
  if (!valid) {
    if (required) throw new OrderError('Choose a complete US shipping address in PayPal before confirming.', 422);
    return null;
  }
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()]));
}

export function verifyOrder(order, draft, orderID) {
  const units = order?.purchase_units;
  const unit = units?.[0];
  if (order?.id !== orderID || order.intent !== 'CAPTURE' || units?.length !== 1 ||
      unit.custom_id !== draft.checkoutId || unit.amount?.currency_code !== 'USD' ||
      unit.amount.value !== money(draft.totals.totalCents) ||
      unit.amount.breakdown?.item_total?.value !== money(draft.totals.subtotalCents) ||
      unit.amount.breakdown?.shipping?.value !== money(draft.totals.shippingCents)) {
    throw new OrderError('The PayPal order does not match the saved configuration and total.', 409);
  }
  if (unit.shipping?.address?.country_code !== 'US') {
    throw new OrderError('Choose a US shipping address in PayPal Sandbox.', 422);
  }
  shippingAddress(order, draft.version >= 2);
}

// Shared by browser confirmation and unattended recovery. It never captures or
// creates a payment; callers must supply a completed order read from PayPal.
export async function saveCompletedOrder({ store, draft, order, orderID, now = () => new Date() }) {
  verifyOrder(order, draft, orderID);
  let capture;
  try { capture = completedCapture(order, orderID, draft.totals); }
  catch (error) { throw new OrderError(error.message, 409); }
  const key = `receipts/${draft.checkoutId}`;
  const receipt = {
    version: 2, mode: 'sandbox', fulfillment: 'disabled', stored: true,
    checkoutId: draft.checkoutId, paypalOrderId: orderID, captureId: capture.id,
    selection: draft.selection, totals: draft.totals, completedAt: now().toISOString(),
    uploads: draft.uploads || [],
    paypalShippingZip: order.purchase_units[0].shipping?.address?.postal_code || null,
    shippingAddress: shippingAddress(order, draft.version >= 2),
  };
  await store.setJSON(key, receipt, { onlyIfNew: true });
  const saved = await store.get(key, { type: 'json' });
  if (!saved || saved.paypalOrderId !== orderID || saved.captureId !== capture.id || !saved.stored) {
    throw new OrderError('The payment was checked but its test record was not saved. Retry confirmation.', 503);
  }
  return saved;
}
