// Avatar-menu pages for every signed-in person: My profile (read-only) and Change password.
import { openModal } from '/js/modal.js';
import { esc } from '/js/ui.js';

const ROLE_LABEL = { sales_rep: 'Sales Rep', lead_gen: 'Lead Gen', cold_caller: 'Cold Caller', finance: 'Finance', project_manager: 'Project Manager', project_agent: 'Project Agent' };
const TYPE_LABEL = { admin: 'Admin', manager: 'Manager', member: 'Member' };
const row = (k, v) => '<div class="pf-row"><span class="pf-k">' + esc(k) + '</span><span class="pf-v">' + (v ? esc(v) : '—') + '</span></div>';

export async function openProfile(sb, prof, wsName) {
  const m = openModal({ title: 'My profile', body: '<p class="muted">Loading…</p>', foot: '<button class="btn btn-ghost" id="pfClose" type="button">Close</button>' });
  m.overlay.querySelector('#pfClose').addEventListener('click', m.close);
  const { data: p } = await sb.from('profiles').select('name,email,phone,department,job_title,roles,joining_date,account_type').eq('id', prof.id).maybeSingle();
  const d = p || prof;
  const roles = (d.roles || []).map((r) => ROLE_LABEL[r] || r).join(', ');
  m.body.innerHTML =
    '<div class="pf-head"><span class="avatar pf-av">' + esc(((d.name || d.email || '?').slice(0, 2)).toUpperCase()) + '</span>' +
    '<div><p class="pf-name">' + esc(d.name || '') + '</p><p class="muted">' + esc(TYPE_LABEL[d.account_type] || 'Member') + (wsName ? ' of ' + esc(wsName) : '') + '</p></div></div>' +
    row('Email', d.email) + row('Phone', d.phone) + row('Department', d.department) + row('Designation', d.job_title) +
    row('Roles', roles) + row('Joined', d.joining_date);
}

export function openPassword(sb) {
  const m = openModal({
    title: 'Change password',
    body: '<div class="wf-group"><label class="wf-label" for="cpA">New password</label><input class="wf-input" id="cpA" type="password" autocomplete="new-password"></div>' +
      '<div class="wf-group"><label class="wf-label" for="cpB">Confirm password</label><input class="wf-input" id="cpB" type="password" autocomplete="new-password"></div>' +
      '<p class="wf-hint">At least 10 characters, with letters and a number.</p><p class="wf-err" id="cpErr" hidden></p>',
    foot: '<button class="btn btn-ghost" id="cpCancel" type="button">Cancel</button><button class="btn" id="cpSave" type="button">Save password</button>',
  });
  const $ = (i) => m.overlay.querySelector('#' + i);
  const err = (t) => { $('cpErr').textContent = t; $('cpErr').hidden = !t; };
  $('cpCancel').addEventListener('click', m.close);
  $('cpSave').addEventListener('click', async (e) => {
    const a = $('cpA').value, b = $('cpB').value;
    if (a.length < 10) return err('Use at least 10 characters.');
    if (!/[A-Za-z]/.test(a) || !/[0-9]/.test(a)) return err('Use letters and at least one number.');
    if (a !== b) return err('The two passwords do not match.');
    e.target.disabled = true; err('');
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) { err('Could not change the password. Try again.'); e.target.disabled = false; return; }
    m.body.innerHTML = '<p style="font-weight:600;color:#15803D">Password changed.</p>'; m.foot.innerHTML = '<button class="btn" id="cpDone" type="button">Done</button>';
    m.overlay.querySelector('#cpDone').addEventListener('click', m.close);
  });
  setTimeout(() => $('cpA').focus(), 0);
}
