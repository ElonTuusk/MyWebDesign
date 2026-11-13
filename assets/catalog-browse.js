// The catalog remains readable with JavaScript disabled. Filtering is optional.
export function initCatalog(document) {
  const filters = document.getElementById('catalog-filters');
  const count = document.getElementById('catalog-count');
  const cards = [...document.querySelectorAll('#catalog-grid .catalog-card')];
  if (!filters || !count || !cards.length) return;
  const buttons = [...filters.querySelectorAll('[data-filter]')];

  function select(type) {
    let visible = 0;
    for (const card of cards) {
      card.hidden = type !== 'all' && card.dataset.productType !== type;
      if (!card.hidden) visible++;
    }
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.filter === type));
    const noun = type === 'digital' ? 'digital file' : type === 'physical' ? 'physical item' : 'product';
    count.textContent = `${visible} ${noun}${visible === 1 ? '' : 's'}`;
  }

  for (const button of buttons) button.addEventListener('click', () => select(button.dataset.filter));
  filters.hidden = false;
  select('all');
}

if (typeof document !== 'undefined') initCatalog(document);
