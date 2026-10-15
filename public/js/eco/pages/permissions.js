// Admin: what each role can see, edit and delete
import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q } from '../data.js';
import { esc, icon, toast, loadingBlock, ROLE_ICONS } from '../ui.js';

const MODULES = [['leads', 'Leads'], ['clients', 'Clients'], ['projects', 'Projects'], ['finance', 'Finance']];
const ACTIONS = [['view', 'Can see'], ['edit', 'Can edit'], ['delete', 'Can delete']];

export async function render({ el }) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Permissions</h1><p>Turn on what each role can see, edit and delete. Changes apply right away.</p></div></div>
    <section class="panel"><div class="table-wrap" id="perm">${loadingBlock(5)}</div></section>
    <div class="explain" style="margin-top:14px">${icon('info', 14)}<span>Admin and Manager always have full access. Project Manager settings apply only to the projects assigned to them: Clients = that project's client details, Finance = that project's invoices. Project members can always see the projects they're approved on. Tasks are always visible to the person they're assigned to. Members see new tabs after they reload the app.</span></div>`;
  const box = el.querySelector('#perm');
  let rows = [];

  function draw() {
    const roles = state.roles.filter((r) => r.key !== 'manager');
    const get = (role, mod) => rows.find((r) => r.role_key === role && r.module === mod) || { can_view: false, can_edit: false, can_delete: false };
    box.innerHTML = `<table class="table perm-table">
      <thead>
        <tr><th rowspan="2">Role</th>${MODULES.map(([, label]) => `<th colspan="3" class="grp">${label}</th>`).join('')}</tr>
        <tr>${MODULES.map(() => ACTIONS.map(([, label], i) => `<th class="c ${i === 0 ? 'first' : ''}">${label}</th>`).join('')).join('')}</tr>
      </thead>
      <tbody>
        <tr><td><div class="row"><span class="role-badge" data-role="manager" style="width:28px;height:28px;border-radius:8px">${icon('users', 14)}</span><b style="font-weight:500">Manager</b></div></td>
          <td colspan="${MODULES.length * 3}" class="c first lock">Full access to everything, like the admin</td></tr>
        ${roles.map((r) => `<tr>
          <td><div class="row"><span class="role-badge" data-role="${esc(r.key)}" style="width:28px;height:28px;border-radius:8px">${icon(ROLE_ICONS[r.key] || 'briefcase', 14)}</span>
            <div><b style="font-weight:500">${esc(r.name)}</b>${r.key === 'project_manager' ? '<div class="small muted">Only projects assigned to them</div>' : ''}</div></div></td>
          ${MODULES.map(([mod]) => ACTIONS.map(([act], i) => {
            const v = get(r.key, mod)[`can_${act}`];
            return `<td class="c ${i === 0 ? 'first' : ''}"><label class="switch" title="${esc(r.name)}: ${act} ${mod}">
              <input type="checkbox" data-role="${esc(r.key)}" data-mod="${mod}" data-act="${act}" ${v ? 'checked' : ''} ${state.isOwner ? '' : 'disabled'} aria-label="${esc(r.name)} ${act} ${mod}"><span></span></label></td>`;
          }).join('')).join('')}
        </tr>`).join('')}
      </tbody></table>`;
  }

  box.addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-act]'); if (!input) return;
    const { role, mod, act } = input.dataset;
    const cur = rows.find((r) => r.role_key === role && r.module === mod);
    const next = { can_view: cur?.can_view, can_edit: cur?.can_edit, can_delete: cur?.can_delete, [`can_${act}`]: input.checked };
    if (act !== 'view' && input.checked) next.can_view = true;          // editing needs seeing
    if (act === 'view' && !input.checked) { next.can_edit = false; next.can_delete = false; }
    input.disabled = true;
    try {
      await q(supabase.from('role_permissions').update(next).eq('workspace_id', state.workspace.id).eq('role_key', role).eq('module', mod));
      Object.assign(cur, next);
      toast('Permission saved');
    } catch (err) { toast(err.message, 'error'); }
    draw();
  });

  rows = await q(supabase.from('role_permissions').select('*').eq('workspace_id', state.workspace.id));
  draw();
}
