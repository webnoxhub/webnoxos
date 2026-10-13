import { esc, icon, toast } from '/js/ui.js';
import { isEmail, EMAIL_MSG } from '/js/validate.js';
import { openModal, api, fieldError, linkRow, bindCopy } from '/js/modal.js';
import { bindCombo } from '/js/combo.js';
import { DEPARTMENTS, DESIGNATIONS } from '/js/lists.js';

const ROLE_LABEL = { sales_rep: 'Sales Representative', lead_gen: 'Lead Generation', cold_caller: 'Cold Caller', finance: 'Finance', project_manager: 'Project Manager', project_agent: 'Project Agent' };
const TYPE_LABEL = { admin: 'Admin', manager: 'Manager', member: 'Member' };
const ROLE_COLOR = { sales_rep: '#2563eb', lead_gen: '#0891b2', cold_caller: '#ea580c', finance: '#16a34a', project_manager: '#d97706', project_agent: '#64748b' };
const ROLE_DESC = {
  sales_rep: 'Client conversations, proposals and closing deals',
  lead_gen: 'Finding and qualifying new prospects',
  cold_caller: 'Calling prospects and booking meetings',
  finance: 'Invoices, payments and financial records',
  project_manager: 'Running delivery for the clients assigned to them',
  project_agent: 'Hands-on project work, assigned by department',
};

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

const reportsTo = (p, all) => {
  const b = p.reports_to && all.find((x) => x.id === p.reports_to);
  return b ? '<span class="muted small">Reports to ' + esc(b.name || '') + '</span>' : '';
};

// ── Read-only directory for plain members (no emails, no phones) ────────────
function paintDirectory(el, rows) {
  el.innerHTML = '<div class="page-head"><h2 class="page-title">Team</h2></div>' +
    '<div class="table-wrap"><table class="wtable"><thead><tr><th>Name</th><th>Type</th><th>Department</th><th>Roles</th><th>Status</th></tr></thead><tbody>' +
    rows.map((p) => '<tr><td data-l="Name" class="c-name"><strong>' + esc(p.name || '—') + '</strong><span class="muted small">' + esc(p.job_title || '') + '</span></td>' +
      '<td data-l="Type">' + esc(TYPE_LABEL[p.account_type] || '') + '</td><td data-l="Department">' + esc(p.department || '—') + reportsTo(p, rows) + '</td>' +
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
      '<td data-l="Department">' + esc(p.department || '—') + reportsTo(p, people) + '</td>' +
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
  let accType = person ? person.account_type : 'member';
  const cards = [
    ...(canType ? [{ key: 'manager', label: 'Manager', color: '#8b5cf6', desc: 'Coordinating the team and keeping work on track', on: accType === 'manager' }] : []),
    ...d.roles.map((r) => ({ key: r, label: ROLE_LABEL[r], color: ROLE_COLOR[r] || '#64748b', desc: ROLE_DESC[r] || '', on: sel.has(r) })),
  ];

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
        '<div class="combo"><input class="wf-input" id="tDept" autocomplete="off" maxlength="60" placeholder="Select or type" value="' + esc(person ? person.department || '' : '') + '"><span class="combo-chev"></span></div></div>' +
      '<div class="wf-group"><label class="wf-label" for="tDesig">Designation</label>' +
        '<div class="combo"><input class="wf-input" id="tDesig" autocomplete="off" maxlength="60" placeholder="Select or type" value="' + esc(person ? person.job_title || '' : '') + '"><span class="combo-chev"></span></div></div></div>' +
      '<div class="wf-group"><label class="wf-label">Roles</label>' +
        '<p class="wf-hint role-intro">Optional. Leave empty for designers, developers, editors and other project agents. They get My tasks, the timer and the projects they are added to. Each role adds its own tab.' +
        (canType ? ' Manager gives full access like the admin (except Settings and Permissions).' : '') + '</p>' +
        (cards.length ? '<div class="role-cards">' + cards.map((c) =>
          '<button class="role-card' + (c.on ? ' is-checked' : '') + '" type="button" data-r="' + c.key + '" role="checkbox" aria-checked="' + c.on + '">' +
            '<span class="rc-box"></span><span class="rc-text"><span class="rc-name"><i class="rc-dot" style="background:' + c.color + '"></i>' + esc(c.label) + '</span>' +
            '<span class="rc-desc">' + esc(c.desc) + '</span></span></button>').join('') + '</div>'
          : '<p class="wf-hint">No extra roles are switched on for this workspace.</p>') + '</div>' +
      '<div class="wf-group" id="tBossGroup" hidden><label class="wf-label" for="tBoss">Reports to</label>' +
        '<select class="wf-select" id="tBoss"></select>' +
        '<p class="wf-hint">Managers of the chosen department are listed first.</p></div>' +
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
  m.body.querySelectorAll('.role-card').forEach((b) => b.addEventListener('click', () => {
    const r = b.dataset.r, on = !b.classList.contains('is-checked');
    if (r === 'manager') accType = on ? 'manager' : 'member'; else on ? sel.add(r) : sel.delete(r);
    b.classList.toggle('is-checked', on); b.setAttribute('aria-checked', on);
  }));
  bindCombo($('tDept'), DEPARTMENTS); bindCombo($('tDesig'), DESIGNATIONS);

  // "Reports to": shown for Project Agents (members only). Managers of the picked department come first.
  let boss = person ? person.reports_to || '' : '', bossTouched = !!boss;
  const bossSel = $('tBoss');
  const same = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const bossLabel = (x) => esc(x.name || 'Unnamed') + ' (' + (x.account_type === 'admin' ? 'Admin' : (x.department ? x.department + ' manager' : 'Manager')) + ')';
  function paintBoss() {
    const dept = $('tDept').value.trim();
    const list = (d.managers || []).filter((x) => !person || x.id !== person.id);
    const mine = list.filter((x) => x.account_type === 'manager' && same(x.department, dept));
    const rest = list.filter((x) => !mine.includes(x));
    if (!boss && !bossTouched && mine.length) boss = mine[0].id;
    const o = (x) => '<option value="' + esc(x.id) + '"' + (x.id === boss ? ' selected' : '') + '>' + bossLabel(x) + '</option>';
    bossSel.innerHTML = '<option value="">Not set</option>' +
      (mine.length ? '<optgroup label="' + esc(dept) + ' department">' + mine.map(o).join('') + '</optgroup>' : '') +
      (rest.length ? '<optgroup label="' + (mine.length ? 'Other managers' : 'Managers and admin') + '">' + rest.map(o).join('') + '</optgroup>' : '');
  }
  const showBoss = () => {
    const agent = sel.has('project_agent') && accType !== 'manager';
    $('tBossGroup').hidden = !agent; if (agent) paintBoss();
  };
  bossSel.addEventListener('change', () => { boss = bossSel.value; bossTouched = true; });
  $('tDept').addEventListener('input', () => { if (!$('tBossGroup').hidden) { if (!bossTouched) boss = ''; paintBoss(); } });
  m.body.querySelectorAll('.role-card').forEach((b) => b.addEventListener('click', showBoss));
  showBoss();
  if ($('tCancel')) $('tCancel').addEventListener('click', m.close);

  const payload = () => ({
    name: $('tName').value.trim(), phone: $('tPhone').value.trim(), joining_date: $('tJoin').value,
    department: $('tDept').value.trim(), designation: $('tDesig').value.trim(), roles: [...sel],
    ...(canType ? { account_type: accType } : {}),
    ...(sel.has('project_agent') && accType !== 'manager' ? { reports_to: boss || null } : (editing ? { reports_to: null } : {})),
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
