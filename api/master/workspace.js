// One workspace: details, edit, regenerate a set-password link.
//   GET   /api/master/workspace?id=<uuid>
//   PATCH /api/master/workspace?id=<uuid>   { name?, status?, roles?: [{role,edit}] }
//   POST  /api/master/workspace?id=<uuid>&action=link   { user_id, send?: boolean }
import { requireMaster, send } from '../../lib/master-guard.js';
import { makeLink, maskEmail, readJson, siteUrl } from '../../lib/invites.js';

const ROLES = ['sales_rep', 'lead_gen', 'cold_caller', 'finance', 'project_manager', 'project_agent'];
const STATUSES = ['setup', 'trial', 'active', 'suspended', 'archived'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const makeHandler = (masterGuard) => async function handler(req, res) {
  const guard = await masterGuard(req);
  if (!guard.ok) return send(res, guard.status, { error: guard.error });
  const admin = guard.admin;

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id') || '';
  if (!UUID.test(id)) return send(res, 400, { error: 'Invalid workspace id' });

  const { data: ws, error: wErr } = await admin.from('workspaces')
    .select('id,name,slug,short_code,type,status,created_at').eq('id', id).maybeSingle();
  if (wErr) return send(res, 502, { error: wErr.message });
  if (!ws) return send(res, 404, { error: 'Workspace not found' });

  if (req.method === 'GET')   return details(admin, ws, res);
  if (req.method === 'PATCH') return update(admin, ws, req, res);
  if (req.method === 'DELETE') return purge(admin, ws, req, res);
  if (req.method === 'POST' && url.searchParams.get('action') === 'link') return regenerate(admin, ws, req, res);
  send(res, 405, { error: 'Method not allowed' });
};
export default makeHandler(requireMaster);

async function details(admin, ws, res) {
  const [roles, subs, people] = await Promise.all([
    admin.from('workspace_roles').select('role_key,active,can_edit').eq('workspace_id', ws.id),
    admin.from('subscriptions').select('cycle,amount_original,currency,next_due,trial_ends_on,status').eq('workspace_id', ws.id).limit(1),
    admin.from('profiles').select('id,name,email,account_type,status').eq('workspace_id', ws.id),
  ]);
  const team = [];
  for (const p of people.data || []) {
    let pending = false;
    try { const u = await admin.auth.admin.getUserById(p.id); pending = !u.data?.user?.last_sign_in_at; } catch { /* ignore */ }
    team.push({ id: p.id, name: p.name, email: maskEmail(p.email), account_type: p.account_type, status: p.status, pending });
  }
  const order = { admin: 0, manager: 1, member: 2 };
  team.sort((a, b) => order[a.account_type] - order[b.account_type]);
  send(res, 200, {
    workspace: ws,
    roles: (roles.data || []).filter((r) => r.active).map((r) => ({ role: r.role_key, edit: r.can_edit })),
    subscription: (subs.data || [])[0] || null,
    team,
  });
}

async function update(admin, ws, req, res) {
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  const errs = [], patch = {};
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (!n || n.length > 80) errs.push('name must be 1-80 characters'); else patch.name = n;
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) errs.push('invalid status'); else patch.status = body.status;
    patch.archived_at = body.status === 'archived' ? new Date().toISOString() : null;
  }
  let roleMap = null;
  if (body.roles !== undefined) {
    if (!Array.isArray(body.roles)) errs.push('roles must be an array');
    else {
      roleMap = new Map();
      for (const r of body.roles) {
        if (!r || !ROLES.includes(r.role)) { errs.push('invalid role'); continue; }
        roleMap.set(r.role, r.edit === true);
      }
    }
  }
  if (errs.length) return send(res, 400, { error: errs.join('; ') });

  if (Object.keys(patch).length) {
    const { error } = await admin.from('workspaces').update(patch).eq('id', ws.id);
    if (error) return send(res, 502, { error: error.message });
  }
  if (roleMap) {
    const rows = ROLES.map((role) => ({
      workspace_id: ws.id, role_key: role, active: roleMap.has(role), can_edit: roleMap.get(role) === true,
    }));
    const { error } = await admin.from('workspace_roles').upsert(rows, { onConflict: 'workspace_id,role_key' });
    if (error) return send(res, 502, { error: error.message });
  }
  send(res, 200, { ok: true });
}

async function regenerate(admin, ws, req, res) {
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  if (!UUID.test(body.user_id || '')) return send(res, 400, { error: 'Invalid user' });

  const { data: p } = await admin.from('profiles').select('id,email,workspace_id,is_master')
    .eq('id', body.user_id).maybeSingle();
  if (!p || p.workspace_id !== ws.id || p.is_master) return send(res, 404, { error: 'Person not found in this workspace' });

  const r = await makeLink(admin, p.email);
  if (r.error) return send(res, 502, { error: r.error });

  let emailed = false;
  if (body.send === true) {
    const { error } = await admin.auth.resetPasswordForEmail(p.email, { redirectTo: `${siteUrl()}/set-password.html` });
    emailed = !error;
  }
  send(res, 200, { link: r.link, emailed, expires: 'about 1 hour' });
}

// Permanent delete of a whole workspace and everything inside it. The Master types the business name to confirm.
async function purge(admin, ws, req, res) {
  let body = {}; try { body = await readJson(req); } catch { /* empty is fine */ }
  if (String(body.confirm || '').trim().toLowerCase() !== String(ws.name).trim().toLowerCase()) return send(res, 400, { error: 'The name you typed does not match' });
  const { data: ids, error } = await admin.rpc('purge_workspace', { p_id: ws.id });
  if (error) return send(res, 502, { error: error.message });
  let failed = 0;
  for (const id of ids || []) { const r = await admin.auth.admin.deleteUser(id); if (r.error) failed++; }
  send(res, 200, { ok: true, accounts_left: failed });
}
