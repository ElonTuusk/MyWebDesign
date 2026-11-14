import { initShop } from './shop.js';
import { initSavedOrderNotice } from './saved-order.js';

export function initProductGallery(document) {
  const image = document.getElementById('product-main-image');
  const buttons = [...document.querySelectorAll('[data-product-image]')];
  for (const button of buttons) button.addEventListener('click', () => {
    image.src = button.dataset.productImage;
    image.alt = button.dataset.imageAlt;
    for (const thumbnail of buttons) thumbnail.setAttribute('aria-pressed', String(thumbnail === button));
  });
}

if (typeof document !== 'undefined') {
  initProductGallery(document);
  initSavedOrderNotice(document, window);
  if (document.getElementById('order-form')) {
    initShop({ document, window }).catch(() => {
      document.getElementById('paypal-sandbox-status').textContent = 'Checkout could not initialize. Please refresh the page.';
    });
  }
}
