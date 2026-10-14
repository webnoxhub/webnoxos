// A signed-in person edits his own name and phone.
//   POST /api/me   { name, phone }
import { requireWork } from '../lib/work-guard.js';
import { send } from '../lib/master-guard.js';
import { readJson } from '../lib/invites.js';
import { checkSelf } from '../lib/team-rules.js';

export const makeHandler = (guard) => async function handler(req, res) {
  const g = await guard(req);
  if (!g.ok) return send(res, g.status, { error: g.error });
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'Invalid JSON body' }); }
  const { errors, value } = checkSelf(body);
  if (errors.length) return send(res, 400, { error: errors.join('; ') });
  const { error } = await g.admin.from('profiles').update(value).eq('id', g.me.id).eq('workspace_id', g.workspace.id);
  if (error) return send(res, 502, { error: error.message });
  send(res, 200, { ok: true, ...value });
};
export default makeHandler(requireWork);
