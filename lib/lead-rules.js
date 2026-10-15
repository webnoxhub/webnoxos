// Pure rules for a lead that arrives through the public form. No I/O.
const STAGES = ['new', 'contacted', 'qualified', 'meeting', 'proposal', 'negotiation'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
export const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

// agents: [{id, name}] the people allowed to submit; returns { errors, value }
export function checkPublicLead(b, agents) {
  b = b && typeof b === 'object' ? b : {};
  const errors = [];
  const value = {
    contact_name: titleCase(clean(b.contact_name, 120)),
    company: clean(b.company, 200),
    email: clean(b.email, 160) || null,
    phone: clean(b.phone, 40) || null,
    country: clean(b.country, 60) || null,
    industry: clean(b.industry, 80) || null,
    service: clean(b.service, 200) || null,
    currency: (clean(b.currency, 8) || 'USD').toUpperCase().replace(/[^A-Z]/g, '') || 'USD',
    budget: b.budget === null || b.budget === '' || b.budget === undefined ? null : Number(b.budget),
    source: clean(b.source, 60) || 'Website',
    status: STAGES.includes(b.status) ? b.status : 'new',
    priority: PRIORITIES.includes(b.priority) ? b.priority : 'medium',
    notes: typeof b.notes === 'string' ? b.notes.trim().slice(0, 4000) : '',
    agent_id: null,
    agent_name: null,
  };
  if (!value.contact_name) errors.push("Enter the lead's full name");
  if (!value.company) errors.push('Enter the company or brand name');
  if (value.email && !EMAIL_RE.test(value.email)) errors.push("That email doesn't look right");
  if (value.budget !== null && !(value.budget >= 0 && value.budget < 1e10)) errors.push('Budget must be a number');
  if (typeof b.agent_id === 'string' && b.agent_id) {
    if (!agents.some((a) => a.id === b.agent_id)) errors.push('Pick your name from the list');
    else value.agent_id = b.agent_id;
  } else {
    value.agent_name = titleCase(clean(b.agent_name, 80)) || null;
    if (!value.agent_name) errors.push('Select or type the agent name');
  }
  return { errors, value };
}
