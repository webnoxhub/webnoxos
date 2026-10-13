// If /logo.png is missing, fall back to the initials badge and name. Standalone so it never waits on sign-in code.
(function () {
  const img = document.getElementById('blLogo');
  if (!img) return;
  const fallback = () => {
    img.hidden = true;
    const i = document.getElementById('blInit'); if (i) i.hidden = false;
    const bd = document.getElementById('blBadge'); if (bd) bd.classList.remove('has-logo');
    const br = document.querySelector('.bl-brand'); if (br) br.classList.remove('has-logo');
  };
  if (img.complete && img.naturalWidth === 0) fallback();
  else img.addEventListener('error', fallback);
})();
