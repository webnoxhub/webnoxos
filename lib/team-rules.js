// Who may do what to whom inside one workspace, and how a member form is validated.
// Pure functions: no network, fully unit-tested.
import { isEmail } from './validate.js';

export const ALL_ROLES = ['sales_rep', 'lead_gen', 'cold_caller', 'finance', 'project_manager', 'project_agent'];

// Admin manages Managers and Members. Manager manages Members only. Nobody manages the Master.
export function canManage(actorType, targetType, sameUser = false) {
  if (actorType === 'admin') return targetType === 'manager' || targetType === 'member' || sameUser;
  if (actorType === 'manager') return targetType === 'member';
  return false;
}
export function canAssignType(actorType, newType) {
  if (actorType === 'admin') return newType === 'member' || newType === 'manager';
  if (actorType === 'manager') return newType === 'member';
  return false;
}

const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'))
  && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

// create: all of name + email required. edit: only fields that are present are checked.
export function checkMember(body, activeRoles, { create }) {
  const errors = [], v = {};
  const b = body || {};

  if (create || b.name !== undefined) {
    const n = clean(b.name, 80);
    if (!n) errors.push('Name is required'); else v.name = n;
  }
  if (create) {
    if (!isEmail(b.email)) errors.push('Enter a valid email address'); else v.email = b.email.trim().toLowerCase();
  }
  if (b.phone !== undefined) {
    const p = clean(b.phone, 20);
    if (p && !/^[+0-9()\-\s]{6,20}$/.test(p)) errors.push('Phone looks wrong'); else v.phone = p || null;
  }
  if (b.joining_date !== undefined) {
    const d = clean(b.joining_date, 10);
    if (d && !validDate(d)) errors.push('Joining date is not a valid date'); else v.joining_date = d || null;
  }
  if (b.department !== undefined) v.department = clean(b.department, 60) || null;
  if (b.designation !== undefined) v.job_title = clean(b.designation, 60) || null;
  if (b.account_type !== undefined) {
    if (!['member', 'manager'].includes(b.account_type)) errors.push('Type must be member or manager');
    else v.account_type = b.account_type;
  }
  if (b.reports_to !== undefined) {
    const r = b.reports_to == null ? '' : String(b.reports_to).trim();
    if (r && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r)) errors.push('Invalid manager');
    else v.reports_to = r || null;
  }
  if (b.status !== undefined) {
    if (!['active', 'inactive'].includes(b.status)) errors.push('Invalid status'); else v.status = b.status;
  }
  if (create || b.roles !== undefined) {
    const list = Array.isArray(b.roles) ? b.roles : [];
    const set = new Set();
    for (const r of list) {
      if (!ALL_ROLES.includes(r) || !activeRoles.includes(r)) { errors.push('Role not available in this workspace: ' + String(r)); continue; }
      set.add(r);
    }
    v.roles = [...set];
  }
  return { errors, value: v };
}
