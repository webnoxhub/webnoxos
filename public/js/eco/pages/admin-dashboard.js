import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q, rpc, loadMembers } from '../data.js';
import { esc, icon, avatar, fullName, presenceTag, emptyState, loadingBlock, on, statusBadge, prioTag } from '../ui.js';
import { todayStr, fmtLongDay, fmtDuration, fmtTime, fmtRelative, dueLabel, dueState, greeting, addDays } from '../time.js';
import { ribbon, ribbonAxis, ribbonLegend, statsStrip, logItem } from '../components.js';
import { liveAttrs } from '../timer.js';
import { openTaskDrawer } from '../task-drawer.js';

export async function render({ el }) {
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(greeting())}, ${esc(state.profile.first_name || 'there')}</h1><p>${esc(fmtLongDay(todayStr()))}</p></div>
      <div class="actions"><a class="btn" href="#/team">${icon('users', 15)}Team</a><a class="btn btn-primary" href="#/tasks?new=1">${icon('plus', 15)}New task</a></div>
    </div>
    <div id="dash">${loadingBlock(6)}</div>`;
  const box = el.querySelector('#dash');

  async function load() {
    const today = todayStr();
    const [members, presence, tasks, timeline, report, logs] = await Promise.all([
      loadMembers(),
      rpc('team_presence'),
      q(supabase.from('tasks').select('id, title, status, priority, due_date, assigned_to, team_role, submitted_at').order('due_date', { ascending: true, nullsFirst: false })),
      rpc('day_timeline', { p_day: today, p_user: null }),
      rpc('report_daily', { p_from: today, p_to: today, p_user: null }),
      q(supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(12)),
    ]);

    const pres = new Map(presence.map((p) => [p.user_id, p]));
    const rep = new Map(report.map((r) => [r.user_id, r]));
    const blocks = new Map();
    timeline.forEach((b) => { if (!blocks.has(b.user_id)) blocks.set(b.user_id, []); blocks.get(b.user_id).push(b); });
    const byId = new Map(members.map((m) => [m.id, m]));

    const online = presence.filter((p) => p.presence !== 'offline');
    const activeN = presence.filter((p) => p.presence === 'active').length;
    const idleN = presence.filter((p) => p.presence === 'idle').length;
    const count = (s) => tasks.filter((t) => t.status === s).length;
    const overdue = tasks.filter((t) => dueState(t) === 'over');

    if (!members.length) {
      box.innerHTML = `<div class="panel">${emptyState('Add your first team member', 'Invite people, give them roles, then assign tasks. Their sign-ins and work time show up here.', '<a class="btn btn-primary" href="#/team?add=1">Add team member</a>')}</div>`;
      return;
    }

    // Team today: everyone not deactivated, plus anyone with activity today
    const rows = members
      .filter((m) => !['inactive', 'suspended'].includes(m.status) || blocks.has(m.id))
      .map((m) => ({ m, p: pres.get(m.id), r: rep.get(m.id) }))
      .sort((a, b) => {
        const rank = (x) => ({ active: 0, idle: 1 }[x.p?.presence] ?? 2);
        return rank(a) - rank(b) || (b.r?.active_seconds || 0) - (a.r?.active_seconds || 0) || fullName(a.m).localeCompare(fullName(b.m));
      });

    const review = tasks.filter((t) => t.status === 'in_review').sort((a, b) => (a.submitted_at || '').localeCompare(b.submitted_at || ''));
    const horizon = addDays(today, 7);
    const deadlines = tasks.filter((t) => t.status !== 'completed' && t.due_date && t.due_date <= horizon).slice(0, 8);

    box.innerHTML = `
      <div class="stats-pair">
        ${statsStrip([[
          { v: members.filter((m) => m.status !== 'inactive' && m.status !== 'suspended').length, k: 'Team members' },
          { v: online.length, k: 'Online' },
          { v: activeN, k: 'Active', dot: 'timer' },
          { v: idleN, k: 'Idle' },
        ]])}
        ${statsStrip([[
          { v: tasks.length, k: 'Total tasks' },
          { v: count('todo'), k: 'Pending' },
          { v: count('in_progress'), k: 'In progress' },
          { v: count('in_review'), k: 'In review' },
          { v: count('completed'), k: 'Completed' },
          { v: overdue.length, k: 'Overdue', cls: overdue.length ? 'warn' : '' },
        ]])}
      </div>

      <section class="panel" style="margin-bottom:20px">
        <div class="panel-head">
          <div><h2>Team today</h2><p>Each strip is today from midnight to midnight. Click a person for details.</p></div>
          ${ribbonLegend()}
        </div>
        <div class="team-rows">
          <div class="team-row head"><span class="muted small">Member</span>${ribbonAxis()}<span class="muted small" style="text-align:right">Active / task timer</span></div>
          ${rows.map(({ m, p, r }) => {
            const status = p?.presence || 'offline';
            const label = status === 'offline'
              ? (p?.last_seen_at ? `Last seen ${fmtRelative(p.last_seen_at)}` : 'Not signed in yet')
              : `${status === 'active' ? 'Active' : 'Idle'} since ${fmtTime(p.session_started_at)}`;
            return `
            <div class="team-row" data-member="${m.id}" tabindex="0" role="link" aria-label="${esc(fullName(m))}">
              <div class="who">${avatar(m)}<div>
                <div class="name">${esc(fullName(m))}</div>
                <div>${presenceTag(status, label)}</div>
                ${p?.timer_task_id ? `<div class="now-on">${icon('play', 10)}<span>${esc(p.timer_task_title)}</span></div>` : ''}
              </div></div>
              ${ribbon(blocks.get(m.id) || [], { isToday: true })}
              <div class="totals"><b>${fmtDuration(r?.active_seconds)}</b> active<br>
                ${p?.timer_started_at
                  ? `<b style="color:#15803D" ${liveAttrs(r?.timer_seconds || 0, Date.now())}>${fmtDuration(r?.timer_seconds)}</b>`
                  : `<b>${fmtDuration(r?.timer_seconds)}</b>`} on tasks</div>
            </div>`;
          }).join('')}
        </div>
      </section>

      <div class="grid-2" style="margin-bottom:20px">
        <section class="panel">
          <div class="panel-head"><div><h2>Waiting for review</h2><p>Submitted work that needs your approval</p></div><a class="btn btn-sm btn-ghost" href="#/tasks?status=in_review">View all</a></div>
          <div class="list">${review.length ? review.slice(0, 6).map((t) => `
            <div class="list-item clickable" data-task="${t.id}">
              ${avatar(byId.get(t.assigned_to), 'sm')}
              <div class="grow"><div class="title">${esc(t.title)}</div><div class="meta"><span>${esc(fullName(byId.get(t.assigned_to)))}</span><span>Submitted ${esc(fmtRelative(t.submitted_at))}</span></div></div>
              ${prioTag(t.priority)}
            </div>`).join('') : emptyState('Nothing to review', 'Submitted tasks will show up here.')}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><div><h2>Deadlines</h2><p>Overdue and due in the next 7 days</p></div><a class="btn btn-sm btn-ghost" href="#/tasks">All tasks</a></div>
          <div class="list">${deadlines.length ? deadlines.map((t) => `
            <div class="list-item clickable" data-task="${t.id}">
              <div class="grow"><div class="title">${esc(t.title)}</div><div class="meta"><span>${esc(t.assigned_to ? fullName(byId.get(t.assigned_to)) : 'Unassigned')}</span>${statusBadge(t.status)}</div></div>
              <span class="due ${dueState(t)}">${esc(dueLabel(t.due_date))}</span>
            </div>`).join('') : emptyState('No deadlines this week')}</div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-head"><div><h2>Recent activity</h2></div><a class="btn btn-sm btn-ghost" href="#/logs">Open activity logs</a></div>
        <div class="list">${logs.length ? logs.map((l) => logItem(l, { time: 'relative', meId: state.profile.id })).join('') : emptyState('No activity yet')}</div>
      </section>`;
  }

  const offs = [
    on(box, 'click', '[data-task]', (e, x) => openTaskDrawer(Number(x.dataset.task))),
    on(box, 'click', '[data-open-task]', (e, x) => openTaskDrawer(Number(x.dataset.openTask))),
    on(box, 'click', '[data-member]', (e, x) => { location.hash = `#/tracking?member=${x.dataset.member}&mode=day`; }),
    on(box, 'keydown', '[data-member]', (e, x) => { if (e.key === 'Enter') location.hash = `#/tracking?member=${x.dataset.member}&mode=day`; }),
  ];
  const safeLoad = () => load().catch((e) => { box.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  await safeLoad();
  const timer = setInterval(safeLoad, 30_000);
  window.addEventListener('ehos:data-changed', safeLoad);
  return () => { clearInterval(timer); offs.forEach((f) => f()); window.removeEventListener('ehos:data-changed', safeLoad); };
}
