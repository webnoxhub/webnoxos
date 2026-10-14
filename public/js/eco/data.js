// Data access: thin wrappers that turn Supabase errors into readable messages.
import { supabase } from './supabase.js';

export function readable(error) {
  const msg = error?.message || String(error || 'Something went wrong');
  if (/row-level security|permission denied/i.test(msg)) return "You don't have permission to do that.";
  if (/violates foreign key constraint.*task_time_entries/i.test(msg)) return 'This task has tracked time, so it can\'t be deleted. Mark it completed instead.';
  if (/JWT expired|invalid JWT|not signed in/i.test(msg)) return 'Your session expired. Sign in again.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'No connection. Check your internet and try again.';
  return msg;
}

export async function q(builder) {
  const { data, error, count } = await builder;
  if (error) throw new Error(readable(error));
  return count !== undefined && count !== null ? { data, count } : data;
}

export async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(readable(error));
  return data;
}

// Calls to our own server (admin actions that need the secret key)
export async function api(path, { method = 'GET', body } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw new Error(readable(e)); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// A Manager account holds the "manager" role on top of the roles ticked for the person.
export const withManager = (r) => [...(r.roles || []), ...(r.account_type === 'manager' ? ['manager'] : [])];

// ---------- Shared queries ----------
export const TASK_FIELDS = 'id, title, description, status, priority, team_role, assigned_to, created_by, start_date, due_date, review_note, submitted_at, completed_at, created_at, updated_at, assignee:profiles!tasks_assigned_to_fkey(id, first_name, last_name, email, status)';

export async function loadMembers({ includeAdmin = false } = {}) {
  let query = supabase.from('profiles')
    .select('id, employee_code, name, first_name, last_name, email, phone, department, job_title, role, account_type, status, joined_on, created_at, roles, reports_to')
    .order('first_name');
  if (!includeAdmin) query = query.eq('role', 'member');
  const rows = await q(query);
  return rows.map((r) => ({ ...r, roles: withManager(r) }));
}

export async function loadTotals(taskIds) {
  if (!taskIds.length) return new Map();
  const rows = await q(supabase.from('task_time_totals').select('*').in('task_id', taskIds));
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.task_id) || { total: 0, running: false, since: null, byUser: {} };
    cur.total += r.total_seconds;
    if (r.running) { cur.running = true; cur.since = r.running_since; }
    cur.byUser[r.user_id] = r;
    map.set(r.task_id, cur);
  }
  map.fetchedAt = Date.now();
  return map;
}

// Names + roles of everyone (safe for any member; no emails or phones)
let dirCache = null; let dirAt = 0;
export async function loadDirectory(force = false) {
  if (!force && dirCache && Date.now() - dirAt < 60_000) return dirCache;
  dirCache = (await rpc('team_directory')).map((d) => ({ ...d, is_admin: d.account_type === 'admin', roles: withManager(d) }));
  dirAt = Date.now();
  return dirCache;
}
export const dirName = (dir, id) => dir.find((d) => d.id === id)?.name || '';
// "Taha Khan · Co-Founder & COO" style label: name + designation (or Admin / team roles)
export function dirLabel(dir, id, roles = []) {
  const d = dir.find((x) => x.id === id);
  if (!d) return '';
  const title = d.job_title || (d.is_admin ? 'Admin' : d.roles.map((k) => roles.find((r) => r.key === k)?.name || k).join(', '));
  return { name: d.name, title };
}
