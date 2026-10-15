// Lead form options + the form itself. Shared by the app and the public lead form (no imports on purpose).
export const COUNTRIES = ['Pakistan', 'USA', 'UK', 'Others'];
export const NICHES = ['Clothing', 'Jewelry', 'Cosmetics', 'Skincare', 'Shoes', 'Home Decor', 'Restaurants', 'Salons', 'Real Estate', 'Gyms', 'Clinics', 'Other'];
export const CURRENCIES = [['PKR', 'PKR (Rs)'], ['USD', 'USD ($)'], ['GBP', 'STG (£)'], ['EUR', 'EUR (€)'], ['OTHER', 'Other']];
export const SOURCES = ['Cold Call', 'Instagram', 'Facebook', 'LinkedIn', 'WhatsApp', 'Website', 'Google Maps', 'Email Outreach', 'Referral', 'Walk-in', 'Other'];
export const STAGES = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', meeting: 'Meeting', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost' };
export const FORM_STAGES = ['new', 'contacted', 'qualified', 'meeting', 'proposal', 'negotiation'];
export const PRIORITIES = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };

const e = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// "haseeb   GUL" → "Haseeb Gul"
export const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

export function currencyLabel(code) {
  const c = String(code || '').toUpperCase();
  return c === 'GBP' ? 'STG' : c || 'USD';
}
export function fmtBudget(amount, code) {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = Number(amount);
  return `${currencyLabel(code)} ${n.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(n) ? 0 : 2 })}`;
}

function select(id, options, value, placeholder) {
  return `<select id="${id}" class="select">${placeholder ? `<option value="">${e(placeholder)}</option>` : ''}${options.map(([v, l]) => `<option value="${e(v)}" ${String(v) === String(value) ? 'selected' : ''}>${e(l)}</option>`).join('')}</select>`;
}
const listOpts = (arr) => arr.map((x) => [x, x]);
const inList = (arr, v) => !v || arr.includes(v);

/**
 * Lead form fields.
 * opts.agents: [{id, name}] lead generators; opts.reps: [{id, name}] sales reps (internal only)
 * opts.isPublic: hides internal-only fields; opts.lead: values when editing
 */
export function leadFormHTML({ lead = {}, agents = [], reps = [], isPublic = false, defaultAgent = '', canAssign = false } = {}) {
  const l = lead;
  const country = inList(COUNTRIES, l.country) ? (l.country || '') : 'Others';
  const niche = inList(NICHES, l.industry) ? (l.industry || '') : 'Other';
  const knownCur = CURRENCIES.some(([c]) => c === (l.currency || 'USD'));
  const cur = knownCur ? (l.currency || 'USD') : 'OTHER';
  const agentVal = l.agent_id || (l.agent_name ? '__other' : defaultAgent);
  return `
    <div class="form-grid lead-form">
      <div class="field"><label for="lf-name">Lead full name <span class="req">*</span></label><input id="lf-name" class="input" maxlength="120" value="${e(l.contact_name)}" placeholder="e.g. Tariq Mehmood" autocomplete="name"></div>
      <div class="field"><label for="lf-company">Company / brand <span class="req">*</span></label><input id="lf-company" class="input" maxlength="200" value="${e(l.company)}" placeholder="e.g. Mehmood Footwear" autocomplete="organization"></div>
      <div class="field"><label for="lf-email">Email address</label><input id="lf-email" class="input" type="email" maxlength="160" value="${e(l.email)}" placeholder="tariq@company.com" autocomplete="email"></div>
      <div class="field"><label for="lf-phone">Phone number</label><input id="lf-phone" class="input" type="tel" maxlength="40" value="${e(l.phone)}" placeholder="+92 300 1234567" autocomplete="tel"></div>
      <div class="field"><label for="lf-country">Country</label>${select('lf-country', listOpts(COUNTRIES), country, 'Select country')}
        <input id="lf-country-other" class="input ${country === 'Others' ? '' : 'hidden'}" maxlength="60" value="${e(country === 'Others' && l.country !== 'Others' ? l.country : '')}" placeholder="Type the country"></div>
      <div class="field"><label for="lf-niche">Business category</label>${select('lf-niche', listOpts(NICHES), niche, 'Select category')}
        <input id="lf-niche-other" class="input ${niche === 'Other' ? '' : 'hidden'}" maxlength="80" value="${e(niche === 'Other' && l.industry !== 'Other' ? l.industry : '')}" placeholder="Type the category"></div>
      <div class="field span-2"><label for="lf-service">Service requested</label><input id="lf-service" class="input" maxlength="200" value="${e(l.service)}" placeholder="e.g. Shopify store + Meta ads"></div>
      <div class="field"><label for="lf-currency">Currency</label>${select('lf-currency', CURRENCIES, cur)}
        <input id="lf-currency-other" class="input ${cur === 'OTHER' ? '' : 'hidden'}" maxlength="8" value="${e(knownCur ? '' : l.currency)}" placeholder="Currency code, e.g. AED"></div>
      <div class="field"><label for="lf-budget">Budget</label><div class="money-input"><span id="lf-cur-tag">${e(currencyLabel(cur === 'OTHER' ? (l.currency || '') : cur) || '—')}</span><input id="lf-budget" class="input" type="number" min="0" step="1" value="${e(l.budget)}" placeholder="5000"></div></div>
      <div class="field"><label for="lf-source">Lead source</label>${select('lf-source', listOpts(SOURCES), l.source || (isPublic ? 'Website' : 'Cold Call'))}</div>
      <div class="field"><label for="lf-stage">${isPublic ? 'Pipeline stage' : 'Pipeline stage'}</label>${select('lf-stage', FORM_STAGES.map((k) => [k, STAGES[k]]).concat(l.status && !FORM_STAGES.includes(l.status) ? [[l.status, STAGES[l.status]]] : []), l.status || 'new')}</div>
      <div class="field"><label for="lf-priority">Priority</label>${select('lf-priority', Object.entries(PRIORITIES), l.priority || 'medium')}</div>
      <div class="field"><label for="lf-agent">Agent name${isPublic ? ' <span class="req">*</span>' : ''}</label>
        ${select('lf-agent', agents.map((a) => [a.id, a.name]).concat([['__other', 'Other']]), agentVal, isPublic ? 'Select your name' : 'Select agent')}
        <input id="lf-agent-other" class="input ${agentVal === '__other' ? '' : 'hidden'}" maxlength="80" value="${e(l.agent_name || '')}" placeholder="Full name, e.g. Haseeb Gul"></div>
      ${isPublic ? '' : `
      ${canAssign ? `<div class="field"><label for="lf-rep">Sales representative</label>${select('lf-rep', reps.map((r) => [r.id, r.name]), l.assigned_to || '', 'Not assigned yet')}</div>` : ''}
      <div class="field"><label for="lf-follow">Next follow-up</label><input id="lf-follow" class="input" type="date" value="${e(l.next_follow_up)}"></div>`}
      <div class="field span-2"><label for="lf-notes">Initial note / requirement details</label><textarea id="lf-notes" class="textarea" maxlength="4000" placeholder="Business, goals, challenges, ad spend…">${e(l.notes)}</textarea></div>
      ${isPublic ? '<input type="text" id="lf-hp" name="website_url" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">' : ''}
      <div class="form-error hidden span-2" id="lf-err" role="alert"></div>
    </div>`;
}

// Show the "type it" boxes when Other is picked, keep the budget tag in sync
export function bindLeadForm(root) {
  const pair = (sel, other, trigger) => {
    const s = root.querySelector(sel); const o = root.querySelector(other);
    s.addEventListener('change', () => { o.classList.toggle('hidden', s.value !== trigger); if (s.value === trigger) o.focus(); });
  };
  pair('#lf-country', '#lf-country-other', 'Others');
  pair('#lf-niche', '#lf-niche-other', 'Other');
  pair('#lf-currency', '#lf-currency-other', 'OTHER');
  pair('#lf-agent', '#lf-agent-other', '__other');
  const tag = root.querySelector('#lf-cur-tag');
  const sync = () => {
    const c = root.querySelector('#lf-currency').value;
    tag.textContent = c === 'OTHER' ? (root.querySelector('#lf-currency-other').value.trim().toUpperCase() || '—') : currencyLabel(c);
  };
  root.querySelector('#lf-currency').addEventListener('change', sync);
  root.querySelector('#lf-currency-other').addEventListener('input', sync);
  const other = root.querySelector('#lf-agent-other');
  other.addEventListener('blur', () => { other.value = titleCase(other.value); });
}

// Read + validate. Returns { payload } or { error }
export function readLeadForm(root, { isPublic = false } = {}) {
  const v = (id) => (root.querySelector(id)?.value || '').trim();
  const country = v('#lf-country') === 'Others' ? (v('#lf-country-other') || 'Others') : v('#lf-country');
  const niche = v('#lf-niche') === 'Other' ? (v('#lf-niche-other') || 'Other') : v('#lf-niche');
  const currency = v('#lf-currency') === 'OTHER' ? v('#lf-currency-other').toUpperCase().replace(/[^A-Z]/g, '') : v('#lf-currency');
  const agentSel = v('#lf-agent');
  const payload = {
    contact_name: titleCase(v('#lf-name')),
    company: v('#lf-company'),
    email: v('#lf-email') || null,
    phone: v('#lf-phone') || null,
    country: country || null,
    industry: niche || null,
    service: v('#lf-service') || null,
    currency: currency || 'USD',
    budget: v('#lf-budget') === '' ? null : Number(v('#lf-budget')),
    source: v('#lf-source') || null,
    status: v('#lf-stage') || 'new',
    priority: v('#lf-priority') || 'medium',
    agent_id: agentSel && agentSel !== '__other' ? agentSel : null,
    agent_name: agentSel === '__other' ? titleCase(v('#lf-agent-other')) : null,
    notes: v('#lf-notes'),
  };
  if (!isPublic) {
    if (root.querySelector('#lf-rep')) payload.assigned_to = v('#lf-rep') || null;
    payload.next_follow_up = v('#lf-follow') || null;
  }
  if (!payload.contact_name) return { error: 'Enter the lead\'s full name.', field: '#lf-name' };
  if (!payload.company) return { error: 'Enter the company or brand name.', field: '#lf-company' };
  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return { error: 'That email doesn\'t look right.', field: '#lf-email' };
  if (v('#lf-currency') === 'OTHER' && !currency) return { error: 'Type the currency code, like AED.', field: '#lf-currency-other' };
  if (payload.budget !== null && !(payload.budget >= 0)) return { error: 'Budget must be a number.', field: '#lf-budget' };
  if (agentSel === '__other' && !payload.agent_name) return { error: 'Type the agent\'s full name.', field: '#lf-agent-other' };
  if (isPublic && !agentSel) return { error: 'Select your name as the agent.', field: '#lf-agent' };
  if (isPublic && v('#lf-hp')) return { error: 'Something went wrong. Reload and try again.' };
  return { payload };
}
