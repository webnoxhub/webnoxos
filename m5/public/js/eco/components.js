// Reusable pieces: the day ribbon, period picker, bar chart, stats strip.
import { esc, icon } from './ui.js';
import { fmtDuration, fmtTime, fmtRelative, periodLabel, shiftPeriod, todayStr, secondsIntoDay, periodRange } from './time.js';

const DAY = 86400;
const hhmm = (sec) => {
  const h = Math.floor(sec / 3600) % 24; const m = Math.floor((sec % 3600) / 60);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ampm}`;
};

// blocks: [{ kind: 'active'|'idle'|'timer', start_sec, end_sec }]
export function ribbon(blocks = [], { isToday = false, size = '' } = {}) {
  const pct = (s) => `${Math.max(0, Math.min(100, (s / DAY) * 100)).toFixed(3)}%`;
  const w = (a, b) => `${Math.max(0.15, ((b - a) / DAY) * 100).toFixed(3)}%`;
  const label = { active: 'Active', idle: 'Idle', timer: 'Task timer' };
  const html = blocks.map((b) => `<span class="blk ${b.kind}" style="left:${pct(b.start_sec)};width:${w(b.start_sec, b.end_sec)}" title="${label[b.kind]} ${hhmm(b.start_sec)} – ${hhmm(b.end_sec)}"></span>`).join('');
  const now = isToday ? `<span class="now" style="left:${pct(secondsIntoDay())}" title="Now"></span>` : '';
  return `<div class="ribbon ${size}" role="img" aria-label="Activity during the day"><div class="track"></div>${html}${now}</div>`;
}
export const ribbonAxis = () => '<div class="ribbon-axis" aria-hidden="true"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span></div>';
export const ribbonLegend = () => '<div class="legend"><span><i class="active"></i>Active in app</span><span><i class="idle"></i>Idle</span><span><i class="timer"></i>Task timer</span></div>';

// Stats strip: groups = [[{ v, k, cls, dot }...], ...]
export function statsStrip(groups) {
  return `<div class="stats-wrap">${groups.map((g) => `<div class="stats"><div class="stat-group">${g.map((s) => `
    <div class="stat"><div class="v ${s.cls || ''}">${s.v}</div><div class="k">${s.dot ? `<i class="${s.dot}"></i>` : ''}${esc(s.k)}</div></div>`).join('')}</div></div>`).join('')}</div>`;
}

// Period picker (Day / Week / Month / Custom)
export function periodPicker(container, initial, onChange) {
  let p = { ...initial };
  const render = () => {
    const custom = p.mode === 'custom';
    container.innerHTML = `
      <div class="period">
        <div class="seg" role="group" aria-label="Period">
          ${['day', 'week', 'month', 'custom'].map((m) => `<button type="button" data-mode="${m}" aria-pressed="${p.mode === m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}
        </div>
        ${custom ? `
          <input type="date" class="input" data-from value="${esc(p.from)}" aria-label="From">
          <span class="muted">to</span>
          <input type="date" class="input" data-to value="${esc(p.to)}" aria-label="To">
        ` : `
          <button type="button" class="btn btn-sm btn-icon" data-prev aria-label="Previous">${icon('chevronL')}</button>
          <span class="range-label">${esc(periodLabel(p))}</span>
          <button type="button" class="btn btn-sm btn-icon" data-next aria-label="Next">${icon('chevronR')}</button>
          ${p.mode === 'day' ? `<input type="date" class="input" data-day value="${esc(p.anchor)}" aria-label="Pick a day">` : ''}
          <button type="button" class="btn btn-sm btn-ghost" data-today>Today</button>
        `}
      </div>`;
    container.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
      const mode = b.dataset.mode;
      if (mode === 'custom') { const r = periodRange(p); p = { mode, anchor: p.anchor, from: r.from, to: r.to }; }
      else p = { ...p, mode };
      render(); onChange(p);
    });
    container.querySelector('[data-prev]')?.addEventListener('click', () => { p = shiftPeriod(p, -1); render(); onChange(p); });
    container.querySelector('[data-next]')?.addEventListener('click', () => { p = shiftPeriod(p, 1); render(); onChange(p); });
    container.querySelector('[data-today]')?.addEventListener('click', () => { p = { ...p, anchor: todayStr() }; render(); onChange(p); });
    container.querySelector('[data-day]')?.addEventListener('change', (e) => { if (e.target.value) { p = { ...p, anchor: e.target.value }; render(); onChange(p); } });
    const from = container.querySelector('[data-from]'); const to = container.querySelector('[data-to]');
    const customChange = () => {
      if (!from.value || !to.value) return;
      p = { ...p, from: from.value <= to.value ? from.value : to.value, to: from.value <= to.value ? to.value : from.value };
      onChange(p);
    };
    from?.addEventListener('change', customChange); to?.addEventListener('change', customChange);
  };
  render();
  return { get: () => p };
}

// Bar chart: rows = [{ label, title, active, idle, timer }] (seconds)
export function barChart(rows) {
  if (!rows.length) return '';
  const max = Math.max(3600, ...rows.map((r) => Math.max(r.active + r.idle, r.timer)));
  const stepH = max > 10 * 3600 ? 4 : max > 4 * 3600 ? 2 : 1;
  const top = Math.ceil(max / 3600 / stepH) * stepH * 3600;
  const lines = [];
  for (let h = stepH; h * 3600 <= top; h += stepH) lines.push(h);
  const H = (s) => `${(s / top) * 100}%`;
  const dense = rows.length > 16;
  return `
    <div class="bars">
      <div class="gridlines">${lines.map((h) => `<div style="bottom:${H(h * 3600)}"><span>${h}h</span></div>`).join('')}</div>
      ${rows.map((r) => `
        <div class="col" title="${esc(r.title || r.label)}
Signed in ${fmtDuration(r.active + r.idle)} · Active ${fmtDuration(r.active)} · Idle ${fmtDuration(r.idle)} · Task timer ${fmtDuration(r.timer)}">
          <div class="stack-bar" style="height:${H(r.active + r.idle)}"><div class="seg-active" style="height:${r.active + r.idle ? (r.active / (r.active + r.idle)) * 100 : 0}%"></div><div class="seg-idle" style="flex:1"></div></div>
          <div class="timer-bar" style="height:${H(r.timer)}"></div>
        </div>`).join('')}
    </div>
    <div class="bar-labels">${rows.map((r, i) => `<span>${dense && i % 2 ? '' : esc(r.label)}</span>`).join('')}</div>`;
}

export const timeRange = (a, b) => `${fmtTime(a)} – ${b ? fmtTime(b) : 'now'}`;

// ---------- Activity log rows ----------
export const EVENT_LABELS = {
  login: 'Signed in', logout: 'Signed out', invite_accepted: 'Joined', admin_provisioned: 'Admin set up',
  member_invited: 'Member invited', member_activated: 'Member activated', member_deactivated: 'Member deactivated',
  member_roles_changed: 'Roles changed', invite_resent: 'Invite link', reset_link_created: 'Reset link',
  task_created: 'Task created', task_assigned: 'Task assigned', task_reassigned: 'Task reassigned', task_updated: 'Task updated',
  task_status_changed: 'Status changed', task_submitted: 'Submitted for review', task_approved: 'Task approved',
  revision_requested: 'Changes requested', comment_added: 'Comment',
  timer_started: 'Timer started', timer_paused: 'Timer paused', timer_resumed: 'Timer resumed', timer_stopped: 'Timer stopped',
  settings_changed: 'Settings changed', permission_changed: 'Permission changed',
  lead_created: 'Lead added', lead_status_changed: 'Lead updated', lead_won: 'Lead won', lead_lost: 'Lead lost', lead_deleted: 'Lead deleted',
  client_created: 'Client added', client_pm_assigned: 'PM assigned', client_status_changed: 'Client updated', client_deleted: 'Client deleted',
  invoice_created: 'Invoice added', invoice_paid: 'Invoice paid', invoice_updated: 'Invoice updated', invoice_deleted: 'Invoice deleted',
  file_uploaded: 'File uploaded', file_deleted: 'File deleted', lead_converted: 'Converted to client',
  client_agent_added: 'Agent added', client_agent_removed: 'Agent removed',
  expense_added: 'Expense added', expense_updated: 'Expense updated', expense_deleted: 'Expense deleted',
  recurring_added: 'Bill added', recurring_deleted: 'Bill removed', recurring_paid: 'Bill paid', recurring_skipped: 'Bill skipped',
  investment_added: 'Investment added', investment_deleted: 'Investment deleted',
  project_created: 'Project created', project_pm_assigned: 'PM assigned', project_status_changed: 'Project updated', project_deleted: 'Project deleted',
  project_member_added: 'Added to project', project_member_requested: 'Approval asked', project_member_approved: 'Approved', project_member_rejected: 'Not approved',
  project_member_cancelled: 'Request cancelled', project_member_removed: 'Removed from project', requirement_added: 'Requirement added', requirement_done: 'Requirement met',
};
export const EVENT_GROUPS = [
  ['Sign-ins', ['login', 'logout']],
  ['Tasks', ['task_created', 'task_assigned', 'task_reassigned', 'task_updated', 'task_status_changed', 'task_submitted', 'task_approved', 'revision_requested']],
  ['Timers', ['timer_started', 'timer_paused', 'timer_resumed', 'timer_stopped']],
  ['Team', ['member_invited', 'invite_accepted', 'member_activated', 'member_deactivated', 'member_roles_changed', 'invite_resent', 'reset_link_created']],
  ['Leads & clients', ['lead_created', 'lead_status_changed', 'lead_won', 'lead_lost', 'lead_converted', 'lead_deleted', 'client_agent_added', 'client_agent_removed', 'client_created', 'client_pm_assigned', 'client_status_changed', 'client_deleted', 'file_uploaded', 'file_deleted']],
  ['Projects', ['project_created', 'project_pm_assigned', 'project_status_changed', 'project_deleted', 'project_member_added', 'project_member_requested', 'project_member_approved', 'project_member_rejected', 'project_member_cancelled', 'project_member_removed', 'requirement_added', 'requirement_done']],
  ['Finance', ['invoice_created', 'invoice_paid', 'invoice_updated', 'invoice_deleted', 'expense_added', 'expense_updated', 'expense_deleted', 'recurring_added', 'recurring_deleted', 'recurring_paid', 'recurring_skipped', 'investment_added', 'investment_deleted']],
  ['Settings', ['settings_changed', 'permission_changed', 'admin_provisioned']],
];
const evClass = (a) => a.startsWith('task_') || a === 'revision_requested' ? 'task' : a.startsWith('timer_') ? 'timer'
  : ['login', 'logout'].includes(a) ? 'signin' : /member|invite|reset_link|admin_/.test(a) ? 'member' : /^(lead|client|file)_/.test(a) ? 'task' : /^(invoice|expense|recurring|investment)_/.test(a) ? 'timer' : /^(project|requirement)_/.test(a) ? 'task' : '';

export function logItem(l, { time = 'time', meId = null } = {}) {
  const whoName = l.actor_id && l.actor_id === meId ? 'You' : (l.actor_name || 'System');
  const taskLink = l.entity_type === 'task' && l.entity_id ? ` <button class="linkish small" data-open-task="${esc(l.entity_id)}">Task #${esc(l.entity_id)}</button>` : '';
  return `
    <div class="log-item">
      <div class="when">${esc(time === 'time' ? fmtTime(l.created_at) : fmtTimeAgo(l.created_at))}</div>
      <div class="what"><b>${esc(whoName)}</b><p>${esc(l.description)}${taskLink}</p></div>
      <span class="ev ${evClass(l.action)}">${esc(EVENT_LABELS[l.action] || l.action.replace(/_/g, ' '))}</span>
    </div>`;
}
const fmtTimeAgo = (iso) => fmtRelative(iso);

// Revenue by month: rows = [{ month: 'YYYY-MM', revenue }]
export function moneyBars(rows, fmt) {
  const max = Math.max(1, ...rows.map((r) => Number(r.revenue)));
  const label = (m) => new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(m + '-01T00:00:00Z'));
  return `<div class="mbars">${rows.map((r, i) => `<div class="col ${i === rows.length - 1 ? 'now' : ''}" title="${esc(r.month)}: ${esc(fmt(r.revenue))}">
      ${Number(r.revenue) ? `<span class="val">${esc(fmt(r.revenue, { compact: true }))}</span>` : ''}<div class="bar" style="height:${(Number(r.revenue) / max) * 100}%"></div></div>`).join('')}</div>
    <div class="mlabels">${rows.map((r) => `<span>${label(r.month)}</span>`).join('')}</div>`;
}
