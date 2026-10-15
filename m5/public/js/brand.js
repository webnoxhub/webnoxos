// Fills the branded left panel of the business sign-in and set-password pages.
export function applyBrand(name, logo, logoOnly) {
  const n = String(name || '').trim();
  if (!n) return;
  const lg = document.getElementById('blLogo');
  if (lg && typeof logo === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(logo)) lg.src = logo;
  const b = document.getElementById('blBrand'); if (b) { b.textContent = n; b.hidden = !!(logoOnly && logo); }
  const bd = document.getElementById('blInit');
  if (bd) {
    const w = n.split(/\s+/).filter(Boolean);
    bd.textContent = ((w.length > 1 ? w[0][0] + w[1][0] : n.slice(0, 2)) || '').toUpperCase();
  }
}
