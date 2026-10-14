// Member: My tasks, and each role tab (same list filtered by role)
import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q, TASK_FIELDS, loadTotals, loadDirectory, dirLabel } from '../data.js';
import { esc, icon, statusBadge, prioTag, roleChip, emptyState, loadingBlock, on, ROLE_ICONS } from '../ui.js';
import { fmtDuration, dueLabel, dueState } from '../time.js';
import { liveAttrs, startTimer, pauseTimer, timerStateFor, onTimerChange } from '../timer.js';
import { openTaskDrawer } from '../task-drawer.js';
import { can, canAny } from '../state.js';

const ORDER = { in_progress: 0, todo: 1, in_review: 2, completed: 3 };
const PRIO = { urgent: 0, high: 1, medium: 2, low: 3 };

export async function render({ el, arg: role, setTitle }) {
  const r = role ? state.roles.find((x) => x.key === role) : null;
  if (r) setTitle(r.name);
  let filter = 'open';
  let tasks = []; let totals = new Map(); let dir = [];

  el.innerHTML = `
    <div class="page-head">
      ${r ? `<div class="role-head" data-role="${esc(r.key)}"><span class="role-badge">${icon(ROLE_ICONS[r.key] || 'briefcase', 20)}</span>
        <div><h1>${esc(r.name)}</h1><p>${esc(r.description)}. Tasks the admin assigned to you for this role.</p></div></div>`
      : '<div><h1>My tasks</h1><p>Everything assigned to you. Start a timer when you begin working on a task.</p></div>'}
    </div>
    <div id="role-panel"></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Filter tasks" id="filters"></div></div>
    <section class="panel"><div id="list">${loadingBlock(5)}</div></section>`;
  const list = el.querySelector('#list');

  function counts() {
    return {
      open: tasks.filter((t) => ['todo', 'in_progress'].includes(t.status)).length,
      in_review: tasks.filter((t) => t.status === 'in_review').length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      all: tasks.length,
    };
  }

  function draw() {
    const c = counts();
    el.querySelector('#filters').innerHTML = [['open', 'Open'], ['in_review', 'In review'], ['completed', 'Completed'], ['all', 'All']]
      .map(([k, label]) => `<button data-f="${k}" aria-pressed="${filter === k}">${label}<span class="count">${c[k]}</span></button>`).join('');

    const shown = tasks.filter((t) => filter === 'all' || (filter === 'open' ? ['todo', 'in_progress'].includes(t.status) : t.status === filter))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || PRIO[a.priority] - PRIO[b.priority] || (a.due_date || '9999').localeCompare(b.due_date || '9999'));

    if (!shown.length) {
      list.innerHTML = filter === 'open'
        ? emptyState(tasks.length ? 'Nothing open right now' : 'No tasks yet', tasks.length ? 'New tasks from the admin appear here automatically.' : `When the admin assigns you a task${r ? ` for ${r.name}` : ''}, it shows up here.`)
        : emptyState('Nothing here');
      return;
    }
    list.innerHTML = shown.map((t) => {
      const tot = totals.get(t.id);
      const mine = tot?.byUser?.[state.profile.id];
      const ts = timerStateFor(mine);
      const canTime = ['todo', 'in_progress'].includes(t.status);
      const total = tot?.total || 0;
      const due = dueState(t);
      return `
        <div class="mtask">
          <button class="play ${ts === 'running' ? 'on' : ts === 'paused' ? 'paused' : ''}" data-timer="${t.id}" data-state="${ts}" ${canTime ? '' : 'disabled'}
            title="${!canTime ? 'Timer closed for this task' : ts === 'running' ? 'Pause timer' : ts === 'paused' ? 'Resume timer' : 'Start timer'}"
            aria-label="${ts === 'running' ? 'Pause timer' : ts === 'paused' ? 'Resume timer' : 'Start timer'} for ${esc(t.title)}">
            ${icon(ts === 'running' ? 'pause' : 'play', 15)}</button>
          <div class="body" data-task="${t.id}" role="button" tabindex="0">
            <div class="t">${esc(t.title)}</div>
            <div class="meta">${statusBadge(t.status)}${prioTag(t.priority)}${!role && t.team_role ? roleChip(t.team_role, state.roles) : ''}
              ${t.due_date && t.status !== 'completed' ? `<span class="due ${due}">${icon('calendar', 12)}${esc(dueLabel(t.due_date))}</span>` : ''}
              ${total || ts === 'running' ? `<span class="tracked ${ts === 'running' ? 'live' : ''}">${icon('clock', 12)}<span ${ts === 'running' ? liveAttrs(total, totals.fetchedAt) : ''}>${fmtDuration(total)}</span></span>` : ''}
              ${(() => { const l = dirLabel(dir, t.created_by, state.roles); return l ? `<span>By ${esc(l.name)}${l.title ? `, ${esc(l.title)}` : ''}</span>` : ''; })()}
              ${t.status === 'in_progress' && t.review_note ? '<span class="due soon">Changes requested</span>' : ''}
            </div>
          </div>
          <div class="ctl">${ts === 'paused' ? '<span class="small muted">Paused</span>' : ''}</div>
        </div>`;
    }).join('');
  }

  async function load() {
    let query = supabase.from('tasks').select(TASK_FIELDS).eq('assigned_to', state.profile.id).order('created_at', { ascending: false });
    if (role) query = query.eq('team_role', role);
    [tasks, dir] = await Promise.all([q(query), loadDirectory().catch(() => [])]);
    totals = await loadTotals(tasks.map((t) => t.id));
    draw();
  }

  el.querySelector('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    filter = b.dataset.f; draw();
  });
  const offs = [
    on(list, 'click', '[data-task]', (e, x) => openTaskDrawer(Number(x.dataset.task))),
    on(list, 'keydown', '[data-task]', (e, x) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTaskDrawer(Number(x.dataset.task)); } }),
    on(list, 'click', '[data-timer]', async (e, b) => {
      b.disabled = true;
      if (b.dataset.state === 'running') await pauseTimer(); else await startTimer(Number(b.dataset.timer));
    }),
    onTimerChange(() => safe()),
  ];
  // Role-specific panel on top of the role tab (leads for lead gen / sales / calls, clients for PMs)
  const rp = el.querySelector('#role-panel');
  async function loadPanel() {
    if (!role) return;
    try {
      if (['lead_gen', 'sales_rep', 'cold_caller'].includes(role) && can('leads')) {
        const m = await import('./leads.js');
        rp.innerHTML = await m.leadsPanel(role);
        rp.querySelector('[data-new-lead]')?.addEventListener('click', () => m.openLeadForm());
        rp.querySelector('[data-import]')?.addEventListener('click', () => m.openImport());
        rp.querySelector('[data-share]')?.addEventListener('click', () => m.shareForm());
        rp.querySelectorAll('[data-lead]').forEach((x) => x.onclick = () => m.openLeadDrawer(Number(x.dataset.lead)));
        m.bindLeadsPanel(rp);
      } else if (role === 'project_manager' && canAny('projects')) {
        const m = await import('./projects.js');
        rp.innerHTML = await m.projectsPanel();
        rp.querySelectorAll('[data-project]').forEach((x) => x.onclick = () => m.openProjectDrawer(Number(x.dataset.project)));
      } else if (role === 'finance' && can('finance')) {
        const b = await import('../business.js');
        rp.innerHTML = `<div class="role-panel">${b.businessPanel(await b.loadBusiness(), { compact: true })}<p style="margin-top:10px"><a class="btn btn-sm" href="#/finance">Open finance</a></p></div>`;
      }
    } catch (e) { rp.innerHTML = `<div class="note warn role-panel">${esc(e.message)}</div>`; }
  }
  loadPanel();
  window.addEventListener('ehos:data-changed', loadPanel);
  const safe = () => load().catch((e) => { list.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  await safe();
  window.addEventListener('ehos:data-changed', safe);
  window.addEventListener('focus', safe);
  const poll = setInterval(safe, 60_000);
  return () => {
    offs.forEach((x) => x()); clearInterval(poll);
    window.removeEventListener('ehos:data-changed', safe); window.removeEventListener('focus', safe);
    window.removeEventListener('ehos:data-changed', loadPanel);
  };
}

