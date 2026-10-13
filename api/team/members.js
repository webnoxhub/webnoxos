// Team management inside ONE workspace (the caller's own).
//   GET   /api/team/members                       list people + roles this workspace has
//   POST  /api/team/members                       add a person, returns a set-password link
//   PATCH /api/team/members?id=<uuid>             edit / activate / deactivate
//   POST  /api/team/members?id=<uuid>&action=link regenerate the set-password link
import { requireTeamManager } from '../../lib/team-guard.js';
import { send } from '../../lib/master-guard.js';
import { makeLink, readJson, siteUrl } from '../../lib/invites.js';
import { canManage, canAssignType, checkMember } from '../../lib/team-rules.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  const g = await requireTeamManager(req);
  if (!g.ok) return send(res, g.status, { error: g.error });
  const { admin, me, workspace } = g;

  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');

  const { data: rr } = await admin.from('workspace_roles').select('role_key').eq('workspace_id', workspace.id).eq('active', true);
  const activeRoles = (rr || []).map((r) => r.role_key);

  if (req.method === 'GET' && !id) return list(admin, workspace, me, activeRoles, res);
  if (req.method === 'POST' && !id) return create(admin, workspace, me, activeRoles, req, res);

  if (!id || !UUID.test(id)) return send(res, 400, { error: 'Invalid person' });
  // The target must belong to the caller's workspace. Anything else looks like "not found".
  const { data: target } = await admin.from('profiles')
    .select('id,name,email,account_type,status,workspace_id,is_master').eq('id', id).eq('workspace_id', workspace.id).maybeSingle();
  if (!target || target.is_master) return send(res, 404, { error: 'Person not found' });
  if (!canManage(me.account_type, target.account_type, target.id === me.id)) return send(res, 403, { error: 'You cannot manage this person' });

  if (req.method === 'PATCH') return edit(admin, me, target, activeRoles, req, res);
  if (req.method === 'POST' && url.searchParams.get('action') === 'link') return regenerate(admin, workspace, target, req, res);
  send(res, 405, { error: 'Method not allowed' });
}

async function list(admin, ws, me, activeRoles, res) {
  const { data, error } = await admin.from('profiles')
    .select('id,name,email,phone,joining_date,department,job_title,account_type,status,roles,last_seen_at')
    .eq('workspace_id', ws.id).eq('is_master', false).order('created_at', { ascending: true });
  if (error) return send(res, 502, { error: error.message });
  const people = [];
  for (const p of data || []) {
    let pending = false;
    try { const u = await admin.auth.admin.getUserById(p.id); pending = !u.data?.user?.last_sign_in_at; } catch { /* ignore */ }
    people.push({ ...p, pending, manageable: canManage(me.account_type, p.account_type, p.id === me.id) });
  }
  send(res, 200, { people, roles: activeRoles, me: { id: me.id, account_type: me.account_type }, workspace: { name: ws.name, slug: ws.slug } });
}

async function create(admin, ws, me, activeRoles, req, res) {
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  const { errors, value: v } = checkMember(body, activeRoles, { create: true });
  const type = body.account_type || 'member';
  if (!canAssignType(me.account_type, type)) errors.push('You cannot add this kind of person');
  if (errors.length) return send(res, 400, { error: errors.join('; ') });

  const { data: ex } = await admin.from('profiles').select('id').eq('email', v.email).maybeSingle();
  if (ex) return send(res, 409, { error: 'This email already has an account.' });

  const r = await makeLink(admin, v.email, { name: v.name });
  if (r.error) return send(res, 502, { error: r.error });

  const { error } = await admin.from('profiles').update({
    workspace_id: ws.id, account_type: type, name: v.name, phone: v.phone ?? null,
    joining_date: v.joining_date ?? null, department: v.department ?? null, job_title: v.job_title ?? null, roles: v.roles,
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
  if (!Object.keys(v).length) return send(res, 200, { ok: true });

  const { error } = await admin.from('profiles').update(v).eq('id', target.id).eq('workspace_id', target.workspace_id);
  if (error) return send(res, 502, { error: error.message });
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
