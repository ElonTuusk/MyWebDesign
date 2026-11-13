export const checkoutId = '61cdb567-5530-4e50-9eb6-ab7c82b161ed';
export const token = 'a'.repeat(64);
export const orderID = 'TESTORDER123456789';
export const tag = (caliber = '9mm Luger') => ({ caliber });
export const kit = () => ({
  kind: 'kit', quantity: 1, destinationZip: '65336',
  trays: Array.from({ length: 6 }, () => ({ type: 'Cartridge loading block', labels: [tag()] })),
});
export function approvedOrder(status = 'APPROVED', captureStatus = 'COMPLETED') {
  return {
    id: orderID, status, intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'organizer', custom_id: checkoutId,
      amount: { currency_code: 'USD', value: '70.00', breakdown: {
        item_total: { currency_code: 'USD', value: '60.00' },
        shipping: { currency_code: 'USD', value: '10.00' },
      } },
      shipping: { name: { full_name: 'Sandbox Buyer' }, address: {
        address_line_1: '123 Test Street', address_line_2: 'Unit 2',
        admin_area_2: 'Knob Noster', admin_area_1: 'MO', country_code: 'US', postal_code: '65336',
      } },
      ...(status === 'COMPLETED' ? { payments: { captures: [{
        id: 'TESTCAPTURE123456', status: captureStatus,
        amount: { currency_code: 'USD', value: '70.00' },
      }] } } : {}),
    }],
  };
}
