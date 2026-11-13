import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelection, quote, paypalOrder, completedCapture, receiptText, photoCount } from '../assets/shop-catalog.js';
import { kit, tag, approvedOrder, orderID } from './fixtures.mjs';

test('kit is $60 + $10 = $70; PayPal receives the exact same breakdown', () => {
  const value = normalizeSelection(kit());
  assert.equal(quote(value).totalCents, 7000);
  const unit = paypalOrder(value).purchase_units[0];
  assert.equal(unit.amount.value, '70.00');
  assert.equal(unit.amount.breakdown.item_total.value, '60.00');
  assert.equal(unit.amount.breakdown.shipping.value, '10.00');
  assert.equal(unit.items[0].unit_amount.value, '60.00');
});
test('all prices and multi-quantity orders use one flat shipping charge', () => {
  for (const [kind, unit] of Object.entries({ kit: 6000, tray: 1500, block: 800, tag: 200, cube: 4500, ornament: 1200, card: 200 })) {
    assert.equal(quote({ kind, quantity: 3 }).totalCents, 3 * unit + 1000);
  }
});
test('custom physical products preserve personalization and require the correct photos', () => {
  const common = { quantity: 1, destinationZip: '65336', customerEmail: 'customer@example.com', personalization: { notes: 'Front photo first' } };
  for (const kind of ['cube', 'ornament']) {
    const selection = { ...common, kind, photos: Array.from({ length: photoCount({ kind, quantity: 1 }) }, (_, slot) => ({ slot, name: `photo-${slot}.jpg` })) };
    const normalized = normalizeSelection(selection);
    assert.equal(normalized.photos.length, kind === 'cube' ? 5 : 1);
    assert.equal(normalized.customerEmail, common.customerEmail);
    assert.equal(normalized.personalization.notes, 'Front photo first');
    assert.throws(() => normalizeSelection({ ...selection, photos: [] }), /exactly/);
    assert.throws(() => normalizeSelection({ ...selection, customerEmail: 'wrong' }), /email/);
  }
  const card = normalizeSelection({ ...common, kind: 'card', personalization: { text: 'My Business\n555-0100', fontColor: 'Jade White', backgroundColor: 'Black', borderColor: 'Blue', notes: 'Logo: a small cube' } });
  assert.match(receiptText({ selection: card, totals: quote(card), paypalOrderId: orderID, captureId: 'CAPTURE', stored: true }), /My Business\n555-0100/);
  assert.equal(quote(card).totalCents, 1200);
  assert.throws(() => normalizeSelection({ ...card, personalization: { ...card.personalization, fontColor: '<script>' } }));
});
test('unavailable STL cannot be purchased and its display quote has no shipping', () => {
  assert.equal(quote({ kind: 'stl', quantity: 1 }).totalCents, 400);
  assert.throws(() => normalizeSelection({ kind: 'stl', quantity: 1 }), /not available/);
});
test('multiple ornaments accept one shared photo or one photo per ornament without changing the quantity charged', () => {
  const base = { kind: 'ornament', quantity: 5, destinationZip: '65336', customerEmail: 'customer@example.com' };
  for (const [photoMode, count] of [['same', 1], ['different', 5]]) {
    const selection = normalizeSelection({ ...base, photoMode, photos: Array.from({ length: count }, (_, slot) => ({ slot, name: `picture-${slot}.jpg` })) });
    assert.equal(photoCount(selection), count);
    assert.equal(quote(selection).totalCents, 7000);
    const order = paypalOrder(selection).purchase_units[0];
    assert.equal(order.items[0].quantity, '5');
    assert.equal(order.amount.value, '70.00');
    const receipt = receiptText({ selection, totals: quote(selection), stored: true });
    assert.match(receipt, photoMode === 'same' ? /same photo on all 5 ornaments/ : /One photo per ornament/);
    assert.throws(() => normalizeSelection({ ...selection, photos: [] }), /exactly/);
    assert.throws(() => normalizeSelection({ ...selection, photoMode: 'wrong' }), /Choose how/);
  }
  assert.throws(() => normalizeSelection({ ...base, photos: [{ slot: 0, name: 'old.jpg' }] }), /exactly 5/);
});
test('server ignores client prices and preserves dual independent custom labels', () => {
  const input = kit();
  input.totalCents = 1;
  input.price = 0;
  input.trays[0] = { type: 'Reloading die holder', labels: [tag('.223 Remington'), { caliber: 'Custom text', text: '  My second set  ' }] };
  const selected = normalizeSelection(input);
  assert.equal(selected.trays[0].labels[0].text, '.223 Remington');
  assert.equal(selected.trays[0].labels[1].text, 'My second set');
  assert.equal(quote(selected).totalCents, 7000);
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
test('receipt contains real line breaks, full configuration and $70 total', () => {
  const value = kit();
  value.trays[0] = { type: 'Reloading die holder', labels: [tag('.223 Remington'), tag('.300 AAC Blackout')] };
  const selection = normalizeSelection(value);
  const text = receiptText({ selection, totals: quote(selection), paypalOrderId: orderID, captureId: 'TESTCAPTURE', stored: false });
  assert.match(text, /\.223 Remington \+ \.300 AAC Blackout/);
  assert.match(text, /Items subtotal: \$60\.00 USD\nShipping and handling: \$10\.00 USD\nSandbox total: \$70\.00 USD/);
  assert.ok(!text.includes('\\n'));
});
