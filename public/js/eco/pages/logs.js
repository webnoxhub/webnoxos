// Activity logs (admin: everything; member: own, inside My activity)
import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q, loadMembers } from '../data.js';
import { esc, icon, fullName, emptyState, loadingBlock, on, downloadCSV } from '../ui.js';
import { todayStr, addDays, periodRange, zonedMidnightIso, localDate, fmtLongDay, fmtDateTime } from '../time.js';
import { periodPicker, logItem, EVENT_GROUPS, EVENT_LABELS } from '../components.js';
import { openTaskDrawer } from '../task-drawer.js';

const PAGE = 100;

export async function render({ el, params }) {
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Activity logs</h1><p>An append-only record of sign-ins, task changes, reviews, timers and settings.</p></div>
    </div>
    <div id="lg"></div>`;
  return mountLogs(el.querySelector('#lg'), { self: false, member: params.get('member') || '', task: params.get('task') || '' });
}

export async function mountLogs(container, { self, member = '', task = '' }) {
  let period = { mode: 'week', anchor: todayStr(), from: addDays(todayStr(), -29), to: todayStr() };
  let action = '';
  let rows = [];
  let more = false;

  container.innerHTML = `
    <div class="toolbar">
      <div data-period></div><span class="grow"></span>
      ${self ? '' : '<select class="select" data-member style="width:auto;min-width:180px" aria-label="Member"><option value="">Everyone</option></select>'}
      <select class="select" data-action style="width:auto" aria-label="Event type"><option value="">All events</option>
        ${EVENT_GROUPS.map(([g, acts]) => `<optgroup label="${esc(g)}">${acts.map((a) => `<option value="${a}">${esc(EVENT_LABELS[a])}</option>`).join('')}</optgroup>`).join('')}</select>
      <input class="input" data-task placeholder="Task #" style="width:96px" inputmode="numeric" aria-label="Task number" value="${esc(task)}">
      <button class="btn" data-csv>${icon('download', 15)}CSV</button>
    </div>
    <section class="panel"><div data-list>${loadingBlock(6)}</div></section>`;

  const list = container.querySelector('[data-list]');
  periodPicker(container.querySelector('[data-period]'), period, (p) => { period = p; safe(); });
  container.querySelector('[data-action]').onchange = (e) => { action = e.target.value; safe(); };
  let t; container.querySelector('[data-task]').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { task = e.target.value.replace(/\D/g, ''); safe(); }, 350); };
  if (!self) {
    const members = await loadMembers({ includeAdmin: true });
    const sel = container.querySelector('[data-member]');
    sel.insertAdjacentHTML('beforeend', members.map((m) => `<option value="${m.id}">${esc(fullName(m))}${m.role === 'admin' ? ' (admin)' : ''}</option>`).join(''));
    sel.value = member;
    sel.onchange = () => { member = sel.value; safe(); };
  }

  async function load(append = false) {
    const { from, to } = periodRange(period);
    let query = supabase.from('activity_logs').select('*')
      .gte('created_at', zonedMidnightIso(from)).lt('created_at', zonedMidnightIso(addDays(to, 1)))
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(append ? rows.length : 0, (append ? rows.length : 0) + PAGE - 1);
    const who = self ? state.profile.id : member;
    if (who) query = query.or(`actor_id.eq.${who},subject_id.eq.${who}`);
    if (action) query = query.eq('action', action);
    if (task) query = query.eq('entity_type', 'task').eq('entity_id', task);
    const data = await q(query);
    rows = append ? rows.concat(data) : data;
    more = data.length === PAGE;
    draw();
  }

  function draw() {
    if (!rows.length) { list.innerHTML = emptyState('No activity in this period'); return; }
    let html = ''; let lastDay = '';
    for (const r of rows) {
      const d = localDate(r.created_at);
      if (d !== lastDay) { html += `<div class="day-sep">${esc(fmtLongDay(d))}</div>`; lastDay = d; }
      html += logItem(r, { meId: state.profile.id });
    }
    if (more) html += '<div style="padding:14px 20px;border-top:1px solid var(--line)"><button class="btn btn-sm" data-more>Load more</button></div>';
    list.innerHTML = html;
  }

  const offs = [
    on(list, 'click', '[data-open-task]', (e, x) => openTaskDrawer(Number(x.dataset.openTask))),
    on(list, 'click', '[data-more]', (e, x) => { x.disabled = true; load(true).catch(() => { x.disabled = false; }); }),
  ];
  container.querySelector('[data-csv]').onclick = () => {
    const out = [['Time', 'Actor', 'Event', 'Description', 'Related', 'Details']];
    rows.forEach((r) => out.push([fmtDateTime(r.created_at), r.actor_name, EVENT_LABELS[r.action] || r.action, r.description,
      r.entity_type ? `${r.entity_type} ${r.entity_id || ''}` : '', JSON.stringify(r.meta || {})]));
    const { from, to } = periodRange(period);
    downloadCSV(`activity-logs_${from}_to_${to}.csv`, out);
  };
  const safe = () => load().catch((e) => { list.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  await safe();
  return () => offs.forEach((x) => x());
}
