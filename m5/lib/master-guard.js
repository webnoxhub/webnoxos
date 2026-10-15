// Server-side wall for every /api/master/* route.
// 401 = no/invalid token. 403 = signed in but not an active Master.
import { createClient } from '@supabase/supabase-js';

let cached;
function defaultAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  if (!cached) cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export function makeGuard(getAdmin = defaultAdmin) {
  return async function requireMaster(req) {
    const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return { ok: false, status: 401, error: 'Unauthorized' };

    const admin = getAdmin();
    if (!admin) return { ok: false, status: 500, error: 'Server not configured' };

    try {
      const { data, error } = await admin.auth.getUser(m[1]);
      if (error || !data || !data.user) return { ok: false, status: 401, error: 'Unauthorized' };

      const { data: prof, error: pe } = await admin
        .from('profiles').select('is_master,status').eq('id', data.user.id).maybeSingle();
      if (pe || !prof || prof.is_master !== true || prof.status !== 'active') {
        return { ok: false, status: 403, error: 'Forbidden' };
      }
      return { ok: true, user: data.user, admin };
    } catch {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
  };
}

export const requireMaster = makeGuard();

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
