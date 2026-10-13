// Small styled suggestion dropdown for text inputs (replaces native <datalist>).
export function bindCombo(input, options) {
  const wrap = input.parentElement;
  const list = document.createElement('div');
  list.className = 'combo-list'; list.hidden = true; list.setAttribute('role', 'listbox');
  wrap.appendChild(list);
  const render = (q) => {
    const s = (q || '').toLowerCase();
    const items = options.filter((o) => !s || o.toLowerCase().includes(s));
    list.innerHTML = items.map((o) =>
      '<button type="button" class="combo-item' + (o === input.value ? ' is-on' : '') + '" role="option">' + o.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</button>').join('');
    list.hidden = !items.length;
  };
  const close = () => { list.hidden = true; };
  input.addEventListener('focus', () => render(''));
  input.addEventListener('click', () => render(''));
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); close(); } });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const b = e.target.closest('.combo-item'); if (!b) return;
    input.value = b.textContent; close(); input.dispatchEvent(new Event('input', { bubbles: true })); close();
  });
  input.addEventListener('blur', close);
}
