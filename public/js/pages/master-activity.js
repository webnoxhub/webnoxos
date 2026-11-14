import { esc } from '/js/ui.js';
import { fmtDateTime } from '/js/time.js';

const actions = {
  opened: 'Opened workspace', full_access_on: 'Enabled full access', full_access_off: 'Disabled full access',
  suspended: 'Suspended workspace', resumed: 'Resumed workspace', archived: 'Archived workspace',
  plan_changed: 'Changed plan', role_changed: 'Changed roles', payment_recorded: 'Recorded a rent payment',
  invoice_issued: 'Issued rent invoice', invoice_voided: 'Voided rent invoice',
};

export default async function render({ el, sb, setTitle }) {
  setTitle('Activity');
  el.innerHTML = '<p class="muted pad">Loading activity…</p>';
  const { data, error } = await sb.from('master_access_log')
    .select('action,at,workspaces(name)').order('at', { ascending: false }).limit(100);
  if (error) {
    el.innerHTML = '<div class="empty"><p>Could not load activity.</p><button class="btn" type="button">Try again</button></div>';
    el.querySelector('button').onclick = () => render({ el, sb, setTitle });
    return;
  }
  const rows = (data || []).map((entry) =>
    '<li class="row"><span class="row-main">' + esc(actions[entry.action] || entry.action) +
    (entry.workspaces?.name ? ' · ' + esc(entry.workspaces.name) : '') +
    '</span><span class="muted small">' + esc(fmtDateTime(entry.at)) + '</span></li>').join('');
  el.innerHTML = '<section class="card"><h2>Workspace activity</h2>' +
    (rows ? '<ul class="rows">' + rows + '</ul>' : '<p class="muted">No activity yet.</p>') + '</section>';
}
