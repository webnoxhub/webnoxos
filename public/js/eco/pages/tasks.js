import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q, TASK_FIELDS, loadMembers } from '../data.js';
import { esc, icon, avatar, fullName, roleChip, prioTag, statusBadge, emptyState, loadingBlock, on, STATUS_LABEL, PRIORITY_LABEL } from '../ui.js';
import { fmtDuration, dueLabel, dueState } from '../time.js';
import { liveAttrs } from '../timer.js';
import { openTaskDrawer, openTaskForm } from '../task-drawer.js';

const STATUSES = ['todo', 'in_progress', 'in_review', 'completed'];

export async function render({ el, params }) {
  let view = 'board';
  try { view = localStorage.getItem('ehos.tasksView') || 'board'; } catch { /* ignore */ }
  const f = { q: '', member: params.get('member') || '', role: params.get('role') || '', priority: '', status: params.get('status') || '' };
  let tasks = []; let members = []; let totals = new Map(); let fetchedAt = Date.now();

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Tasks</h1><p>Create work, assign it by role, and review what comes back. Project tasks live inside each project.</p></div>
      <div class="actions">
        <div class="seg" role="group" aria-label="View">
          <button data-view="board" aria-pressed="${view === 'board'}">${icon('board', 14)} Board</button>
          <button data-view="list" aria-pressed="${view === 'list'}">${icon('list', 14)} List</button>
        </div>
        <button class="btn btn-primary" id="new">${icon('plus', 15)}New task</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="f-q" placeholder="Search tasks" aria-label="Search tasks"></div>
      <select class="select" id="f-member" style="width:auto" aria-label="Member"></select>
      <select class="select" id="f-role" style="width:auto" aria-label="Role"><option value="">All roles</option>${state.roles.map((r) => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join('')}</select>
      <select class="select" id="f-priority" style="width:auto" aria-label="Priority"><option value="">Any priority</option>${Object.entries(PRIORITY_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <select class="select" id="f-status" style="width:auto" aria-label="Status"><option value="">Any status</option>${STATUSES.map((s) => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}</select>
    </div>
    <div id="tasks">${loadingBlock(5)}</div>`;

  const box = el.querySelector('#tasks');
  el.querySelector('#f-role').value = f.role;
  el.querySelector('#f-status').value = f.status;

  const timeOf = (t) => {
    const x = totals.get(t.id);
    if (!x || (!x.total && !x.running)) return '';
    return `<span class="tracked ${x.running ? 'live' : ''}">${icon('clock', 12)}<span ${x.running ? liveAttrs(x.total, fetchedAt) : ''}>${fmtDuration(x.total)}</span></span>`;
  };

  function filtered() {
    const s = f.q.toLowerCase();
    return tasks.filter((t) => (!s || t.title.toLowerCase().includes(s) || String(t.id) === s.replace('#', ''))
      && (!f.member || (f.member === 'none' ? !t.assigned_to : t.assigned_to === f.member))
      && (!f.role || t.team_role === f.role)
      && (!f.priority || t.priority === f.priority)
      && (!f.status || t.status === f.status));
  }

  function card(t) {
    const due = dueState(t);
    return `<button class="tcard" data-task="${t.id}">
      <div class="t">${esc(t.title)}</div>
      <div class="meta">${prioTag(t.priority)}${t.team_role ? roleChip(t.team_role, state.roles) : ''}</div>
      <div class="foot">
        <span class="who" style="gap:6px">${t.assignee ? `${avatar(t.assignee, 'sm')}<span class="small">${esc(fullName(t.assignee))}</span>` : '<span class="small muted">Unassigned</span>'}</span>
        <span class="row" style="gap:8px">${timeOf(t)}${t.due_date && t.status !== 'completed' ? `<span class="due ${due}">${esc(dueLabel(t.due_date))}</span>` : ''}</span>
      </div>
    </button>`;
  }

  function draw() {
    const list = filtered();
    if (!tasks.length) {
      box.innerHTML = `<div class="panel">${emptyState('No tasks yet', 'Create a task, pick a role and a member. It shows up in their My tasks right away.', '<button class="btn btn-primary" data-new>New task</button>')}</div>`;
      return;
    }
    if (view === 'board') {
      const cols = f.status ? [f.status] : STATUSES;
      box.innerHTML = `<div class="board" style="${f.status ? 'grid-template-columns:minmax(260px,420px)' : ''}">${cols.map((s) => {
        const items = list.filter((t) => t.status === s);
        if (s === 'completed') items.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
        return `<div class="board-col"><div class="board-col-head"><i class="${s}"></i>${STATUS_LABEL[s]}<span class="count">${items.length}</span></div>
          ${items.map(card).join('') || '<div class="board-empty">Nothing here</div>'}</div>`;
      }).join('')}</div>`;
    } else {
      box.innerHTML = list.length ? `<section class="panel"><div class="table-wrap"><table class="table">
        <thead><tr><th>Task</th><th>Assigned to</th><th>Role</th><th>Priority</th><th>Status</th><th>Due</th><th class="r">Time</th></tr></thead>
        <tbody>${list.map((t) => `<tr class="clickable" data-task="${t.id}" tabindex="0">
          <td><div style="font-weight:500">${esc(t.title)}</div><div class="small muted">#${t.id}</div></td>
          <td>${t.assignee ? `<div class="who">${avatar(t.assignee, 'sm')}<span>${esc(fullName(t.assignee))}</span></div>` : '<span class="muted">Unassigned</span>'}</td>
          <td>${t.team_role ? roleChip(t.team_role, state.roles) : '<span class="muted small">Any</span>'}</td>
          <td>${prioTag(t.priority)}</td>
          <td>${statusBadge(t.status)}</td>
          <td>${t.due_date ? `<span class="due ${dueState(t)}">${esc(dueLabel(t.due_date))}</span>` : '<span class="muted">—</span>'}</td>
          <td class="r">${timeOf(t) || '<span class="muted">—</span>'}</td>
        </tr>`).join('')}</tbody></table></div></section>`
        : `<div class="panel">${emptyState('No tasks match these filters')}</div>`;
    }
  }

  async function load() {
    const [t, m, tt] = await Promise.all([
      q(supabase.from('tasks').select(TASK_FIELDS).is('project_id', null).order('created_at', { ascending: false }).limit(2000)),
      members.length ? Promise.resolve(members) : loadMembers(),
      q(supabase.from('task_time_totals').select('task_id, total_seconds, running')),
    ]);
    tasks = t; members = m; fetchedAt = Date.now();
    totals = new Map();
    tt.forEach((r) => { const x = totals.get(r.task_id) || { total: 0, running: false }; x.total += r.total_seconds; x.running ||= r.running; totals.set(r.task_id, x); });
    const sel = el.querySelector('#f-member');
    sel.innerHTML = `<option value="">Everyone</option><option value="none">Unassigned</option>${members.map((x) => `<option value="${x.id}">${esc(fullName(x))}</option>`).join('')}`;
    sel.value = f.member;
    draw();
  }

  const bindF = (id, key, ev = 'change') => el.querySelector(id).addEventListener(ev, (e) => { f[key] = e.target.value.trim(); draw(); });
  bindF('#f-q', 'q', 'input'); bindF('#f-member', 'member'); bindF('#f-role', 'role'); bindF('#f-priority', 'priority'); bindF('#f-status', 'status');
  el.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => {
    view = b.dataset.view;
    try { localStorage.setItem('ehos.tasksView', view); } catch { /* ignore */ }
    el.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    draw();
  });
  const newTask = () => openTaskForm({ presetMember: params.get('member') || f.member || null, presetRole: f.role || null, onSaved: () => load() });
  el.querySelector('#new').onclick = newTask;
  const offs = [
    on(box, 'click', '[data-task]', (e, x) => openTaskDrawer(Number(x.dataset.task))),
    on(box, 'keydown', 'tr[data-task]', (e, x) => { if (e.key === 'Enter') openTaskDrawer(Number(x.dataset.task)); }),
    on(box, 'click', '[data-new]', newTask),
  ];
  const safe = () => load().catch((e) => { box.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  await safe();
  if (params.get('new') === '1') newTask();
  window.addEventListener('ehos:data-changed', safe);
  const poll = setInterval(safe, 60_000);
  return () => { offs.forEach((x) => x()); clearInterval(poll); window.removeEventListener('ehos:data-changed', safe); };
}
