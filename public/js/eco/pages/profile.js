// Member profile (and the "Your profile" block reused in admin Settings)
import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { api } from '../data.js';
import { esc, icon, avatar, fullName, roleChip, toast, busy } from '../ui.js';
import { fmtDate } from '../time.js';

export async function render({ el }) {
  const p = state.profile;
  el.innerHTML = `
    <div class="page-head"><div><h1>Profile</h1><p>Your details, roles and password.</p></div></div>
    <div class="grid-3-1">
      <div class="stack">
        <section class="panel"><div class="panel-head"><h2>Personal details</h2></div><div class="panel-body" id="pf"></div></section>
        <section class="panel"><div class="panel-head"><h2>Password</h2></div><div class="panel-body" id="pw"></div></section>
      </div>
      <div class="stack">
        <section class="panel"><div class="panel-body">
          <div class="row" style="gap:14px;margin-bottom:16px">${avatar(p, 'lg')}<div><div style="font-weight:600;font-size:15px">${esc(fullName(p))}</div><div class="small muted">${esc(p.email)}</div></div></div>
          <dl class="kv" style="grid-template-columns:110px 1fr">
            <dt>Employee ID</dt><dd class="num">${esc(p.employee_code)}</dd>
            <dt>Job title</dt><dd>${esc(p.job_title || '—')}</dd>
            <dt>Department</dt><dd>${esc(p.department || '—')}</dd>
            <dt>Joined</dt><dd>${esc(fmtDate(p.joined_on))}</dd>
          </dl>
          <div class="section-title" style="margin-top:18px">My roles</div>
          <div class="chips">${state.myRoles.map((r) => roleChip(r, state.roles)).join('') || '<span class="muted small">No roles yet</span>'}</div>
          <p class="small muted" style="margin-top:12px">The admin manages your roles, job title and department.</p>
        </div></section>
        <section class="panel"><div class="panel-body">
          <div class="section-title" style="justify-content:flex-start">${icon('shield', 14)} How tracking works</div>
          <p class="small" style="color:var(--ink-2);line-height:1.6">Webnox OS records when you sign in and out, whether you're active or idle in this tab (idle after ${state.settings.idle_minutes} minutes without a click, key press or scroll), and the time you log with task timers. It does not record what you type, take screenshots, or see other apps. Your records are under <a href="#/my-activity">My activity</a> and <a href="#/my-time">My work time</a>.</p>
        </div></section>
      </div>
    </div>`;
  mountProfileForm(el.querySelector('#pf'));
  mountPasswordForm(el.querySelector('#pw'));
}

// Centre-crop to a 192px square JPEG so the picture stays small.
function squarePic(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height), c = document.createElement('canvas'); c.width = c.height = 192;
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 192, 192);
      URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image.')); };
    img.src = url;
  });
}

export function mountProfileForm(box) {
  const p = state.profile;
  box.innerHTML = `
    <form class="form-grid" novalidate>
      <div class="field span-2"><label>Profile picture</label>
        <div class="row" style="gap:14px"><span id="pf-pic">${avatar(p, 'lg')}</span>
          <button class="btn btn-sm" type="button" id="pf-pick">Change picture</button>
          ${p.avatar_url ? '<button class="btn btn-sm btn-ghost" type="button" id="pf-clear">Remove</button>' : ''}
          <input type="file" id="pf-file" accept="image/png,image/jpeg,image/webp" hidden></div>
        <span class="hint">A square photo works best. It shows in the sidebar, on tasks and in the team list.</span></div>
      <div class="field"><label for="pf-name">Full name</label><input id="pf-name" class="input" value="${esc(p.name || '')}" maxlength="80"></div>
      <div class="field"><label for="pf-email">Email</label><input id="pf-email" class="input" value="${esc(p.email)}" disabled></div>
      <div class="field"><label for="pf-phone">Phone</label><input id="pf-phone" class="input" value="${esc(p.phone || '')}" maxlength="20"></div>
      <div class="span-2"><button class="btn btn-primary" type="submit">Save details</button></div>
    </form>`;
  const savePic = async (avatarData) => {
    try {
      await api('/me', { method: 'POST', body: { avatar: avatarData } });
      state.profile.avatar_url = avatarData;
      document.querySelectorAll('.sidebar-foot .avatar, .pmenu-btn .avatar, .pmenu-head .avatar, #pf-pic .avatar').forEach((n) => {
        const big = n.classList.contains('lg');
        n.outerHTML = avatar(state.profile, big ? 'lg' : '');
      });
      toast(avatarData ? 'Picture saved' : 'Picture removed');
      if (!avatarData) box.querySelector('#pf-clear')?.remove();
      else if (!box.querySelector('#pf-clear')) { const b = document.createElement('button'); b.className = 'btn btn-sm btn-ghost'; b.type = 'button'; b.id = 'pf-clear'; b.textContent = 'Remove'; b.onclick = () => savePic(null); box.querySelector('#pf-pick').after(b); }
    } catch (err) { toast(err.message, 'error'); }
  };
  box.querySelector('#pf-pick').addEventListener('click', () => box.querySelector('#pf-file').click());
  box.querySelector('#pf-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { await savePic(await squarePic(f)); } catch (err) { toast(err.message, 'error'); }
  });
  box.querySelector('#pf-clear')?.addEventListener('click', () => savePic(null));
  const form = box.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = { name: form.querySelector('#pf-name').value.trim(), phone: form.querySelector('#pf-phone').value.trim() };
    if (!body.name) { toast('Name is required', 'error'); return; }
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        const r = await api('/me', { method: 'POST', body });
        const [first, ...rest] = r.name.split(/\s+/);
        Object.assign(state.profile, { name: r.name, phone: r.phone, first_name: first, last_name: rest.join(' ') });
        document.querySelectorAll('.me .name, .ws-brand .brand-name').forEach((n) => { if (n.classList.contains('name')) n.textContent = fullName(state.profile); else n.firstChild.textContent = fullName(state.profile); });
        toast('Details saved');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

export function mountPasswordForm(box) {
  box.innerHTML = `
    <form class="form-grid" novalidate>
      <div class="field"><label for="np1">New password</label><input id="np1" type="password" class="input" autocomplete="new-password" minlength="10"></div>
      <div class="field"><label for="np2">Confirm new password</label><input id="np2" type="password" class="input" autocomplete="new-password" minlength="10"></div>
      <div class="span-2"><button class="btn" type="submit">Change password</button></div>
    </form>`;
  const form = box.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const a = form.querySelector('#np1').value; const b = form.querySelector('#np2').value;
    if (a.length < 10) return toast('Use at least 10 characters', 'error');
    if (!/[A-Za-z]/.test(a) || !/[0-9]/.test(a)) return toast('Use letters and at least one number', 'error');
    if (a !== b) return toast('The passwords don\'t match', 'error');
    busy(form.querySelector('[type=submit]'), async () => {
      const { error } = await supabase.auth.updateUser({ password: a });
      if (error) return toast(error.message, 'error');
      form.reset();
      toast('Password changed');
    });
  });
}
