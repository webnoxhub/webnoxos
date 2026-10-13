// Projects, staffing requests and approvals inside ONE workspace (the caller's own).
//   GET  ?a=list                       projects I can see (+ project managers, for the create form)
//   POST ?a=create                     new project (Admin / Manager)
//   GET  ?a=get&id=<project>           one project with members, requests, comments
//   POST ?a=update&id=<project>        edit / assign Project Manager (Admin / Manager)
//   POST ?a=request&id=<project>       Project Manager asks for people
//   POST ?a=decide&id=<request>        approve | decline | discuss (Admin / Manager, never your own)
//   POST ?a=comment&id=<request>       comment on a request
//   POST ?a=addmember&id=<project>     Project Manager fills an approved slot
//   POST ?a=removemember&id=<project>  Project Manager or Admin / Manager
import { requireWork, record, approvers } from '../lib/work-guard.js';
import { send } from '../lib/master-guard.js';
import { readJson } from '../lib/invites.js';
import {
  isAdminOrManager, isUuid, checkProject, checkRequest, canDecide, canMove, DECISIONS, itemsLabel, agentFits, say,
} from '../lib/project-rules.js';

export const makeHandler = (guard) => async function handler(req, res) {
  const g = await guard(req);
  if (!g.ok) return send(res, g.status, { error: g.error });
  const url = new URL(req.url, 'http://x');
  const a = url.searchParams.get('a') || '';
  const id = url.searchParams.get('id') || '';
  const ctx = { ...g, res };
  let body = {};
  if (req.method !== 'GET') { try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); } }

  try {
    if (req.method === 'GET' && a === 'list') return list(ctx);
    if (req.method === 'GET' && a === 'get') return detail(ctx, id);
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    switch (a) {
      case 'create': return create(ctx, body);
      case 'update': return update(ctx, id, body);
      case 'request': return makeRequest(ctx, id, body);
      case 'decide': return decide(ctx, id, body);
      case 'comment': return comment(ctx, id, body);
      case 'addmember': return addMember(ctx, id, body);
      case 'removemember': return removeMember(ctx, id, body);
      default: return send(res, 404, { error: 'Not found' });
    }
  } catch (e) { return send(res, 502, { error: e && e.message ? e.message : 'Something went wrong' }); }
};
export default makeHandler(requireWork);

const nameOf = async (admin, id) => {
  if (!id) return '';
  const { data } = await admin.from('profiles').select('name,email').eq('id', id).maybeSingle();
  return (data && (data.name || data.email)) || 'Someone';
};

// Load a project of MY workspace and tell whether I may see it.
async function loadProject(ctx, id) {
  if (!isUuid(id)) return null;
  const { admin, me, workspace } = ctx;
  const { data: p } = await admin.from('projects').select('*').eq('id', id).eq('workspace_id', workspace.id).maybeSingle();
  if (!p) return null;
  const boss = isAdminOrManager(me.account_type);
  let member = false;
  if (!boss && p.manager_id !== me.id) {
    const { data: pm } = await admin.from('project_members').select('user_id').eq('project_id', p.id).eq('user_id', me.id).maybeSingle();
    member = !!pm;
  }
  if (!(boss || p.manager_id === me.id || member)) return null;
  return p;
}

async function list({ admin, me, workspace, res }) {
  const boss = isAdminOrManager(me.account_type);
  const { data: all } = await admin.from('projects').select('id,name,client,status,manager_id,created_at').eq('workspace_id', workspace.id).order('created_at', { ascending: false });
  let rows = all || [];
  if (!boss) {
    const { data: mine } = await admin.from('project_members').select('project_id').eq('user_id', me.id);
    const ids = new Set((mine || []).map((x) => x.project_id));
    rows = rows.filter((p) => p.manager_id === me.id || ids.has(p.id));
  }
  const ids = rows.map((p) => p.id);
  const [{ data: mem }, { data: reqs }, { data: people }] = await Promise.all([
    ids.length ? admin.from('project_members').select('project_id').in('project_id', ids) : { data: [] },
    ids.length ? admin.from('staffing_requests').select('project_id,status').in('project_id', ids) : { data: [] },
    admin.from('profiles').select('id,name,roles,status').eq('workspace_id', workspace.id),
  ]);
  const nm = new Map((people || []).map((p) => [p.id, p.name]));
  const projects = rows.map((p) => ({
    ...p, manager_name: nm.get(p.manager_id) || null,
    members: (mem || []).filter((m) => m.project_id === p.id).length,
    open_requests: (reqs || []).filter((r) => r.project_id === p.id && ['pending', 'discussing'].includes(r.status)).length,
  }));
  const pms = boss ? (people || []).filter((p) => p.status === 'active' && (p.roles || []).includes('project_manager')).map((p) => ({ id: p.id, name: p.name })) : [];
  send(res, 200, { projects, pms, me: { id: me.id, account_type: me.account_type }, can_create: boss });
}

async function create({ admin, me, workspace, res }, body) {
  if (!isAdminOrManager(me.account_type)) return send(res, 403, { error: 'Only an Admin or Manager can create projects' });
  const { errors, value: v } = checkProject(body, { create: true });
  if (errors.length) return send(res, 400, { error: errors.join('; ') });
  if (v.manager_id && !(await isProjectManager(admin, workspace.id, v.manager_id))) return send(res, 400, { error: 'Pick a Project Manager from this workspace' });
  const { data: p, error } = await admin.from('projects').insert({ ...v, workspace_id: workspace.id, created_by: me.id }).select('id,name').single();
  if (error) return send(res, 502, { error: error.message });
  await record(admin, workspace.id, { actorId: me.id, projectId: p.id, text: say.projectCreated(me.name, p.name) });
  if (v.manager_id) {
    const mn = await nameOf(admin, v.manager_id);
    await record(admin, workspace.id, { actorId: me.id, projectId: p.id, text: say.managerAssigned(me.name, mn, p.name), to: [v.manager_id] });
  }
  send(res, 201, { id: p.id });
}

async function isProjectManager(admin, wsId, userId) {
  const { data } = await admin.from('profiles').select('roles,status').eq('id', userId).eq('workspace_id', wsId).maybeSingle();
  return !!data && data.status === 'active' && (data.roles || []).includes('project_manager');
}

async function update(ctx, id, body) {
  const { admin, me, workspace, res } = ctx;
  if (!isAdminOrManager(me.account_type)) return send(res, 403, { error: 'Only an Admin or Manager can edit projects' });
  const p = await loadProject(ctx, id);
  if (!p) return send(res, 404, { error: 'Project not found' });
  const { errors, value: v } = checkProject(body, { create: false });
  if (errors.length) return send(res, 400, { error: errors.join('; ') });
  if (v.manager_id && !(await isProjectManager(admin, workspace.id, v.manager_id))) return send(res, 400, { error: 'Pick a Project Manager from this workspace' });
  if (!Object.keys(v).length) return send(res, 200, { ok: true });
  const { error } = await admin.from('projects').update(v).eq('id', p.id).eq('workspace_id', workspace.id);
  if (error) return send(res, 502, { error: error.message });
  if (v.manager_id !== undefined && v.manager_id !== p.manager_id && v.manager_id) {
    const mn = await nameOf(admin, v.manager_id);
    await record(admin, workspace.id, { actorId: me.id, projectId: p.id, text: say.managerAssigned(me.name, mn, v.name || p.name), to: [v.manager_id] });
  }
  send(res, 200, { ok: true });
}

async function detail(ctx, id) {
  const { admin, me, workspace, res } = ctx;
  const p = await loadProject(ctx, id);
  if (!p) return send(res, 404, { error: 'Project not found' });
  const [{ data: reqs }, { data: mem }, { data: people }] = await Promise.all([
    admin.from('staffing_requests').select('*').eq('project_id', p.id).order('created_at', { ascending: false }),
    admin.from('project_members').select('user_id,item_id,added_at').eq('project_id', p.id),
    admin.from('profiles').select('id,name,job_title,department,roles,account_type,status').eq('workspace_id', workspace.id),
  ]);
  const byId = new Map((people || []).map((x) => [x.id, x]));
  const rids = (reqs || []).map((r) => r.id);
  const [{ data: items }, { data: comments }] = await Promise.all([
    rids.length ? admin.from('staffing_request_items').select('*').in('request_id', rids) : { data: [] },
    rids.length ? admin.from('request_comments').select('*').in('request_id', rids).order('created_at', { ascending: true }) : { data: [] },
  ]);
  const used = new Map(); (mem || []).forEach((m) => m.item_id && used.set(m.item_id, (used.get(m.item_id) || 0) + 1));
  const requests = (reqs || []).map((r) => ({
    id: r.id, status: r.status, note: r.note, created_at: r.created_at,
    requester: (byId.get(r.requested_by) || {}).name || null, requested_by: r.requested_by,
    decided_by: (byId.get(r.decided_by) || {}).name || null, decided_at: r.decided_at, decision_note: r.decision_note,
    items: (items || []).filter((i) => i.request_id === r.id).map((i) => ({ id: i.id, designation: i.designation, department: i.department, qty: i.qty, used: used.get(i.id) || 0 })),
    comments: (comments || []).filter((c) => c.request_id === r.id).map((c) => ({ id: c.id, author: (byId.get(c.author_id) || {}).name || 'Someone', body: c.body, created_at: c.created_at })),
  }));
  const isPm = p.manager_id === me.id;
  // For the Project Manager: who can fill each approved slot that still has room.
  const inProject = new Set((mem || []).map((m) => m.user_id));
  const candidates = {};
  if (isPm) {
    for (const r of requests.filter((x) => x.status === 'approved'))
      for (const it of r.items) if (it.used < it.qty)
        candidates[it.id] = (people || []).filter((x) => !inProject.has(x.id) && agentFits(x, it))
          .map((x) => ({ id: x.id, name: x.name, job_title: x.job_title, department: x.department }));
  }
  const boss = isAdminOrManager(me.account_type);
  send(res, 200, {
    project: { id: p.id, name: p.name, client: p.client, description: p.description, status: p.status, manager_id: p.manager_id, manager_name: (byId.get(p.manager_id) || {}).name || null },
    members: (mem || []).map((m) => { const x = byId.get(m.user_id) || {}; return { id: m.user_id, name: x.name, job_title: x.job_title, department: x.department, item_id: m.item_id }; }),
    requests, candidates,
    can: { manage: boss, request: isPm && p.status === 'active', add_members: isPm, remove: boss || isPm },
    me: { id: me.id, account_type: me.account_type },
  });
}

async function makeRequest(ctx, id, body) {
  const { admin, me, workspace, res } = ctx;
  const p = await loadProject(ctx, id);
  if (!p) return send(res, 404, { error: 'Project not found' });
  if (p.manager_id !== me.id) return send(res, 403, { error: 'Only the Project Manager of this project can ask for people' });
  if (p.status !== 'active') return send(res, 400, { error: 'This project is not active' });
  const { errors, value: v } = checkRequest(body);
  if (errors.length) return send(res, 400, { error: errors.join('; ') });
  const { data: r, error } = await admin.from('staffing_requests').insert({
    workspace_id: workspace.id, project_id: p.id, requested_by: me.id, note: v.note,
  }).select('id').single();
  if (error) return send(res, 502, { error: error.message });
  const { error: ie } = await admin.from('staffing_request_items').insert(v.items.map((i) => ({ ...i, request_id: r.id })));
  if (ie) { await admin.from('staffing_requests').delete().eq('id', r.id); return send(res, 502, { error: ie.message }); }
  await record(admin, workspace.id, {
    actorId: me.id, projectId: p.id, requestId: r.id, text: say.requestSent(me.name, itemsLabel(v.items), p.name), to: await approvers(admin, workspace.id),
  });
  send(res, 201, { id: r.id });
}

async function loadRequest(ctx, id) {
  if (!isUuid(id)) return {};
  const { admin, workspace } = ctx;
  const { data: r } = await admin.from('staffing_requests').select('*').eq('id', id).eq('workspace_id', workspace.id).maybeSingle();
  if (!r) return {};
  const p = await loadProject(ctx, r.project_id);
  if (!p) return {};
  const { data: items } = await admin.from('staffing_request_items').select('designation,qty').eq('request_id', r.id);
  return { r, p, label: itemsLabel(items || []) };
}

async function decide(ctx, id, body) {
  const { admin, me, workspace, res } = ctx;
  const { r, p, label } = await loadRequest(ctx, id);
  if (!r) return send(res, 404, { error: 'Request not found' });
  if (!canDecide(me, r.requested_by)) return send(res, 403, { error: 'You cannot decide this request' });
  const decision = body && body.decision;
  if (!canMove(r.status, decision)) return send(res, 400, { error: r.status === 'approved' || r.status === 'declined' ? 'This request is already closed' : 'Invalid action' });
  const note = body && body.note != null ? String(body.note).trim().slice(0, 500) : '';
  const patch = { status: DECISIONS[decision] };
  if (decision !== 'discuss') { patch.decided_by = me.id; patch.decided_at = new Date().toISOString(); patch.decision_note = note || null; }
  const { error } = await admin.from('staffing_requests').update(patch).eq('id', r.id).eq('workspace_id', workspace.id);
  if (error) return send(res, 502, { error: error.message });
  if (decision === 'discuss' && note) await admin.from('request_comments').insert({ request_id: r.id, author_id: me.id, body: note });
  const fn = { approve: say.approved, decline: say.declined, discuss: say.discussing }[decision];
  const text = fn(me.name, label, p.name);
  const others = (await approvers(admin, workspace.id));
  await record(admin, workspace.id, {
    actorId: me.id, projectId: p.id, requestId: r.id, text,
    to: [r.requested_by, ...others], toText: { [r.requested_by]: fn(me.name, label, p.name, 'your') },
  });
  send(res, 200, { ok: true, status: patch.status });
}

async function comment(ctx, id, body) {
  const { admin, me, workspace, res } = ctx;
  const { r, p, label } = await loadRequest(ctx, id);
  if (!r) return send(res, 404, { error: 'Request not found' });
  // Only the requester and Admin / Manager take part in the discussion.
  if (!(isAdminOrManager(me.account_type) || r.requested_by === me.id)) return send(res, 403, { error: 'Not allowed' });
  const text = body && body.body != null ? String(body.body).trim().slice(0, 1000) : '';
  if (!text) return send(res, 400, { error: 'Write a comment first' });
  if (r.status === 'approved' || r.status === 'declined') return send(res, 400, { error: 'This request is already closed' });
  const { error } = await admin.from('request_comments').insert({ request_id: r.id, author_id: me.id, body: text });
  if (error) return send(res, 502, { error: error.message });
  const to = [r.requested_by, ...(await approvers(admin, workspace.id))];
  await record(admin, workspace.id, {
    actorId: me.id, projectId: p.id, requestId: r.id, text: say.commented(me.name, label, p.name), to,
    toText: { [r.requested_by]: say.commented(me.name, label, p.name, 'your') },
  });
  send(res, 201, { ok: true });
}

async function addMember(ctx, id, body) {
  const { admin, me, workspace, res } = ctx;
  const p = await loadProject(ctx, id);
  if (!p) return send(res, 404, { error: 'Project not found' });
  if (p.manager_id !== me.id) return send(res, 403, { error: 'Only the Project Manager of this project can add people' });
  const userId = body && body.user_id, itemId = body && body.item_id;
  if (!isUuid(userId) || !isUuid(itemId)) return send(res, 400, { error: 'Choose a person and a slot' });
  // The slot must belong to an APPROVED request of THIS project, and still have room.
  const { data: item } = await admin.from('staffing_request_items').select('id,request_id,designation,department,qty').eq('id', itemId).maybeSingle();
  if (!item) return send(res, 404, { error: 'Slot not found' });
  const { data: r } = await admin.from('staffing_requests').select('id,status,project_id').eq('id', item.request_id).maybeSingle();
  if (!r || r.project_id !== p.id || r.status !== 'approved') return send(res, 403, { error: 'This request is not approved' });
  const { count } = await admin.from('project_members').select('user_id', { count: 'exact', head: true }).eq('project_id', p.id).eq('item_id', item.id);
  if ((count || 0) >= item.qty) return send(res, 400, { error: 'All slots for this requirement are filled' });
  const { data: person } = await admin.from('profiles').select('id,name,job_title,department,roles,account_type,status').eq('id', userId).eq('workspace_id', workspace.id).maybeSingle();
  if (!person || !agentFits(person, item)) return send(res, 400, { error: 'This person does not match the approved requirement' });
  const { error } = await admin.from('project_members').insert({ project_id: p.id, user_id: person.id, item_id: item.id, added_by: me.id });
  if (error) return send(res, 400, { error: /duplicate|already/i.test(error.message) ? 'Already in this project' : error.message });
  await record(admin, workspace.id, { actorId: me.id, projectId: p.id, text: say.memberAdded(me.name, person.name, p.name), to: [person.id, ...(await approvers(admin, workspace.id))] });
  send(res, 201, { ok: true });
}

async function removeMember(ctx, id, body) {
  const { admin, me, workspace, res } = ctx;
  const p = await loadProject(ctx, id);
  if (!p) return send(res, 404, { error: 'Project not found' });
  if (!(isAdminOrManager(me.account_type) || p.manager_id === me.id)) return send(res, 403, { error: 'Not allowed' });
  const userId = body && body.user_id;
  if (!isUuid(userId)) return send(res, 400, { error: 'Choose a person' });
  const { data: gone } = await admin.from('project_members').delete().eq('project_id', p.id).eq('user_id', userId).select('user_id');
  if (!gone || !gone.length) return send(res, 404, { error: 'Not in this project' });
  const mn = await nameOf(admin, userId);
  await record(admin, workspace.id, { actorId: me.id, projectId: p.id, text: say.memberRemoved(me.name, mn, p.name), to: [userId] });
  send(res, 200, { ok: true });
}
