import { esc, icon } from '/js/ui.js';
import { todayISO, fmtDate } from '/js/time.js';
import { statusInfo, TYPE_LABEL, CYCLE_LABEL } from '/js/billing.js';
import { isEmail, EMAIL_MSG } from '/js/validate.js';
import { confirmByName } from '/js/modal.js';

const FILTERS = [
  ['all', 'All'], ['trial', 'Trial'], ['active', 'Active'], ['suspended', 'Suspended'], ['archived', 'Archived'],
];

const STATUS_LABEL = { setup: 'Setup', trial: 'Trial', active: 'Active', suspended: 'Suspended', archived: 'Archived' };
const STATUS_TONE  = { setup: 'muted', trial: 'accent', active: 'ok', suspended: 'err', archived: 'muted' };

const ROLES = [
  { id: 'sales_rep',       label: 'Sales Rep' },
  { id: 'lead_gen',        label: 'Lead Gen' },
  { id: 'cold_caller',     label: 'Cold Caller' },
  { id: 'finance',         label: 'Finance' },
  { id: 'project_manager', label: 'Project Manager' },
  { id: 'project_agent',   label: 'Project Agent' },
];

const PLANS = [
  { id: 'trial_7',   label: '7-Day Trial',  paid: false },
  { id: 'trial_14',  label: '14-Day Trial', paid: false },
  { id: 'monthly',   label: 'Monthly',      paid: true  },
  { id: 'quarterly', label: 'Quarterly',    paid: true  },
  { id: 'yearly',    label: 'Yearly',       paid: true  },
];

// ── Main entry ─────────────────────────────────────────────────────────────────
export default async function render({ el, sb, setTitle }) {
  setTitle('Workspaces');
  el.innerHTML = '<p class="muted pad">Loading…</p>';

  const data = await loadWorkspaces(sb);
  if (data.error) {
    el.innerHTML = '<div class="empty"><p>Could not load workspaces.</p><button class="btn" id="retry" type="button">Try again</button></div>';
    el.querySelector('#retry').addEventListener('click', () => render({ el, sb, setTitle }));
    return;
  }

  const reload = () => render({ el, sb, setTitle });
  renderList(el, data,
    () => openCreateModal({ el, sb, onCreated: reload }),
    (id) => openWorkspacePanel({ sb, id, onChanged: reload }));
}

// ── Load workspaces + member counts ───────────────────────────────────────────
async function loadWorkspaces(sb) {
  const [wsR, memR] = await Promise.all([
    sb.from('workspaces')
      .select('id,name,slug,short_code,type,status,created_at,subscriptions(cycle,amount_original,currency,next_due,trial_ends_on,status)')
      .order('created_at', { ascending: false }),
    sb.from('master_member_list').select('workspace_id'),
  ]);
  if (wsR.error) return { error: wsR.error };
  if (memR.error) return { error: memR.error };

  const members = {};
  (memR.data || []).forEach((m) => { members[m.workspace_id] = (members[m.workspace_id] || 0) + 1; });
  const today = todayISO();
  const list = (wsR.data || []).map((w) => {
    const sub = Array.isArray(w.subscriptions) ? w.subscriptions[0] : w.subscriptions;
    return { w, sub: sub || null, info: statusInfo(w, sub || null, today), n: members[w.id] || 0 };
  });
  return { list };
}

// ── Render workspace list ──────────────────────────────────────────────────────
function renderList(el, { list }, onNew, onOpen) {
  if (!list.length) {
    el.innerHTML =
      '<div class="page-head"><h2 class="page-title">Workspaces</h2>' +
      '<button class="btn" id="newWs" type="button">' + icon('plus', 16) + ' New Workspace</button></div>' +
      '<div class="empty">' + icon('building', 36) +
      '<p>No workspaces yet.</p><p class="muted small">Create your first workspace to get started.</p></div>';
    el.querySelector('#newWs').addEventListener('click', onNew);
    return;
  }

  const count = (k) => (k === 'all' ? list.length : list.filter((x) => x.w.status === k).length);
  let filter = 'all', q = '';

  el.innerHTML =
    '<div class="page-head"><h2 class="page-title">Workspaces</h2>' +
    '<button class="btn" id="newWs" type="button">' + icon('plus', 16) + ' New Workspace</button></div>' +
    '<div class="toolbar">' +
      '<div class="chips" role="group" aria-label="Filter by status">' +
        FILTERS.map(([k, label]) =>
          '<button class="fchip" type="button" data-f="' + k + '" aria-pressed="' + (k === 'all') + '">' +
          esc(label) + ' <span class="fcount">' + count(k) + '</span></button>').join('') +
      '</div>' +
      '<label class="search">' + icon('search', 16) +
        '<input id="q" type="search" placeholder="Search workspaces" aria-label="Search workspaces" autocomplete="off"></label>' +
    '</div>' +
    '<div class="table-wrap"><table class="wtable"><thead><tr>' +
      '<th>Workspace</th><th>Type</th><th>Members</th><th>Plan</th><th>Next due</th><th>Days left</th><th>Status</th><th></th>' +
    '</tr></thead><tbody id="rows"></tbody></table></div>' +
    '<div class="empty" id="none" hidden><p>No workspaces match.</p></div>';

  el.querySelector('#newWs').addEventListener('click', onNew);

  const rows = el.querySelector('#rows'), none = el.querySelector('#none');

  function paint() {
    const shown = list.filter((x) =>
      (filter === 'all' || x.w.status === filter) &&
      (!q || (x.w.name + ' ' + x.w.slug).toLowerCase().includes(q)));
    rows.innerHTML = shown.map(({ w, sub, info, n }) => {
      const days = info.days === null ? '—' : String(info.days);
      return '<tr>' +
        '<td data-l="Workspace" class="c-name"><strong>' + esc(w.name) + '</strong><span class="muted small">/' + esc(w.slug) + '</span></td>' +
        '<td data-l="Type">' + esc(TYPE_LABEL[w.type] || w.type) + '</td>' +
        '<td data-l="Members">' + n + '</td>' +
        '<td data-l="Plan">' + (sub ? esc(CYCLE_LABEL[sub.cycle] || sub.cycle) +
            '<span class="muted small">' + esc(sub.currency) + ' ' + esc(Number(sub.amount_original).toLocaleString('en-US')) + '</span>' : '—') + '</td>' +
        '<td data-l="Next due">' + esc(sub ? fmtDate(sub.next_due || sub.trial_ends_on) : '—') + '</td>' +
        '<td data-l="Days left" class="c-days' + (info.days !== null && info.days < 0 ? ' neg' : '') + '">' + esc(days) + '</td>' +
        '<td data-l="Status"><span class="chip chip-' + (STATUS_TONE[w.status] || 'muted') + '">' + esc(STATUS_LABEL[w.status] || w.status) + '</span>' +
          (w.type === 'rented' && info.label !== (STATUS_LABEL[w.status] || '') ? '<span class="muted small">' + esc(info.label) + '</span>' : '') + '</td>' +
        '<td data-l=""><button class="btn btn-sm btn-ghost" type="button" data-open="' + esc(w.id) + '">Open</button></td>' +
      '</tr>';
    }).join('');
    rows.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => onOpen(b.dataset.open)));
    none.hidden = shown.length > 0;
    el.querySelector('.table-wrap').hidden = shown.length === 0;
  }

  el.querySelectorAll('.fchip').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    el.querySelectorAll('.fchip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paint();
  }));
  el.querySelector('#q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); paint(); });
  paint();
}

// ── Create workspace modal (5 steps) ──────────────────────────────────────────
function openCreateModal({ sb, onCreated }) {
  document.getElementById('wsModal')?.remove();

  const state = {
    step: 0,
    name: '', slug: '', short_code: '',
    type: 'rented',
    plan_cycle: null, plan_amount: '', plan_currency: 'PKR',
    roles: Object.fromEntries(ROLES.map((r) => [r.id, { use: false, edit: false }])),
    admin_email: '', manager_email: '',
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'wsModal';
  overlay.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">' +
      '<div class="modal-head">' +
        '<h3 class="modal-title" id="modalTitle">New Workspace</h3>' +
        '<button class="modal-close" id="modalClose" type="button" aria-label="Close">' + icon('x', 18) + '</button>' +
      '</div>' +
      '<div class="wiz-steps" id="wizSteps"></div>' +
      '<div class="modal-body" id="modalBody"></div>' +
      '<div class="modal-foot" id="modalFoot"></div>' +
    '</div>';

  document.body.appendChild(overlay);
  overlay.querySelector('#modalClose').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  function closeModal() { overlay.remove(); }
  function goStep(n) { state.step = n; renderStep(); }

  function renderStep() {
    renderWizSteps(overlay.querySelector('#wizSteps'), state.step);
    const body = overlay.querySelector('#modalBody');
    const foot = overlay.querySelector('#modalFoot');
    switch (state.step) {
      case 0: return renderStep0(body, foot, state, goStep);
      case 1: return renderStep1(body, foot, state, goStep);
      case 2: return renderStep2(body, foot, state, goStep);
      case 3: return renderStep3(body, foot, state, goStep);
      case 4: return renderStep4(body, foot, state, goStep, sb, closeModal, onCreated);
    }
  }

  renderStep();
}

// ── Wizard step indicator ──────────────────────────────────────────────────────
function renderWizSteps(el, active) {
  const labels = ['Workspace', 'Type', 'Roles', 'Team', 'Review'];
  el.innerHTML = labels.map((l, i) =>
    '<div class="wiz-step' + (i < active ? ' is-done' : i === active ? ' is-current' : '') + '">' +
      '<span class="wiz-dot">' + (i < active ? icon('check', 12) : String(i + 1)) + '</span>' +
      '<span class="wiz-label">' + esc(l) + '</span>' +
    '</div>' +
    (i < labels.length - 1 ? '<span class="wiz-line"></span>' : '')
  ).join('');
}

// ── Step 0: Workspace name, slug, short code ───────────────────────────────────
function renderStep0(body, foot, state, goStep) {
  body.innerHTML =
    '<div class="wf-group">' +
      '<label class="wf-label" for="wsName">Business Name <span class="req">*</span></label>' +
      '<input class="wf-input" id="wsName" type="text" placeholder="e.g. Acme Ecom" maxlength="80" value="' + esc(state.name) + '">' +
    '</div>' +
    '<div class="wf-group">' +
      '<label class="wf-label" for="wsSlug">Slug <span class="req">*</span></label>' +
      '<div class="wf-slug-wrap"><span class="wf-slug-pre">/</span>' +
        '<input class="wf-input wf-slug-input" id="wsSlug" type="text" placeholder="acme-ecom" maxlength="40" value="' + esc(state.slug) + '">' +
      '</div>' +
      '<p class="wf-hint">URL-safe, lowercase, hyphens only. Auto-filled from name.</p>' +
    '</div>' +
    '<div class="wf-group">' +
      '<label class="wf-label" for="wsCode">Short Code <span class="req">*</span></label>' +
      '<input class="wf-input" id="wsCode" type="text" placeholder="ACM" maxlength="4" value="' + esc(state.short_code) + '" style="text-transform:uppercase">' +
      '<p class="wf-hint">2–4 letters (A–Z). Auto-filled from name.</p>' +
    '</div>';

  const nameEl = body.querySelector('#wsName');
  const slugEl = body.querySelector('#wsSlug');
  const codeEl = body.querySelector('#wsCode');
  let slugEdited = !!state.slug;
  let codeEdited = !!state.short_code;

  nameEl.addEventListener('input', () => {
    if (!slugEdited) slugEl.value = slugify(nameEl.value);
    if (!codeEdited) codeEl.value = codeify(nameEl.value);
  });
  slugEl.addEventListener('input', () => { slugEdited = true; });
  codeEl.addEventListener('input', () => { codeEdited = true; });

  foot.innerHTML =
    '<span></span>' +
    '<button class="btn" id="step0Next" type="button">Next</button>';

  foot.querySelector('#step0Next').addEventListener('click', () => {
    const name = nameEl.value.trim();
    const slug = slugEl.value.trim().toLowerCase();
    const code = codeEl.value.trim().toUpperCase();
    if (!name) return shakeField(nameEl, 'Business name is required.');
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) return shakeField(slugEl, 'Slug must be lowercase letters, numbers and hyphens.');
    if (!code || !/^[A-Z]{2,4}$/.test(code)) return shakeField(codeEl, 'Short code must be 2–4 letters (A–Z).');
    state.name = name; state.slug = slug; state.short_code = code;
    goStep(1);
  });
}

// ── Step 1: Type + Plan ────────────────────────────────────────────────────────
function renderStep1(body, foot, state, goStep) {
  body.innerHTML =
    '<div class="wf-group">' +
      '<label class="wf-label">Workspace Type <span class="req">*</span></label>' +
      '<div class="wf-plan-cards" id="typeCards">' +
        '<button class="plan-card' + (state.type === 'rented' ? ' is-selected' : '') + '" type="button" data-t="rented">' +
          '<strong>On Rent</strong><span>Client rents this workspace</span></button>' +
        '<button class="plan-card' + (state.type === 'master_project' ? ' is-selected' : '') + '" type="button" data-t="master_project">' +
          '<strong>Personal</strong><span>Your own internal project</span></button>' +
      '</div>' +
    '</div>' +
    '<div class="wf-group" id="planSection"' + (state.type === 'master_project' ? ' hidden' : '') + '>' +
      '<label class="wf-label">Billing Plan</label>' +
      '<div class="wf-plan-cards" id="planCards">' +
        PLANS.map((p) =>
          '<button class="plan-card' + (state.plan_cycle === p.id ? ' is-selected' : '') + '" type="button" data-p="' + p.id + '">' +
          '<strong>' + esc(p.label) + '</strong>' +
          '<span>' + (p.paid ? 'Paid' : 'Free trial') + '</span></button>'
        ).join('') +
      '</div>' +
    '</div>' +
    '<div class="wf-group" id="amountSection"' + (!isPaidPlan(state.plan_cycle) ? ' hidden' : '') + '>' +
      '<label class="wf-label" for="planAmount">Amount <span class="req">*</span></label>' +
      '<div style="display:flex;gap:8px">' +
        '<input class="wf-input" id="planAmount" type="number" min="0" placeholder="e.g. 25000" style="flex:1" value="' + esc(state.plan_amount) + '">' +
        '<select class="wf-select" id="planCurrency" style="width:100px">' +
          ['PKR','USD','EUR','GBP'].map((c) => '<option' + (state.plan_currency === c ? ' selected' : '') + '>' + c + '</option>').join('') +
        '</select>' +
      '</div>' +
    '</div>';

  body.querySelectorAll('#typeCards .plan-card').forEach((b) => b.addEventListener('click', () => {
    body.querySelectorAll('#typeCards .plan-card').forEach((x) => x.classList.remove('is-selected'));
    b.classList.add('is-selected');
    state.type = b.dataset.t;
    body.querySelector('#planSection').hidden = state.type === 'master_project';
    body.querySelector('#amountSection').hidden = true;
    if (state.type === 'master_project') { state.plan_cycle = null; state.plan_amount = ''; }
  }));

  body.querySelectorAll('#planCards .plan-card').forEach((b) => b.addEventListener('click', () => {
    body.querySelectorAll('#planCards .plan-card').forEach((x) => x.classList.remove('is-selected'));
    b.classList.add('is-selected');
    state.plan_cycle = b.dataset.p;
    body.querySelector('#amountSection').hidden = !isPaidPlan(state.plan_cycle);
  }));

  foot.innerHTML =
    '<button class="btn btn-ghost" id="step1Back" type="button">Back</button>' +
    '<button class="btn" id="step1Next" type="button">Next</button>';

  foot.querySelector('#step1Back').addEventListener('click', () => goStep(0));
  foot.querySelector('#step1Next').addEventListener('click', () => {
    if (state.type === 'rented' && state.plan_cycle && isPaidPlan(state.plan_cycle)) {
      const amt = body.querySelector('#planAmount').value.trim();
      if (!amt || isNaN(Number(amt)) || Number(amt) < 0)
        return shakeField(body.querySelector('#planAmount'), 'Enter the plan amount.');
      state.plan_amount = amt;
      state.plan_currency = body.querySelector('#planCurrency').value;
    }
    goStep(2);
  });
}

// ── Step 2: Roles table (Allow to use / Allow to edit, on-off switches) ───────
function renderStep2(body, foot, state, goStep) {
  body.innerHTML = rolesTableHTML(state.roles);
  bindRolesTable(body, state.roles);

  foot.innerHTML =
    '<button class="btn btn-ghost" id="step2Back" type="button">Back</button>' +
    '<button class="btn" id="step2Next" type="button">Next</button>';

  foot.querySelector('#step2Back').addEventListener('click', () => goStep(1));
  foot.querySelector('#step2Next').addEventListener('click', () => goStep(3));
}

function rolesTableHTML(map) {
  const sw = (role, kind, on) =>
    '<button class="switch' + (on ? ' is-on' : '') + '" type="button" role="switch" aria-checked="' + on + '"' +
    ' data-r="' + role.id + '" data-k="' + kind + '" aria-label="' + esc(role.label) + ' — ' + (kind === 'use' ? 'allow to use' : 'allow to edit') + '">' +
    '<span class="switch-knob"></span></button>';
  return '<p class="wf-hint" style="margin:0 0 12px">Applies to this workspace only. Only roles switched on will be available inside it.</p>' +
    '<div class="table-wrap"><table class="rtable"><thead><tr>' +
      '<th>Role</th><th>Allow to use</th><th>Allow to edit</th>' +
    '</tr></thead><tbody>' +
      ROLES.map((r) =>
        '<tr><td class="rt-name">' + esc(r.label) + '</td>' +
        '<td>' + sw(r, 'use', map[r.id].use) + '</td>' +
        '<td>' + sw(r, 'edit', map[r.id].edit) + '</td></tr>'
      ).join('') +
    '</tbody></table></div>';
}

function bindRolesTable(root, map) {
  function paintRow(id) {
    root.querySelectorAll('.switch[data-r="' + id + '"]').forEach((b) => {
      const on = map[id][b.dataset.k];
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }
  root.querySelectorAll('.switch').forEach((b) => b.addEventListener('click', () => {
    const st = map[b.dataset.r], k = b.dataset.k;
    st[k] = !st[k];
    if (k === 'edit' && st.edit) st.use = true;   // editing needs use
    if (k === 'use' && !st.use) st.edit = false;  // no use, no edit
    paintRow(b.dataset.r);
  }));
}

// ── Step 3: Team emails ────────────────────────────────────────────────────────
function renderStep3(body, foot, state, goStep) {
  body.innerHTML =
    '<div class="wf-group">' +
      '<label class="wf-label" for="adminEmail">Admin Email <span class="req">*</span></label>' +
      '<input class="wf-input" id="adminEmail" type="email" placeholder="admin@client.com" value="' + esc(state.admin_email) + '">' +
      '<p class="wf-hint">An invite email will be sent to this address.</p>' +
    '</div>' +
    '<div class="wf-group">' +
      '<label class="wf-label" for="mgrEmail">Manager Email <span class="muted">(optional)</span></label>' +
      '<input class="wf-input" id="mgrEmail" type="email" placeholder="manager@client.com" value="' + esc(state.manager_email) + '">' +
    '</div>';

  // Validate as soon as the person leaves the field
  body.querySelector('#adminEmail').addEventListener('blur', (e) => {
    const v = e.target.value.trim();
    if (v && !isEmail(v)) shakeField(e.target, EMAIL_MSG, false);
  });
  body.querySelector('#mgrEmail').addEventListener('blur', (e) => {
    const v = e.target.value.trim();
    if (v && !isEmail(v)) shakeField(e.target, EMAIL_MSG, false);
  });

  foot.innerHTML =
    '<button class="btn btn-ghost" id="step3Back" type="button">Back</button>' +
    '<button class="btn" id="step3Next" type="button">Review →</button>';

  foot.querySelector('#step3Back').addEventListener('click', () => goStep(2));
  foot.querySelector('#step3Next').addEventListener('click', () => {
    const ae = body.querySelector('#adminEmail').value.trim().toLowerCase();
    const me = body.querySelector('#mgrEmail').value.trim().toLowerCase();
    if (!isEmail(ae)) return shakeField(body.querySelector('#adminEmail'), ae ? EMAIL_MSG : 'Admin email is required.');
    if (me && !isEmail(me)) return shakeField(body.querySelector('#mgrEmail'), EMAIL_MSG);
    if (me && me === ae) return shakeField(body.querySelector('#mgrEmail'), 'Manager email must differ from the admin email.');
    state.admin_email = ae;
    state.manager_email = me;
    goStep(4);
  });
}

// ── Step 4: Review + Submit ────────────────────────────────────────────────────
function renderStep4(body, foot, state, goStep, sb, closeModal, onCreated) {
  const planLabel = state.plan_cycle ? PLANS.find((p) => p.id === state.plan_cycle)?.label || state.plan_cycle : 'No plan';
  const typeLabel = state.type === 'rented' ? 'On Rent' : 'Personal';
  const paidAmt = isPaidPlan(state.plan_cycle) && state.plan_amount
    ? state.plan_currency + ' ' + Number(state.plan_amount).toLocaleString('en-US') : null;

  body.innerHTML =
    '<div class="result-block">' +
      row('Name', state.name) +
      row('Slug', '/' + state.slug) +
      row('Code', state.short_code) +
      row('Type', typeLabel) +
      row('Plan', planLabel + (paidAmt ? ' — ' + paidAmt : '')) +
      row('Roles', rolesSummary(state.roles)) +
      row('Admin', state.admin_email) +
      (state.manager_email ? row('Manager', state.manager_email) : '') +
    '</div>' +
    '<p id="createErr" class="wf-err" hidden></p>';

  foot.innerHTML =
    '<button class="btn btn-ghost" id="step4Back" type="button">Back</button>' +
    '<button class="btn" id="step4Create" type="button">Create Workspace</button>';

  foot.querySelector('#step4Back').addEventListener('click', () => goStep(3));
  foot.querySelector('#step4Create').addEventListener('click', async () => {
    const createBtn = foot.querySelector('#step4Create');
    const errEl = body.querySelector('#createErr');
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';
    errEl.hidden = true;

    try {
      const { data: { session } } = await sb.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('Not signed in');

      const payload = {
        name:        state.name,
        slug:        state.slug,
        short_code:  state.short_code,
        type:        state.type,
        admin_email: state.admin_email,
        roles:       ROLES.filter((r) => state.roles[r.id].use).map((r) => ({ role: r.id, edit: state.roles[r.id].edit })),
      };
      if (state.plan_cycle)    payload.plan_cycle    = state.plan_cycle;
      if (state.plan_amount)   payload.plan_amount   = Number(state.plan_amount);
      if (state.plan_currency) payload.plan_currency = state.plan_currency;
      if (state.manager_email) payload.manager_email = state.manager_email;

      const res = await fetch('/api/master/workspaces', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();

      if (!res.ok) {
        createBtn.disabled = false;
        createBtn.textContent = 'Create Workspace';
        errEl.textContent = json.error || 'Something went wrong.';
        errEl.hidden = false;
        return;
      }

      closeModal();
      showResultModal(json, state, onCreated);

    } catch (err) {
      createBtn.disabled = false;
      createBtn.textContent = 'Create Workspace';
      errEl.textContent = err.message || 'Network error.';
      errEl.hidden = false;
    }
  });
}

// ── Result modal ──────────────────────────────────────────────────────────────
function linkRow(label, link, text) {
  return '<div class="wf-group"><label class="wf-label">' + esc(label) + '</label>' +
    '<div class="copy-row"><input class="wf-input" readonly value="' + esc(link) + '">' +
    '<button class="btn btn-sm" type="button" data-copy>Copy</button>' +
    '<a class="btn btn-sm btn-wa" href="' + waLink(text + link) + '" target="_blank" rel="noopener">WhatsApp</a></div></div>';
}

function bindCopy(root) {
  root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    copyText(b.parentElement.querySelector('input').value);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  }));
}

function showResultModal(json, state, onCreated) {
  document.getElementById('wsResultModal')?.remove();
  const ws = json.workspace || {};
  const inv = json.invites || {};
  const name = ws.name || state.name;
  const part = (key, label) => !inv[key] ? '' :
    (inv[key].link ? linkRow(label, inv[key].link, label.replace(' link', '') + ' for ' + name + ' — set your password: ')
                   : '<p class="wf-err">' + esc(label) + ' failed: ' + esc(inv[key].error || 'unknown error') + '</p>');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'wsResultModal';
  overlay.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="resultTitle">' +
      '<div class="modal-head"><h3 class="modal-title" id="resultTitle">Workspace Created</h3>' +
        '<button class="modal-close" id="resultClose" type="button" aria-label="Close">' + icon('x', 18) + '</button></div>' +
      '<div class="modal-body">' +
        '<div class="result-block"><p class="result-ws-name">' + esc(name) + '</p>' +
          '<p class="result-ws-slug muted small">/' + esc(ws.slug || state.slug) + ' · ' + esc(ws.short_code || state.short_code) + '</p></div>' +
        part('admin', 'Admin link') + part('manager', 'Manager link') +
        '<p class="wf-hint">Each link works once and lasts about an hour. If it expires, open the workspace and press Regenerate.</p>' +
      '</div>' +
      '<div class="modal-foot"><span></span><button class="btn" id="resultDone" type="button">Done</button></div>' +
    '</div>';
  document.body.appendChild(overlay);
  bindCopy(overlay);
  const close = () => { overlay.remove(); onCreated(); };
  overlay.querySelector('#resultClose').addEventListener('click', close);
  overlay.querySelector('#resultDone').addEventListener('click', close);
}

// ── Workspace panel: details, edit, regenerate link ───────────────────────────
async function apiFetch(sb, url, opts = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(url, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + (session?.access_token || ''), 'Content-Type': 'application/json' },
  });
  let json = {}; try { json = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

async function openWorkspacePanel({ sb, id, onChanged }) {
  document.getElementById('wsPanel')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'wsPanel';
  overlay.innerHTML =
    '<div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="panelTitle">' +
      '<div class="modal-head"><h3 class="modal-title" id="panelTitle">Workspace</h3>' +
        '<button class="modal-close" id="panelClose" type="button" aria-label="Close">' + icon('x', 18) + '</button></div>' +
      '<div class="modal-body" id="panelBody"><p class="muted">Loading…</p></div>' +
      '<div class="modal-foot" id="panelFoot"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#panelClose').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const body = overlay.querySelector('#panelBody'), foot = overlay.querySelector('#panelFoot');
  let d;
  try { d = await apiFetch(sb, '/api/master/workspace?id=' + encodeURIComponent(id)); }
  catch (e) { body.innerHTML = '<p class="wf-err">' + esc(e.message) + '</p>'; return; }

  const ws = d.workspace;
  const roles = Object.fromEntries(ROLES.map((r) => {
    const f = d.roles.find((x) => x.role === r.id);
    return [r.id, { use: !!f, edit: !!(f && f.edit) }];
  }));
  const sub = d.subscription;
  const planText = sub ? (CYCLE_LABEL[sub.cycle] || sub.cycle) + ' · ' + sub.currency + ' ' + Number(sub.amount_original).toLocaleString('en-US') : 'No plan';
  const who = { admin: 'Admin', manager: 'Manager', member: 'Member' };

  overlay.querySelector('#panelTitle').textContent = ws.name;
  body.innerHTML =
    '<div class="wf-group"><label class="wf-label" for="pName">Business name</label>' +
      '<input class="wf-input" id="pName" maxlength="80" value="' + esc(ws.name) + '"></div>' +
    '<div class="wf-group"><label class="wf-label" for="pStatus">Status</label>' +
      '<select class="wf-select" id="pStatus">' +
        Object.keys(STATUS_LABEL).map((k) => '<option value="' + k + '"' + (ws.status === k ? ' selected' : '') + '>' + STATUS_LABEL[k] + '</option>').join('') +
      '</select></div>' +
    '<div class="result-block">' +
      row('Slug', '/' + ws.slug) + row('Code', ws.short_code) +
      row('Type', TYPE_LABEL[ws.type] || ws.type) + row('Plan', planText) +
    '</div>' +
    '<h4 class="panel-h">Roles</h4>' + rolesTableHTML(roles) +
    '<h4 class="panel-h">Team</h4><div id="teamList">' +
      (d.team.length ? d.team.map((p) =>
        '<div class="team-row" data-u="' + esc(p.id) + '">' +
          '<div class="team-main"><strong>' + esc(p.name || who[p.account_type]) + '</strong>' +
            '<span class="muted small">' + esc(who[p.account_type]) + (p.email ? ' · ' + esc(p.email) : '') + '</span></div>' +
          '<span class="chip chip-' + (p.pending ? 'warn' : 'ok') + '">' + (p.pending ? 'Invite pending' : 'Active') + '</span>' +
          '<button class="btn btn-sm btn-ghost" type="button" data-regen="' + esc(p.id) + '">Regenerate link</button>' +
          '<div class="team-link" hidden></div>' +
        '</div>').join('') : '<p class="muted small">No people yet.</p>') +
    '</div>' +
    '<p id="panelErr" class="wf-err" hidden></p>';
  bindRolesTable(body, roles);

  const err = body.querySelector('#panelErr');
  const showErr = (m) => { err.textContent = m; err.hidden = !m; };

  body.querySelectorAll('[data-regen]').forEach((b) => b.addEventListener('click', async () => {
    const row_ = b.closest('.team-row'), box = row_.querySelector('.team-link');
    b.disabled = true; b.textContent = 'Working…'; showErr('');
    try {
      const r = await apiFetch(sb, '/api/master/workspace?id=' + encodeURIComponent(id) + '&action=link',
        { method: 'POST', body: JSON.stringify({ user_id: b.dataset.regen }) });
      box.hidden = false;
      box.innerHTML = linkRow('New link (valid ' + r.expires + ')', r.link, 'Set your password for ' + ws.name + ': ') +
        '<button class="btn btn-sm btn-ghost" type="button" data-mail>Email it</button><span class="muted small" data-mailnote></span>';
      bindCopy(box);
      box.querySelector('[data-mail]').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const m = await apiFetch(sb, '/api/master/workspace?id=' + encodeURIComponent(id) + '&action=link',
            { method: 'POST', body: JSON.stringify({ user_id: b.dataset.regen, send: true }) });
          box.querySelector('[data-mailnote]').textContent = m.emailed ? ' Email sent.' : ' Email could not be sent. Use Copy or WhatsApp.';
        } catch (x) { box.querySelector('[data-mailnote]').textContent = ' ' + x.message; }
      });
    } catch (x) { showErr(x.message); }
    b.disabled = false; b.textContent = 'Regenerate link';
  }));

  const onHold = ws.status === 'suspended';
  foot.innerHTML = '<span class="foot-left"><button class="btn btn-sm btn-ghost" id="panelHold" type="button">' + (onHold ? 'Resume workspace' : 'Put on hold') + '</button>' +
    '<button class="btn btn-sm btn-danger" id="panelDelete" type="button">Delete</button></span>' +
    '<button class="btn btn-ghost" id="panelCancel" type="button">Close</button>' +
    '<button class="btn" id="panelSave" type="button">Save changes</button>';
  foot.querySelector('#panelCancel').addEventListener('click', close);
  foot.querySelector('#panelHold').addEventListener('click', async (e) => {
    e.target.disabled = true; showErr('');
    try {
      await apiFetch(sb, '/api/master/workspace?id=' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status: onHold ? 'active' : 'suspended' }) });
      close(); onChanged();
    } catch (x) { showErr(x.message); e.target.disabled = false; }
  });
  foot.querySelector('#panelDelete').addEventListener('click', () => confirmByName({
    title: 'Delete ' + ws.name + ' permanently', name: ws.name,
    warning: 'This erases <strong>' + esc(ws.name) + '</strong> and everything in it: all people and their sign-ins, projects, requests, notifications, activity, plan and payment records. This cannot be undone.',
    onConfirm: async (typed) => {
      await apiFetch(sb, '/api/master/workspace?id=' + encodeURIComponent(id), { method: 'DELETE', body: JSON.stringify({ confirm: typed }) });
      close(); onChanged();
    },
  }));
  foot.querySelector('#panelSave').addEventListener('click', async (e) => {
    const name = body.querySelector('#pName').value.trim();
    if (!name) return shakeField(body.querySelector('#pName'), 'Business name is required.');
    e.target.disabled = true; e.target.textContent = 'Saving…'; showErr('');
    try {
      await apiFetch(sb, '/api/master/workspace?id=' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({
        name, status: body.querySelector('#pStatus').value,
        roles: ROLES.filter((r) => roles[r.id].use).map((r) => ({ role: r.id, edit: roles[r.id].edit })),
      }) });
      close(); onChanged();
    } catch (x) { showErr(x.message); e.target.disabled = false; e.target.textContent = 'Save changes'; }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function slugify(v) {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function codeify(v) {
  const words = v.toUpperCase().replace(/[^A-Z\s]/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 4).map((w) => w[0]).join('');
  return (words[0] || '').slice(0, 4);
}

function rolesSummary(map) {
  const on = ROLES.filter((r) => map[r.id].use);
  if (!on.length) return 'None';
  return on.map((r) => r.label + (map[r.id].edit ? ' (use + edit)' : ' (use)')).join(', ');
}

function isPaidPlan(cycle) {
  return cycle === 'monthly' || cycle === 'quarterly' || cycle === 'yearly';
}

function row(label, value) {
  return '<div class="result-row"><span class="result-label">' + esc(label) + '</span><span class="result-value">' + esc(value) + '</span></div>';
}

function shakeField(el, msg, focus = true) {
  if (focus) el.focus();
  el.classList.add('is-invalid');
  let hint = el.parentElement.querySelector('.wf-err');
  if (!hint) { hint = document.createElement('p'); hint.className = 'wf-err'; el.parentElement.appendChild(hint); }
  hint.textContent = msg;
  hint.hidden = false;
  el.addEventListener('input', () => { el.classList.remove('is-invalid'); if (hint) hint.hidden = true; }, { once: true });
}

function waLink(text) {
  return 'https://wa.me/?text=' + encodeURIComponent(text);
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
