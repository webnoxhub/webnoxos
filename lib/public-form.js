// The public lead form: no login. One link per workspace, made from a secret token.
//   GET  /api/public/form?t=<token>   -> { company, agents: [{id, name}] }
//   POST /api/public/lead  { t, ...lead }
// The workspace always comes from the token. Anything unknown answers the same way.
import { createClient } from '@supabase/supabase-js';
import { readJson } from './invites.js';
import { checkPublicLead } from './lead-rules.js';

let cached;
function defaultAdmin() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  if (!cached) cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}
const TOKEN = /^[a-f0-9]{32}$/;
const hits = new Map();
export function rateOk(ip, now = Date.now()) {
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length <= 15;
}
export const resetRate = () => hits.clear();
const ipOf = (req) => String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();

function out(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function findForm(admin, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const { data: ws } = await admin.from('workspaces').select('id,name,status').eq('public_form_token', token).maybeSingle();
  if (!ws || ws.status === 'archived' || ws.status === 'suspended') return null;
  const { data: people } = await admin.from('profiles').select('id,name,roles,status').eq('workspace_id', ws.id).eq('status', 'active');
  const agents = (people || []).filter((p) => Array.isArray(p.roles) && p.roles.includes('lead_gen'))
    .map((p) => ({ id: p.id, name: p.name || '' })).sort((a, b) => a.name.localeCompare(b.name));
  return { ws, agents };
}

export const makeFormHandler = (getAdmin = defaultAdmin) => async function handler(req, res) {
  const admin = getAdmin();
  if (!admin) return out(res, 500, { error: 'The form is not connected yet' });
  try {
    const t = new URL(req.url, 'http://x').searchParams.get('t');
    const f = await findForm(admin, t);
    if (!f) return out(res, 404, { error: 'This form link is not valid' });
    return out(res, 200, { company: f.ws.name, agents: f.agents });
  } catch { return out(res, 500, { error: 'Something went wrong' }); }
};

export const makeLeadHandler = (getAdmin = defaultAdmin) => async function handler(req, res) {
  if (req.method !== 'POST') return out(res, 405, { error: 'Method not allowed' });
  const admin = getAdmin();
  if (!admin) return out(res, 500, { error: 'The form is not connected yet' });
  try {
    if (!rateOk(ipOf(req))) return out(res, 429, { error: 'Too many submissions. Wait a few minutes and try again.' });
    let body; try { body = await readJson(req); } catch { return out(res, 400, { error: 'Invalid JSON body' }); }
    if (body && body.hp) return out(res, 200, { ok: true });      // a bot filled the hidden field
    const f = await findForm(admin, body && body.t);
    if (!f) return out(res, 404, { error: 'This form link is not valid' });
    const { errors, value } = checkPublicLead(body, f.agents);
    if (errors.length) return out(res, 400, { error: errors[0] });
    // One workspace cannot be flooded: at most 200 form leads in the last hour.
    const { data: recent } = await admin.from('leads').select('created_at').eq('workspace_id', f.ws.id).is('created_by', null).order('created_at', { ascending: false }).limit(200);
    const hourAgo = Date.now() - 3600_000;
    if ((recent || []).filter((r) => new Date(r.created_at).getTime() > hourAgo).length >= 200) return out(res, 429, { error: 'The form is busy. Try again later.' });
    const { error } = await admin.from('leads').insert({ ...value, workspace_id: f.ws.id });
    if (error) return out(res, 400, { error: "Couldn't save the lead. Check the details and try again." });
    return out(res, 201, { ok: true });
  } catch { return out(res, 500, { error: 'Something went wrong' }); }
};
