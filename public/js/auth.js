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

// ---------------------------------------------------------------------------
// First-time password (invite link) and reset-link page.
// ---------------------------------------------------------------------------
export async function initSetPassword() {
  const form = document.getElementById('spForm');
  const pass = document.getElementById('spPass');
  const pass2 = document.getElementById('spPass2');
  const errorEl = document.getElementById('spError');
  const okEl = document.getElementById('spOk');
  const waitEl = document.getElementById('spWait');
  const submit = document.getElementById('spSubmit');
  const eye = document.getElementById('spEye');

  const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearError = () => { errorEl.textContent = ''; errorEl.hidden = true; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  eye.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    pass2.type = pass.type;
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  let sb;
  try { sb = await getClient(); } catch { sb = null; }

  // The link carries a one-time token; the client turns it into a session.
  let session = null;
  if (sb) {
    for (let i = 0; i < 10 && !session; i++) {
      try { const { data } = await sb.auth.getSession(); session = data && data.session; } catch { /* retry */ }
      if (!session) await sleep(300);
    }
  }
  waitEl.hidden = true;
  if (!session) {
    showError('This link has expired or was already used. Ask for a new one.');
    return;
  }
  history.replaceState(null, '', location.pathname); // remove the token from the address bar
  form.hidden = false;
  pass.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    clearError();
    const a = pass.value, b = pass2.value;
    if (a.length < 10) { showError('Use at least 10 characters.'); return; }
    if (!/[A-Za-z]/.test(a) || !/[0-9]/.test(a)) { showError('Use letters and at least one number.'); return; }
    if (a !== b) { showError('The two passwords do not match.'); return; }

    submit.disabled = true; submit.classList.add('is-busy'); pass.disabled = true; pass2.disabled = true;
    let saved = false;
    try {
      const { error } = await sb.auth.updateUser({ password: a });
      saved = !error;
    } catch { saved = false; }

    if (saved) {
      try { await sb.auth.signOut(); } catch { /* ignore */ }
      form.hidden = true;
      okEl.hidden = false;
      return;
    }
    submit.disabled = false; submit.classList.remove('is-busy'); pass.disabled = false; pass2.disabled = false;
    showError('Could not save that password. Try a different one.');
  });
}
