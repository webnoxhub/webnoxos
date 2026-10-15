import { esc, icon } from '/js/ui.js';
import { todayISO, addDaysISO, monthStartISO, fmtDate, fmtDateTime, greeting, longDate, money } from '/js/time.js';
import { statusInfo, needsAttention } from '/js/billing.js';

const ACTION_LABEL = {
  opened: 'Opened workspace', full_access_on: 'Full access turned on', full_access_off: 'Full access turned off',
  suspended: 'Suspended workspace', resumed: 'Resumed workspace', archived: 'Archived workspace',
  plan_changed: 'Changed plan', role_changed: 'Changed roles', payment_recorded: 'Recorded a rent payment',
};

export default async function render({ el, sb, setTitle }) {
  setTitle('Home');
  const today = todayISO();
  el.innerHTML = '<p class="muted pad">Loading…</p>';

  const [wsR, subR, payR, logR] = await Promise.all([
    sb.from('workspaces').select('id,name,type,status'),
    sb.from('subscriptions').select('workspace_id,next_due,trial_ends_on,status,amount'),
    sb.from('subscription_payments').select('amount').gte('paid_on', monthStartISO()),
    sb.from('master_access_log').select('action,at,workspaces(name)').order('at', { ascending: false }).limit(8),
  ]);
  if (wsR.error || subR.error || payR.error || logR.error) {
    el.innerHTML = '<div class="empty"><p>Could not load your overview.</p><button class="btn" id="retry" type="button">Try again</button></div>';
    el.querySelector('#retry').addEventListener('click', () => render({ el, sb, setTitle }));
    return;
  }

  const workspaces = wsR.data || [], subs = subR.data || [];
  const subBy = Object.fromEntries(subs.map((s) => [s.workspace_id, s]));
  const live = workspaces.filter((w) => w.status === 'trial' || w.status === 'active').length;
  const weekEnd = addDaysISO(today, 7);
  const dueWeek = subs.filter((s) => s.next_due && s.next_due >= today && s.next_due <= weekEnd && s.status !== 'cancelled').length;
  const overdueAmt = subs.filter((s) => s.next_due && s.next_due < today && s.status !== 'cancelled')
    .reduce((a, s) => a + Number(s.amount || 0), 0);
  const collected = (payR.data || []).reduce((a, p) => a + Number(p.amount || 0), 0);

  const attention = workspaces
    .map((w) => ({ w, info: statusInfo(w, subBy[w.id], today) }))
    .filter((x) => needsAttention(x.info))
    .sort((a, b) => (a.info.days ?? 0) - (b.info.days ?? 0));

  const logs = logR.data || [];

  el.innerHTML =
    '<section class="hero"><h2>' + esc(greeting()) + '</h2><p>' + esc(longDate()) + '</p></section>' +
    '<section class="hero-cards" aria-label="Overview">' +
      card('Workspaces live', String(live), live === 1 ? 'workspace in trial or active' : 'workspaces in trial or active') +
      card('Due this week', String(dueWeek), 'rent due in the next 7 days') +
      card('Overdue amount', money(overdueAmt), 'past its due date') +
      card('Collected this month', money(collected), 'rent received') +
    '</section>' +
    '<div class="grid2">' +
      '<section class="card"><h3>Needs attention</h3>' + (attention.length
        ? '<ul class="rows">' + attention.map((x) =>
            '<li class="row"><span class="row-main">' + esc(x.w.name) + '</span>' +
            '<span class="chip chip-' + x.info.tone + '">' + esc(x.info.label) + '</span></li>').join('') + '</ul>'
        : '<div class="empty slim">' + icon('building', 28) + '<p>' + (workspaces.length
            ? 'Nothing needs attention right now.' : 'No workspaces yet. Workspaces you create will appear here.') + '</p></div>') +
      '</section>' +
      '<section class="card"><h3>Recent activity</h3>' + (logs.length
        ? '<ul class="rows">' + logs.map((l) =>
            '<li class="row"><span class="row-main">' + esc(ACTION_LABEL[l.action] || l.action) +
            (l.workspaces ? ' · ' + esc(l.workspaces.name) : '') + '</span>' +
            '<span class="muted small">' + esc(fmtDateTime(l.at)) + '</span></li>').join('') + '</ul>'
        : '<div class="empty slim">' + icon('pulse', 28) + '<p>No activity yet.</p></div>') +
      '</section>' +
    '</div>';
}

function card(label, value, note) {
  return '<div class="hero-card"><p class="hc-label">' + esc(label) + '</p><p class="hc-value">' + esc(value) +
    '</p><p class="hc-note">' + esc(note) + '</p></div>';
}
