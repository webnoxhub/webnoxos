// Member dashboard
import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q, rpc, TASK_FIELDS, loadTotals } from '../data.js';
import { esc, icon, emptyState, loadingBlock, on, prioTag, ROLE_ICONS } from '../ui.js';
import { todayStr, fmtLongDay, fmtDuration, fmtClock, fmtTime, greeting, dueLabel, dueState, nowMs } from '../time.js';
import { ribbon, ribbonAxis, ribbonLegend, statsStrip, logItem } from '../components.js';
import { liveAttrs, runningTimer, startTimer, pauseTimer, stopTimer, onTimerChange, timerStateFor } from '../timer.js';
import { openTaskDrawer } from '../task-drawer.js';

const PRIO = { urgent: 0, high: 1, medium: 2, low: 3 };

export async function render({ el }) {
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(greeting())}, ${esc(state.profile.first_name || 'there')}</h1><p>${esc(fmtLongDay(todayStr()))}</p></div>
      <div class="actions"><a class="btn" href="#/my-tasks">${icon('tasks', 15)}My tasks</a></div>
    </div>
    <div id="home">${loadingBlock(6)}</div>`;
  const box = el.querySelector('#home');

  async function load() {
    const today = todayStr();
    const [tasks, timeline, report, logs] = await Promise.all([
      q(supabase.from('tasks').select(TASK_FIELDS).eq('assigned_to', state.profile.id)),
      rpc('day_timeline', { p_day: today, p_user: state.profile.id }),
      rpc('report_daily', { p_from: today, p_to: today, p_user: state.profile.id }),
      q(supabase.from('activity_logs').select('*').or(`actor_id.eq.${state.profile.id},subject_id.eq.${state.profile.id}`).order('created_at', { ascending: false }).limit(8)),
    ]);
    const totals = await loadTotals(tasks.filter((t) => t.status !== 'completed').map((t) => t.id));
    const day = report[0] || {};
    const count = (s) => tasks.filter((t) => t.status === s).length;
    const open = tasks.filter((t) => ['todo', 'in_progress'].includes(t.status))
      .sort((a, b) => (a.status === 'in_progress' ? -1 : 0) - (b.status === 'in_progress' ? -1 : 0) || PRIO[a.priority] - PRIO[b.priority] || (a.due_date || '9999').localeCompare(b.due_date || '9999'));
    const upcoming = tasks.filter((t) => t.status !== 'completed' && t.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 6);
    const run = runningTimer();

    let timerCard;
    if (run) {
      const tot = totals.get(run.task_id);
      timerCard = `
        <section class="panel timer-card running">
          <div class="what"><div class="label">Working on</div><div class="t"><button class="linkish" style="font-size:15px;font-weight:600;color:var(--ink)" data-task="${run.task_id}">${esc(run.title)}</button></div>
            <div class="small muted" style="margin-top:4px">Started at ${esc(fmtTime(run.started_at))}. Total on this task: <span ${liveAttrs(tot?.total || 0, totals.fetchedAt)}>${fmtDuration(tot?.total)}</span></div></div>
          <div class="clock" ${liveAttrs(0, Date.parse(run.started_at), 'clock')}>${fmtClock((nowMs() - Date.parse(run.started_at)) / 1000)}</div>
          <div class="row"><button class="btn btn-lg" data-pause>${icon('pause', 15)}Pause</button><button class="btn btn-lg" data-stop="${run.task_id}">${icon('stop', 14)}Stop</button></div>
        </section>`;
    } else {
      const next = open[0];
      const paused = next && timerStateFor(totals.get(next.id)?.byUser?.[state.profile.id]) === 'paused';
      timerCard = `
        <section class="panel timer-card">
          <div class="what"><div class="label">No timer running</div>
            ${next ? `<div class="t">Up next: <button class="linkish" style="font-size:15px;font-weight:600;color:var(--ink)" data-task="${next.id}">${esc(next.title)}</button></div><div class="small muted" style="margin-top:4px">${prioTag(next.priority)}${next.due_date ? ` <span class="due ${dueState(next)}">${esc(dueLabel(next.due_date))}</span>` : ''}</div>`
              : '<div class="t">You have no open tasks</div><div class="small muted">New tasks from the admin show up in My tasks automatically.</div>'}
          </div>
          <div class="clock muted" style="color:var(--line-2)">0:00:00</div>
          ${next ? `<button class="btn btn-success btn-lg" data-start="${next.id}">${icon('play', 15)}${paused ? 'Resume' : 'Start'} timer</button>` : ''}
        </section>`;
    }

    box.innerHTML = `
      ${timerCard}
      <section class="panel" style="margin:20px 0">
        <div class="panel-head"><div><h2>Your day</h2><p>Signed in ${fmtDuration(day.session_seconds)}, active ${fmtDuration(day.active_seconds)}, ${fmtDuration(day.timer_seconds)} on tasks</p></div>${ribbonLegend()}</div>
        <div class="panel-body">${ribbonAxis()}${ribbon(timeline, { isToday: true, size: 'lg' })}</div>
      </section>
      ${statsStrip([[
        { v: tasks.length, k: 'Assigned to me' },
        { v: count('todo'), k: 'Pending' },
        { v: count('in_progress'), k: 'In progress' },
        { v: count('in_review'), k: 'In review' },
        { v: count('completed'), k: 'Completed' },
      ], [
        { v: fmtDuration(day.timer_seconds), k: 'Tracked today', dot: 'timer' },
        { v: fmtDuration(day.active_seconds), k: 'Active today', dot: 'active' },
      ]])}
      <div class="grid-2" style="margin-top:20px">
        <section class="panel">
          <div class="panel-head"><div><h2>Deadlines</h2></div><a class="btn btn-sm btn-ghost" href="#/my-tasks">All tasks</a></div>
          <div class="list">${upcoming.length ? upcoming.map((t) => `
            <div class="list-item clickable" data-task="${t.id}"><div class="grow"><div class="title">${esc(t.title)}</div><div class="meta">${prioTag(t.priority)}</div></div>
            <span class="due ${dueState(t)}">${esc(dueLabel(t.due_date))}</span></div>`).join('') : emptyState('No upcoming deadlines')}</div>
        </section>
        <div class="stack">
          ${state.myRoles.length ? `<section class="panel"><div class="panel-head"><h2>My roles</h2></div><div class="list">${state.myRoles.map((k) => {
            const r = state.roles.find((x) => x.key === k);
            const n = tasks.filter((t) => t.team_role === k && ['todo', 'in_progress'].includes(t.status)).length;
            return `<a class="list-item clickable" href="#/role/${esc(k)}" style="text-decoration:none;color:inherit" data-role="${esc(k)}"><span class="role-badge" style="width:30px;height:30px;border-radius:8px">${icon(ROLE_ICONS[k] || 'briefcase', 15)}</span><div class="grow"><div class="title">${esc(r?.name || k)}</div></div><span class="small muted">${n} open</span></a>`;
          }).join('')}</div></section>` : ''}
          <section class="panel">
            <div class="panel-head"><h2>Recent activity</h2><a class="btn btn-sm btn-ghost" href="#/my-activity">See all</a></div>
            <div class="list">${logs.length ? logs.map((l) => logItem(l, { time: 'relative', meId: state.profile.id })).join('') : emptyState('Nothing yet')}</div>
          </section>
        </div>
      </div>`;
  }

  const offs = [
    on(box, 'click', '[data-task]', (e, x) => openTaskDrawer(Number(x.dataset.task))),
    on(box, 'click', '[data-open-task]', (e, x) => openTaskDrawer(Number(x.dataset.openTask))),
    on(box, 'click', '[data-start]', (e, b) => { b.disabled = true; startTimer(Number(b.dataset.start)); }),
    on(box, 'click', '[data-pause]', (e, b) => { b.disabled = true; pauseTimer(); }),
    on(box, 'click', '[data-stop]', (e, b) => { b.disabled = true; stopTimer(Number(b.dataset.stop)); }),
    onTimerChange(() => safe()),
  ];
  const safe = () => load().catch((e) => { box.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  await safe();
  const poll = setInterval(safe, 60_000);
  window.addEventListener('ehos:data-changed', safe);
  return () => { offs.forEach((x) => x()); clearInterval(poll); window.removeEventListener('ehos:data-changed', safe); };
}
