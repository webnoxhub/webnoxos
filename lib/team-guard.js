// Server-side wall for /api/team/*: only an active Admin or Manager of a live workspace gets through.
// Every query afterwards is pinned to the caller's own workspace_id, taken from HIS profile, never from the request.
import { createClient } from '@supabase/supabase-js';

let cached;
function defaultAdmin() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  if (!cached) cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export function makeTeamGuard(getAdmin = defaultAdmin) {
  return async function requireTeamManager(req) {
    const m = /^Bearer\s+(.+)$/i.exec((req.headers && (req.headers.authorization || req.headers.Authorization)) || '');
    if (!m) return { ok: false, status: 401, error: 'Unauthorized' };
    const admin = getAdmin();
    if (!admin) return { ok: false, status: 500, error: 'Server not configured' };
    try {
      const { data, error } = await admin.auth.getUser(m[1]);
      if (error || !data || !data.user) return { ok: false, status: 401, error: 'Unauthorized' };
      const { data: me } = await admin.from('profiles')
        .select('id,name,account_type,status,workspace_id,is_master').eq('id', data.user.id).maybeSingle();
      if (!me || me.is_master || me.status !== 'active' || !me.workspace_id ||
          !['admin', 'manager'].includes(me.account_type)) return { ok: false, status: 403, error: 'Forbidden' };
      const { data: ws } = await admin.from('workspaces').select('id,name,slug,status').eq('id', me.workspace_id).maybeSingle();
      if (!ws || ws.status === 'archived' || ws.status === 'suspended') return { ok: false, status: 403, error: 'Forbidden' };
      return { ok: true, admin, me, workspace: ws };
    } catch { return { ok: false, status: 401, error: 'Unauthorized' }; }
  };
}
export const requireTeamManager = makeTeamGuard();
