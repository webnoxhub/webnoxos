// Clients: onboarding, project manager, invoices, contracts & documents
import { supabase } from '../supabase.js';
import { state, can, canAny, money } from '../state.js';
import { q, loadDirectory, dirName } from '../data.js';
import { esc, icon, emptyState, loadingBlock, on, openDrawer, closeDrawer, openModal, confirmDialog, toast, busy } from '../ui.js';
import { fmtDate, fmtDateOfIso, todayStr, daysBetween, dueLabel, dueState } from '../time.js';
import { statusBadge, prioTag } from '../ui.js';
import { INVOICE_STATUS, invoiceState, invoiceBadge, invAmount, openInvoiceEditor, openInvoiceView } from '../invoices.js';

export { INVOICE_STATUS, invoiceState, invoiceBadge };

// Invoices come with Finance and Projects with their own page; flip these when those land.
const INVOICES_READY = false;
const PROJECTS_READY = false;
const canProj = () => PROJECTS_READY && can('projects', 'edit');

export const CLIENT_STATUS = { onboarding: 'Onboarding', active: 'Active', paused: 'Paused', churned: 'Churned' };
const FILE_KINDS = { contract: 'Contract', document: 'Document', invoice: 'Invoice PDF', other: 'Other' };
const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
export const clientBadge = (s) => `<span class="badge ${esc(s)}">${esc(CLIENT_STATUS[s] || s)}</span>`;
const isPM = (c) => c.project_manager === state.profile.id;
const canEditClient = (c) => can('clients', 'edit') || (isPM(c) && state.pmPerms.clients?.edit);
const canDeleteClient = (c) => can('clients', 'delete') || (isPM(c) && state.pmPerms.clients?.delete);
const canInv = (c, a) => can('finance', a) || (isPM(c) && state.pmPerms.finance?.[a]);
const canFiles = (c, a) => (a === 'view' ? true : a === 'edit' ? canEditClient(c) : canDeleteClient(c));

export async function render({ el, params }) {
  let clients = []; let invoices = []; let dir = []; let projects = [];
  let status = params.get('status') || 'all';
  let search = '';
  const showMoney = INVOICES_READY && canAny('finance');
  const onlyMine = !can('clients');

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${onlyMine ? 'My clients' : 'Clients'}</h1><p>${onlyMine ? 'Clients of the projects you run or work on.' : (PROJECTS_READY && INVOICES_READY ? 'Won deals with their onboarding, projects, contracts, invoices and revenue.' : 'Won deals with their onboarding, contracts, documents and tasks.')}</p></div>
      <div class="actions">${can('clients', 'edit') ? `<button class="btn btn-primary" id="new">${icon('plus', 15)}New client</button>` : ''}</div>
    </div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Status" id="status"></div></div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search clients" aria-label="Search clients"></div>
    </div>
    <section class="panel"><div class="table-wrap" id="table">${loadingBlock(5)}</div></section>`;
  const table = el.querySelector('#table');

  const sums = (id) => {
    const inv = invoices.filter((i) => i.client_id === id);
    return { paid: inv.filter((i) => i.status === 'paid').reduce((a, i) => a + Number(i.amount), 0), due: inv.filter((i) => i.status === 'sent').reduce((a, i) => a + Number(i.amount), 0), overdue: inv.some((i) => invoiceState(i) === 'overdue') };
  };

  function draw() {
    el.querySelector('#status').innerHTML = [['all', 'All'], ...Object.entries(CLIENT_STATUS)].map(([k, v]) =>
      `<button data-s="${k}" aria-pressed="${status === k}">${v}<span class="count">${k === 'all' ? clients.length : clients.filter((c) => c.status === k).length}</span></button>`).join('');
    const s = search.toLowerCase();
    const list = clients.filter((c) => (status === 'all' || c.status === status)
      && (!s || `${c.name} ${c.buid || ''} ${c.contact_name || ''} ${c.email || ''}`.toLowerCase().includes(s)));
    if (!clients.length) {
      table.innerHTML = emptyState(onlyMine ? 'No clients assigned to you yet' : 'No clients yet', onlyMine ? 'When you run or join a project, its client shows up here.' : 'Mark a lead as won, or add a client directly.', can('clients', 'edit') ? '<button class="btn btn-primary" data-new>New client</button>' : '');
      return;
    }
    if (!list.length) { table.innerHTML = emptyState('No clients match these filters'); return; }
    table.innerHTML = `<table class="table">
      <thead><tr><th>Client</th><th>Status</th><th>Onboarded</th>${PROJECTS_READY ? '<th>Projects</th>' : '<th>Contact</th>'}<th class="r">Retainer / mo</th>${showMoney ? '<th class="r">Revenue</th><th class="r">Unpaid</th>' : ''}</tr></thead>
      <tbody>${list.map((c) => { const m = sums(c.id); return `<tr class="clickable" data-id="${c.id}" tabindex="0">
        <td><div style="font-weight:500">${esc(c.name)}${c.buid ? ` <span class="inv-buid-chip">${esc(c.buid)}</span>` : ''}</div><div class="small muted">${esc([c.contact_name, c.country].filter(Boolean).join(', ') || '—')}</div></td>
        <td>${clientBadge(c.status)}</td>
        <td class="small">${esc(fmtDate(c.onboarding_date))}</td>
        ${!PROJECTS_READY ? `<td class="small">${esc(c.contact_name || '—')}</td>` : `<td class="small">${(() => { const ps = projects.filter((x) => x.client_id === c.id); return ps.length ? `${ps.length} ${ps.length === 1 ? 'project' : 'projects'}<div class="muted">${esc([...new Set(ps.map((x) => dirName(dir, x.project_manager)).filter(Boolean))].join(', ') || 'No PM yet')}</div>` : '<span class="muted">No project yet</span>'; })()}</td>`}
        <td class="r money">${c.monthly_retainer ? money(c.monthly_retainer) : '<span class="muted">—</span>'}</td>
        ${showMoney ? `<td class="r money pos">${money(m.paid)}</td><td class="r money" style="${m.overdue ? 'color:var(--error);font-weight:600' : ''}">${m.due ? money(m.due) : '<span class="muted">—</span>'}</td>` : ''}
      </tr>`; }).join('')}</tbody></table>`;
  }

  async function load() {
    [clients, invoices, dir, projects] = await Promise.all([
      q(supabase.from('clients').select('*').order('created_at', { ascending: false })),
      showMoney ? q(supabase.from('invoices').select('id, client_id, amount, status, due_date')) : Promise.resolve([]),
      loadDirectory(),
      PROJECTS_READY ? q(supabase.from('projects').select('id, client_id, project_manager, status')).catch(() => []) : Promise.resolve([]),
    ]);
    draw();
  }

  el.querySelector('#status').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { status = b.dataset.s; draw(); } });
  el.querySelector('#q').addEventListener('input', (e) => { search = e.target.value.trim(); draw(); });
  el.querySelector('#new')?.addEventListener('click', () => openClientForm());
  const offs = [
    on(table, 'click', '[data-new]', () => openClientForm()),
    on(table, 'click', 'tr[data-id]', (e, tr) => openClientDrawer(Number(tr.dataset.id))),
    on(table, 'keydown', 'tr[data-id]', (e, tr) => { if (e.key === 'Enter') openClientDrawer(Number(tr.dataset.id)); }),
  ];
  const safe = () => load().catch((e) => { table.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  await safe();
  if (params.get('open')) openClientDrawer(Number(params.get('open')));
  window.addEventListener('ehos:data-changed', safe);
  return () => { offs.forEach((x) => x()); window.removeEventListener('ehos:data-changed', safe); };
}

// ---------- Client form ----------
export async function openClientForm(client = null) {
  const c = client || { name: '', contact_name: '', email: '', phone: '', website: '', country: '', services: '', onboarding_date: todayStr(), status: 'onboarding', monthly_retainer: '', project_manager: '', notes: '' };
  const m = openModal({
    title: client ? 'Edit client' : 'New client',
    wide: true,
    body: `
      <form id="cf" class="form-grid" novalidate>
        <div class="field span-2"><label for="cf-name">Client / brand</label><input id="cf-name" class="input" maxlength="200" value="${esc(c.name)}" required></div>
        <div class="field"><label for="cf-contact">Contact person</label><input id="cf-contact" class="input" maxlength="120" value="${esc(c.contact_name || '')}"></div>
        <div class="field"><label for="cf-email">Email</label><input id="cf-email" class="input" type="email" maxlength="160" value="${esc(c.email || '')}"></div>
        <div class="field"><label for="cf-phone">Phone / WhatsApp</label><input id="cf-phone" class="input" maxlength="40" value="${esc(c.phone || '')}"></div>
        <div class="field"><label for="cf-web">Website / store</label><input id="cf-web" class="input" maxlength="200" value="${esc(c.website || '')}"></div>
        <div class="field span-2"><label for="cf-address">Address</label><input id="cf-address" class="input" maxlength="300" value="${esc(c.address || '')}" placeholder="Street, city — printed on invoices"></div>
        <div class="field"><label for="cf-country">Country</label><input id="cf-country" class="input" maxlength="60" value="${esc(c.country || '')}"></div>
        <div class="field"><label for="cf-date">Onboarding date</label><input id="cf-date" class="input" type="date" value="${esc(c.onboarding_date || '')}"></div>
        <div class="field"><label for="cf-status">Status</label><select id="cf-status" class="select">${Object.entries(CLIENT_STATUS).map(([k, v]) => `<option value="${k}" ${c.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="cf-ret">Monthly retainer (${esc(state.settings.currency || 'USD')})</label><input id="cf-ret" class="input" type="number" min="0" step="1" value="${esc(c.monthly_retainer ?? '')}"></div>
        <div class="field span-2"><label for="cf-services">Services</label><input id="cf-services" class="input" maxlength="300" value="${esc(c.services || '')}" placeholder="Meta ads, Google ads, CRO…"></div>
        <div class="field span-2"><label for="cf-notes">Notes</label><textarea id="cf-notes" class="textarea">${esc(c.notes || '')}</textarea></div>
        <div class="form-error hidden span-2" id="cf-err"></div>
      </form>`,
    foot: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${client ? 'Save client' : 'Add client'}</button>`,
  });
  m.querySelector('[data-cancel]').onclick = () => m.close();
  const err = m.querySelector('#cf-err'); const save = m.querySelector('[data-save]');
  const submit = () => busy(save, async () => {
    err.classList.add('hidden');
    const v = (id) => m.querySelector(id).value.trim();
    const payload = {
      name: v('#cf-name'), contact_name: v('#cf-contact') || null, email: v('#cf-email') || null, phone: v('#cf-phone') || null,
      website: v('#cf-web') || null, address: v('#cf-address') || null, country: v('#cf-country') || null, onboarding_date: v('#cf-date') || null, status: v('#cf-status'),
      monthly_retainer: v('#cf-ret') === '' ? null : Number(v('#cf-ret')), services: v('#cf-services') || null, notes: v('#cf-notes'),
    };
    if (!payload.name) { err.textContent = 'Enter the client name.'; err.classList.remove('hidden'); return; }
    try {
      if (client) await q(supabase.from('clients').update(payload).eq('id', client.id));
      else {
        const row = await q(supabase.from('clients').insert(payload).select('id').single());
        toast('Client added'); m.close(); changed();
        if (canProj() && await confirmDialog({ title: 'Create a project for this client?', text: 'A project gets a project manager and a team.', confirm: 'Create project' })) {
          (await import('./projects.js')).openProjectForm({ clientId: row.id });
        }
        return;
      }
      toast('Client saved'); m.close(); changed();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  save.onclick = submit;
  m.querySelector('#cf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

// ---------- Invoice form (kept for older callers; the editor lives in ../invoices.js) ----------
export function openInvoiceForm({ clientId = null, projectId = null, invoice = null } = {}) {
  return openInvoiceEditor({ kind: 'client', clientId, projectId, invoice });
}

// ---------- Client drawer ----------
export function openClientDrawer(id, tab = 'overview') {
  const drawer = openDrawer({ title: 'Client', body: loadingBlock(4), onClose: () => window.removeEventListener('ehos:data-changed', reload) });
  const reload = () => load();
  window.addEventListener('ehos:data-changed', reload);

  async function load() {
    const [c, dir] = await Promise.all([q(supabase.from('clients').select('*').eq('id', id).maybeSingle()), loadDirectory()]);
    if (!drawer.isConnected) return;
    if (!c) { drawer.querySelector('.drawer-body').innerHTML = '<p class="muted">This client was deleted or isn\'t assigned to you.</p>'; return; }
    const showInv = INVOICES_READY && canInv(c, 'view');
    const [invoices, files, projects, ctasks] = await Promise.all([
      showInv ? q(supabase.from('invoices').select('*').eq('client_id', id).order('issue_date', { ascending: false })) : Promise.resolve([]),
      q(supabase.from('client_files').select('*').eq('client_id', id).order('created_at', { ascending: false })),
      PROJECTS_READY ? q(supabase.from('projects').select('*').eq('client_id', id).order('created_at', { ascending: false })).catch(() => []) : Promise.resolve([]),
      q(supabase.from('tasks').select('id, title, status, priority, due_date, assigned_to').eq('client_id', id).order('created_at', { ascending: false })),
    ]);
    if (!drawer.isConnected) return;
    drawer.querySelector('.drawer-head h2').textContent = c.name;
    const paid = invoices.filter((i) => i.status === 'paid').reduce((a, i) => a + Number(i.amount), 0);
    const due = invoices.filter((i) => i.status === 'sent').reduce((a, i) => a + Number(i.amount), 0);
    const projName = (pid) => projects.find((x) => x.id === pid)?.name || '';
    const projectBadge = PROJECTS_READY ? (await import('./projects.js')).projectBadge : () => '';
    const tabs = [['overview', 'Overview'], PROJECTS_READY && ['projects', `Projects${projects.length ? ` (${projects.length})` : ''}`], ['tasks', `Tasks${ctasks.length ? ` (${ctasks.length})` : ''}`],
      showInv && ['invoices', `Invoices${invoices.length ? ` (${invoices.length})` : ''}`], ['files', `Files${files.length ? ` (${files.length})` : ''}`]].filter(Boolean);
    if (!tabs.some(([k]) => k === tab)) tab = 'overview';

    let content = '';
    if (tab === 'overview') {
      content = `
        <div class="row wrap">${clientBadge(c.status)}${c.buid ? `<span class="inv-buid-chip" title="Business ID — used in invoice numbers">${esc(c.buid)}</span>` : ''}${c.monthly_retainer ? `<span class="chip">${money(c.monthly_retainer)} / mo</span>` : ''}</div>
        ${showInv ? `<div class="stats"><div class="stat-group">
          <div class="stat"><div class="v" style="font-size:19px;color:#15803D">${money(paid)}</div><div class="k">Revenue</div></div>
          <div class="stat"><div class="v" style="font-size:19px">${money(due)}</div><div class="k">Unpaid</div></div>
          <div class="stat"><div class="v" style="font-size:19px">${invoices.length}</div><div class="k">Invoices</div></div></div></div>` : ''}
        <dl class="kv">
          <dt>Onboarding date</dt><dd>${esc(fmtDate(c.onboarding_date))}</dd>
          ${c.buid ? `<dt>Business ID</dt><dd>${esc(c.buid)} ${INVOICES_READY ? `<span class="muted small">· invoices ${esc(`INV-BUID-${c.invoice_code || ''}001…`)}</span>` : ''}</dd>` : ''}
          ${PROJECTS_READY ? `<dt>Projects</dt><dd>${projects.length ? projects.map((x) => `${esc(x.name)} <span class="muted small">(${esc(dirName(dir, x.project_manager) || 'no PM yet')})</span>`).join('<br>') : 'None yet'}</dd>` : ''}
          <dt>Contact</dt><dd>${esc(c.contact_name || '—')}</dd>
          <dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</dd>
          <dt>Phone</dt><dd>${esc(c.phone || '—')}</dd>
          <dt>Website</dt><dd>${c.website ? `<a href="${esc(/^https?:/.test(c.website) ? c.website : 'https://' + c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : '—'}</dd>
          <dt>Address</dt><dd>${esc(c.address || '—')}</dd>
          <dt>Country</dt><dd>${esc(c.country || '—')}</dd>
          <dt>Services</dt><dd>${esc(c.services || '—')}</dd>
          <dt>Client since</dt><dd>${esc(fmtDateOfIso(c.created_at))}${c.lead_id ? ' (from a won lead)' : ''}</dd>
        </dl>
        <div><div class="section-title">Notes</div>${c.notes ? `<div class="desc">${esc(c.notes)}</div>` : '<p class="muted small">No notes.</p>'}</div>`;
    } else if (tab === 'projects') {
      content = `
        <div class="note info">Each project has its own project manager and team. The project manager sees only their project: its tasks, files and invoices.</div>
        <div class="section-title">Projects for this client <span>${canProj() ? `<button class="btn btn-sm btn-primary" data-new-project>${icon('plus', 13)}Create project</button>` : ''}</span></div>
        ${projects.length ? `<div class="panel"><div class="list">${projects.map((x) => `
          <a class="list-item" href="#/project/${x.id}"><div class="grow"><div class="title">${esc(x.name)}</div>
            <div class="meta"><span>PM: ${esc(dirName(dir, x.project_manager) || 'not assigned')}</span>${x.due_date ? `<span>Due ${esc(fmtDate(x.due_date))}</span>` : ''}</div></div>${projectBadge(x.status)}</a>`).join('')}</div></div>`
          : emptyState('No projects yet', canProj() ? 'Create a project, pick its project manager, then add the team.' : '')}`;
    } else if (tab === 'tasks') {
      content = `
        <div class="section-title">Tasks for this client <span>${state.isAdmin ? `<button class="btn btn-sm btn-primary" data-assign="">${icon('plus', 13)}New task</button>` : ''}</span></div>
        ${ctasks.length ? `<div class="panel"><div class="list">${ctasks.map((t) => `
          <div class="list-item clickable" data-task="${t.id}"><div class="grow"><div class="title">${esc(t.title)}</div>
            <div class="meta">${statusBadge(t.status)}${prioTag(t.priority)}<span>${esc(dirName(dir, t.assigned_to) || 'Unassigned')}</span>${t.due_date && t.status !== 'completed' ? `<span class="due ${dueState(t)}">${esc(dueLabel(t.due_date))}</span>` : ''}</div></div></div>`).join('')}</div></div>`
          : emptyState('No tasks yet', 'Tasks made inside a project show up here too.')}`;
    } else if (tab === 'invoices') {
      content = `
        <div class="section-title">Invoices <span class="row">${canInv(c, 'edit') ? `<button class="btn btn-sm btn-primary" data-new-inv>${icon('plus', 13)}New invoice</button>` : ''}</span></div>
        ${invoices.length ? `<div class="panel"><div class="list">${invoices.map((i) => `
          <div class="list-item clickable" style="padding:11px 14px" data-view-inv="${i.id}">
            <div class="grow"><div class="title">${esc(i.invoice_number || `Invoice #${i.id}`)} <span class="money" style="font-weight:600;margin-left:6px">${invAmount(i)}</span></div>
              <div class="meta"><span>Issued ${esc(fmtDate(i.issue_date))}</span>${i.due_date ? `<span>Due ${esc(fmtDate(i.due_date))}</span>` : ''}${i.paid_date ? `<span>Paid ${esc(fmtDate(i.paid_date))}</span>` : ''}${i.description ? `<span>${esc(i.description)}</span>` : ''}${i.project_id ? `<span>${icon('folder', 11)} ${esc(projName(i.project_id))}</span>` : ''}</div></div>
            ${invoiceBadge(i)}
            ${canInv(c, 'edit') && i.status === 'sent' ? `<button class="btn btn-sm" data-paid="${i.id}">${icon('check', 13)}Mark paid</button>` : ''}
            ${canInv(c, 'edit') ? `<button class="btn btn-sm btn-ghost btn-icon" data-edit-inv="${i.id}" aria-label="Edit invoice">${icon('edit', 13)}</button>` : ''}
            ${canInv(c, 'delete') ? `<button class="btn btn-sm btn-ghost btn-icon btn-danger" data-del-inv="${i.id}" aria-label="Delete invoice">${icon('trash', 13)}</button>` : ''}
          </div>`).join('')}</div></div>` : emptyState('No invoices yet', 'Paid invoices count as revenue on the dashboard.')}`;
    } else {
      content = `
        ${canFiles(c, 'edit') ? `<div class="panel"><div class="panel-body stack" style="gap:10px">
          <div class="section-title" style="margin:0">Upload a file</div>
          <div class="row wrap"><select class="select select-sm" id="f-kind" style="width:auto">${Object.entries(FILE_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <input type="file" id="f-file" aria-label="File" style="flex:1;min-width:180px"><button class="btn btn-sm btn-primary" data-upload>${icon('upload', 13)}Upload</button></div>
          <span class="hint small muted">PDF, Word, images, up to 25 MB. Only people who can see this client can open it.</span></div></div>` : ''}
        ${files.length ? `<div class="panel"><div>${files.map((f) => `
          <div class="file-row">${icon('file', 18)}<div class="grow"><div class="title">${esc(f.name)}</div>
            <div class="small muted">${f.project_id ? `${icon('folder', 11)} ${esc(projName(f.project_id))}, ` : ''}${esc(FILE_KINDS[f.kind] || f.kind)}, ${f.size_bytes ? (f.size_bytes / 1048576).toFixed(1) + ' MB, ' : ''}${esc(dirName(dir, f.uploaded_by) || '')} ${esc(fmtDateOfIso(f.created_at))}</div></div>
            <button class="btn btn-sm" data-open-file="${esc(f.storage_path)}">${icon('download', 13)}Open</button>
            ${canFiles(c, 'delete') ? `<button class="btn btn-sm btn-ghost btn-icon btn-danger" data-del-file="${f.id}" aria-label="Delete file">${icon('trash', 13)}</button>` : ''}
          </div>`).join('')}</div></div>` : emptyState('No contracts or documents yet')}`;
    }

    drawer.querySelector('.drawer-body').innerHTML = `
      <div class="tabs-line" role="tablist">${tabs.map(([k, v]) => `<button data-tab="${k}" aria-pressed="${tab === k}">${v}</button>`).join('')}</div>${content}`;
    let foot = '';
    if (canDeleteClient(c)) foot += `<button class="btn btn-ghost btn-danger" data-act="delete">${icon('trash', 14)}Delete</button>`;
    foot += '<span style="flex:1"></span>';
    if (canProj()) foot += `<button class="btn" data-act="project">${icon('folder', 14)}Create project</button>`;
    if (canEditClient(c) || (projects.some((x) => x.project_manager === state.profile.id) && state.pmPerms.clients?.edit)) foot += `<button class="btn btn-primary" data-act="edit">${icon('edit', 14)}Edit client</button>`;
    let footEl = drawer.querySelector('.drawer-foot');
    if (!footEl) { footEl = document.createElement('div'); footEl.className = 'drawer-foot'; drawer.append(footEl); }
    footEl.innerHTML = foot;

    const body = drawer.querySelector('.drawer-body');
    body.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; load(); });
    body.querySelector('[data-new-inv]')?.addEventListener('click', () => openInvoiceForm({ clientId: id }));
    body.querySelector('[data-act="edit"]')?.addEventListener('click', () => openClientForm(c));
    body.querySelector('[data-new-project]')?.addEventListener('click', async () => (await import('./projects.js')).openProjectForm({ clientId: id }));
    body.querySelectorAll('[data-assign]').forEach((b) => b.onclick = async () => {
      const { openTaskForm } = await import('../task-drawer.js');
      openTaskForm({ clientId: id, clientName: c.name, presetMember: b.dataset.assign || null, onSaved: () => { tab = 'tasks'; changed(); } });
    });
    body.querySelectorAll('[data-task]').forEach((x) => x.onclick = async () => { const { openTaskDrawer } = await import('../task-drawer.js'); openTaskDrawer(Number(x.dataset.task)); });
    body.querySelectorAll('[data-edit-inv]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); openInvoiceForm({ clientId: id, invoice: invoices.find((i) => i.id === Number(b.dataset.editInv)) }); });
    body.querySelectorAll('[data-view-inv]').forEach((x) => x.onclick = (e) => { if (!e.target.closest('button')) openInvoiceView(Number(x.dataset.viewInv)); });
    body.querySelectorAll('[data-paid]').forEach((b) => b.onclick = (e) => busy(b, async () => {
      try { await q(supabase.from('invoices').update({ status: 'paid' }).eq('id', Number(b.dataset.paid))); toast('Marked as paid'); changed(); } catch (e) { toast(e.message, 'error'); }
    }));
    body.querySelectorAll('[data-del-inv]').forEach((b) => b.onclick = async (e) => {
      e.stopPropagation();
      if (!await confirmDialog({ title: 'Delete this invoice?', text: 'It stops counting toward revenue.', confirm: 'Delete invoice', danger: true })) return;
      try { await q(supabase.from('invoices').delete().eq('id', Number(b.dataset.delInv))); toast('Invoice deleted'); changed(); } catch (e) { toast(e.message, 'error'); }
    });
    body.querySelectorAll('[data-open-file]').forEach((b) => b.onclick = () => busy(b, async () => {
      const { data, error } = await supabase.storage.from('client-files').createSignedUrl(b.dataset.openFile, 120);
      if (error) return toast(error.message, 'error');
      window.open(data.signedUrl, '_blank', 'noopener');
    }));
    body.querySelectorAll('[data-del-file]').forEach((b) => b.onclick = async () => {
      const f = files.find((x) => x.id === Number(b.dataset.delFile));
      if (!await confirmDialog({ title: `Delete ${f.name}?`, confirm: 'Delete file', danger: true })) return;
      try {
        await q(supabase.from('client_files').delete().eq('id', f.id));
        await supabase.storage.from('client-files').remove([f.storage_path]);
        toast('File deleted'); changed();
      } catch (e) { toast(e.message, 'error'); }
    });
    body.querySelector('[data-upload]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const file = body.querySelector('#f-file').files[0];
      if (!file) return toast('Choose a file first', 'error');
      if (file.size > 25 * 1048576) return toast('Files can be up to 25 MB', 'error');
      const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
      const path = `${state.workspace.id}/${id}/${crypto.randomUUID()}-${safeName}`;
      const up = await supabase.storage.from('client-files').upload(path, file, { contentType: file.type || 'application/octet-stream' });
      if (up.error) return toast(up.error.message, 'error');
      try {
        await q(supabase.from('client_files').insert({ client_id: id, kind: body.querySelector('#f-kind').value, name: file.name.slice(0, 200), storage_path: path, size_bytes: file.size }));
        toast('File uploaded'); changed();
      } catch (err) {
        await supabase.storage.from('client-files').remove([path]);
        toast(err.message, 'error');
      }
    }));
    footEl.querySelector('[data-act="edit"]')?.addEventListener('click', () => openClientForm(c));
    footEl.querySelector('[data-act="project"]')?.addEventListener('click', async () => (await import('./projects.js')).openProjectForm({ clientId: id }));
    footEl.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      if (!await confirmDialog({ title: `Delete ${c.name}?`, text: 'Its projects, invoices and file records are deleted too. This can\'t be undone.', confirm: 'Delete client', danger: true })) return;
      try {
        const paths = files.map((f) => f.storage_path);
        if (paths.length) await supabase.storage.from('client-files').remove(paths); // while access checks still pass
        await q(supabase.from('clients').delete().eq('id', id));
        toast('Client deleted'); closeDrawer(); changed();
      } catch (e) { toast(e.message, 'error'); }
    });
  }
  load().catch((e) => { drawer.querySelector('.drawer-body').innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
}

// Small list for the Project Manager role tab
export async function clientsPanel() {
  const list = await q(supabase.from('clients').select('id, name, status, onboarding_date, contact_name').eq('project_manager', state.profile.id).order('name'));
  return `
    <section class="panel role-panel">
      <div class="panel-head"><div><h2>Your clients</h2><p>${list.length} assigned to you</p></div><a class="btn btn-sm btn-ghost" href="#/clients">Open clients</a></div>
      <div class="list">${list.length ? list.map((c) => `
        <div class="list-item clickable" data-client="${c.id}"><div class="grow"><div class="title">${esc(c.name)}</div><div class="meta"><span>${esc(c.contact_name || '')}</span><span>Onboarded ${esc(fmtDate(c.onboarding_date))}</span></div></div>${clientBadge(c.status)}</div>`).join('')
        : emptyState('No clients assigned yet', 'When the admin assigns you a client, it shows up here.')}</div>
    </section>`;
}
