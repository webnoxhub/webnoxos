// Login history (admin: everyone; member: own, inside My activity)
import { state } from '../state.js';
import { rpc, loadMembers } from '../data.js';
import { esc, icon, avatar, fullName, presenceTag, emptyState, loadingBlock, downloadCSV } from '../ui.js';
import { todayStr, fmtDuration, fmtTime, fmtDateTime, localDate, fmtDateShort, fmtWeekday, periodRange, hours } from '../time.js';
import { periodPicker } from '../components.js';

const END = { logout: 'Signed out', expired: 'Expired', inactive: 'Deactivated', disconnected: 'Connection lost', unknown: 'Unknown' };

export async function render({ el, params }) {
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Login history</h1><p>Every session: when it started, how long it stayed open, and how it ended.</p></div>
    </div>
    <div id="lh"></div>`;
  return mountLogins(el.querySelector('#lh'), { self: false, member: params.get('member') || '' });
}

export async function mountLogins(container, { self, member = '' }) {
  let period = { mode: 'week', anchor: todayStr(), from: todayStr(), to: todayStr() };
  let status = '';
  let members = [];
  let rows = [];

  container.innerHTML = `
    <div class="toolbar">
      <div data-period></div><span class="grow"></span>
      ${self ? '' : '<select class="select" data-member style="width:auto;min-width:190px" aria-label="Member"><option value="">All members</option></select>'}
      <select class="select" data-status style="width:auto" aria-label="Session status"><option value="">All sessions</option><option value="open">Online now</option><option value="ended">Ended</option></select>
      <button class="btn" data-csv>${icon('download', 15)}Export CSV</button>
    </div>
    <section class="panel"><div class="table-wrap" data-table>${loadingBlock(5)}</div></section>
    <p class="explain" style="margin-top:12px">${icon('info', 14)}<span>Times with ~ are estimated. When a browser closes or loses connection, the session ends at the last heartbeat the app received (it sends one every minute).</span></p>`;

  const table = container.querySelector('[data-table]');
  periodPicker(container.querySelector('[data-period]'), period, (p) => { period = p; safe(); });
  container.querySelector('[data-status]').onchange = (e) => { status = e.target.value; draw(); };
  if (!self) {
    members = await loadMembers();
    const sel = container.querySelector('[data-member]');
    sel.insertAdjacentHTML('beforeend', members.map((m) => `<option value="${m.id}">${esc(fullName(m))}</option>`).join(''));
    sel.value = member;
    sel.onchange = () => { member = sel.value; safe(); };
  }
  const person = (id) => (id === state.profile.id ? state.profile : members.find((m) => m.id === id));

  async function load() {
    const { from, to } = periodRange(period);
    const data = await rpc('list_sessions', { p_from: from, p_to: to, p_user: self ? state.profile.id : (member || null) });
    rows = self ? data : data.filter((r) => members.some((m) => m.id === r.user_id));
    draw();
  }

  function draw() {
    const list = rows.filter((r) => !status || (status === 'open' ? r.status !== 'ended' : r.status === 'ended'));
    if (!list.length) { table.innerHTML = emptyState('No sessions in this period'); return; }
    table.innerHTML = `<table class="table">
      <thead><tr>${self ? '' : '<th>Member</th>'}<th>Signed in</th><th>Last seen</th><th>Ended</th><th class="r">Duration</th><th class="r">Active</th><th class="r">Idle</th><th>Status</th><th>Device</th><th>How it ended</th></tr></thead>
      <tbody>${list.map((r) => {
        const p = person(r.user_id);
        const day = localDate(r.started_at);
        return `<tr>
          ${self ? '' : `<td><div class="who">${avatar(p || { first_name: r.member_name }, 'sm')}<span class="name">${esc(r.member_name)}</span></div></td>`}
          <td><div>${esc(fmtWeekday(day))}, ${esc(fmtDateShort(day))}</div><div class="small muted num">${esc(fmtTime(r.started_at))}</div></td>
          <td class="num">${esc(fmtTime(r.last_seen_at))}</td>
          <td class="num">${r.ended_at ? `${r.end_estimated ? '~' : ''}${esc(fmtTime(r.ended_at))}${r.end_estimated ? '<span class="est">est.</span>' : ''}` : '<span class="muted">—</span>'}</td>
          <td class="r">${fmtDuration(r.duration_seconds)}</td>
          <td class="r"><b>${fmtDuration(r.active_seconds)}</b></td>
          <td class="r">${fmtDuration(r.idle_seconds)}</td>
          <td>${r.status === 'ended' ? '<span class="badge outline">Ended</span>' : presenceTag(r.status, r.status === 'active' ? 'Active now' : 'Idle now')}</td>
          <td class="small muted">${esc(r.device || '—')}</td>
          <td class="small">${r.ended_at ? esc(END[r.end_reason] || r.end_reason || '—') : '<span class="muted">Still open</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }

  container.querySelector('[data-csv]').onclick = () => {
    const out = [['Member', 'Login date', 'Login time', 'Last seen', 'Logout time', 'Logout estimated', 'Duration (h)', 'Active (h)', 'Idle (h)', 'Status', 'Device', 'End reason']];
    rows.forEach((r) => out.push([r.member_name, localDate(r.started_at), fmtTime(r.started_at), fmtDateTime(r.last_seen_at), r.ended_at ? fmtDateTime(r.ended_at) : '',
      r.end_estimated ? 'yes' : 'no', hours(r.duration_seconds), hours(r.active_seconds), hours(r.idle_seconds), r.status, r.device || '', r.end_reason || '']));
    const { from, to } = periodRange(period);
    downloadCSV(`login-history_${from}_to_${to}.csv`, out);
  };

  const safe = () => load().catch((e) => { table.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  await safe();
  const poll = setInterval(safe, 60_000);
  return () => clearInterval(poll);
}
