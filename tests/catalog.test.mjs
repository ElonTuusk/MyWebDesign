import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelection, quote, paypalOrder, completedCapture, receiptText } from '../assets/shop-catalog.js';
import { kit, tag, approvedOrder, orderID } from './fixtures.mjs';

test('kit is $45 + $10 = $55; PayPal receives the exact same breakdown', () => {
  const value = normalizeSelection(kit());
  assert.equal(quote(value).totalCents, 5500);
  const unit = paypalOrder(value).purchase_units[0];
  assert.equal(unit.amount.value, '55.00');
  assert.equal(unit.amount.breakdown.item_total.value, '45.00');
  assert.equal(unit.amount.breakdown.shipping.value, '10.00');
  assert.equal(unit.items[0].unit_amount.value, '45.00');
});
test('all prices and multi-quantity orders use one flat shipping charge', () => {
  for (const [kind, unit] of Object.entries({ kit: 4500, tray: 1000, block: 800, tag: 200 })) {
    assert.equal(quote({ kind, quantity: 3 }).totalCents, 3 * unit + 1000);
  }
});
test('server ignores client prices and preserves dual independent custom labels', () => {
  const input = kit();
  input.totalCents = 1;
  input.price = 0;
  input.trays[0] = { type: 'Reloading die holder', labels: [tag('.223 Remington'), { caliber: 'Custom text', text: '  My second set  ' }] };
  const selected = normalizeSelection(input);
  assert.equal(selected.trays[0].labels[0].text, '.223 Remington');
  assert.equal(selected.trays[0].labels[1].text, 'My second set');
  assert.equal(quote(selected).totalCents, 5500);
  assert.ok(!('price' in selected));
});
test('invalid quantity, tray count, tag count, ZIP and custom text are rejected', () => {
  const cases = [
    { ...kit(), quantity: 1.5 }, { ...kit(), quantity: 0 }, { ...kit(), quantity: 21 },
    { ...kit(), quantity: '1' }, { ...kit(), kind: 'toString' }, { ...kit(), destinationZip: '1234' },
    { ...kit(), trays: [] },
    { kind: 'tray', quantity: 1, destinationZip: '65336', trays: [{ type: 'Reloading die holder', labels: [tag()] }] },
    ...['', '   ', '<script>', 'a'.repeat(41), 'line\nbreak'].map(text => ({
      kind: 'tag', quantity: 1, destinationZip: '65336', label: { caliber: 'Custom text', text },
    })),
  ];
  for (const input of cases) assert.throws(() => normalizeSelection(input));
});
test('pending, wrong-amount, wrong-currency and mismatched captures cannot create success', () => {
  const totals = quote(kit());
  for (const mutate of [
    order => { order.status = 'APPROVED'; },
    order => { order.purchase_units[0].payments.captures[0].status = 'PENDING'; },
    order => { order.purchase_units[0].payments.captures[0].amount.value = '1.00'; },
    order => { order.purchase_units[0].payments.captures[0].amount.currency_code = 'EUR'; },
    order => { order.id = 'OTHERORDER'; },
  ]) {
    const order = approvedOrder('COMPLETED'); mutate(order);
    assert.throws(() => completedCapture(order, orderID, totals));
  }
});
test('receipt contains real line breaks, full configuration and $55 total', () => {
  const value = kit();
  value.trays[0] = { type: 'Reloading die holder', labels: [tag('.223 Remington'), tag('.300 AAC Blackout')] };
  const selection = normalizeSelection(value);
  const text = receiptText({ selection, totals: quote(selection), paypalOrderId: orderID, captureId: 'TESTCAPTURE', stored: false });
  assert.match(text, /\.223 Remington \+ \.300 AAC Blackout/);
  assert.match(text, /Items subtotal: \$45\.00 USD\nShipping and handling: \$10\.00 USD\nSandbox total: \$55\.00 USD/);
  assert.ok(!text.includes('\\n'));
});
