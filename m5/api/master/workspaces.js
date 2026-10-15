// POST /api/master/workspaces — create a new workspace
// GET  /api/master/workspaces — list all workspaces (for the dashboard)
import { requireMaster, send } from '../../lib/master-guard.js';
import { createClient } from '@supabase/supabase-js';
import { isEmail } from '../../lib/validate.js';
import { makeLink } from '../../lib/invites.js';

const ALLOWED_ROLES = ['sales_rep', 'lead_gen', 'cold_caller', 'finance', 'project_manager', 'project_agent'];
const ALLOWED_CYCLES = ['trial_7', 'trial_14', 'monthly', 'quarterly', 'yearly'];
const ALLOWED_TYPES = ['rented', 'master_project'];

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export default async function handler(req, res) {
  const guard = await requireMaster(req);
  if (!guard.ok) return send(res, guard.status, { error: guard.error });

  if (req.method === 'GET') return handleList(guard, res);
  if (req.method === 'POST') return handleCreate(req, guard, res);
  send(res, 405, { error: 'Method not allowed' });
}

// ── GET: list workspaces with latest subscription ─────────────────────────────
async function handleList(guard, res) {
  const admin = adminClient();
  if (!admin) return send(res, 500, { error: 'Server not configured' });

  const { data, error } = await admin
    .from('workspaces')
    .select('id,name,slug,short_code,type,status,created_at,subscriptions(cycle,amount_original,currency,next_due,trial_ends_on,status)')
    .order('created_at', { ascending: false });

  if (error) return send(res, 502, { error: error.message });
  send(res, 200, { workspaces: data });
}

// ── POST: create workspace ────────────────────────────────────────────────────
async function handleCreate(req, guard, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'Invalid JSON body' });
  }

  // ── Validate required fields ──
  const { name, slug, short_code, type, plan_cycle, plan_amount,
          plan_currency = 'PKR', plan_fx = 1,
          admin_email, roles = [] } = body;

  const errs = [];
  if (!name || !name.trim())       errs.push('name is required');
  if (!slug || !slug.trim())       errs.push('slug is required');
  if (!short_code || !short_code.trim()) errs.push('short_code is required');
  if (type && !ALLOWED_TYPES.includes(type)) errs.push('invalid type');
  if (plan_cycle && !ALLOWED_CYCLES.includes(plan_cycle)) errs.push('invalid plan_cycle');
  if (plan_amount !== undefined && (isNaN(plan_amount) || plan_amount < 0)) errs.push('invalid plan_amount');
  if (!isEmail(admin_email)) errs.push('valid admin_email is required');

  // roles: [{ role, edit }]  (a bare string means use-only). Duplicates merge.
  const roleMap = new Map();
  if (!Array.isArray(roles)) errs.push('roles must be an array');
  else for (const r of roles) {
    const key = typeof r === 'string' ? r : r && r.role;
    const edit = typeof r === 'object' && r ? r.edit === true : false;
    if (!ALLOWED_ROLES.includes(key)) { errs.push('invalid role: ' + String(key)); continue; }
    roleMap.set(key, roleMap.get(key) || edit);
  }
  const roleList = [...roleMap].map(([role, edit]) => ({ role, edit }));
  if (errs.length) return send(res, 400, { error: errs.join('; ') });

  const admin = adminClient();
  if (!admin) return send(res, 500, { error: 'Server not configured' });

  // An email that already has an account cannot be invited again.
  for (const [who, mail] of [['Admin', admin_email]]) {
    if (!mail) continue;
    const { data: ex } = await admin.from('profiles').select('id').eq('email', mail.trim().toLowerCase()).maybeSingle();
    if (ex) return send(res, 409, { error: `${who} email already has an account. Use a different email.` });
  }

  // ── 1. Create workspace via RPC ──────────────────────────────────────────
  const { data: wsId, error: rpcErr } = await admin.rpc('master_create_workspace', {
    p_name:          name.trim(),
    p_slug:          slug.trim(),
    p_short_code:    short_code.trim().toUpperCase(),
    p_type:          type || 'rented',
    p_status:        'setup',
    p_plan_cycle:    plan_cycle || null,
    p_plan_amount:   plan_amount !== undefined ? Number(plan_amount) : (plan_cycle ? 0 : null),  // trials are free
    p_plan_currency: plan_currency,
    p_plan_fx:       Number(plan_fx),
    p_plan_start:    new Date().toISOString().slice(0, 10),
    p_roles:         roleList,
    p_master_id:     guard.user.id,
  });

  if (rpcErr) {
    const msg = rpcErr.message || '';
    if (msg.includes('duplicate') || msg.includes('unique'))
      return send(res, 409, { error: 'Slug or short_code already taken. Try a different one.' });
    return send(res, 502, { error: msg });
  }

  const workspaceId = wsId;
  const invites = {};

  // ── 2. Invite the Admin with a real set-password link (more people are added later from the workspace panel) ──
  for (const [key, mail, type] of [['admin', admin_email, 'admin']]) {
    if (!mail) continue;
    const email = mail.trim().toLowerCase();
    const r = await makeLink(admin, email, { workspace_id: workspaceId, account_type: type, workspace_slug: slug });
    if (r.error) { invites[key] = { email, error: r.error }; continue; }
    await admin.from('profiles').update({ workspace_id: workspaceId, account_type: type }).eq('id', r.user.id);
    invites[key] = { email, userId: r.user.id, link: r.link };
  }

  // ── 4. Fetch the created workspace row ─────────────────────────────────────
  const { data: ws } = await admin.from('workspaces')
    .select('id,name,slug,short_code,type,status,created_at')
    .eq('id', workspaceId)
    .single();

  send(res, 201, { workspace: ws, invites });
}

// ── Utility: read request body ─────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
