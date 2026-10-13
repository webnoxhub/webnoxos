// Pure rules for projects and staffing requests: validation, who may do what, and the English
// sentences that go into the activity log and notifications. No network. Unit-tested.
export const STATUSES = ['active', 'on_hold', 'completed'];
export const isAdminOrManager = (t) => t === 'admin' || t === 'manager';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
export const sameText = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

export function checkProject(body, { create }) {
  const errors = [], v = {}, b = body || {};
  if (create || b.name !== undefined) { const n = clean(b.name, 120); if (!n) errors.push('Project name is required'); else v.name = n; }
  if (b.client !== undefined) v.client = clean(b.client, 120) || null;
  if (b.description !== undefined) v.description = clean(b.description, 2000) || null;
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) errors.push('Invalid status'); else v.status = b.status; }
  if (b.manager_id !== undefined) {
    if (b.manager_id === null || b.manager_id === '') v.manager_id = null;
    else if (!isUuid(b.manager_id)) errors.push('Invalid project manager'); else v.manager_id = b.manager_id;
  }
  return { errors, value: v };
}

export function checkRequest(body) {
  const errors = [], b = body || {};
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length) errors.push('Add at least one requirement');
  if (raw.length > 8) errors.push('At most 8 requirements per request');
  const items = [], seen = new Set();
  for (const it of raw.slice(0, 8)) {
    const designation = clean(it && it.designation, 60);
    const qty = Number(it && it.qty);
    if (!designation) { errors.push('Every requirement needs a designation'); continue; }
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) { errors.push('Quantity must be 1 to 20'); continue; }
    const key = designation.toLowerCase();
    if (seen.has(key)) { errors.push('Each designation can be listed once: ' + designation); continue; }
    seen.add(key);
    items.push({ designation, qty, department: clean(it.department, 60) || null });
  }
  const note = clean(b.note, 500) || null;
  return { errors, value: { items, note } };
}

// Approve / decline / discuss: Admin or any Manager, but never on your own request.
export function canDecide(actor, requesterId) {
  return !!actor && isAdminOrManager(actor.account_type) && actor.id !== requesterId;
}
export const DECISIONS = { approve: 'approved', decline: 'declined', discuss: 'discussing' };
// A decision is possible while the request is still open. Discussing can later become approved/declined.
export function canMove(from, decision) {
  if (!DECISIONS[decision]) return false;
  if (from === 'approved' || from === 'declined') return false;
  if (from === 'discussing' && decision === 'discuss') return false;
  return true;
}

export const itemsLabel = (items) => items.map((i) => i.designation).join(', ');

// Can this person fill an approved slot?
export function agentFits(agent, item) {
  return !!agent && agent.status === 'active' && (agent.roles || []).includes('project_agent')
    && agent.account_type === 'member' && sameText(agent.job_title, item.designation)
    && (!item.department || sameText(agent.department, item.department));
}

// English sentences. whose: 'the' for the log, 'your' for the person who sent the request.
export const say = {
  projectCreated: (a, p) => `${a} created the project ${p}`,
  managerAssigned: (a, m, p) => `${a} assigned ${m} as Project Manager of ${p}`,
  requestSent: (a, label, p) => `${a} sent a ${label} request for ${p}`,
  approved: (a, label, p, whose = 'the') => `${a} approved ${whose} ${label} request on ${p}`,
  declined: (a, label, p, whose = 'the') => `${a} declined ${whose} ${label} request on ${p}`,
  discussing: (a, label, p, whose = 'the') => `${a} opened a discussion on ${whose} ${label} request on ${p}`,
  commented: (a, label, p, whose = 'the') => `${a} commented on ${whose} ${label} request on ${p}`,
  memberAdded: (a, m, p) => `${a} added ${m} to ${p}`,
  memberRemoved: (a, m, p) => `${a} removed ${m} from ${p}`,
};
