import { getClient } from '/js/supabase.js';

const REFUSED = "These details don't work here.";
const EMPTY = 'Enter your email and password.';
const FLOOR_MS = 600;

export async function initMasterLogin() {
  const form = document.getElementById('mlForm');
  const email = document.getElementById('mlEmail');
  const pass = document.getElementById('mlPass');
  const errorEl = document.getElementById('mlError');
  const submit = document.getElementById('mlSubmit');
  const eye = document.getElementById('mlEye');

  function setBusy(on) {
    submit.disabled = on;
    submit.classList.toggle('is-busy', on);
    email.disabled = on;
    pass.disabled = on;
  }
  function showError(msg) { errorEl.textContent = msg; errorEl.hidden = false; }
  function clearError() { errorEl.textContent = ''; errorEl.hidden = true; }

  eye.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  let sb;
  try { sb = await getClient(); } catch { sb = null; }

  async function isMaster(userId) {
    try {
      const { data, error } = await sb.from('profiles').select('is_master').eq('id', userId).maybeSingle();
      return !error && data && data.is_master === true;
    } catch { return false; }
  }

  async function floor(started) {
    const wait = Math.max(0, FLOOR_MS - (Date.now() - started));
    await new Promise(r => setTimeout(r, wait));
  }

  // On load: Master with a live session goes straight in; anything else is signed out.
  if (sb) {
    try {
      const { data } = await sb.auth.getSession();
      const user = data && data.session && data.session.user;
      if (user) {
        if (await isMaster(user.id)) { location.replace('/app.html'); return; }
        await sb.auth.signOut();
      }
    } catch { /* stay on the page */ }
  }
  email.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;

    const mail = email.value.trim().toLowerCase();
    const pw = pass.value;
    if (!mail || !pw) { showError(EMPTY); return; }

    setBusy(true);
    clearError();
    const started = Date.now();

    let ok = false;
    let passwordOnly = false;
    try {
      if (!sb) throw new Error('x');
      const { data, error } = await sb.auth.signInWithPassword({ email: mail, password: pw });
      if (error || !data || !data.user) {
        passwordOnly = true;
      } else if (await isMaster(data.user.id)) {
        ok = true;
      }
    } catch { passwordOnly = true; }

    if (ok) { location.replace('/app.html'); return; } // page is leaving, stay busy

    try { if (sb) await sb.auth.signOut(); } catch { /* ignore */ }
    await floor(started);
    setBusy(false);
    showError(REFUSED);
    pass.value = '';
    if (passwordOnly) { pass.focus(); } else { email.value = ''; email.focus(); }
  });
}
