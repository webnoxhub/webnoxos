// Team: Admin and Managers manage people; everyone else sees a read-only directory.
import { state, roleName } from '../state.js';
import { rpc, api } from '../data.js';
import {
  esc, icon, avatar, memberBadge, roleChip, presenceTag, emptyState, loadingBlock, on,
  openModal, confirmDialog, toast, busy, copyText,
} from '../ui.js';
import { fmtRelative } from '../time.js';
import { DEPARTMENTS, DESIGNATIONS } from '/js/lists.js';

const TYPE_LABEL = { admin: 'Admin', manager: 'Manager', member: 'Member' };
const ROLE_DESC = {
  sales_rep: 'Client conversations, proposals and closing deals',
  lead_gen: 'Finding and qualifying new prospects',
  cold_caller: 'Calling prospects and booking meetings',
  finance: 'Invoices, payments and financial records',
  project_manager: 'Running delivery for the clients assigned to them',
  project_agent: 'Hands-on project work, assigned by department',
};
const rolesOf = (p) => [...(p.roles || []), ...(p.account_type === 'manager' ? ['manager'] : [])];
const isOff = (s) => ['inactive', 'suspended'].includes(s);

export async function render({ el }) {
  const canManage = state.isAdmin;
  el.innerHTML = `<div class="page-head"><div><h1>Team</h1><p>${canManage ? 'Add people, give them roles, and manage their access.' : 'Everyone in your workspace.'}</p></div></div>${loadingBlock(5)}`;
  try {
    if (canManage) {
      const d = await api('/team/members');
      return paintManager(el, d, () => render({ el }));
    }
    const rows = await rpc('team_directory');
    paintDirectory(el, rows || []);
  } catch (e) {
    el.innerHTML = `<div class="empty"><p>Could not load the team. ${esc(e.message || '')}</p><button class="btn" id="retry">Try again</button></div>`;
    el.querySelector('#retry').onclick = () => render({ el });
  }
}

const who = (p, sub, sub2) => `<div class="who">${avatar({ ...p, first_name: (p.name || '?').split(' ')[0], last_name: (p.name || '').split(' ').slice(1).join(' ') })}<div><div class="name">${esc(p.name || '—')}</div><div class="sub">${esc(sub || '')}</div>${sub2 ? `<div class="sub">${esc(sub2)}</div>` : ''}</div></div>`;
const bossOf = (p, all) => { const b = p.reports_to && all.find((x) => x.id === p.reports_to); return b ? `<div class="sub">Reports to ${esc(b.name || '')}</div>` : ''; };
const chips = (p) => `<div class="chips">${rolesOf(p).map((r) => roleChip(r, state.roles)).join('') || '<span class="muted small">No role</span>'}</div>`;

function paintDirectory(el, rows) {
  el.innerHTML = `<div class="page-head"><div><h1>Team</h1><p>Everyone in your workspace.</p></div></div>
    <section class="panel"><div class="table-wrap">${rows.length ? `<table class="table"><thead><tr><th>Member</th><th>Type</th><th>Department</th><th>Roles</th><th>Status</th></tr></thead><tbody>
    ${rows.map((p) => `<tr><td>${who(p, p.job_title)}</td><td>${esc(TYPE_LABEL[p.account_type] || '')}</td><td>${esc(p.department || '—')}${bossOf(p, rows)}</td><td>${chips(p)}</td><td>${memberBadge(p.status === 'inactive' ? 'inactive' : 'active')}</td></tr>`).join('')}
    </tbody></table>` : emptyState('No one here yet')}</div></section>`;
}

function paintManager(el, d, reload) {
  const people = d.people || [];
  let filter = 'all', search = '', roleFilter = 'all', presence = new Map();
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Team</h1><p>Add people, give them roles, and manage their access.</p></div>
      <div class="actions"><button class="btn btn-primary" id="add">${icon('plus', 15)}Add team member</button></div>
    </div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Filter by role" id="roles"></div></div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search by name or email" aria-label="Search team"></div>
      <select class="select" id="status" style="width:auto" aria-label="Status">
        <option value="current">Active and invited</option><option value="all">All statuses</option>
        <option value="active">Active</option><option value="invited">Invited</option><option value="inactive">Inactive</option>
      </select>
    </div>
    <section class="panel"><div class="table-wrap" id="table"></div></section>`;
  const table = el.querySelector('#table');
  const stOf = (p) => (p.status === 'inactive' ? 'inactive' : p.pending ? 'invited' : 'active');
  filter = 'current';

  function paintRoles() {
    const cur = people.filter((p) => stOf(p) !== 'inactive');
    el.querySelector('#roles').innerHTML = `<button data-r="all" aria-pressed="${roleFilter === 'all'}">All<span class="count">${cur.length}</span></button>` +
      state.roles.map((r) => `<button data-r="${esc(r.key)}" aria-pressed="${roleFilter === r.key}">${esc(r.name)}<span class="count">${cur.filter((p) => rolesOf(p).includes(r.key)).length}</span></button>`).join('');
  }
  function paint() {
    const s = search.toLowerCase();
    const list = people.filter((p) => {
      const st = stOf(p);
      if (roleFilter !== 'all' && !rolesOf(p).includes(roleFilter)) return false;
      if (filter === 'current' && st === 'inactive') return false;
      if (!['current', 'all'].includes(filter) && st !== filter) return false;
      return !s || `${p.name || ''} ${p.email || ''}`.toLowerCase().includes(s);
    });
    if (!people.length) { table.innerHTML = emptyState('No team members yet', 'Add someone and share their set-password link.', '<button class="btn btn-primary" data-add>Add team member</button>'); return; }
    if (!list.length) { table.innerHTML = emptyState('No one matches these filters'); return; }
    table.innerHTML = `<table class="table"><thead><tr><th>Member</th><th>Type</th><th>Department</th><th>Roles</th><th>Status</th><th>Presence</th><th></th></tr></thead><tbody>
      ${list.map((p) => {
        const st = stOf(p), pr = presence.get(p.id);
        return `<tr class="${p.manageable ? 'clickable' : ''}" data-id="${esc(p.id)}" ${p.manageable ? 'tabindex="0"' : ''}>
          <td>${who(p, p.job_title || p.email, p.job_title ? p.email : '')}</td>
          <td>${esc(TYPE_LABEL[p.account_type] || '')}</td>
          <td>${esc(p.department || '—')}${bossOf(p, people)}</td>
          <td>${chips(p)}</td>
          <td>${memberBadge(st)}</td>
          <td>${st === 'invited' ? '<span class="muted small">Not joined yet</span>' : st === 'inactive' ? '' : presenceTag(pr?.presence || 'offline', (pr?.presence || 'offline') === 'offline' ? (pr?.last_seen_at ? `Seen ${fmtRelative(pr.last_seen_at)}` : 'Offline') : null)}</td>
          <td class="r">${p.manageable ? `<button class="btn btn-sm" data-open="${esc(p.id)}">Open</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>`;
  }
  const open = (id) => { const p = people.find((x) => x.id === id); if (p && p.manageable) memberForm({ d, person: p, onDone: reload }); };
  el.querySelector('#roles').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { roleFilter = b.dataset.r; paintRoles(); paint(); } });
  el.querySelector('#q').addEventListener('input', (e) => { search = e.target.value.trim(); paint(); });
  el.querySelector('#status').addEventListener('change', (e) => { filter = e.target.value; paint(); });
  el.querySelector('#add').onclick = () => memberForm({ d, person: null, onDone: reload });
  on(table, 'click', '[data-add]', () => memberForm({ d, person: null, onDone: reload }));
  on(table, 'click', 'tr[data-id]', (e, tr) => open(tr.dataset.id));
  on(table, 'keydown', 'tr[data-id]', (e, tr) => { if (e.key === 'Enter') open(tr.dataset.id); });
  paintRoles(); paint();
  rpc('team_presence').then((p) => { presence = new Map((p || []).map((x) => [x.user_id, x])); paint(); }).catch(() => {});
}

function linkBlock(label, link, name) {
  const text = `Set your password: ${link}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  return `<div class="field"><label>${esc(label)}</label>
    <div class="row" style="gap:8px"><input class="input" readonly value="${esc(link)}" data-link style="flex:1">
    <button class="btn" type="button" data-copy>${icon('copy', 14)}Copy</button></div>
    <div class="row" style="gap:8px;margin-top:6px"><a class="btn btn-sm" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>
    <button class="btn btn-sm" type="button" data-mail>Email it</button><span class="muted small" data-note></span></div></div>`;
}

function memberForm({ d, person, onDone }) {
  const editing = !!person;
  const isSelf = editing && person.id === d.me.id;
  const iAmAdmin = d.me.account_type === 'admin';
  const canType = iAmAdmin && !isSelf && (!editing || person.account_type !== 'admin');
  const canDelete = editing && iAmAdmin && !isSelf && person.account_type !== 'admin';
  const sel = new Set(person ? person.roles || [] : []);
  let accType = person ? person.account_type : 'member';
  let boss = person ? person.reports_to || '' : '', bossTouched = !!boss;
  const cards = [
    ...(canType ? [{ key: 'manager', name: 'Manager', desc: 'Coordinating the team and keeping work on track', on: accType === 'manager' }] : []),
    ...(d.roles || []).map((r) => ({ key: r, name: roleName(r), desc: ROLE_DESC[r] || '', on: sel.has(r) })),
  ];

  const m = openModal({
    title: esc(editing ? person.name || 'Team member' : 'Add team member'), wide: true,
    body: `<div class="form-grid" id="mf">
      <div class="field span-2"><label for="tName">Full name</label><input id="tName" class="input" maxlength="80" value="${esc(person?.name || '')}"></div>
      <div class="field"><label for="tEmail">Email</label><input id="tEmail" class="input" type="email" autocomplete="off" spellcheck="false" ${editing ? 'readonly' : ''} value="${esc(person?.email || '')}"></div>
      <div class="field"><label for="tPhone">Phone</label><input id="tPhone" class="input" inputmode="tel" value="${esc(person?.phone || '')}"></div>
      <div class="field"><label for="tDept">Department</label><input id="tDept" class="input" list="dl-dept" maxlength="60" placeholder="Select or type" value="${esc(person?.department || '')}"></div>
      <div class="field"><label for="tDesig">Designation</label><input id="tDesig" class="input" list="dl-desig" maxlength="60" placeholder="Select or type" value="${esc(person?.job_title || '')}"></div>
      <div class="field"><label for="tJoin">Joining date</label><input id="tJoin" class="input" type="date" value="${esc(person?.joining_date || '')}"></div>
      <div class="field span-2"><label>Roles</label>
        <span class="hint">Optional. Leave empty for designers, developers and editors. Each role adds its own tab.${canType ? ' Manager gives full access like the admin (except Settings and Permissions).' : ''}</span>
        <div class="stack" style="gap:8px;margin-top:6px" id="tRoles">${cards.map((c) => `<label class="check"><input type="checkbox" data-r="${esc(c.key)}" ${c.on ? 'checked' : ''}><span><b>${esc(c.name)}</b><br><span class="muted small">${esc(c.desc)}</span></span></label>`).join('') || '<span class="muted small">No extra roles are switched on.</span>'}</div></div>
      <div class="field span-2" id="tBossG" hidden><label for="tBoss">Reports to</label><select id="tBoss" class="select"></select><span class="hint">Managers of the chosen department are listed first.</span></div>
      <div class="span-2" id="tLinkBox"></div>
      <div class="form-error hidden span-2" id="tErr"></div>
      <datalist id="dl-dept">${DEPARTMENTS.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <datalist id="dl-desig">${DESIGNATIONS.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    </div>`,
    foot: editing
      ? `<span style="margin-right:auto;display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-sm" id="tRegen">${icon('refresh', 13)}Regenerate link</button>${!isSelf ? `<button class="btn btn-sm" id="tToggle">${person.status === 'active' ? 'Deactivate' : 'Activate'}</button>` : ''}${canDelete ? '<button class="btn btn-sm btn-danger" id="tDelete">Delete</button>' : ''}</span><button class="btn btn-primary" id="tSave">Save changes</button>`
      : '<button class="btn" id="tCancel">Cancel</button><button class="btn btn-primary" id="tSave">Add and get link</button>',
  });
  const $ = (s) => m.querySelector(s);
  const err = $('#tErr'), showErr = (t) => { err.textContent = t; err.classList.toggle('hidden', !t); };
  const bossSel = $('#tBoss');
  const same = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();
  function paintBoss() {
    const dept = $('#tDept').value.trim();
    const list = (d.managers || []).filter((x) => !person || x.id !== person.id);
    const mine = list.filter((x) => x.account_type === 'manager' && same(x.department, dept));
    const rest = list.filter((x) => !mine.includes(x));
    if (!boss && !bossTouched && mine.length) boss = mine[0].id;
    const lab = (x) => `${esc(x.name || 'Unnamed')} (${x.account_type === 'admin' ? 'Admin' : x.department ? `${esc(x.department)} manager` : 'Manager'})`;
    const o = (x) => `<option value="${esc(x.id)}" ${x.id === boss ? 'selected' : ''}>${lab(x)}</option>`;
    bossSel.innerHTML = '<option value="">Not set</option>' +
      (mine.length ? `<optgroup label="${esc(dept)} department">${mine.map(o).join('')}</optgroup>` : '') +
      (rest.length ? `<optgroup label="${mine.length ? 'Other managers' : 'Managers and admin'}">${rest.map(o).join('')}</optgroup>` : '');
  }
  const showBoss = () => { const a = sel.has('project_agent') && accType !== 'manager'; $('#tBossG').hidden = !a; if (a) paintBoss(); };
  $('#tRoles').addEventListener('change', (e) => {
    const r = e.target.dataset.r; if (!r) return;
    if (r === 'manager') accType = e.target.checked ? 'manager' : 'member';
    else e.target.checked ? sel.add(r) : sel.delete(r);
    showBoss();
  });
  bossSel.addEventListener('change', () => { boss = bossSel.value; bossTouched = true; });
  $('#tDept').addEventListener('input', () => { if (!$('#tBossG').hidden) { if (!bossTouched) boss = ''; paintBoss(); } });
  showBoss();
  const cancel = $('#tCancel'); if (cancel) cancel.onclick = () => m.close();

  const payload = () => ({
    name: $('#tName').value.trim(), phone: $('#tPhone').value.trim(), joining_date: $('#tJoin').value,
    department: $('#tDept').value.trim(), designation: $('#tDesig').value.trim(), roles: [...sel],
    ...(canType ? { account_type: accType } : {}),
    ...(sel.has('project_agent') && accType !== 'manager' ? { reports_to: boss || null } : (editing ? { reports_to: null } : {})),
  });
  const bindLink = (box, id) => {
    box.querySelector('[data-copy]').onclick = async (e) => { await copyText(box.querySelector('[data-link]').value); e.currentTarget.textContent = 'Copied'; };
    box.querySelector('[data-mail]').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api(`/team/members?id=${encodeURIComponent(id)}&action=link`, { method: 'POST', body: { send: true } });
        box.querySelector('[data-note]').textContent = r.emailed ? ' Email sent.' : ' Email could not be sent. Use Copy or WhatsApp.';
      } catch (x) { box.querySelector('[data-note]').textContent = ` ${x.message}`; }
    };
  };

  $('#tSave').onclick = async (e) => {
    const body = payload();
    if (!body.name) return showErr('Name is required.');
    if (!editing) { body.email = $('#tEmail').value.trim(); if (!/^\S+@\S+\.\S+$/.test(body.email)) return showErr(body.email ? 'Enter a valid email address.' : 'Email is required.'); }
    showErr('');
    await busy(e.currentTarget, async () => {
      try {
        if (editing) {
          await api(`/team/members?id=${encodeURIComponent(person.id)}`, { method: 'PATCH', body });
          m.close(); toast('Saved'); onDone();
        } else {
          const r = await api('/team/members', { method: 'POST', body });
          m.querySelector('.modal-body').innerHTML = `<div class="stack"><div><b>${esc(body.name)}</b><div class="muted small">${esc(body.email)}</div></div>
            <div id="tLinkBox">${linkBlock(`Set-password link (valid ${r.expires})`, r.link, body.name)}</div>
            <p class="muted small">Send this link to ${esc(body.name)}. If it expires, open the person and press Regenerate link.</p></div>`;
          bindLink(m.querySelector('#tLinkBox'), r.id || r.user_id || r.person?.id);
          m.querySelector('.modal-foot').innerHTML = '<button class="btn btn-primary" id="tDone">Done</button>';
          m.querySelector('#tDone').onclick = () => { m.close(); onDone(); };
        }
      } catch (x) { showErr(x.message); }
    });
  };

  if (!editing) return;
  $('#tRegen').onclick = (e) => busy(e.currentTarget, async () => {
    showErr('');
    try {
      const r = await api(`/team/members?id=${encodeURIComponent(person.id)}&action=link`, { method: 'POST', body: {} });
      const box = $('#tLinkBox'); box.innerHTML = linkBlock(`New link (valid ${r.expires})`, r.link, person.name); bindLink(box, person.id);
    } catch (x) { showErr(x.message); }
  });
  if ($('#tToggle')) $('#tToggle').onclick = async (e) => {
    const next = person.status === 'active' ? 'inactive' : 'active';
    if (next === 'inactive' && !(await confirmDialog({ title: `Deactivate ${person.name || 'this person'}?`, text: 'They will be signed out and will not be able to sign in. Their running timer is paused.', confirm: 'Deactivate', danger: true }))) return;
    await busy(e.target, async () => {
      try { await api(`/team/members?id=${encodeURIComponent(person.id)}`, { method: 'PATCH', body: { status: next } }); m.close(); toast(next === 'active' ? 'Activated' : 'Deactivated'); onDone(); }
      catch (x) { showErr(x.message); }
    });
  };
  if ($('#tDelete')) $('#tDelete').onclick = () => deleteByName(person, () => { m.close(); onDone(); });
}

function deleteByName(person, done) {
  const nm = person.name || person.email;
  const dm = openModal({
    title: `Delete ${esc(nm)} permanently`,
    body: `<p class="muted">This removes <b>${esc(nm)}</b> from the whole system: their sign-in, comments, requests, place in projects and every line about them in the activity log. This cannot be undone.</p>
      <div class="field" style="margin-top:12px"><label for="dName">Type <b>${esc(nm)}</b> to confirm</label><input id="dName" class="input" autocomplete="off"></div>
      <div class="form-error hidden" id="dErr"></div>`,
    foot: '<button class="btn" id="dNo">Cancel</button><button class="btn btn-danger" id="dYes" disabled>Delete permanently</button>',
  });
  const inp = dm.querySelector('#dName'), yes = dm.querySelector('#dYes');
  inp.addEventListener('input', () => { yes.disabled = inp.value.trim() !== nm; });
  dm.querySelector('#dNo').onclick = () => dm.close();
  yes.onclick = () => busy(yes, async () => {
    try {
      await api(`/team/members?id=${encodeURIComponent(person.id)}&action=delete`, { method: 'POST', body: { confirm: inp.value.trim() } });
      dm.close(); toast('Deleted'); done();
    } catch (x) { const e = dm.querySelector('#dErr'); e.textContent = x.message; e.classList.remove('hidden'); }
  });
}
