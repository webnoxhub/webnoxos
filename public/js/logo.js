// Shows /logo.png in the branded left panel when the file exists. Standalone so it never waits on sign-in code.
(function () {
  const img = document.getElementById('blLogo');
  if (!img) return;
  const t = new Image();
  t.onload = () => {
    img.hidden = false;
    const i = document.getElementById('blInit'); if (i) i.hidden = true;
    const bd = document.getElementById('blBadge'); if (bd) bd.classList.add('has-logo');
    const br = document.querySelector('.bl-brand'); if (br) br.classList.add('has-logo');
  };
  t.src = '/logo.png';
})();
