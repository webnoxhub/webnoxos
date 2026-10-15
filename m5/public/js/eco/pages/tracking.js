// Work tracking & reports (admin: everyone; member: "My work time")
import { supabase } from '../supabase.js';
import { state, roleName } from '../state.js';
import { q, rpc, loadMembers } from '../data.js';
import { esc, icon, avatar, fullName, roleChip, statusBadge, emptyState, loadingBlock, on, downloadCSV } from '../ui.js';
import {
  todayStr, addDays, eachDay, fmtDuration, hours, fmtWeekday, fmtDateShort, fmtDate, localDate, dueState,
  periodRange, startOfWeek, startOfMonth, daysBetween,
} from '../time.js';
import { periodPicker, statsStrip, barChart, ribbon, ribbonAxis, ribbonLegend } from '../components.js';
import { openTaskDrawer } from '../task-drawer.js';

export async function render({ el, params, route }) {
  const self = route === 'my-time' || !state.isAdmin;
  const today = todayStr();
  let period = { mode: params.get('mode') || 'week', anchor: today, from: addDays(today, -13), to: today };
  let member = self ? state.profile.id : (params.get('member') || '');
  let members = [];
  let last = null;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${self ? 'My work time' : 'Work tracking'}</h1>
        <p>${self ? 'Your sign-ins, active time in the app, and time logged on tasks.' : 'How long each person was signed in, active in the app, and working on tasks.'}</p></div>
      <div class="actions">
        <button class="btn" id="csv">${icon('download', 15)}Export CSV</button>
        <button class="btn" id="csv-tasks">${icon('download', 15)}Task time CSV</button>
      </div>
    </div>
    <div class="toolbar">
      <div id="period"></div>
      <span class="grow"></span>
      ${self ? '' : '<select class="select" id="member" style="width:auto;min-width:200px" aria-label="Member"><option value="">All members</option></select>'}
    </div>
    <div id="report">${loadingBlock(6)}</div>`;

  const box = el.querySelector('#report');
  periodPicker(el.querySelector('#period'), period, (p) => { period = p; safe(); });

  if (!self) {
    members = await loadMembers();
    const sel = el.querySelector('#member');
    sel.insertAdjacentHTML('beforeend', members.map((m) => `<option value="${m.id}">${esc(fullName(m))}${m.status !== 'active' ? ` (${m.status})` : ''}</option>`).join(''));
    sel.value = member;
    sel.onchange = () => { member = sel.value; safe(); };
  }
  const nameOf = (id) => (id === state.profile.id ? fullName(state.profile) : fullName(members.find((m) => m.id === id)));
  const codeOf = (id) => (id === state.profile.id ? state.profile.employee_code : members.find((m) => m.id === id)?.employee_code || '');

  async function load() {
    const { from, to } = periodRange(period);
    if (daysBetween(from, to) > 366) throw new Error('Pick a range of up to one year.');
    const user = member || null;
    let taskQuery = supabase.from('tasks').select('id, assigned_to, status, created_at, completed_at, due_date');
    if (user) taskQuery = taskQuery.eq('assigned_to', user);
    const single = from === to;
    const [daily, byTask, tasks, timeline] = await Promise.all([
      rpc('report_daily', { p_from: from, p_to: to, p_user: user }),
      rpc('report_tasks', { p_from: from, p_to: to, p_user: user }),
      q(taskQuery),
      single ? rpc('day_timeline', { p_day: from, p_user: user }) : Promise.resolve([]),
    ]);
    // admin's own sessions aren't part of team reports
    const keep = (id) => self || members.some((m) => m.id === id);
    last = { from, to, single, daily: daily.filter((r) => keep(r.user_id)), byTask: byTask.filter((r) => keep(r.user_id)), tasks, timeline: timeline.filter((r) => keep(r.user_id)) };
    draw();
  }

  function taskStats(tasks, from, to, uid = null) {
    const mine = uid ? tasks.filter((t) => t.assigned_to === uid) : tasks.filter((t) => t.assigned_to);
    const inRange = (iso) => { if (!iso) return false; const d = localDate(iso); return d >= from && d <= to; };
    return {
      assigned: mine.filter((t) => inRange(t.created_at)).length,
      completed: mine.filter((t) => t.status === 'completed' && inRange(t.completed_at)).length,
      pending: mine.filter((t) => t.status !== 'completed').length,
      overdue: mine.filter((t) => dueState(t) === 'over').length,
    };
  }

  function draw() {
    const { from, to, single, daily, byTask, tasks, timeline } = last;
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const ts = taskStats(tasks, from, to, member || null);
    const tot = {
      session: sum(daily, 'session_seconds'), active: sum(daily, 'active_seconds'), idle: sum(daily, 'idle_seconds'),
      timer: sum(daily, 'timer_seconds'), sessions: sum(daily, 'sessions'),
    };

    // ---- chart ----
    let chart = '';
    if (single) {
      const ids = member ? [member] : self ? [state.profile.id]
        : members.filter((m) => m.status === 'active' || timeline.some((b) => b.user_id === m.id)).map((m) => m.id);
      const blocks = (id) => timeline.filter((b) => b.user_id === id);
      const dayRow = (id) => daily.find((r) => r.user_id === id) || {};
      chart = ids.length ? `
        <div class="team-rows">
          <div class="team-row head" style="cursor:default"><span class="muted small">${self ? '' : 'Member'}</span>${ribbonAxis()}<span class="muted small" style="text-align:right">Active / task timer</span></div>
          ${ids.map((id) => `<div class="team-row" style="cursor:default">
            <div class="who">${avatar(id === state.profile.id ? state.profile : members.find((m) => m.id === id))}<div><div class="name">${esc(nameOf(id))}</div><div class="sub">${fmtDuration(dayRow(id).session_seconds)} signed in</div></div></div>
            ${ribbon(blocks(id), { isToday: from === today, size: ids.length === 1 ? 'lg' : '' })}
            <div class="totals"><b>${fmtDuration(dayRow(id).active_seconds)}</b> active<br><b>${fmtDuration(dayRow(id).timer_seconds)}</b> on tasks</div>
          </div>`).join('')}
        </div>` : emptyState('No members to show');
    } else {
      const days = eachDay(from, to);
      const span = days.length;
      const buckets = [];
      const bucketOf = span <= 31 ? (d) => d : span <= 120 ? (d) => startOfWeek(d) : (d) => startOfMonth(d);
      for (const d of days) {
        const key = bucketOf(d);
        let b = buckets.find((x) => x.key === key);
        if (!b) { b = { key, active: 0, idle: 0, timer: 0 }; buckets.push(b); }
        for (const r of daily.filter((x) => x.day === d)) { b.active += r.active_seconds; b.idle += r.idle_seconds; b.timer += r.timer_seconds; }
      }
      chart = `<div class="panel-body">${barChart(buckets.map((b) => ({
        ...b,
        label: span <= 8 ? `${fmtWeekday(b.key)} ${Number(b.key.slice(8))}` : span <= 31 ? String(Number(b.key.slice(8))) : fmtDateShort(b.key),
        title: span <= 31 ? fmtDate(b.key) : span <= 120 ? `Week of ${fmtDate(b.key)}` : b.key.slice(0, 7),
      })))}</div>`;
    }

    // ---- tables ----
    let byMember = '';
    if (!self && !member) {
      const rows = members.map((m) => {
        const r = daily.filter((x) => x.user_id === m.id);
        return { m, session: sum(r, 'session_seconds'), active: sum(r, 'active_seconds'), idle: sum(r, 'idle_seconds'), timer: sum(r, 'timer_seconds'), sessions: sum(r, 'sessions'), t: taskStats(tasks, from, to, m.id) };
      }).filter((x) => x.session || x.timer || x.t.pending || x.t.assigned || x.m.status === 'active')
        .sort((a, b) => b.active - a.active || b.timer - a.timer);
      byMember = `
        <section class="panel" style="margin-top:20px">
          <div class="panel-head"><div><h2>By member</h2><p>Click a row to see one person's days.</p></div></div>
          <div class="table-wrap">${rows.length ? `<table class="table">
            <thead><tr><th>Member</th><th class="r">Sessions</th><th class="r">Signed in</th><th class="r">Active</th><th class="r">Idle</th><th class="r">Active %</th><th class="r">Task timer</th><th class="r">Assigned</th><th class="r">Completed</th><th class="r">Pending</th><th class="r">Overdue</th></tr></thead>
            <tbody>${rows.map((x) => `<tr class="clickable" data-member="${x.m.id}">
              <td>${`<div class="who">${avatar(x.m, 'sm')}<span class="name">${esc(fullName(x.m))}</span></div>`}</td>
              <td class="r">${x.sessions}</td><td class="r">${fmtDuration(x.session)}</td><td class="r"><b>${fmtDuration(x.active)}</b></td>
              <td class="r">${fmtDuration(x.idle)}</td><td class="r muted">${x.session ? Math.round((x.active / x.session) * 100) + '%' : '—'}</td>
              <td class="r"><b style="color:#15803D">${fmtDuration(x.timer)}</b></td>
              <td class="r">${x.t.assigned}</td><td class="r">${x.t.completed}</td><td class="r">${x.t.pending}</td><td class="r" style="${x.t.overdue ? 'color:var(--error);font-weight:600' : ''}">${x.t.overdue}</td>
            </tr>`).join('')}</tbody>
            <tfoot><tr><td>Total</td><td class="r">${tot.sessions}</td><td class="r">${fmtDuration(tot.session)}</td><td class="r">${fmtDuration(tot.active)}</td><td class="r">${fmtDuration(tot.idle)}</td><td class="r">${tot.session ? Math.round((tot.active / tot.session) * 100) + '%' : '—'}</td><td class="r">${fmtDuration(tot.timer)}</td><td class="r">${ts.assigned}</td><td class="r">${ts.completed}</td><td class="r">${ts.pending}</td><td class="r">${ts.overdue}</td></tr></tfoot>
          </table>` : emptyState('No activity in this period')}</div>
        </section>`;
    }

    let byDay = '';
    if ((self || member) && !single) {
      const days = eachDay(from, to).reverse();
      byDay = `
        <section class="panel" style="margin-top:20px">
          <div class="panel-head"><div><h2>By day</h2></div></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Day</th><th class="r">Sessions</th><th class="r">Signed in</th><th class="r">Active</th><th class="r">Idle</th><th class="r">Task timer</th></tr></thead>
            <tbody>${days.map((d) => { const r = daily.find((x) => x.day === d) || {}; const none = !r.session_seconds && !r.timer_seconds; return `
              <tr${none ? ' style="color:var(--muted)"' : ''}><td>${fmtWeekday(d)}, ${fmtDateShort(d)}</td><td class="r">${r.sessions || 0}</td><td class="r">${fmtDuration(r.session_seconds)}</td>
              <td class="r">${none ? '0m' : `<b>${fmtDuration(r.active_seconds)}</b>`}</td><td class="r">${fmtDuration(r.idle_seconds)}</td><td class="r">${none ? '0m' : `<b style="color:#15803D">${fmtDuration(r.timer_seconds)}</b>`}</td></tr>`; }).join('')}</tbody>
          </table></div>
        </section>`;
    }

    const maxTask = Math.max(1, ...byTask.map((t) => t.seconds));
    const taskTable = `
      <section class="panel" style="margin-top:20px">
        <div class="panel-head"><div><h2>Time by task</h2><p>Task timer time inside this period</p></div></div>
        <div class="table-wrap">${byTask.length ? `<table class="table">
          <thead><tr><th>Task</th>${self ? '' : '<th>Member</th>'}<th>Role</th><th>Status</th><th style="width:28%"></th><th class="r">Time</th></tr></thead>
          <tbody>${byTask.slice(0, 100).map((t) => `<tr class="clickable" data-task="${t.task_id}">
            <td style="font-weight:500">${esc(t.title)}</td>${self ? '' : `<td>${esc(nameOf(t.user_id))}</td>`}
            <td>${t.team_role ? roleChip(t.team_role, state.roles) : '<span class="muted small">Any</span>'}</td><td>${statusBadge(t.status)}</td>
            <td><div class="hbar"><i style="width:${(t.seconds / maxTask) * 100}%"></i></div></td>
            <td class="r"><b>${fmtDuration(t.seconds)}</b></td></tr>`).join('')}</tbody>
        </table>` : emptyState('No task time in this period', 'Time appears here when someone runs a timer on a task.')}</div>
      </section>`;

    box.innerHTML = `
      ${statsStrip([[
        { v: fmtDuration(tot.session), k: 'Signed in' },
        { v: fmtDuration(tot.active), k: 'Active in app', dot: 'active' },
        { v: fmtDuration(tot.idle), k: 'Idle', dot: 'idle' },
        { v: fmtDuration(tot.timer), k: 'Task timer', dot: 'timer' },
        { v: tot.sessions, k: 'Sessions' },
      ], [
        { v: ts.assigned, k: 'Tasks assigned' },
        { v: ts.completed, k: 'Completed' },
        { v: ts.pending, k: 'Pending now' },
        { v: ts.overdue, k: 'Overdue now', cls: ts.overdue ? 'warn' : '' },
      ]])}
      <p class="explain">${icon('info', 14)}<span>Signed in is how long a session was open. Active counts only interaction with Webnox OS; idle starts after ${state.settings.idle_minutes} minutes without it. Task timer is logged separately and can overlap with both, so it is never added to active time. Work done in other apps only shows through task timers.</span></p>
      <section class="panel">
        <div class="panel-head"><div><h2>${single ? 'Day timeline' : 'Activity over time'}</h2></div>${ribbonLegend()}</div>
        ${chart}
      </section>
      ${byMember}${byDay}${taskTable}`;
  }

  function exportCsv() {
    if (!last) return;
    const { from, to, daily } = last;
    const rows = [['Date', 'Member', 'Employee ID', 'Sessions', 'Signed in (h)', 'Active (h)', 'Idle (h)', 'Task timer (h)']];
    [...daily].sort((a, b) => a.day.localeCompare(b.day) || nameOf(a.user_id).localeCompare(nameOf(b.user_id)))
      .forEach((r) => rows.push([r.day, nameOf(r.user_id), codeOf(r.user_id), r.sessions, hours(r.session_seconds), hours(r.active_seconds), hours(r.idle_seconds), hours(r.timer_seconds)]));
    const s = (k) => daily.reduce((a, r) => a + r[k], 0);
    rows.push(['Total', '', '', s('sessions'), hours(s('session_seconds')), hours(s('active_seconds')), hours(s('idle_seconds')), hours(s('timer_seconds'))]);
    downloadCSV(`work-tracking_${member ? nameOf(member).replace(/\s+/g, '-').toLowerCase() + '_' : ''}${from}_to_${to}.csv`, rows);
  }
  function exportTasksCsv() {
    if (!last) return;
    const rows = [['Task ID', 'Task', 'Member', 'Role', 'Status', 'Time (h)']];
    last.byTask.forEach((t) => rows.push([t.task_id, t.title, nameOf(t.user_id), t.team_role ? roleName(t.team_role) : '', t.status, hours(t.seconds)]));
    downloadCSV(`task-time_${last.from}_to_${last.to}.csv`, rows);
  }
  el.querySelector('#csv').onclick = exportCsv;
  el.querySelector('#csv-tasks').onclick = exportTasksCsv;

  const offs = [
    on(box, 'click', 'tr[data-member]', (e, tr) => {
      member = tr.dataset.member;
      const sel = el.querySelector('#member'); if (sel) sel.value = member;
      safe();
    }),
    on(box, 'click', 'tr[data-task]', (e, tr) => openTaskDrawer(Number(tr.dataset.task))),
  ];
  const safe = () => load().catch((e) => { box.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  await safe();
  const poll = setInterval(() => { if (last && last.to >= todayStr()) safe(); }, 60_000);
  return () => { offs.forEach((x) => x()); clearInterval(poll); };
}
