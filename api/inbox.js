// Notifications for the signed-in person, and the workspace activity log for Admin / Manager.
//   GET  ?a=notifications     latest 30 + unread count
//   POST ?a=read              mark all (or one: body.id) as read
//   GET  ?a=activity          latest 100 lines (Admin / Manager only)
import { requireWork } from '../lib/work-guard.js';
import { send } from '../lib/master-guard.js';
import { readJson } from '../lib/invites.js';
import { isAdminOrManager, isUuid } from '../lib/project-rules.js';

export const makeHandler = (guard) => async function handler(req, res) {
  const g = await guard(req);
  if (!g.ok) return send(res, g.status, { error: g.error });
  const { admin, me, workspace } = g;
  const a = new URL(req.url, 'http://x').searchParams.get('a') || '';
  try {
    if (req.method === 'GET' && a === 'notifications') {
      const { data } = await admin.from('notifications').select('id,text,project_id,request_id,read_at,created_at')
        .eq('user_id', me.id).order('created_at', { ascending: false }).limit(30);
      const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', me.id).is('read_at', null);
      return send(res, 200, { items: data || [], unread: count || 0 });
    }
    if (req.method === 'POST' && a === 'read') {
      let body = {}; try { body = await readJson(req); } catch { /* empty is fine */ }
      let q = admin.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', me.id).is('read_at', null);
      if (body && body.id) { if (!isUuid(body.id)) return send(res, 400, { error: 'Invalid id' }); q = q.eq('id', body.id); }
      await q;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && a === 'activity') {
      if (!isAdminOrManager(me.account_type)) return send(res, 403, { error: 'Forbidden' });
      const { data } = await admin.from('activity_log').select('id,text,project_id,created_at')
        .eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(100);
      return send(res, 200, { items: data || [] });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) { return send(res, 502, { error: e && e.message ? e.message : 'Something went wrong' }); }
};
export default makeHandler(requireWork);
