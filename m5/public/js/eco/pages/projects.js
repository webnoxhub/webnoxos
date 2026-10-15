// Projects list (cards) + shared project helpers. The project itself opens in the workspace (pages/project.js).
// People come in through staffing requests: the Project Manager asks, the admin / a manager approves,
// declines or discusses, then the Project Manager fills each approved slot with a matching Project Agent.
import { supabase } from '../supabase.js';
import { state, can } from '../state.js';
import { q, rpc, loadDirectory, dirName, dirLabel } from '../data.js';
import { esc, icon, emptyState, loadingBlock, on, openModal, confirmDialog, toast, busy } from '../ui.js';
import { fmtDate, fmtDateTime, fmtRelative, todayStr } from '../time.js';

export const PROJECT_STATUS = { planning: 'Planning', active: 'Active', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
export const FILE_KINDS = { contract: 'Contract', document: 'Document', invoice: 'Invoice PDF', other: 'Other' };
export const REQUEST_STATUS = { pending: 'Waiting for a decision', discussing: 'In discussion', approved: 'Approved', declined: 'Declined' };
export const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
export const projectBadge = (s) => `<span class="badge ${esc(s)}">${esc(PROJECT_STATUS[s] || s)}</span>`;
export const projectInitials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const me = () => state.profile.id;
export const isPMof = (p) => p.project_manager === me();
export const canEditProject = (p) => can('projects', 'edit') || (isPMof(p) && Boolean(state.pmPerms.projects?.edit));
export const canDeleteProject = (p) => can('projects', 'delete') || (isPMof(p) && Boolean(state.pmPerms.projects?.delete));
export const canInvP = (p, a) => can('finance', a) || (isPMof(p) && Boolean(state.pmPerms.finance?.[a]));
export const canFileP = (p, a) => (a === 'view' ? true : a === 'edit' ? can('clients', 'edit') || canEditProject(p) : can('clients', 'delete') || canDeleteProject(p));
export const isOpen = (p) => !['completed', 'cancelled'].includes(p.status);

export const labelOf = (dir, id) => { const l = dirLabel(dir, id, state.roles); return l ? `${l.name}${l.title ? `, ${l.title}` : ''}` : 'Someone'; };
export const itemsLabel = (items) => items.map((i) => i.designation).join(', ');
// A request the admin / managers still have to decide (never their own)
export const toDecide = (r) => state.isAdmin && ['pending', 'discussing'].includes(r.status) && r.requested_by !== me();

// Old links (#/projects?open=…) and callers land in the workspace
export function openProjectDrawer(id, tab = 'overview') { location.hash = `#/project/${id}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`; }

// ---------- Page ----------
export async function render({ el, params }) {
  if (params.get('open')) { location.replace(`#/project/${Number(params.get('open'))}${params.get('tab') ? `?tab=${encodeURIComponent(params.get('tab'))}` : ''}`); return; }
  let projects = []; let members = []; let tasks = []; let dir = []; let requests = []; let slots = [];
  let status = params.get('status') || 'open';
  let pmFilter = ''; let search = '';
  const all = can('projects');

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${all ? 'Projects' : 'My projects'}</h1><p>${all ? 'Client work, who runs it, and who is on the team.' : 'Projects you run or work on. Open one to start working.'}</p></div>
      <div class="actions">${can('projects', 'edit') ? `<button class="btn btn-primary" id="new">${icon('plus', 15)}New project</button>` : ''}</div>
    </div>
    <div id="approvals"></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Status" id="status"></div></div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search projects or clients" aria-label="Search projects"></div>
      ${all ? '<select class="select" id="pm" style="width:auto" aria-label="Project manager"><option value="">Any project manager</option><option value="none">No project manager</option></select>' : ''}
    </div>
    <div id="grid">${loadingBlock(4)}</div>`;
  const grid = el.querySelector('#grid');
  const appr = el.querySelector('#approvals');

  const filters = { open: (p) => isOpen(p), all: () => true, ...Object.fromEntries(Object.keys(PROJECT_STATUS).map((k) => [k, (p) => p.status === k])) };
  const labels = { open: 'Open', all: 'All', ...PROJECT_STATUS };

  function draw() {
    el.querySelector('#status').innerHTML = Object.keys(labels).map((k) =>
      `<button data-s="${k}" aria-pressed="${status === k}">${labels[k]}<span class="count">${projects.filter(filters[k]).length}</span></button>`).join('');
    const s = search.toLowerCase();
    const list = projects.filter((p) => filters[status](p)
      && (!pmFilter || (pmFilter === 'none' ? !p.project_manager : p.project_manager === pmFilter))
      && (!s || `${p.name} ${p.client?.name || ''}`.toLowerCase().includes(s)));
    if (!projects.length) {
      grid.innerHTML = `<div class="panel">${emptyState(all ? 'No projects yet' : 'No projects for you yet',
        all ? 'Open a client and press Create project, or start one here.' : 'When you\'re made project manager of a project, or added to its team, it shows up here.',
        can('projects', 'edit') ? '<button class="btn btn-primary" data-new>New project</button>' : '')}</div>`;
      return;
    }
    if (!list.length) { grid.innerHTML = `<div class="panel">${emptyState('No projects match these filters')}</div>`; return; }
    grid.innerHTML = `<div class="proj-grid">${list.map((p) => {
      const team = members.filter((m) => m.project_id === p.id && m.status === 'approved');
      const waiting = requests.filter((r) => r.project_id === p.id && toDecide(r)).length;
      const pt = tasks.filter((t) => t.project_id === p.id); const done = pt.filter((t) => t.status === 'completed').length;
      const pct = pt.length ? Math.round((done / pt.length) * 100) : 0;
      const role = isPMof(p) ? 'You run this' : team.some((m) => m.member_id === me()) ? `You: ${esc(team.find((m) => m.member_id === me()).role_label)}` : '';
      return `<a class="proj-card" href="#/project/${p.id}">
        <div class="pc-top"><span class="pc-mark">${esc(projectInitials(p.name))}</span>
          <div class="pc-name"><b>${esc(p.name)}</b><small>${esc(p.client?.name || 'Client')}</small></div>${projectBadge(p.status)}</div>
        <div class="pc-progress"><div class="proj-progress"><i style="width:${pct}%"></i></div><span>${pt.length ? `${done}/${pt.length} tasks` : 'No tasks yet'}</span></div>
        <div class="pc-foot">
          <span class="pc-who">${icon('user', 13)}${p.project_manager ? esc(dirName(dir, p.project_manager)) : '<span class="muted">No PM yet</span>'}</span>
          <span>${icon('users', 13)}${team.length}</span>
          ${p.due_date ? `<span class="due ${p.due_date < todayStr() && isOpen(p) ? 'over' : ''}">${icon('calendar', 12)}${esc(fmtDate(p.due_date))}</span>` : ''}
        </div>
        ${role || waiting ? `<div class="pc-tags">${role ? `<span class="chip">${role}</span>` : ''}${waiting ? `<span class="badge pending">${waiting} to decide</span>` : ''}</div>` : ''}
      </a>`;
    }).join('')}</div>`;
  }

  function drawApprovals() {
    const mine = requests.filter(toDecide);
    if (!mine.length) { appr.innerHTML = ''; return; }
    appr.innerHTML = `<section class="approvals" aria-label="Waiting for your decision">
      <h2>${icon('shield', 15)}Staffing requests waiting for you (${mine.length})</h2>
      ${mine.map((r) => { const p = projects.find((x) => x.id === r.project_id); const lines = slots.filter((i) => i.request_id === r.id); return `
        <div class="approval-row">
          <div class="grow"><div class="title">${esc(dirName(dir, r.requested_by) || 'The project manager')} asked for ${esc(itemsLabel(lines) || 'people')} on ${esc(p?.name || 'a project')}</div>
            <div class="meta">${r.status === 'discussing' ? 'In discussion. ' : ''}${esc(fmtRelative(r.created_at))}</div></div>
          <a class="btn btn-sm btn-primary" href="#/project/${r.project_id}?tab=team">Review</a>
        </div>`; }).join('')}
    </section>`;
  }

  async function load() {
    [projects, members, tasks, dir, requests, slots] = await Promise.all([
      q(supabase.from('projects').select('*, client:clients(id, name)').order('created_at', { ascending: false })),
      q(supabase.from('project_members').select('*')),
      q(supabase.from('tasks').select('id, project_id, status').not('project_id', 'is', null)),
      loadDirectory(),
      q(supabase.from('staffing_requests').select('id, project_id, requested_by, status, created_at').in('status', ['pending', 'discussing'])).catch(() => []),
      q(supabase.from('staffing_request_items').select('id, request_id, designation')).catch(() => []),
    ]);
    const sel = el.querySelector('#pm');
    if (sel && sel.options.length <= 2) {
      sel.insertAdjacentHTML('beforeend', dir.filter((d) => d.roles.includes('project_manager')).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join(''));
    }
    drawApprovals();
    draw();
  }

  el.querySelector('#status').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { status = b.dataset.s; draw(); } });
  el.querySelector('#q').addEventListener('input', (e) => { search = e.target.value.trim(); draw(); });
  el.querySelector('#pm')?.addEventListener('change', (e) => { pmFilter = e.target.value; draw(); });
  el.querySelector('#new')?.addEventListener('click', () => openProjectForm());
  const offs = [
    on(grid, 'click', '[data-new]', () => openProjectForm()),
  ];
  const safe = () => load().catch((e) => { grid.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  await safe();
  window.addEventListener('ehos:data-changed', safe);
  return () => { offs.forEach((x) => x()); window.removeEventListener('ehos:data-changed', safe); };
}

// ---------- New project ----------
export async function openProjectForm({ clientId = null } = {}) {
  const [dir, clients] = await Promise.all([
    loadDirectory(),
    clientId ? Promise.resolve([]) : q(supabase.from('clients').select('id, name').order('name')),
  ]);
  const pms = dir.filter((d) => d.roles.includes('project_manager') && d.status !== 'inactive');
  const clientName = clientId ? (await q(supabase.from('clients').select('name, website').eq('id', clientId).maybeSingle())) : null;
  const m = openModal({
    title: 'New project',
    subtitle: clientName ? `For client ${esc(clientName.name)}` : '',
    wide: true,
    body: `
      <form id="pf" class="form-grid" novalidate>
        ${!clientId ? `<div class="field span-2"><label for="pf-client">Client</label><select id="pf-client" class="select"><option value="">Choose a client</option>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          ${clients.length ? '' : '<span class="hint">No clients yet. Convert a won lead or add a client first.</span>'}</div>` : ''}
        <div class="field span-2"><label for="pf-name">Project name</label><input id="pf-name" class="input" maxlength="200" value="${esc(clientName ? `${clientName.name} project` : '')}" placeholder="e.g. Shopify store build, Meta ads Q4" required></div>
        <div class="field span-2"><label for="pf-pm">Project manager</label>
          <select id="pf-pm" class="select"><option value="">Not assigned yet</option>${pms.map((d) => `<option value="${d.id}">${esc(d.name)}${d.job_title ? ` (${esc(d.job_title)})` : ''}</option>`).join('')}</select>
          <span class="hint">${pms.length ? 'They get a notification and the project shows up in their Projects tab.' : 'Give someone the Project Manager role on the Team page first.'}</span></div>
        <div class="field"><label for="pf-start">Start date</label><input id="pf-start" class="input" type="date" value="${esc(todayStr())}"></div>
        <div class="field"><label for="pf-due">Due date (optional)</label><input id="pf-due" class="input" type="date"></div>
        <div class="field span-2"><label for="pf-web">Website (optional)</label><input id="pf-web" class="input" maxlength="300" value="${esc(clientName?.website || '')}" placeholder="glowco.com"></div>
        <div class="field span-2"><label for="pf-desc">Scope / notes</label><textarea id="pf-desc" class="textarea" placeholder="What's being delivered, links, deadlines"></textarea></div>
        <div class="form-error hidden span-2" id="pf-err"></div>
      </form>`,
    foot: '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Create project</button>',
  });
  m.querySelector('[data-cancel]').onclick = () => m.close();
  const err = m.querySelector('#pf-err'); const save = m.querySelector('[data-save]');
  const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
  const submit = () => busy(save, async () => {
    err.classList.add('hidden');
    const v = (id) => m.querySelector(id)?.value.trim() ?? '';
    const payload = { name: v('#pf-name'), status: 'planning', start_date: v('#pf-start') || null, due_date: v('#pf-due') || null,
      description: v('#pf-desc'), project_manager: v('#pf-pm') || null, website_url: normalizeUrl(v('#pf-web')) };
    const cid = clientId || Number(v('#pf-client'));
    if (!cid) return fail('Choose a client.');
    if (!payload.name) return fail('Give the project a name.');
    if (payload.start_date && payload.due_date && payload.due_date < payload.start_date) return fail('The due date is before the start date.');
    try {
      const row = await q(supabase.from('projects').insert({ ...payload, client_id: cid }).select('id').single());
      toast(payload.project_manager ? 'Project created. The project manager was notified.' : 'Project created');
      m.close(); changed();
      location.hash = `#/project/${row.id}`;
    } catch (e) { fail(e.message); }
  });
  save.onclick = submit;
  m.querySelector('#pf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

export function normalizeUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

// ---------- Project Manager role tab ----------
export async function projectsPanel() {
  const [list, reqs] = await Promise.all([
    q(supabase.from('projects').select('id, name, status, due_date, project_manager, client:clients(name)').eq('project_manager', me()).order('name')),
    q(supabase.from('staffing_requests').select('id, project_id, status').eq('requested_by', me()).in('status', ['pending', 'discussing'])).catch(() => []),
  ]);
  const open = (id) => reqs.filter((r) => r.project_id === id).length;
  return `
    <section class="panel role-panel">
      <div class="panel-head"><div><h2>Your projects</h2><p>${list.filter(isOpen).length} open${reqs.length ? `, <b style="color:#B45309">${reqs.length} staffing ${reqs.length === 1 ? 'request' : 'requests'} waiting for a decision</b>` : ''}</p></div><a class="btn btn-sm btn-ghost" href="#/projects">All my projects</a></div>
      <div class="list">${list.length ? list.map((p) => `
        <a class="list-item clickable" href="#/project/${p.id}"><span class="pc-mark sm">${esc(projectInitials(p.name))}</span><div class="grow"><div class="title">${esc(p.name)}</div><div class="meta"><span>${esc(p.client?.name || '')}</span>${p.due_date ? `<span>Due ${esc(fmtDate(p.due_date))}</span>` : ''}${open(p.id) ? '<span>Request waiting</span>' : ''}</div></div>${projectBadge(p.status)}</a>`).join('')
        : emptyState('No projects assigned yet', 'When the admin or a manager makes you project manager of a project, it shows up here.')}</div>
    </section>`;
}
