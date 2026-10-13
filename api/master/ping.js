// GET /api/master/ping — proves the Master guard works. Every future /api/master/* route starts the same way.
import { requireMaster, send } from '../../lib/master-guard.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  const g = await requireMaster(req);
  if (!g.ok) return send(res, g.status, { error: g.error });
  return send(res, 200, { ok: true });
}
