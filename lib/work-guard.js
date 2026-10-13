// Server-side wall for /api/projects and /api/inbox: any ACTIVE person of a live workspace.
// workspace_id always comes from the caller's own profile, never from the request.
import { createClient } from '@supabase/supabase-js';

let cached;
function defaultAdmin() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  if (!cached) cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export function makeWorkGuard(getAdmin = defaultAdmin) {
  return async function requireWork(req) {
    const m = /^Bearer\s+(.+)$/i.exec((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    if (!m) return { ok: false, status: 401, error: 'Unauthorized' };
    const admin = getAdmin();
    if (!admin) return { ok: false, status: 500, error: 'Server not configured' };
    try {
      const { data, error } = await admin.auth.getUser(m[1]);
      if (error || !data || !data.user) return { ok: false, status: 401, error: 'Unauthorized' };
      const { data: me } = await admin.from('profiles')
        .select('id,name,account_type,status,workspace_id,is_master,roles').eq('id', data.user.id).maybeSingle();
      if (!me || me.is_master || me.status !== 'active' || !me.workspace_id) return { ok: false, status: 403, error: 'Forbidden' };
      const { data: ws } = await admin.from('workspaces').select('id,name,slug,status').eq('id', me.workspace_id).maybeSingle();
      if (!ws || ws.status === 'archived' || ws.status === 'suspended') return { ok: false, status: 403, error: 'Forbidden' };
      return { ok: true, admin, me, workspace: ws };
    } catch { return { ok: false, status: 401, error: 'Unauthorized' }; }
  };
}
export const requireWork = makeWorkGuard();

// Writes one line to the activity log and one notification per recipient (never the actor).
export async function record(admin, wsId, { actorId, projectId = null, requestId = null, text, to = [], toText = {}, about = [] }) {
  const involved = [...new Set([actorId, ...about])].filter(Boolean);
  await admin.from('activity_log').insert({ workspace_id: wsId, actor_id: actorId, project_id: projectId, request_id: requestId, text, involved });
  const ids = [...new Set(to)].filter((id) => id && id !== actorId);
  if (ids.length) {
    await admin.from('notifications').insert(ids.map((id) => ({
      workspace_id: wsId, user_id: id, text: toText[id] || text, project_id: projectId, request_id: requestId,
    })));
  }
}

// Active Admins and Managers of a workspace (the people who approve).
export async function approvers(admin, wsId) {
  const { data } = await admin.from('profiles').select('id').eq('workspace_id', wsId).eq('status', 'active').in('account_type', ['admin', 'manager']);
  return (data || []).map((p) => p.id);
}
