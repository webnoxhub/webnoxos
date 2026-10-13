import { esc, icon, toast } from '/js/ui.js';
import { isEmail, EMAIL_MSG } from '/js/validate.js';
import { openModal, api, fieldError, linkRow, bindCopy } from '/js/modal.js';

const ROLE_LABEL = { sales_rep: 'Sales Rep', lead_gen: 'Lead Gen', cold_caller: 'Cold Caller', finance: 'Finance', project_manager: 'Project Manager' };
const TYPE_LABEL = { admin: 'Admin', manager: 'Manager', member: 'Member' };
const DEPARTMENTS = ['Sales', 'Marketing', 'Design', 'Development', 'Finance', 'Operations', 'Support'];
const DESIGNATIONS = ['Sales Representative', 'Lead Generation Executive', 'Cold Caller', 'Accountant', 'Project Manager', 'Designer', 'Developer', 'Team Lead'];

export default async function render({ el, sb, profile, setTitle }) {
  setTitle('Team');
  const canManage = profile.account_type === 'admin' || profile.account_type === 'manager';
  el.innerHTML = '<p class="muted pad">Loading…</p>';
  try {
    if (canManage) {
      const d = await api(sb, '/api/team/members');
      return paintManager(el, sb, d, () => render({ el, sb, profile, setTitle }));
    }
    const { data, error } = await sb.rpc('team_directory');
    if (error) throw error;
    paintDirectory(el, data || []);
  } catch (e) {
    el.innerHTML = '<div class="empty"><p>Could not load the team.</p><button class="btn" id="retry" type="button">Try again</button></div>';
    el.querySelector('#retry').addEventListener('click', () => render({ el, sb, profile, setTitle }));
  }
}

const statusChip = (p) => p.status === 'inactive'
  ? '<span class="chip chip-muted">Inactive</span>'
  : p.pending ? '<span class="chip chip-warn">Invite pending</span>' : '<span class="chip chip-ok">Active</span>';
const roleChips = (roles) => (roles || []).map((r) => '<span class="chip chip-accent">' + esc(ROLE_LABEL[r] || r) + '</span>').join(' ');

// ── Read-only directory for plain members (no emails, no phones) ────────────
function paintDirectory(el, rows) {
  el.innerHTML = '<div class="page-head"><h2 class="page-title">Team</h2></div>' +
    '<div class="table-wrap"><table class="wtable"><thead><tr><th>Name</th><th>Type</th><th>Department</th><th>Roles</th><th>Status</th></tr></thead><tbody>' +
    rows.map((p) => '<tr><td data-l="Name" class="c-name"><strong>' + esc(p.name || '—') + '</strong><span class="muted small">' + esc(p.job_title || '') + '</span></td>' +
      '<td data-l="Type">' + esc(TYPE_LABEL[p.account_type] || '') + '</td><td data-l="Department">' + esc(p.department || '—') + '</td>' +
      '<td data-l="Roles">' + (roleChips(p.roles) || '—') + '</td>' +
      '<td data-l="Status">' + (p.status === 'inactive' ? '<span class="chip chip-muted">Inactive</span>' : '<span class="chip chip-ok">Active</span>') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

// ── Admin / Manager view ─────────────────────────────────────────────────────
function paintManager(el, sb, d, reload) {
  const people = d.people;
  let filter = 'all', q = '';
  el.innerHTML =
    '<div class="page-head"><h2 class="page-title">Team</h2>' +
      '<button class="btn" id="addMember" type="button">' + icon('plus', 16) + ' Add team member</button></div>' +
    '<div class="toolbar"><div class="chips" role="group" aria-label="Filter">' +
      [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive']].map(([k, l]) =>
        '<button class="fchip" type="button" data-f="' + k + '" aria-pressed="' + (k === 'all') + '">' + l + '</button>').join('') + '</div>' +
      '<label class="search">' + icon('search', 16) + '<input id="q" type="search" placeholder="Search team" aria-label="Search team" autocomplete="off"></label></div>' +
    '<div class="table-wrap"><table class="wtable"><thead><tr><th>Name</th><th>Type</th><th>Department</th><th>Roles</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>' +
    '<div class="empty" id="none" hidden><p>No one matches.</p></div>';

  const rows = el.querySelector('#rows'), none = el.querySelector('#none');
  function paint() {
    const shown = people.filter((p) => (filter === 'all' || p.status === filter) &&
      (!q || ((p.name || '') + ' ' + (p.email || '') + ' ' + (p.job_title || '')).toLowerCase().includes(q)));
    rows.innerHTML = shown.map((p) =>
      '<tr><td data-l="Name" class="c-name"><strong>' + esc(p.name || '—') + '</strong><span class="muted small">' + esc(p.email || '') + '</span></td>' +
      '<td data-l="Type">' + esc(TYPE_LABEL[p.account_type]) + '<span class="muted small">' + esc(p.job_title || '') + '</span></td>' +
      '<td data-l="Department">' + esc(p.department || '—') + '</td>' +
      '<td data-l="Roles">' + (roleChips(p.roles) || '—') + '</td>' +
      '<td data-l="Status">' + statusChip(p) + '</td>' +
      '<td data-l="">' + (p.manageable ? '<button class="btn btn-sm btn-ghost" type="button" data-edit="' + esc(p.id) + '">Open</button>' : '') + '</td></tr>').join('');
    rows.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () =>
      openMemberModal({ sb, d, person: people.find((x) => x.id === b.dataset.edit), onDone: reload })));
    none.hidden = shown.length > 0;
    el.querySelector('.table-wrap').hidden = shown.length === 0;
  }
  el.querySelectorAll('.fchip').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    el.querySelectorAll('.fchip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paint();
  }));
  el.querySelector('#q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); paint(); });
  el.querySelector('#addMember').addEventListener('click', () => openMemberModal({ sb, d, person: null, onDone: reload }));
  paint();
}

// ── Add / edit modal ──────────────────────────────────────────────────────────
function openMemberModal({ sb, d, person, onDone }) {
  const editing = !!person;
  const isSelf = editing && person.id === d.me.id;
  const canType = d.me.account_type === 'admin' && !isSelf && (!editing || person.account_type !== 'admin');
  const sel = new Set(person ? person.roles || [] : []);
  const opt = (arr) => arr.map((x) => '<option value="' + esc(x) + '">').join('');

  const m = openModal({
    title: editing ? (person.name || 'Team member') : 'Add team member', wide: true,
    body:
      '<div class="wf-group"><label class="wf-label" for="tName">Full name <span class="req">*</span></label>' +
        '<input class="wf-input" id="tName" maxlength="80" value="' + esc(person ? person.name : '') + '"></div>' +
      '<div class="wf-group"><label class="wf-label" for="tEmail">Email' + (editing ? '' : ' <span class="req">*</span>') + '</label>' +
        '<input class="wf-input" id="tEmail" type="email" autocomplete="off" spellcheck="false" ' + (editing ? 'readonly' : '') +
        ' value="' + esc(person ? person.email : '') + '"></div>' +
      '<div class="wf-row"><div class="wf-group"><label class="wf-label" for="tPhone">Phone</label>' +
        '<input class="wf-input" id="tPhone" inputmode="tel" value="' + esc(person ? person.phone || '' : '') + '"></div>' +
      '<div class="wf-group"><label class="wf-label" for="tJoin">Joining date</label>' +
        '<input class="wf-input" id="tJoin" type="date" value="' + esc(person ? person.joining_date || '' : '') + '"></div></div>' +
      '<div class="wf-row"><div class="wf-group"><label class="wf-label" for="tDept">Department</label>' +
        '<input class="wf-input" id="tDept" list="dl-dept" maxlength="60" value="' + esc(person ? person.department || '' : '') + '"><datalist id="dl-dept">' + opt(DEPARTMENTS) + '</datalist></div>' +
      '<div class="wf-group"><label class="wf-label" for="tDesig">Designation</label>' +
        '<input class="wf-input" id="tDesig" list="dl-desig" maxlength="60" value="' + esc(person ? person.job_title || '' : '') + '"><datalist id="dl-desig">' + opt(DESIGNATIONS) + '</datalist></div></div>' +
      (canType ? '<div class="wf-group"><label class="wf-label" for="tType">Access level</label><select class="wf-select" id="tType">' +
        '<option value="member"' + (person && person.account_type === 'member' || !person ? ' selected' : '') + '>Member</option>' +
        '<option value="manager"' + (person && person.account_type === 'manager' ? ' selected' : '') + '>Manager</option></select></div>' : '') +
      '<div class="wf-group"><label class="wf-label">Roles</label>' +
        (d.roles.length ? '<div class="role-toggles">' + d.roles.map((r) =>
          '<button class="role-toggle' + (sel.has(r) ? ' is-checked' : '') + '" type="button" data-r="' + r + '">' + esc(ROLE_LABEL[r]) + '</button>').join('') + '</div>'
          : '<p class="wf-hint">No extra roles are switched on for this workspace.</p>') + '</div>' +
      (editing ? '<div id="tLinkBox"></div>' : '') +
      '<p class="wf-err" id="tErr" hidden></p>',
    foot: editing
      ? '<span class="foot-left">' +
          '<button class="btn btn-sm btn-ghost" id="tRegen" type="button">Regenerate link</button>' +
          (!isSelf ? '<button class="btn btn-sm btn-ghost" id="tToggle" type="button">' + (person.status === 'active' ? 'Deactivate' : 'Activate') + '</button>' : '') +
        '</span><button class="btn" id="tSave" type="button">Save changes</button>'
      : '<button class="btn btn-ghost" id="tCancel" type="button">Cancel</button><button class="btn" id="tSave" type="button">Add and get link</button>',
  });

  const $ = (id) => m.overlay.querySelector('#' + id);
  const err = $('tErr'), showErr = (t) => { err.textContent = t; err.hidden = !t; };
  m.body.querySelectorAll('.role-toggle').forEach((b) => b.addEventListener('click', () => {
    const r = b.dataset.r; sel.has(r) ? sel.delete(r) : sel.add(r); b.classList.toggle('is-checked', sel.has(r));
  }));
  if ($('tCancel')) $('tCancel').addEventListener('click', m.close);

  const payload = () => ({
    name: $('tName').value.trim(), phone: $('tPhone').value.trim(), joining_date: $('tJoin').value,
    department: $('tDept').value.trim(), designation: $('tDesig').value.trim(), roles: [...sel],
    ...($('tType') ? { account_type: $('tType').value } : {}),
  });

  $('tSave').addEventListener('click', async (e) => {
    const body = payload();
    if (!body.name) return fieldError($('tName'), 'Name is required.');
    if (!editing) {
      body.email = $('tEmail').value.trim();
      if (!isEmail(body.email)) return fieldError($('tEmail'), body.email ? EMAIL_MSG : 'Email is required.');
    }
    e.target.disabled = true; showErr('');
    try {
      if (editing) {
        await api(sb, '/api/team/members?id=' + encodeURIComponent(person.id), { method: 'PATCH', body: JSON.stringify(body) });
        m.close(); toast('Saved'); onDone();
      } else {
        const r = await api(sb, '/api/team/members', { method: 'POST', body: JSON.stringify(body) });
        m.setTitle('Member added');
        m.body.innerHTML = '<div class="result-block"><p class="result-ws-name">' + esc(body.name) + '</p><p class="muted small">' + esc(body.email) + '</p></div>' +
          linkRow('Set-password link (valid ' + r.expires + ')', r.link, 'Set your password: ') +
          '<p class="wf-hint">Send this link to ' + esc(body.name) + '. If it expires, open the person from the Team page and press Regenerate link.</p>';
        bindCopy(m.body);
        m.foot.innerHTML = '<span></span><button class="btn" id="tDone" type="button">Done</button>';
        m.foot.querySelector('#tDone').addEventListener('click', () => { m.close(); onDone(); });
      }
    } catch (x) { showErr(x.message); e.target.disabled = false; }
  });

  if (editing) {
    $('tRegen').addEventListener('click', async (e) => {
      e.target.disabled = true; showErr('');
      try {
        const r = await api(sb, '/api/team/members?id=' + encodeURIComponent(person.id) + '&action=link', { method: 'POST', body: '{}' });
        const box = $('tLinkBox');
        box.innerHTML = linkRow('New link (valid ' + r.expires + ')', r.link, 'Set your password: ') +
          '<button class="btn btn-sm btn-ghost" type="button" data-mail>Email it</button><span class="muted small" data-note></span>';
        bindCopy(box);
        box.querySelector('[data-mail]').addEventListener('click', async (ev) => {
          ev.target.disabled = true;
          try {
            const mm = await api(sb, '/api/team/members?id=' + encodeURIComponent(person.id) + '&action=link', { method: 'POST', body: JSON.stringify({ send: true }) });
            box.querySelector('[data-note]').textContent = mm.emailed ? ' Email sent.' : ' Email could not be sent. Use Copy or WhatsApp.';
          } catch (x) { box.querySelector('[data-note]').textContent = ' ' + x.message; }
        });
      } catch (x) { showErr(x.message); }
      e.target.disabled = false;
    });
    if ($('tToggle')) $('tToggle').addEventListener('click', async (e) => {
      const next = person.status === 'active' ? 'inactive' : 'active';
      if (next === 'inactive' && !confirm('Deactivate ' + (person.name || 'this person') + '? They will not be able to sign in.')) return;
      e.target.disabled = true; showErr('');
      try {
        await api(sb, '/api/team/members?id=' + encodeURIComponent(person.id), { method: 'PATCH', body: JSON.stringify({ status: next }) });
        m.close(); toast(next === 'active' ? 'Activated' : 'Deactivated'); onDone();
      } catch (x) { showErr(x.message); e.target.disabled = false; }
    });
  }
}
