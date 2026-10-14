import { applyBrand } from '/js/brand.js';
import { getClient } from '/js/supabase.js';
import { isEmail, EMAIL_MSG } from '/js/validate.js';

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
    if (!isEmail(mail)) { showError(EMAIL_MSG); email.focus(); return; } // format only, before any network call

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

  // Whose workspace is this? Show its name on the left panel.
  let slug = '';
  try {
    const { data: me } = await sb.from('profiles').select('is_master,workspace_id').eq('id', session.user.id).maybeSingle();
    if (me && !me.is_master && me.workspace_id) {
      const { data: w } = await sb.from('workspaces').select('name,slug,logo_url').eq('id', me.workspace_id).maybeSingle();
      if (w) {
        applyBrand(w.name, w.logo_url);
        document.getElementById('spTier').textContent = 'Welcome aboard';
        document.getElementById('spSub').textContent = 'Create a password to get started.';
        document.title = 'Set your password · ' + w.name;
        slug = w.slug || '';
      }
    }
  } catch { /* the form still works without the name */ }
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
      if (slug) { const go = document.getElementById('spGo'); go.addEventListener('click', () => { location.href = '/login.html?w=' + encodeURIComponent(slug); }); go.hidden = false; }
      return;
    }
    submit.disabled = false; submit.classList.remove('is-busy'); pass.disabled = false; pass2.disabled = false;
    showError('Could not save that password. Try a different one.');
  });
}

// ---------------------------------------------------------------------------
// Business sign-in. A Master account is refused here with the same sentence
// the Master page uses, so neither page hints the other exists.
// ---------------------------------------------------------------------------
const MESSAGES = {
  noprofile: 'Ask your admin to add you.',
  inactive: 'Your account is not active.',
  closed: 'This workspace is closed.',
};

export async function initBusinessLogin() {
  const form = document.getElementById('blForm');
  const email = document.getElementById('blEmail');
  const pass = document.getElementById('blPass');
  const errorEl = document.getElementById('blError');
  const noteEl = document.getElementById('blNote');
  const submit = document.getElementById('blSubmit');
  const eye = document.getElementById('blEye');
  const forgot = document.getElementById('blForgot');
  const forgotText = document.getElementById('blForgotText');

  // ?w=<slug> shows the business name. The server answers {} for anything that is not a live workspace.
  const wslug = (new URLSearchParams(location.search).get('w') || '').toLowerCase();
  if (/^[a-z0-9-]{1,40}$/.test(wslug)) {
    fetch('/api/public/workspace-brand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: wslug }) })
      .then((r) => r.json()).then((b) => {
        if (b && b.name) { const t = document.getElementById('blTitle'); t.textContent = 'Sign in to ' + b.name; document.title = 'Sign in · ' + b.name; applyBrand(b.name, b.logo_url); }
      }).catch(() => { /* plain sign-in page */ });
  }

  const code = new URLSearchParams(location.search).get('m');
  if (code && MESSAGES[code]) { noteEl.textContent = MESSAGES[code]; noteEl.hidden = false; }

  const setBusy = (on) => { submit.disabled = on; submit.classList.toggle('is-busy', on); email.disabled = on; pass.disabled = on; };
  const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false; };
  const clearError = () => { errorEl.textContent = ''; errorEl.hidden = true; };

  eye.addEventListener('click', () => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
  forgot.addEventListener('click', () => {
    forgotText.hidden = !forgotText.hidden;
    forgot.setAttribute('aria-expanded', String(!forgotText.hidden));
  });

  let sb;
  try { sb = await getClient(); } catch { sb = null; }

  // Already signed in as a business member: go straight to the app. A Master session is cleared.
  if (sb && !code) {
    try {
      const { data } = await sb.auth.getSession();
      const user = data && data.session && data.session.user;
      if (user) {
        const { data: p } = await sb.from('profiles').select('is_master').eq('id', user.id).maybeSingle();
        if (p && p.is_master === false) { location.replace('/app.html'); return; }
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
    if (!isEmail(mail)) { showError(EMAIL_MSG); email.focus(); return; } // format only, before any network call

    setBusy(true); clearError(); noteEl.hidden = true;
    const started = Date.now();
    let ok = false;
    try {
      if (!sb) throw new Error('x');
      const { data, error } = await sb.auth.signInWithPassword({ email: mail, password: pw });
      if (!error && data && data.user) {
        const { data: p } = await sb.from('profiles').select('is_master').eq('id', data.user.id).maybeSingle();
        ok = !!p && p.is_master === false;
      }
    } catch { ok = false; }

    if (ok) { location.replace('/app.html'); return; }

    try { if (sb) await sb.auth.signOut(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, Math.max(0, FLOOR_MS - (Date.now() - started))));
    setBusy(false);
    showError(REFUSED);
    pass.value = '';
    pass.focus();
  });
}
