// Fills the branded left panel of the business sign-in and set-password pages.
export function applyBrand(name) {
  const n = String(name || '').trim();
  if (!n) return;
  const b = document.getElementById('blBrand'); if (b) b.textContent = n;
  const bd = document.getElementById('blInit');
  if (bd) {
    const w = n.split(/\s+/).filter(Boolean);
    bd.textContent = ((w.length > 1 ? w[0][0] + w[1][0] : n.slice(0, 2)) || '').toUpperCase();
  }
}

// Use /logo.png when it exists; otherwise the initials stay.
(function () {
  const img = document.getElementById('blLogo');
  if (!img) return;
  const t = new Image();
  t.onload = () => {
    img.hidden = false;
    const i = document.getElementById('blInit'); if (i) i.hidden = true;
    const bd = document.getElementById('blBadge'); if (bd) bd.classList.add('has-logo');
  };
  t.src = '/logo.png';
})();
