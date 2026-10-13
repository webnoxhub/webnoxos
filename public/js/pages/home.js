import { esc } from '/js/ui.js';

const ROLE_LABEL = { sales_rep: 'Sales Rep', lead_gen: 'Lead Gen', cold_caller: 'Cold Caller', finance: 'Finance', project_manager: 'Project Manager' };
const TYPE_LABEL = { admin: 'Admin', manager: 'Manager', member: 'Member' };

export default async function render({ el, sb, profile, setTitle, workspace }) {
  setTitle('Home');
  const { data } = await sb.from('profiles').select('roles,job_title,department').eq('id', profile.id).maybeSingle();
  const roles = (data && data.roles) || [];
  el.innerHTML =
    '<section class="card home-card">' +
      '<h2 class="home-hi">Welcome, ' + esc((profile.name || '').split(' ')[0] || 'there') + '</h2>' +
      '<p class="muted">You are signed in to <strong>' + esc(workspace ? workspace.name : '') + '</strong> as ' +
        esc(TYPE_LABEL[profile.account_type] || 'Member') + (data && data.job_title ? ' · ' + esc(data.job_title) : '') + '.</p>' +
      (roles.length ? '<p class="home-roles">' + roles.map((r) => '<span class="chip chip-accent">' + esc(ROLE_LABEL[r] || r) + '</span>').join(' ') + '</p>' : '') +
      '<p class="muted small">Tasks, leads and finance are coming next. Your team is already available under Team.</p>' +
    '</section>';
}
