// Fills the branded left panel of the business sign-in and set-password pages.
export function applyBrand(name) {
  const n = String(name || '').trim();
  if (!n) return;
  const b = document.getElementById('blBrand'); if (b) b.textContent = n;
  const bd = document.getElementById('blBadge');
  if (bd) {
    const w = n.split(/\s+/).filter(Boolean);
    bd.textContent = ((w.length > 1 ? w[0][0] + w[1][0] : n.slice(0, 2)) || '').toUpperCase();
  }
}
