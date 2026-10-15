// Leads pipeline: add, import, share the public form, work stages, won → convert to client
import { supabase } from '../supabase.js';
import { state, can } from '../state.js';
import { q, rpc, loadDirectory, dirName } from '../data.js';
import { esc, icon, emptyState, loadingBlock, on, openDrawer, closeDrawer, openModal, confirmDialog, toast, busy, copyText } from '../ui.js';
import { fmtDate, fmtDateOfIso, fmtRelative, todayStr, localDate, startOfWeek } from '../time.js';
import { STAGES, PRIORITIES, leadFormHTML, bindLeadForm, readLeadForm, fmtBudget } from '../lead-options.js';

export const LEAD_STATUS = STAGES;
const OPEN = ['new', 'contacted', 'qualified', 'meeting', 'proposal', 'negotiation'];
const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
export const leadBadge = (s) => `<span class="badge ${esc(s)}">${esc(STAGES[s] || s)}</span>`;
const initial = (name) => esc((name || '?').trim()[0]?.toUpperCase() || '?');

function waLink(phone, country) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && (!country || country === 'Pakistan')) d = '92' + d.slice(1);
  return `https://wa.me/${d}`;
}
export const canAssignLeads = () => state.isAdmin || state.myRoles.includes('sales_rep');
export function agentLabel(l, dir) { return dirName(dir, l.agent_id) || l.agent_name || dirName(dir, l.created_by) || ''; }

export async function render({ el, params }) {
  let leads = []; let dir = [];
  let status = params.get('status') || 'all';
  let scope = params.get('scope') || 'all';
  let search = '';
  const canEdit = can('leads', 'edit');
  const canAssign = canAssignLeads();

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Leads</h1><p>Every prospect from first contact to a converted client.</p></div>
      <div class="actions">
        <button class="btn" id="share">${icon('share', 15)}Share lead form</button>
        ${canEdit ? `<button class="btn" id="import">${icon('upload', 15)}Import CSV</button><button class="btn btn-primary" id="new">${icon('plus', 15)}New lead</button>` : ''}
      </div>
    </div>
    <div id="unassigned-note"></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Stage" id="status"></div></div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search name, company, email, phone" aria-label="Search leads"></div>
      <select class="select" id="scope" style="width:auto" aria-label="Whose leads">
        <option value="all">All leads</option><option value="mine">My leads (agent / added by me)</option><option value="assigned">Assigned to me</option><option value="unassigned">Not assigned yet</option>
      </select>
    </div>
    <section class="panel"><div class="table-wrap" id="table">${loadingBlock(5)}</div></section>`;
  const table = el.querySelector('#table');
  el.querySelector('#scope').value = scope;

  const groups = {
    all: () => true,
    open: (l) => OPEN.includes(l.status),
    ...Object.fromEntries(Object.keys(STAGES).map((k) => [k, (l) => l.status === k && !(k === 'won' && l.client_id)])),
    converted: (l) => Boolean(l.client_id),
  };
  const labels = [['all', 'All'], ['open', 'Open'], ...OPEN.map((k) => [k, STAGES[k]]), ['won', 'Won'], ['converted', 'Converted to client'], ['lost', 'Lost']];

  function draw() {
    const waiting = leads.filter((l) => !l.assigned_to && !l.client_id && OPEN.includes(l.status)).length;
    el.querySelector('#unassigned-note').innerHTML = canAssign && waiting && scope !== 'unassigned'
      ? `<div class="note warn" style="margin-bottom:14px">${icon('target', 14)} <b>${waiting}</b> ${waiting === 1 ? 'lead is' : 'leads are'} waiting for a sales rep. <button class="linkish" data-show-unassigned>Show them</button></div>` : '';
    el.querySelector('#status').innerHTML = labels.map(([k, v]) =>
      `<button data-s="${k}" aria-pressed="${status === k}">${v}<span class="count">${leads.filter(groups[k]).length}</span></button>`).join('');
    const s = search.toLowerCase();
    const me = state.profile.id;
    const list = leads.filter((l) => groups[status](l)
      && (scope === 'all' || (scope === 'mine' ? (l.created_by === me || l.agent_id === me) : scope === 'unassigned' ? (!l.assigned_to && !l.client_id && OPEN.includes(l.status)) : l.assigned_to === me))
      && (!s || `${l.contact_name || ''} ${l.company} ${l.email || ''} ${l.phone || ''}`.toLowerCase().includes(s)));
    if (!leads.length) {
      table.innerHTML = emptyState('No leads yet', canEdit ? 'Add a lead, import a CSV, or share the lead form.' : 'Leads added by the team show up here.', canEdit ? '<button class="btn btn-primary" data-new>New lead</button>' : '');
      return;
    }
    if (!list.length) { table.innerHTML = emptyState('No leads match these filters'); return; }
    const reps = dir.filter((d) => d.roles.includes('sales_rep') && d.status !== 'inactive');
    table.innerHTML = `<table class="table caps">
      <thead><tr><th>Lead / company</th><th>Service</th><th>Pipeline status</th><th>Assigned to</th><th>Budget</th><th>Contact &amp; outreach</th><th>Next follow-up</th><th class="r">Actions</th></tr></thead>
      <tbody>${list.map((l) => {
        const rep = dirName(dir, l.assigned_to);
        const wa = waLink(l.phone, l.country);
        const fu = l.next_follow_up;
        return `<tr class="${l.status === 'won' ? 'won' : ''}" data-id="${l.id}">
        <td><div style="font-weight:600">${esc(l.contact_name || l.company)}</div><div class="small muted">${esc(l.contact_name ? l.company : (l.industry || ''))}</div>
          ${l.client_id ? `<div class="client-chip">${icon('check', 11)}Client</div>` : ''}</td>
        <td><div>${esc(l.service || l.industry || '—')}</div><span class="prio-pill ${esc(l.priority)}">${esc(PRIORITIES[l.priority] || l.priority)}</span></td>
        <td>${canEdit && !l.client_id
          ? `<select class="stage-select" data-stage="${esc(l.status)}" data-stage-for="${l.id}" aria-label="Pipeline status for ${esc(l.company)}">${Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`
          : `<select class="stage-select" data-stage="${esc(l.status)}" disabled aria-label="Pipeline status"><option>${l.client_id ? 'Converted' : esc(STAGES[l.status])}</option></select>`}</td>
        <td>${canAssign && !l.client_id
          ? `<select class="assign-select ${l.assigned_to ? 'set' : ''}" data-assign-for="${l.id}" aria-label="Sales representative for ${esc(l.company)}"><option value="">Unassigned</option>${reps.map((r) => `<option value="${r.id}" ${l.assigned_to === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}${l.assigned_to && !reps.some((r) => r.id === l.assigned_to) ? `<option value="${l.assigned_to}" selected>${esc(rep || 'Former member')}</option>` : ''}</select>`
          : rep ? `<div class="row" style="gap:8px"><span class="mini-av">${initial(rep)}</span><span>${esc(rep)}</span></div>` : '<span class="muted small">Unassigned</span>'}</td>
        <td>${l.budget !== null && l.budget !== undefined ? `<div style="font-weight:600" class="money">${esc(fmtBudget(l.budget, l.currency))}</div>` : '<div class="muted">—</div>'}<div class="small muted">${l.source ? `via ${esc(l.source)}` : ''}</div></td>
        <td><div class="outreach">
          ${l.phone ? `<a href="tel:${esc(l.phone)}" title="Call ${esc(l.phone)}" aria-label="Call">${icon('phone', 15)}</a>` : `<span title="No phone">${icon('phone', 15)}</span>`}
          ${wa ? `<a class="wa" href="${wa}" target="_blank" rel="noopener" title="WhatsApp" aria-label="WhatsApp">${icon('chat', 15)}</a>` : `<span title="No phone">${icon('chat', 15)}</span>`}
          ${l.email ? `<a href="mailto:${esc(l.email)}" title="Email ${esc(l.email)}" aria-label="Email">${icon('mail', 15)}</a>` : `<span title="No email">${icon('mail', 15)}</span>`}
        </div></td>
        <td class="small">${fu ? `<span class="due ${fu < todayStr() ? 'over' : fu === todayStr() ? 'soon' : ''}">${esc(fmtDate(fu))}</span>` : '<span class="muted">None</span>'}</td>
        <td class="r"><button class="btn btn-sm btn-soft" data-open="${l.id}">Workspace ${icon('arrowRight', 13)}</button></td>
      </tr>`; }).join('')}</tbody></table>`;
  }

  async function load() {
    [leads, dir] = await Promise.all([
      q(supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(3000)),
      loadDirectory(),
    ]);
    draw();
  }

  el.querySelector('#status').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { status = b.dataset.s; draw(); } });
  el.querySelector('#q').addEventListener('input', (e) => { search = e.target.value.trim(); draw(); });
  el.querySelector('#scope').addEventListener('change', (e) => { scope = e.target.value; draw(); });
  el.querySelector('#unassigned-note').addEventListener('click', (e) => { if (e.target.closest('[data-show-unassigned]')) { scope = 'unassigned'; el.querySelector('#scope').value = scope; draw(); } });
  el.querySelector('#new')?.addEventListener('click', () => openLeadForm());
  el.querySelector('#import')?.addEventListener('click', () => openImport());
  el.querySelector('#share').addEventListener('click', () => shareForm());
  const offs = [
    on(table, 'click', '[data-new]', () => openLeadForm()),
    on(table, 'click', '[data-open]', (e, b) => openLeadDrawer(Number(b.dataset.open))),
    on(table, 'change', '[data-assign-for]', async (e, sel) => {
      const id = Number(sel.dataset.assignFor); const to = sel.value || null;
      sel.disabled = true;
      try {
        await q(supabase.from('leads').update({ assigned_to: to }).eq('id', id));
        toast(to ? `Assigned to ${dirName(dir, to)}. They were notified.` : 'Lead unassigned');
        changed();
      } catch (err) { toast(err.message, 'error'); load(); }
    }),
    on(table, 'change', '[data-stage-for]', async (e, sel) => {
      const id = Number(sel.dataset.stageFor); const next = sel.value;
      sel.dataset.stage = next; sel.disabled = true;
      try {
        await q(supabase.from('leads').update({ status: next }).eq('id', id));
        toast(next === 'won' ? 'Marked as won. Open Workspace to convert it to a client.' : `Moved to ${STAGES[next]}`);
        changed();
      } catch (err) { toast(err.message, 'error'); load(); }
    }),
  ];
  const safe = () => load().catch((e) => { table.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  await safe();
  if (params.get('new') === '1' && canEdit) openLeadForm();
  if (params.get('open')) openLeadDrawer(Number(params.get('open')));
  window.addEventListener('ehos:data-changed', safe);
  const poll = setInterval(safe, 60_000);
  return () => { offs.forEach((x) => x()); clearInterval(poll); window.removeEventListener('ehos:data-changed', safe); };
}

// ---------- Share the public form ----------
export async function shareForm() {
  let token = '';
  try { token = (await q(supabase.from('workspaces').select('public_form_token').eq('id', state.workspace.id).maybeSingle()))?.public_form_token || ''; } catch { /* shown below */ }
  const link = `${location.origin}/lead-form.html?t=${encodeURIComponent(token)}`;
  const msg = `Submit leads for ${state.workspace.name} here: ${link}`;
  if (!token) {
    const m = openModal({
      title: 'Share the lead form', icon: 'share', subtitle: 'Anyone with the link can submit a lead. No login needed.',
      body: `<div class="note warn">The form link could not be loaded. Try again.</div>`,
      foot: '<button class="btn" data-cancel>Close</button>',
    });
    m.querySelector('[data-cancel]').onclick = () => m.close();
    return;
  }
  const m = openModal({
    title: 'Share the lead form', icon: 'share', subtitle: 'Anyone with the link can submit a lead. No login needed.',
    body: `
      <div class="link-box"><input class="input" readonly value="${esc(link)}" aria-label="Form link"><button class="btn" data-copy>${icon('copy', 14)}Copy</button></div>
      <p class="small muted">The agent list shows everyone with the Lead Generation role, plus Other. New leads land in Leads. The admin, managers and the Sales team get a notification, and a sales rep picks them up. Keep the link to people you trust: anyone who has it can add leads.</p>`,
    foot: `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open form</a><a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">${icon('send', 14)}Share on WhatsApp</a>`,
  });
  m.querySelector('[data-copy]').onclick = async (e) => { if (await copyText(link)) { e.currentTarget.innerHTML = `${icon('check', 14)}Copied`; toast('Link copied'); } };
}

// ---------- Lead form (add / edit) ----------
export async function openLeadForm(lead = null) {
  const dir = await loadDirectory();
  const agents = dir.filter((d) => d.roles.includes('lead_gen') && d.status === 'active').map((d) => ({ id: d.id, name: d.name }));
  const reps = dir.filter((d) => d.roles.includes('sales_rep') && d.status === 'active').map((d) => ({ id: d.id, name: d.name }));
  const defaultAgent = !lead && agents.some((a) => a.id === state.profile.id) ? state.profile.id : '';
  const m = openModal({
    title: lead ? 'Edit lead' : 'Add inbound or outreach lead',
    subtitle: lead ? esc(lead.company) : `Enroll a new prospect into the ${state.workspace.name} pipeline`,
    icon: 'userPlus',
    wide: true,
    body: `<form id="lf" novalidate>${leadFormHTML({ lead: lead || {}, agents, reps, defaultAgent, canAssign: canAssignLeads() })}</form>`,
    foot: `<button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary btn-lg" data-save>${lead ? 'Save lead' : 'Create lead'}</button>`,
  });
  bindLeadForm(m);
  m.querySelector('[data-cancel]').onclick = () => m.close();
  const err = m.querySelector('#lf-err'); const save = m.querySelector('[data-save]');
  const submit = () => busy(save, async () => {
    err.classList.add('hidden');
    const r = readLeadForm(m);
    if (r.error) { err.textContent = r.error; err.classList.remove('hidden'); if (r.field) m.querySelector(r.field)?.focus(); return; }
    try {
      if (lead) await q(supabase.from('leads').update(r.payload).eq('id', lead.id));
      else await q(supabase.from('leads').insert(r.payload));
      toast(lead ? 'Lead saved' : 'Lead created');
      m.close(); changed();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  save.onclick = submit;
  m.querySelector('#lf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

// ---------- Lead workspace (drawer) ----------
export async function openLeadDrawer(id) {
  const drawer = openDrawer({ title: 'Lead', body: loadingBlock(4), onClose: () => window.removeEventListener('ehos:data-changed', reload) });
  const reload = () => load();
  window.addEventListener('ehos:data-changed', reload);
  async function load() {
    const [lead, dir] = await Promise.all([q(supabase.from('leads').select('*').eq('id', id).maybeSingle()), loadDirectory()]);
    if (!drawer.isConnected) return;
    if (!lead) { drawer.querySelector('.drawer-body').innerHTML = '<p class="muted">This lead was deleted.</p>'; return; }
    const canEdit = can('leads', 'edit');
    const wa = waLink(lead.phone, lead.country);
    drawer.querySelector('.drawer-head h2').innerHTML = `${esc(lead.contact_name || lead.company)}<div class="small muted" style="font-weight:400">${esc(lead.contact_name ? lead.company : '')}</div>`;
    let banner = '';
    if (lead.client_id) banner = `<div class="note ok"><b>Converted to client</b> ${esc(fmtRelative(lead.converted_at || lead.won_at))}. ${can('clients') ? `<button class="linkish" data-client="${lead.client_id}">Open client</button>` : ''}</div>`;
    else if (lead.status === 'won') banner = `<div class="note ok row between wrap" style="gap:10px"><span><b>Won</b> ${esc(fmtRelative(lead.won_at))}. Convert it so the client can be onboarded.</span>${canEdit ? `<button class="btn btn-success btn-sm" data-act="convert">${icon('briefcase', 13)}Convert to client</button>` : ''}</div>`;
    else if (lead.status === 'lost') banner = '<div class="note warn"><b>Lost.</b> Move it back to an open stage if the conversation restarts.</div>';

    drawer.querySelector('.drawer-body').innerHTML = `
      ${banner}
      <div class="row wrap">${leadBadge(lead.status)}<span class="prio-pill ${esc(lead.priority)}" style="margin:0">${esc(PRIORITIES[lead.priority])} priority</span>
        ${lead.budget !== null && lead.budget !== undefined ? `<span class="chip">${esc(fmtBudget(lead.budget, lead.currency))}</span>` : ''}</div>
      <div class="outreach">
        ${lead.phone ? `<a href="tel:${esc(lead.phone)}" aria-label="Call">${icon('phone', 15)}</a>` : ''}
        ${wa ? `<a class="wa" href="${wa}" target="_blank" rel="noopener" aria-label="WhatsApp">${icon('chat', 15)}</a>` : ''}
        ${lead.email ? `<a href="mailto:${esc(lead.email)}" aria-label="Email">${icon('mail', 15)}</a>` : ''}
      </div>
      ${canEdit && !lead.client_id ? `<div><div class="section-title">Pipeline stage</div><div class="seg" role="group" aria-label="Lead stage">${OPEN.map((k) => `<button data-status="${k}" aria-pressed="${lead.status === k}">${STAGES[k]}</button>`).join('')}</div>
        <div class="row" style="margin-top:10px">${lead.status !== 'won' ? `<button class="btn btn-sm btn-success" data-status="won">${icon('trophy', 13)}Mark as won</button>` : ''}${lead.status !== 'lost' ? `<button class="btn btn-sm btn-danger" data-status="lost">${icon('x', 13)}Mark as lost</button>` : ''}</div></div>` : ''}
      <dl class="kv">
        <dt>Company</dt><dd>${esc(lead.company)}</dd>
        <dt>Email</dt><dd>${lead.email ? `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>` : '—'}</dd>
        <dt>Phone</dt><dd>${esc(lead.phone || '—')}</dd>
        <dt>Country</dt><dd>${esc(lead.country || '—')}</dd>
        <dt>Category</dt><dd>${esc(lead.industry || '—')}</dd>
        <dt>Service</dt><dd>${esc(lead.service || '—')}</dd>
        <dt>Source</dt><dd>${esc(lead.source || '—')}</dd>
        <dt>Agent</dt><dd>${esc(agentLabel(lead, dir) || '—')}</dd>
        <dt>Sales rep</dt><dd>${esc(dirName(dir, lead.assigned_to) || 'Not assigned')}</dd>
        <dt>Next follow-up</dt><dd>${lead.next_follow_up ? esc(fmtDate(lead.next_follow_up)) : 'None'}</dd>
        <dt>Added</dt><dd>${esc(fmtDateOfIso(lead.created_at))}${lead.created_by ? `, by ${esc(dirName(dir, lead.created_by))}` : ', via the lead form'}</dd>
      </dl>
      <div><div class="section-title">Notes / requirements</div>${lead.notes ? `<div class="desc">${esc(lead.notes)}</div>` : '<p class="muted small">No notes.</p>'}</div>`;
    let foot = '';
    if (can('leads', 'delete')) foot += `<button class="btn btn-ghost btn-danger" data-act="delete">${icon('trash', 14)}Delete</button>`;
    foot += '<span style="flex:1"></span>';
    if (canEdit) foot += `<button class="btn btn-primary" data-act="edit">${icon('edit', 14)}Edit lead</button>`;
    let footEl = drawer.querySelector('.drawer-foot');
    if (!footEl) { footEl = document.createElement('div'); footEl.className = 'drawer-foot'; drawer.append(footEl); }
    footEl.innerHTML = foot;

    drawer.querySelectorAll('[data-status]').forEach((b) => b.onclick = () => busy(b, async () => {
      try {
        await q(supabase.from('leads').update({ status: b.dataset.status }).eq('id', id));
        toast(b.dataset.status === 'won' ? 'Marked as won. Admin and managers were notified.' : `Moved to ${STAGES[b.dataset.status]}`);
        changed();
      } catch (e) { toast(e.message, 'error'); }
    }));
    drawer.querySelector('[data-client]')?.addEventListener('click', async (e) => {
      const { openClientDrawer } = await import('./clients.js');
      closeDrawer(); openClientDrawer(Number(e.currentTarget.dataset.client));
    });
    drawer.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => busy(b, async () => {
      try {
        if (b.dataset.act === 'edit') return openLeadForm(lead);
        if (b.dataset.act === 'convert') {
          const ok = await confirmDialog({ title: `Convert ${lead.company} to a client?`, text: 'A client is created with these details. Next, create a project for it and assign a project manager. The admin and managers get notified.', confirm: 'Convert to client' });
          if (!ok) return;
          const cid = await rpc('lead_convert', { p_lead: id });
          toast('Converted to client');
          if (can('projects', 'edit') && await confirmDialog({ title: 'Create a project now?', text: `Start a project for ${lead.company} and pick its project manager.`, confirm: 'Create project' })) {
            const pm = await import('./projects.js'); pm.openProjectForm({ clientId: cid });
          }
          changed();
        }
        if (b.dataset.act === 'delete') {
          const ok = await confirmDialog({ title: `Delete ${lead.company}?`, text: 'This removes the lead. A client made from it stays.', confirm: 'Delete lead', danger: true });
          if (!ok) return;
          await q(supabase.from('leads').delete().eq('id', id));
          toast('Lead deleted'); closeDrawer(); changed();
        }
      } catch (e) { toast(e.message, 'error'); }
    }));
  }
  load().catch((e) => { drawer.querySelector('.drawer-body').innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
}

// ---------- CSV import ----------
function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const FIELD_MATCH = [
  ['company', /company|brand|business|store name|shop/],
  ['contact_name', /full name|contact|person|owner|lead name|^name$/],
  ['email', /e-?mail/],
  ['phone', /phone|mobile|whatsapp|number/],
  ['website', /website|url|site|domain|link/],
  ['country', /country|location/],
  ['industry', /industry|niche|category/],
  ['service', /service/],
  ['source', /source|channel/],
  ['currency', /currency/],
  ['budget', /budget|value|spend|amount/],
  ['notes', /note|comment|description|requirement/],
];

export function openImport() {
  const m = openModal({
    title: 'Import leads from CSV', icon: 'upload', subtitle: 'From Google Sheets or Excel: File → Download → CSV',
    body: `
      <p class="muted">The first row needs column names like <b>Full name</b>, <b>Company</b>, Email, Phone, Country, Category, Service, Source, Currency, Budget, Notes.</p>
      <div class="dropzone"><input type="file" accept=".csv,text/csv" id="csv-file" aria-label="CSV file"></div>
      <div id="csv-preview"></div>
      <div class="form-error hidden" id="csv-err"></div>`,
    foot: '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-go disabled>Import leads</button>',
  });
  let records = [];
  const err = m.querySelector('#csv-err'); const go = m.querySelector('[data-go]');
  m.querySelector('[data-cancel]').onclick = () => m.close();
  m.querySelector('#csv-file').onchange = async (e) => {
    err.classList.add('hidden'); go.disabled = true; records = [];
    const file = e.target.files[0]; if (!file) return;
    const rows = parseCSV(await file.text());
    if (rows.length < 2) { err.textContent = 'The file needs a header row and at least one lead.'; err.classList.remove('hidden'); return; }
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const map = {};
    headers.forEach((h, i) => { const f = FIELD_MATCH.find(([key, re]) => !Object.values(map).includes(key) && re.test(h)); if (f) map[i] = f[0]; });
    if (!Object.values(map).includes('company') && !Object.values(map).includes('contact_name')) { err.textContent = 'Couldn\'t find a Company or Full name column.'; err.classList.remove('hidden'); return; }
    const me = state.profile.id;
    records = rows.slice(1).map((r) => {
      const o = {};
      Object.entries(map).forEach(([i, key]) => {
        const v = (r[i] || '').trim(); if (!v) return;
        if (key === 'budget') o.budget = Number(v.replace(/[^0-9.]/g, '')) || null;
        else if (key === 'currency') o.currency = v.toUpperCase().replace('STG', 'GBP').replace(/[^A-Z]/g, '').slice(0, 8);
        else o[key] = v.slice(0, key === 'notes' ? 4000 : 200);
      });
      if (!o.company) o.company = o.contact_name;
      if (state.myRoles.includes('lead_gen')) o.agent_id = me;
      return o;
    }).filter((o) => o.company).slice(0, 2000);
    m.querySelector('#csv-preview').innerHTML = `<div class="note info">Found <b>${records.length}</b> leads. Columns used: ${esc(Object.values(map).join(', '))}.</div>
      <div class="panel" style="margin-top:10px"><div class="list">${records.slice(0, 3).map((r) => `<div class="list-item" style="padding:9px 14px"><div class="grow"><div class="title">${esc(r.contact_name || r.company)}</div><div class="meta">${esc([r.company, r.email, r.country].filter(Boolean).join(', '))}</div></div></div>`).join('')}</div></div>`;
    go.disabled = !records.length;
  };
  go.onclick = () => busy(go, async () => {
    try {
      for (let i = 0; i < records.length; i += 200) await q(supabase.from('leads').insert(records.slice(i, i + 200)));
      toast(`${records.length} leads imported`); m.close(); changed();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
}

// Small list used on role tabs
export async function leadsPanel(kind) {
  const all = await q(supabase.from('leads').select('id, company, contact_name, status, created_at, created_by, agent_id, assigned_to, source, client_id').order('created_at', { ascending: false }).limit(500));
  const me = state.profile.id;
  let list; let title; let sub;
  if (kind === 'lead_gen') {
    list = all.filter((l) => l.created_by === me || l.agent_id === me);
    const week = list.filter((l) => localDate(l.created_at) >= startOfWeek(todayStr())).length;
    title = 'Your leads'; sub = `${week} this week, ${list.length} in total`;
  } else {
    list = all.filter((l) => OPEN.includes(l.status)).sort((a, b) => (b.assigned_to === me) - (a.assigned_to === me));
    const mine = list.filter((l) => l.assigned_to === me).length;
    title = kind === 'cold_caller' ? 'Leads to call' : 'Leads to work'; sub = `${list.length} open leads${mine ? `, ${mine} assigned to you` : ''}`;
  }
  // Sales team: leads nobody has picked up yet, with an assign dropdown
  let pool = '';
  if (kind === 'sales_rep' && canAssignLeads()) {
    const dir = await loadDirectory();
    const reps = dir.filter((d) => d.roles.includes('sales_rep') && d.status !== 'inactive');
    const open = all.filter((l) => !l.assigned_to && !l.client_id && OPEN.includes(l.status));
    pool = `
    <section class="panel role-panel" style="margin-bottom:16px">
      <div class="panel-head"><div><h2>Not assigned yet</h2><p>${open.length ? `${open.length} new ${open.length === 1 ? 'lead needs' : 'leads need'} a sales rep` : 'Every lead has a sales rep'}</p></div>
        <a class="btn btn-sm btn-ghost" href="#/leads?scope=unassigned">See all</a></div>
      <div class="list">${open.length ? open.slice(0, 8).map((l) => `
        <div class="list-item" style="flex-wrap:wrap"><div class="grow clickable" data-lead="${l.id}" style="min-width:160px"><div class="title">${esc(l.contact_name || l.company)}</div>
          <div class="meta"><span>${esc(l.contact_name ? l.company : '')}</span><span>By ${esc(agentLabel(l, dir) || 'lead form')}</span><span>${esc(fmtRelative(l.created_at))}</span></div></div>
          <button class="btn btn-sm btn-primary" data-take="${l.id}">${icon('check', 13)}Take it</button>
          <select class="assign-select" data-assign-for="${l.id}" aria-label="Assign ${esc(l.company)}"><option value="">Assign to…</option>${reps.map((r) => `<option value="${r.id}">${esc(r.name)}${r.id === me ? ' (me)' : ''}</option>`).join('')}</select>
        </div>`).join('') : emptyState('Nothing waiting', 'New leads from Lead Generation and the lead form show up here first.')}</div>
    </section>`;
  }
  const canEdit = can('leads', 'edit');
  return `${pool}
    <section class="panel role-panel">
      <div class="panel-head"><div><h2>${title}</h2><p>${esc(sub)}</p></div>
        <div class="row wrap">${kind === 'lead_gen' ? `<button class="btn btn-sm" data-share>${icon('share', 14)}Share form</button>` : ''}
          ${kind === 'lead_gen' && canEdit ? `<button class="btn btn-sm" data-import>${icon('upload', 14)}Import CSV</button><button class="btn btn-sm btn-primary" data-new-lead>${icon('plus', 14)}New lead</button>` : ''}
          <a class="btn btn-sm btn-ghost" href="#/leads${kind === 'lead_gen' ? '?scope=mine' : '?status=open'}">All leads</a></div></div>
      <div class="list">${list.length ? list.slice(0, 6).map((l) => `
        <div class="list-item clickable" data-lead="${l.id}"><div class="grow"><div class="title">${esc(l.contact_name || l.company)}</div><div class="meta"><span>${esc(l.contact_name ? l.company : '')}</span><span>${esc(fmtRelative(l.created_at))}</span></div></div>${l.client_id ? '<span class="badge won">Client</span>' : leadBadge(l.status)}</div>`).join('')
        : emptyState(kind === 'lead_gen' ? 'No leads yet' : 'No open leads', kind === 'lead_gen' ? 'Add your first lead or share the form.' : 'New leads from lead generation show up here.')}</div>
    </section>`;
}

// Wire the Sales rep "Not assigned yet" panel
export function bindLeadsPanel(root) {
  const assign = async (id, to, ctl) => {
    ctl.disabled = true;
    try {
      await q(supabase.from('leads').update({ assigned_to: to }).eq('id', id));
      toast(to === state.profile.id ? 'The lead is yours now' : 'Lead assigned. They were notified.');
      changed();
    } catch (e) { toast(e.message, 'error'); ctl.disabled = false; }
  };
  root.querySelectorAll('[data-take]').forEach((b) => b.onclick = () => assign(Number(b.dataset.take), state.profile.id, b));
  root.querySelectorAll('[data-assign-for]').forEach((sel) => sel.onchange = () => { if (sel.value) assign(Number(sel.dataset.assignFor), sel.value, sel); });
}
