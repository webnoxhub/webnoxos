// Team management inside ONE workspace (the caller's own).
//   GET   /api/team/members                       list people + roles this workspace has
//   POST  /api/team/members                       add a person, returns a set-password link
//   PATCH /api/team/members?id=<uuid>             edit / activate / deactivate
//   POST  /api/team/members?id=<uuid>&action=link regenerate the set-password link
import { requireTeamManager } from '../../lib/team-guard.js';
import { send } from '../../lib/master-guard.js';
import { makeLink, readJson, siteUrl } from '../../lib/invites.js';
import { canManage, canAssignType, checkMember, checkLogo } from '../../lib/team-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const makeHandler = (guard) => async function handler(req, res) {
  const g = await guard(req);
  if (!g.ok) return send(res, g.status, { error: g.error });
  const { admin, me, workspace } = g;

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');

  const { data: rr } = await admin.from('workspace_roles').select('role_key').eq('workspace_id', workspace.id).eq('active', true);
  const activeRoles = (rr || []).map((r) => r.role_key);

  if (req.method === 'GET' && !id) return list(admin, workspace, me, activeRoles, res);
  if (req.method === 'POST' && !id && url.searchParams.get('action') === 'logo') return setLogo(admin, me, workspace, req, res);
  if (req.method === 'POST' && !id) return create(admin, workspace, me, activeRoles, req, res);

  if (!id || !UUID.test(id)) return send(res, 400, { error: 'Invalid person' });
  // The target must belong to the caller's workspace. Anything else looks like "not found".
  const { data: target } = await admin.from('profiles')
    .select('id,name,email,account_type,status,workspace_id,is_master,reports_to').eq('id', id).eq('workspace_id', workspace.id).maybeSingle();
  if (!target || target.is_master) return send(res, 404, { error: 'Person not found' });
  if (!canManage(me.account_type, target.account_type, target.id === me.id)) return send(res, 403, { error: 'You cannot manage this person' });

  if (req.method === 'PATCH') return edit(admin, me, target, activeRoles, req, res);
  if (req.method === 'POST' && url.searchParams.get('action') === 'link') return regenerate(admin, workspace, target, req, res);
  if (req.method === 'POST' && url.searchParams.get('action') === 'delete') return remove(admin, me, target, req, res);
  send(res, 405, { error: 'Method not allowed' });
};
export default makeHandler(requireTeamManager);

async function list(admin, ws, me, activeRoles, res) {
  const { data, error } = await admin.from('profiles')
    .select('id,name,email,phone,joining_date,department,job_title,account_type,status,roles,reports_to,last_seen_at,avatar_url')
    .eq('workspace_id', ws.id).eq('is_master', false).order('created_at', { ascending: true });
  if (error) return send(res, 502, { error: error.message });
  const people = [];
  for (const p of data || []) {
    let pending = false;
    try { const u = await admin.auth.admin.getUserById(p.id); pending = !u.data?.user?.last_sign_in_at; } catch { /* ignore */ }
    people.push({ ...p, pending, manageable: canManage(me.account_type, p.account_type, p.id === me.id) });
  }
  const managers = people.filter((x) => x.status === 'active' && ['admin', 'manager'].includes(x.account_type))
    .map((x) => ({ id: x.id, name: x.name, department: x.department, account_type: x.account_type }));
  send(res, 200, { people, managers, roles: activeRoles, me: { id: me.id, account_type: me.account_type }, workspace: { name: ws.name, slug: ws.slug } });
}

async function create(admin, ws, me, activeRoles, req, res) {
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  const { errors, value: v } = checkMember(body, activeRoles, { create: true });
  const type = body.account_type || 'member';
  if (!canAssignType(me.account_type, type)) errors.push('You cannot add this kind of person');
  if (errors.length) return send(res, 400, { error: errors.join('; ') });

  if (type !== 'member') v.reports_to = null;
  if (v.reports_to && !(await validBoss(admin, ws.id, v.reports_to))) return send(res, 400, { error: 'Pick a manager from this workspace' });

  const { data: ex } = await admin.from('profiles').select('id').eq('email', v.email).maybeSingle();
  if (ex) return send(res, 409, { error: 'This email already has an account.' });

  const r = await makeLink(admin, v.email, { name: v.name });
  if (r.error) return send(res, 502, { error: r.error });

  const { error } = await admin.from('profiles').update({
    workspace_id: ws.id, account_type: type, name: v.name, phone: v.phone ?? null,
    joining_date: v.joining_date ?? null, department: v.department ?? null, job_title: v.job_title ?? null, roles: v.roles,
    reports_to: v.reports_to ?? null,
  }).eq('id', r.user.id);
  if (error) {
    try { await admin.auth.admin.deleteUser(r.user.id); } catch { /* best effort: no half-made account */ }
    return send(res, 502, { error: error.message });
  }
  send(res, 201, { id: r.user.id, link: r.link, expires: 'about 1 hour' });
}

async function edit(admin, me, target, activeRoles, req, res) {
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  const { errors, value: v } = checkMember(body, activeRoles, { create: false });
  const self = target.id === me.id;
  if (v.account_type !== undefined) {
    if (self) errors.push('You cannot change your own type');
    else if (!canAssignType(me.account_type, v.account_type)) errors.push('You cannot set this type');
  }
  if (v.status !== undefined && self) errors.push('You cannot change your own status');
  if (errors.length) return send(res, 400, { error: errors.join('; ') });
  const finalType = v.account_type || target.account_type;
  if (finalType !== 'member') { if (target.reports_to || v.reports_to !== undefined || v.account_type) v.reports_to = null; }
  else if (v.reports_to && !(await validBoss(admin, target.workspace_id, v.reports_to, target.id))) return send(res, 400, { error: 'Pick a manager from this workspace' });
  if (!Object.keys(v).length) return send(res, 200, { ok: true });

  const { error } = await admin.from('profiles').update(v).eq('id', target.id).eq('workspace_id', target.workspace_id);
  if (error) return send(res, 502, { error: error.message });
  // Switched off: end his open sessions and pause his task timer right away.
  if (v.status === 'inactive') await admin.rpc('close_member_sessions', { p_member: target.id });
  send(res, 200, { ok: true });
}

async function regenerate(admin, ws, target, req, res) {
  let body = {}; try { body = await readJson(req); } catch { /* empty is fine */ }
  const r = await makeLink(admin, target.email);
  if (r.error) return send(res, 502, { error: r.error });
  let emailed = false;
  if (body.send === true) {
    const { error } = await admin.auth.resetPasswordForEmail(target.email, { redirectTo: `${siteUrl()}/set-password.html` });
    emailed = !error;
  }
  send(res, 200, { link: r.link, emailed, expires: 'about 1 hour' });
}

async function validBoss(admin, wsId, bossId, selfId) {
  if (bossId === selfId) return false;
  const { data } = await admin.from('profiles').select('id,account_type,status').eq('id', bossId).eq('workspace_id', wsId).maybeSingle();
  return !!data && data.status === 'active' && ['admin', 'manager'].includes(data.account_type);
}

// Permanent delete: Admin only, never himself, never another admin. Name must be typed to confirm.
async function remove(admin, me, target, req, res) {
  let body = {}; try { body = await readJson(req); } catch { /* empty is fine */ }
  if (me.account_type !== 'admin' || target.id === me.id || target.account_type === 'admin') return send(res, 403, { error: 'You cannot delete this person' });
  const want = String(target.name || target.email || '').trim().toLowerCase();
  if (!want || String(body.confirm || '').trim().toLowerCase() !== want) return send(res, 400, { error: 'The name you typed does not match' });
  const r1 = await admin.rpc('purge_person_activity', { p_id: target.id });
  if (r1.error) return send(res, 502, { error: r1.error.message });
  const r2 = await admin.auth.admin.deleteUser(target.id);
  if (r2.error) return send(res, 502, { error: r2.error.message });
  send(res, 200, { ok: true });
}

async function setLogo(admin, me, ws, req, res) {
  if (me.account_type !== 'admin') return send(res, 403, { error: 'Only the Admin can change the logo' });
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  const { error, value } = checkLogo(body.logo);
  if (error) return send(res, 400, { error });
  const logo_only = value ? body.logo_only === true : false;   // only a logo can stand alone
  const { error: e } = await admin.from('workspaces').update({ logo_url: value, logo_only }).eq('id', ws.id);
  if (e) return send(res, 502, { error: e.message });
  send(res, 200, { ok: true, logo_url: value, logo_only });
}
