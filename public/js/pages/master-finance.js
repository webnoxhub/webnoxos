// Master Finance: dashboard, subscriptions, invoices, payments and reports.
import { esc, icon, toast } from '/js/ui.js';
import { todayISO, fmtDate, fmtDateTime, money, monthStartISO } from '/js/time.js';
import { statusInfo, CYCLE_LABEL, TYPE_LABEL } from '/js/billing.js';
import { openModal, fieldError, api } from '/js/modal.js';
import { rentInvoiceDocHTML, printRentInvoice, ensureInvoiceCss, RENT_STATUS } from '/js/rent-invoice.js';

const TABS = [['dashboard', 'Dashboard'], ['subscriptions', 'Subscriptions'], ['invoices', 'Invoices'],
  ['payments', 'Payments'], ['reports', 'Reports']];

const PLANS = [
  ['trial_7', '7-day trial'], ['trial_14', '14-day trial'],
  ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly'],
];
const METHODS = [['bank_transfer', 'Bank transfer'], ['other', 'Other']];
const CURRENCIES = ['PKR', 'USD', 'GBP', 'EUR', 'AED', 'SAR'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default async function render({ el, sb, setTitle }) {
  setTitle('Finance');
  el.innerHTML = '<p class="muted pad">Loading…</p>';

  // One sweep per visit: countdowns, due dates, overdue and auto-holds catch up.
  let sweepFailed = false;
  try {
    const { error } = await sb.rpc('master_sweep');
    sweepFailed = Boolean(error);
  } catch {
    sweepFailed = true;
  }

  const data = await load(sb);
  if (data.error) {
    el.innerHTML = '<div class="empty"><p>Could not load Finance.</p>' +
      '<button class="btn" id="retry" type="button">Try again</button></div>';
    el.querySelector('#retry').addEventListener('click', () => render({ el, sb, setTitle }));
    return;
  }

  const reload = () => render({ el, sb, setTitle });
  let tab = (new URLSearchParams((location.hash.split('?')[1] || '')).get('tab')) || 'dashboard';
  if (!TABS.some(([k]) => k === tab)) tab = 'dashboard';

  el.innerHTML =
    '<div class="page-head"><h2 class="page-title">Finance</h2></div>' +
    (sweepFailed ? '<p class="note warn" role="status">Billing statuses could not refresh. Reload Finance to try again.</p>' : '') +
    '<div class="tabs" role="tablist">' + TABS.map(([k, label]) =>
      '<button class="tab" type="button" role="tab" data-t="' + k + '" aria-selected="' + (k === tab) + '">' +
      esc(label) + '</button>').join('') + '</div>' +
    '<div id="tabView"></div>';

  const view = el.querySelector('#tabView');
  const paint = () => {
    el.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === tab)));
    history.replaceState(null, '', '#/master/finance?tab=' + tab);
    if (tab === 'dashboard') return dashboard(view, data);
    if (tab === 'subscriptions') return subscriptions(view, sb, data, reload);
    if (tab === 'invoices') return invoicesTab(view, sb, data, reload);
    if (tab === 'payments') return payments(view, sb, data, reload);
    return reports(view, sb);
  };
  el.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; paint(); }));
  paint();
}

// ── Data ──────────────────────────────────────────────────────────────────────
async function load(sb) {
  const [ovR, wsR, payR, invR] = await Promise.all([
    sb.rpc('master_overview'),
    sb.from('workspaces')
      .select('id,name,slug,short_code,type,status,subscriptions(plan_name,cycle,next_cycle,amount_original,amount,currency,fx_rate,start_date,trial_ends_on,next_due,grace_days,member_limit,status,notes)')
      .order('name'),
    sb.from('subscription_payments')
      .select('id,workspace_id,amount,amount_original,currency,fx_rate,paid_on,method,reference,period_from,period_to,note,created_at,workspaces(name)')
      .order('paid_on', { ascending: false }).limit(300),
    sb.from('rent_invoices')
      .select('id,workspace_id,invoice_no,status,issue_date,due_date,period_from,period_to,currency,amount_original,fx_rate,amount,paid_on,notes,workspaces(name,slug,short_code)')
      .order('issue_date', { ascending: false }).limit(300),
  ]);
  const error = ovR.error || wsR.error || payR.error || invR.error;
  if (error) return { error };

  const today = todayISO();
  const rows = (wsR.data || []).map((w) => {
    const sub = Array.isArray(w.subscriptions) ? w.subscriptions[0] : w.subscriptions;
    return { w, sub: sub || null, info: statusInfo(w, sub || null, today) };
  });
  return { ov: ovR.data || {}, rows, payments: payR.data || [], invoices: (invR && invR.data) || [], today };
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function dashboard(view, { ov, today }) {
  const c = ov.counts || {};
  const renewals = (ov.renewals || []).filter((r) => r.days >= 0).slice(0, 8);
  const months = ov.months || [];
  const peak = Math.max(1, ...months.map((m) => Number(m.amount) || 0));

  view.innerHTML =
    '<section class="hero-cards" aria-label="This month">' +
      hcard('Expected this month', money(ov.expected), 'rent falling due') +
      hcard('Collected this month', money(ov.collected), 'rent received') +
      hcard('Outstanding', money(ov.outstanding), 'due or past due') +
      hcard('Overdue', money(ov.overdue_amount), (ov.overdue_count || 0) + ' workspace' + (ov.overdue_count === 1 ? '' : 's')) +
    '</section>' +
    '<div class="statline">' +
      stat('Active', c.active || 0) + stat('In trial', c.trial || 0) +
      stat('Due this week', c.due_week || 0) + stat('On hold', c.suspended || 0) +
    '</div>' +
    '<div class="grid2">' +
      '<section class="card"><h3>Renewals in the next 30 days</h3>' + (renewals.length
        ? '<ul class="rows">' + renewals.map((r) =>
            '<li class="row"><span class="row-main">' + esc(r.name) +
              '<span class="muted small">' + esc(fmtDate(r.next_due)) + ' · ' + esc(r.currency) + ' ' +
              Number(r.amount_original).toLocaleString('en-US') + '</span></span>' +
            '<span class="chip chip-' + (r.days <= 3 ? 'warn' : 'ok') + '">' +
              (r.days === 0 ? 'Due today' : 'in ' + r.days + ' day' + (r.days === 1 ? '' : 's')) + '</span></li>').join('') + '</ul>'
        : '<div class="empty slim">' + icon('clock', 28) + '<p>Nothing renews in the next 30 days.</p></div>') +
      '</section>' +
      '<section class="card"><h3>Collected, last 12 months</h3>' + (months.some((m) => Number(m.amount) > 0)
        ? '<div class="bars">' + months.map((m) => {
            const v = Number(m.amount) || 0;
            const mm = MONTH[Number(String(m.month).slice(5, 7)) - 1] || '';
            return '<div class="bar" title="' + esc(mm + ' ' + String(m.month).slice(0, 4) + ' · ' + money(v)) + '">' +
              '<span class="bar-fill" style="height:' + Math.max(2, Math.round((v / peak) * 100)) + '%"></span>' +
              '<span class="bar-l">' + esc(mm) + '</span></div>';
          }).join('') + '</div>'
        : '<div class="empty slim">' + icon('wallet', 28) + '<p>No rent recorded yet.</p></div>') +
      '</section>' +
    '</div>' +
    '<p class="muted small pad-t">Every figure is in PKR, converted at the rate saved with each entry. As of ' + esc(fmtDate(today)) + '.</p>';
}

const hcard = (label, value, note) =>
  '<div class="hero-card"><p class="hc-label">' + esc(label) + '</p><p class="hc-value">' + esc(value) +
  '</p><p class="hc-note">' + esc(note) + '</p></div>';
const stat = (label, n) =>
  '<div class="stat"><span class="stat-n">' + esc(String(n)) + '</span><span class="stat-l">' + esc(label) + '</span></div>';

// ── Subscriptions ─────────────────────────────────────────────────────────────
function subscriptions(view, sb, data, reload) {
  const rented = data.rows.filter((r) => r.w.type === 'rented');
  const own = data.rows.filter((r) => r.w.type !== 'rented');

  if (!rented.length) {
    view.innerHTML = '<div class="empty">' + icon('wallet', 36) +
      '<p>No rented workspaces yet.</p><p class="muted small">Create one under Workspaces and its plan appears here.</p></div>';
    return;
  }

  let q = '';
  view.innerHTML =
    '<div class="toolbar"><label class="search">' + icon('search', 16) +
      '<input id="q" type="search" placeholder="Search workspaces" aria-label="Search workspaces" autocomplete="off"></label>' +
      '<span class="muted small">' + rented.length + ' rented · ' + own.length + ' personal</span></div>' +
    '<div class="table-wrap"><table class="wtable"><thead><tr>' +
      '<th>Workspace</th><th>Plan</th><th>Rent</th><th>Started</th><th>Next due</th><th>Days left</th><th>Status</th><th></th>' +
    '</tr></thead><tbody id="rows"></tbody></table></div>' +
    '<div class="empty" id="none" hidden><p>No workspaces match.</p></div>';

  const rowsEl = view.querySelector('#rows'), none = view.querySelector('#none');

  function paint() {
    const shown = rented.filter((r) => !q || (r.w.name + ' ' + r.w.slug).toLowerCase().includes(q));
    rowsEl.innerHTML = shown.map(({ w, sub, info }) => {
      const d = info.days;
      return '<tr>' +
        '<td class="c-name" data-l="Workspace"><strong>' + esc(w.name) + '</strong>' +
          '<span class="muted small">' + esc(w.short_code || w.slug) + '</span></td>' +
        '<td data-l="Plan">' + esc(sub ? (sub.plan_name || CYCLE_LABEL[sub.cycle] || sub.cycle) : 'No plan') + '</td>' +
        '<td data-l="Rent">' + (sub ? esc(sub.currency + ' ' + Number(sub.amount_original).toLocaleString('en-US')) +
          (sub.currency !== 'PKR' ? '<span class="muted small">' + esc(money(sub.amount)) + '</span>' : '') : '—') + '</td>' +
        '<td data-l="Started">' + esc(sub ? fmtDate(sub.start_date) : '—') + '</td>' +
        '<td data-l="Next due">' + esc(sub && sub.next_due ? fmtDate(sub.next_due) : sub && sub.trial_ends_on ? 'Trial ends ' + fmtDate(sub.trial_ends_on) : '—') + '</td>' +
        '<td class="c-days' + (d !== null && d < 0 ? ' neg' : '') + '" data-l="Days left">' +
          (d === null ? '—' : d < 0 ? 'overdue by ' + (-d) + ' day' + (d === -1 ? '' : 's') : String(d)) + '</td>' +
        '<td data-l="Status"><span class="chip chip-' + info.tone + '">' + esc(info.label) + '</span></td>' +
        '<td data-l=""><button class="btn btn-sm btn-ghost" type="button" data-row="' + esc(w.id) + '">Manage</button></td>' +
      '</tr>';
    }).join('');
    none.hidden = shown.length > 0;
    rowsEl.querySelectorAll('[data-row]').forEach((b) => b.addEventListener('click', () =>
      openRow(sb, rented.find((r) => r.w.id === b.dataset.row), reload)));
  }
  view.querySelector('#q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); paint(); });
  paint();
}

// One workspace's rent: everything the Master can do to it, in one place.
function openRow(sb, row, reload) {
  const { w, sub, info } = row;
  const m = openModal({
    title: w.name,
    wide: true,
    body:
      '<div class="result-block">' +
        line('Plan', sub ? (sub.plan_name ? sub.plan_name + ' · ' : '') + (CYCLE_LABEL[sub.cycle] || sub.cycle) : 'No plan yet') +
        line('Rent', sub ? sub.currency + ' ' + Number(sub.amount_original).toLocaleString('en-US') +
          (sub.currency !== 'PKR' ? ' (' + money(sub.amount) + ')' : '') : '—') +
        line('Started', sub ? fmtDate(sub.start_date) : '—') +
        line('Next due', sub && sub.next_due ? fmtDate(sub.next_due) : sub && sub.trial_ends_on ? 'Trial ends ' + fmtDate(sub.trial_ends_on) : '—') +
        line('Grace days', sub ? String(sub.grace_days) : '—') +
        line('Status', info.label) +
        line('Space', TYPE_LABEL[w.type] || w.type) +
      '</div>' +
      '<p class="muted small">A change of plan takes effect from the next due date. Nothing already paid is touched.</p>' +
      '<p id="rowErr" class="wf-err" hidden></p>',
    foot:
      '<span class="foot-left">' +
        '<button class="btn btn-sm btn-ghost" id="rPlan" type="button">Change plan</button>' +
        '<button class="btn btn-sm btn-ghost" id="rInv" type="button">Issue invoice</button>' +
        '<button class="btn btn-sm btn-ghost" id="rHold" type="button">' + (w.status === 'suspended' ? 'Resume' : 'Put on hold') + '</button>' +
      '</span>' +
      '<button class="btn btn-ghost" id="rClose" type="button">Close</button>' +
      '<button class="btn" id="rPay" type="button">Record payment</button>',
  });
  const err = m.overlay.querySelector('#rowErr');
  const showErr = (t) => { err.textContent = t; err.hidden = !t; };

  m.overlay.querySelector('#rClose').addEventListener('click', m.close);
  m.overlay.querySelector('#rPay').addEventListener('click', () => { m.close(); openPayment(sb, row, reload); });
  m.overlay.querySelector('#rPlan').addEventListener('click', () => { m.close(); openPlan(sb, row, reload); });
  m.overlay.querySelector('#rInv').addEventListener('click', () => { m.close(); openIssue(sb, row, reload); });
  // Status goes through the Master API, the same route the Workspaces page uses.
  m.overlay.querySelector('#rHold').addEventListener('click', async (e) => {
    e.target.disabled = true; showErr('');
    const next = w.status === 'suspended' ? 'active' : 'suspended';
    try {
      await api(sb, '/api/master/workspace?id=' + encodeURIComponent(w.id),
        { method: 'PATCH', body: JSON.stringify({ status: next }) });
      m.close(); toast(next === 'active' ? 'Workspace resumed.' : 'Workspace put on hold.'); reload();
    } catch (x) { showErr(x.message); e.target.disabled = false; }
  });
}

// ── Record a payment ──────────────────────────────────────────────────────────
function openPayment(sb, row, reload) {
  const { w, sub } = row;
  if (!sub) return toast('Give this workspace a plan first.');
  const today = todayISO();

  const m = openModal({
    title: 'Record payment · ' + w.name,
    body:
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="pCur">Currency</label>' +
          '<select class="wf-select" id="pCur">' + CURRENCIES.map((c) =>
            '<option value="' + c + '"' + (c === sub.currency ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
        '<div class="wf-group"><label class="wf-label" for="pAmt">Amount<span class="req">*</span></label>' +
          '<input class="wf-input" id="pAmt" inputmode="decimal" value="' + esc(String(sub.amount_original)) + '"></div>' +
      '</div>' +
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="pFx">Rate to PKR</label>' +
          '<input class="wf-input" id="pFx" inputmode="decimal" value="' + esc(String(sub.fx_rate)) + '">' +
          '<p class="wf-hint" id="pFxNote">1 for PKR.</p></div>' +
        '<div class="wf-group"><label class="wf-label" for="pDate">Paid on</label>' +
          '<input class="wf-input" id="pDate" type="date" max="' + today + '" value="' + today + '"></div>' +
      '</div>' +
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="pMethod">Method</label>' +
          '<select class="wf-select" id="pMethod">' + METHODS.map(([k, l]) =>
            '<option value="' + k + '">' + l + '</option>').join('') + '</select></div>' +
        '<div class="wf-group"><label class="wf-label" for="pRef">Reference</label>' +
          '<input class="wf-input" id="pRef" maxlength="80" placeholder="Transaction number"></div>' +
      '</div>' +
      '<div class="wf-group"><label class="wf-label" for="pNote">Note</label>' +
        '<input class="wf-input" id="pNote" maxlength="200" placeholder="Optional"></div>' +
      '<p class="muted small">Saving moves the next due date on by one cycle and lifts a hold that was only about money.</p>' +
      '<p id="payErr" class="wf-err" hidden></p>',
    foot: '<button class="btn btn-ghost" id="payCancel" type="button">Cancel</button>' +
          '<button class="btn" id="paySave" type="button">Save payment</button>',
  });
  const $ = (id) => m.overlay.querySelector('#' + id);
  const err = $('payErr');
  const showErr = (t) => { err.textContent = t; err.hidden = !t; };

  $('pCur').addEventListener('change', () => {
    const pkr = $('pCur').value === 'PKR';
    if (pkr) $('pFx').value = '1';
    $('pFxNote').textContent = pkr ? '1 for PKR.' : 'How many PKR one ' + $('pCur').value + ' was worth on the day.';
  });
  $('payCancel').addEventListener('click', m.close);
  $('paySave').addEventListener('click', async (e) => {
    const amount = Number($('pAmt').value), fx = Number($('pFx').value);
    if (!(amount > 0)) return fieldError($('pAmt'), 'Enter an amount above zero.');
    if (!(fx > 0)) return fieldError($('pFx'), 'Enter a rate above zero.');
    if ($('pDate').value > today) return fieldError($('pDate'), 'A payment cannot be dated in the future.');
    e.target.disabled = true; e.target.textContent = 'Saving…'; showErr('');
    const { error } = await sb.rpc('master_record_payment', {
      p_ws: w.id, p_amount: amount, p_currency: $('pCur').value, p_fx: fx,
      p_paid_on: $('pDate').value || null, p_method: $('pMethod').value,
      p_reference: $('pRef').value.trim() || null, p_note: $('pNote').value.trim() || null,
    });
    if (error) { showErr(error.message); e.target.disabled = false; e.target.textContent = 'Save payment'; return; }
    m.close(); toast('Payment recorded.'); reload();
  });
  setTimeout(() => $('pAmt').focus(), 0);
}

// ── Change a plan ─────────────────────────────────────────────────────────────
function openPlan(sb, row, reload) {
  const { w, sub } = row;
  const m = openModal({
    title: (sub ? 'Change plan · ' : 'Set a plan · ') + w.name,
    body:
      '<div class="wf-group"><label class="wf-label" for="cCycle">Plan</label>' +
        '<select class="wf-select" id="cCycle">' + PLANS.map(([k, l]) =>
          '<option value="' + k + '"' + (sub && sub.cycle === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
        '<p class="wf-hint">A trial already running keeps its end date; the cycle you pick starts the day it ends.</p></div>' +
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="cCur">Currency</label>' +
          '<select class="wf-select" id="cCur">' + CURRENCIES.map((c) =>
            '<option value="' + c + '"' + (sub && sub.currency === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
        '<div class="wf-group"><label class="wf-label" for="cAmt">Rent<span class="req">*</span></label>' +
          '<input class="wf-input" id="cAmt" inputmode="decimal" value="' + esc(sub ? String(sub.amount_original) : '') + '"></div>' +
      '</div>' +
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="cFx">Rate to PKR</label>' +
          '<input class="wf-input" id="cFx" inputmode="decimal" value="' + esc(sub ? String(sub.fx_rate) : '1') + '"></div>' +
        '<div class="wf-group"><label class="wf-label" for="cGrace">Grace days</label>' +
          '<input class="wf-input" id="cGrace" inputmode="numeric" value="' + esc(sub ? String(sub.grace_days) : '7') + '"></div>' +
      '</div>' +
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="cName">Plan name</label>' +
          '<input class="wf-input" id="cName" maxlength="40" placeholder="Optional" value="' + esc(sub && sub.plan_name ? sub.plan_name : '') + '"></div>' +
        '<div class="wf-group"><label class="wf-label" for="cLimit">Member limit</label>' +
          '<input class="wf-input" id="cLimit" inputmode="numeric" placeholder="No limit" value="' + esc(sub && sub.member_limit ? String(sub.member_limit) : '') + '">' +
          '<p class="wf-hint">Shown as a warning; sign-in is never blocked by it.</p></div>' +
      '</div>' +
      '<p id="planErr" class="wf-err" hidden></p>',
    foot: '<button class="btn btn-ghost" id="planCancel" type="button">Cancel</button>' +
          '<button class="btn" id="planSave" type="button">Save plan</button>',
  });
  const $ = (id) => m.overlay.querySelector('#' + id);
  const err = $('planErr');

  $('cCur').addEventListener('change', () => { if ($('cCur').value === 'PKR') $('cFx').value = '1'; });
  $('planCancel').addEventListener('click', m.close);
  $('planSave').addEventListener('click', async (e) => {
    const amount = Number($('cAmt').value), fx = Number($('cFx').value), grace = Number($('cGrace').value);
    if (!($('cAmt').value !== '' && amount >= 0)) return fieldError($('cAmt'), 'Enter the rent.');
    if (!(fx > 0)) return fieldError($('cFx'), 'Enter a rate above zero.');
    if (!(Number.isInteger(grace) && grace >= 0)) return fieldError($('cGrace'), 'Grace days must be 0 or more.');
    const limit = $('cLimit').value.trim() === '' ? null : Number($('cLimit').value);
    if (limit !== null && !(Number.isInteger(limit) && limit > 0)) return fieldError($('cLimit'), 'Leave it empty or enter a whole number.');

    e.target.disabled = true; e.target.textContent = 'Saving…'; err.hidden = true;
    const { error } = await sb.rpc('master_change_plan', {
      p_ws: w.id, p_cycle: $('cCycle').value, p_amount: amount, p_currency: $('cCur').value, p_fx: fx,
      p_grace_days: grace, p_member_limit: limit, p_plan_name: $('cName').value.trim() || null,
    });
    if (error) { err.textContent = error.message; err.hidden = false; e.target.disabled = false; e.target.textContent = 'Save plan'; return; }
    m.close(); toast('Plan saved.'); reload();
  });
}

// ── Payments ──────────────────────────────────────────────────────────────────
function payments(view, sb, data) {
  const all = data.payments;
  if (!all.length) {
    view.innerHTML = '<div class="empty">' + icon('wallet', 36) +
      '<p>No rent recorded yet.</p><p class="muted small">Payments appear here as you record them on the Subscriptions tab.</p></div>';
    return;
  }
  const thisMonth = monthStartISO();
  let q = '', only = 'all';
  const FILTERS = [['all', 'All'], ['month', 'This month']];

  view.innerHTML =
    '<div class="toolbar">' +
      '<div class="chips" role="group" aria-label="Filter payments">' + FILTERS.map(([k, l]) =>
        '<button class="fchip" type="button" data-f="' + k + '" aria-pressed="' + (k === 'all') + '">' + esc(l) + '</button>').join('') +
      '</div>' +
      '<label class="search">' + icon('search', 16) +
        '<input id="pq" type="search" placeholder="Search workspace or reference" aria-label="Search payments" autocomplete="off"></label>' +
    '</div>' +
    '<div class="table-wrap"><table class="wtable"><thead><tr>' +
      '<th>Paid on</th><th>Workspace</th><th>Amount</th><th>In PKR</th><th>Method</th><th>Reference</th><th>Period</th>' +
    '</tr></thead><tbody id="prows"></tbody></table></div>' +
    '<div class="empty" id="pnone" hidden><p>No payments match.</p></div>' +
    '<p class="muted small pad-t" id="ptotal"></p>';

  const rows = view.querySelector('#prows'), none = view.querySelector('#pnone'), total = view.querySelector('#ptotal');
  const methodLabel = Object.fromEntries(METHODS);

  function paint() {
    const shown = all.filter((p) =>
      (only === 'all' || p.paid_on >= thisMonth) &&
      (!q || ((p.workspaces ? p.workspaces.name : '') + ' ' + (p.reference || '')).toLowerCase().includes(q)));
    rows.innerHTML = shown.map((p) =>
      '<tr>' +
        '<td class="c-name" data-l="Paid on"><strong>' + esc(fmtDate(p.paid_on)) + '</strong>' +
          '<span class="muted small">' + esc(fmtDateTime(p.created_at)) + '</span></td>' +
        '<td data-l="Workspace">' + esc(p.workspaces ? p.workspaces.name : '—') + '</td>' +
        '<td data-l="Amount">' + esc(p.currency + ' ' + Number(p.amount_original).toLocaleString('en-US')) + '</td>' +
        '<td data-l="In PKR">' + esc(money(p.amount)) + '</td>' +
        '<td data-l="Method">' + esc(methodLabel[p.method] || p.method) + '</td>' +
        '<td data-l="Reference">' + esc(p.reference || '—') + '</td>' +
        '<td data-l="Period">' + esc(p.period_from ? fmtDate(p.period_from) + ' – ' + fmtDate(p.period_to) : '—') + '</td>' +
      '</tr>').join('');
    none.hidden = shown.length > 0;
    total.textContent = shown.length + ' payment' + (shown.length === 1 ? '' : 's') + ' · ' +
      money(shown.reduce((a, p) => a + Number(p.amount || 0), 0)) + ' in all.';
  }
  view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
    only = b.dataset.f;
    view.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paint();
  }));
  view.querySelector('#pq').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); paint(); });
  paint();
}

// ── Reports ───────────────────────────────────────────────────────────────────
async function reports(view, sb) {
  const today = todayISO();
  const from = today.slice(0, 4) + '-01-01';
  view.innerHTML =
    '<div class="toolbar">' +
      '<div class="wf-row range">' +
        '<div class="wf-group"><label class="wf-label" for="rFrom">From</label>' +
          '<input class="wf-input" id="rFrom" type="date" value="' + from + '"></div>' +
        '<div class="wf-group"><label class="wf-label" for="rTo">To</label>' +
          '<input class="wf-input" id="rTo" type="date" value="' + today + '"></div>' +
      '</div>' +
      '<span class="foot-left">' +
        '<button class="btn btn-sm" id="rRun" type="button">Run</button>' +
        '<button class="btn btn-sm btn-ghost" id="rCsv" type="button">Download CSV</button>' +
        '<button class="btn btn-sm btn-ghost" id="rPrint" type="button">Print</button>' +
      '</span>' +
    '</div>' +
    '<div id="rOut"><p class="muted">Loading…</p></div>';

  const out = view.querySelector('#rOut');
  let current = null;

  async function run() {
    const a = view.querySelector('#rFrom').value, b = view.querySelector('#rTo').value;
    if (a && b && a > b) { out.innerHTML = '<p class="wf-err">The start date is after the end date.</p>'; return; }
    out.innerHTML = '<p class="muted">Loading…</p>';
    const { data, error } = await sb.rpc('master_report', { p_from: a || null, p_to: b || null });
    if (error) { out.innerHTML = '<p class="wf-err">' + esc(error.message) + '</p>'; return; }
    current = data; draw(out, data);
  }
  view.querySelector('#rRun').addEventListener('click', run);
  view.querySelector('#rPrint').addEventListener('click', () => window.print());
  view.querySelector('#rCsv').addEventListener('click', () => { if (current) downloadCsv(current); });
  run();
}

function draw(out, r) {
  out.innerHTML =
    '<section class="hero-cards" aria-label="Report totals">' +
      hcard('Collected', money(r.total), fmtDate(r.from) + ' – ' + fmtDate(r.to)) +
      hcard('Payments', String(r.count), 'entries in the window') +
      hcard('Outstanding now', money((r.outstanding || []).reduce((a, x) => a + Number(x.amount || 0), 0)),
        (r.outstanding || []).length + ' workspace' + ((r.outstanding || []).length === 1 ? '' : 's')) +
      hcard('Workspaces paying', String((r.by_workspace || []).length), 'in this window') +
    '</section>' +
    '<div class="grid2">' +
      '<section class="card"><h3>By month</h3>' + ((r.by_month || []).length
        ? '<ul class="rows">' + r.by_month.map((m) =>
            '<li class="row"><span class="row-main">' + esc(MONTH[Number(String(m.month).slice(5, 7)) - 1] + ' ' + String(m.month).slice(0, 4)) +
            '<span class="muted small">' + m.count + ' payment' + (m.count === 1 ? '' : 's') + '</span></span>' +
            '<span>' + esc(money(m.amount)) + '</span></li>').join('') + '</ul>'
        : '<div class="empty slim"><p>Nothing in this window.</p></div>') + '</section>' +
      '<section class="card"><h3>By workspace</h3>' + ((r.by_workspace || []).length
        ? '<ul class="rows">' + r.by_workspace.map((x) =>
            '<li class="row"><span class="row-main">' + esc(x.name) +
            '<span class="muted small">' + x.count + ' payment' + (x.count === 1 ? '' : 's') + '</span></span>' +
            '<span>' + esc(money(x.amount)) + '</span></li>').join('') + '</ul>'
        : '<div class="empty slim"><p>Nothing in this window.</p></div>') + '</section>' +
    '</div>' +
    '<section class="card"><h3>Outstanding right now</h3>' + ((r.outstanding || []).length
      ? '<ul class="rows">' + r.outstanding.map((x) =>
          '<li class="row"><span class="row-main">' + esc(x.name) +
          '<span class="muted small">Due ' + esc(fmtDate(x.next_due)) + '</span></span>' +
          '<span class="chip chip-' + (x.days > 0 ? 'err' : 'warn') + '">' +
            (x.days > 0 ? 'overdue by ' + x.days + ' day' + (x.days === 1 ? '' : 's') : 'due today') + '</span>' +
          '<span>' + esc(money(x.amount)) + '</span></li>').join('') + '</ul>'
      : '<div class="empty slim">' + icon('check', 28) + '<p>Nothing is outstanding.</p></div>') + '</section>';
}

function downloadCsv(r) {
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['Section', 'Name', 'Amount (PKR)', 'Count / Due']];
  (r.by_month || []).forEach((m) => lines.push(['By month', m.month, m.amount, m.count]));
  (r.by_workspace || []).forEach((x) => lines.push(['By workspace', x.name, x.amount, x.count]));
  (r.outstanding || []).forEach((x) => lines.push(['Outstanding', x.name, x.amount, x.next_due]));
  lines.push(['Total', 'Collected ' + r.from + ' to ' + r.to, r.total, r.count]);
  const csv = lines.map((l) => l.map(q).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'webnox-rent-' + r.from + '-to-' + r.to + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const line = (label, value) =>
  '<div class="result-row"><span class="result-label">' + esc(label) + '</span>' +
  '<span class="result-value">' + esc(value) + '</span></div>';

// ── Invoices ──────────────────────────────────────────────────────────────────
function invoicesTab(view, sb, data, reload) {
  ensureInvoiceCss();
  const all = data.invoices;
  const today = data.today;
  if (!all.length) {
    view.innerHTML = '<div class="empty">' + icon('file', 36) +
      '<p>No rent invoices yet.</p><p class="muted small">Open a workspace on the Subscriptions tab and choose Issue invoice.</p></div>';
    return;
  }
  let q = '', only = 'all';
  const FILTERS = [['all', 'All'], ['sent', 'Unpaid'], ['paid', 'Paid'], ['void', 'Cancelled']];

  view.innerHTML =
    '<div class="toolbar">' +
      '<div class="chips" role="group" aria-label="Filter invoices">' + FILTERS.map(([k, l]) =>
        '<button class="fchip" type="button" data-f="' + k + '" aria-pressed="' + (k === 'all') + '">' + esc(l) + '</button>').join('') +
      '</div>' +
      '<label class="search">' + icon('search', 16) +
        '<input id="iq" type="search" placeholder="Search number or workspace" aria-label="Search invoices" autocomplete="off"></label>' +
    '</div>' +
    '<div class="table-wrap"><table class="wtable"><thead><tr>' +
      '<th>Invoice</th><th>Workspace</th><th>Issued</th><th>Period</th><th>Due</th><th>Amount</th><th>Status</th><th></th>' +
    '</tr></thead><tbody id="irows"></tbody></table></div>' +
    '<div class="empty" id="inone" hidden><p>No invoices match.</p></div>' +
    '<p class="muted small pad-t" id="itotal"></p>';

  const rows = view.querySelector('#irows'), none = view.querySelector('#inone'), total = view.querySelector('#itotal');

  function paint() {
    const shown = all.filter((i) =>
      (only === 'all' || i.status === only) &&
      (!q || (i.invoice_no + ' ' + (i.workspaces ? i.workspaces.name : '')).toLowerCase().includes(q)));
    rows.innerHTML = shown.map((i) => {
      const late = i.status === 'sent' && i.due_date < today;
      const tone = late ? 'err' : i.status === 'paid' ? 'ok' : i.status === 'void' ? 'muted' : 'warn';
      return '<tr>' +
        '<td class="c-name" data-l="Invoice"><strong>' + esc(i.invoice_no) + '</strong></td>' +
        '<td data-l="Workspace">' + esc(i.workspaces ? i.workspaces.name : '—') + '</td>' +
        '<td data-l="Issued">' + esc(fmtDate(i.issue_date)) + '</td>' +
        '<td data-l="Period">' + esc(fmtDate(i.period_from)) + ' – ' + esc(fmtDate(i.period_to)) + '</td>' +
        '<td data-l="Due">' + esc(fmtDate(i.due_date)) + '</td>' +
        '<td data-l="Amount">' + esc(i.currency + ' ' + Number(i.amount_original).toLocaleString('en-US')) +
          (i.currency !== 'PKR' ? '<span class="muted small">' + esc(money(i.amount)) + '</span>' : '') + '</td>' +
        '<td data-l="Status"><span class="chip chip-' + tone + '">' +
          (late ? 'Overdue' : esc(RENT_STATUS[i.status])) + '</span></td>' +
        '<td data-l=""><button class="btn btn-sm btn-ghost" type="button" data-iv="' + esc(i.id) + '">Open</button></td>' +
      '</tr>';
    }).join('');
    none.hidden = shown.length > 0;
    const open = shown.filter((i) => i.status === 'sent');
    total.textContent = shown.length + ' invoice' + (shown.length === 1 ? '' : 's') +
      (open.length ? ' · ' + money(open.reduce((a, i) => a + Number(i.amount || 0), 0)) + ' still unpaid.' : '.');
    rows.querySelectorAll('[data-iv]').forEach((b) => b.addEventListener('click', () =>
      openInvoice(sb, all.find((x) => x.id === b.dataset.iv), reload)));
  }
  view.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
    only = b.dataset.f;
    view.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paint();
  }));
  view.querySelector('#iq').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); paint(); });
  paint();
}

function openInvoice(sb, i, reload) {
  const ws = i.workspaces || {};
  const m = openModal({
    title: i.invoice_no,
    wide: true,
    body: '<div class="inv-preview">' + rentInvoiceDocHTML(i, { workspace: ws }) + '</div>' +
          '<p id="ivErr" class="wf-err" hidden></p>',
    foot:
      (i.status === 'sent'
        ? '<span class="foot-left"><button class="btn btn-sm btn-ghost danger" id="ivVoid" type="button">Cancel invoice</button></span>'
        : '') +
      '<button class="btn btn-ghost" id="ivClose" type="button">Close</button>' +
      '<button class="btn" id="ivPrint" type="button">Print / Save PDF</button>',
  });
  const err = m.overlay.querySelector('#ivErr');
  m.overlay.querySelector('#ivClose').addEventListener('click', m.close);
  m.overlay.querySelector('#ivPrint').addEventListener('click', () => printRentInvoice(i, { workspace: ws }));
  const vd = m.overlay.querySelector('#ivVoid');
  if (vd) vd.addEventListener('click', async () => {
    const why = window.prompt('Why is ' + i.invoice_no + ' being cancelled? The workspace Admin is told.');
    if (why === null) return;
    vd.disabled = true; err.hidden = true;
    const { error } = await sb.rpc('master_void_rent_invoice', { p_id: i.id, p_reason: why.trim() || null });
    if (error) { err.textContent = error.message; err.hidden = false; vd.disabled = false; return; }
    m.close(); toast('Invoice cancelled.'); reload();
  });
}

// ── Issue an invoice ──────────────────────────────────────────────────────────
function openIssue(sb, row, reload) {
  const { w, sub } = row;
  if (!sub) return toast('Give this workspace a plan first.');
  const from = sub.next_due || sub.trial_ends_on || sub.start_date;

  const m = openModal({
    title: 'Issue invoice · ' + w.name,
    body:
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="iFrom">Period from</label>' +
          '<input class="wf-input" id="iFrom" type="date" value="' + esc(from || '') + '"></div>' +
        '<div class="wf-group"><label class="wf-label" for="iTo">Period to</label>' +
          '<input class="wf-input" id="iTo" type="date">' +
          '<p class="wf-hint">Leave empty for one full cycle.</p></div>' +
      '</div>' +
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="iCur">Currency</label>' +
          '<select class="wf-select" id="iCur">' + CURRENCIES.map((c) =>
            '<option value="' + c + '"' + (c === sub.currency ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
        '<div class="wf-group"><label class="wf-label" for="iAmt">Amount</label>' +
          '<input class="wf-input" id="iAmt" inputmode="decimal" value="' + esc(String(sub.amount_original)) + '"></div>' +
      '</div>' +
      '<div class="wf-row">' +
        '<div class="wf-group"><label class="wf-label" for="iFx">Rate to PKR</label>' +
          '<input class="wf-input" id="iFx" inputmode="decimal" value="' + esc(String(sub.fx_rate)) + '"></div>' +
        '<div class="wf-group"><label class="wf-label" for="iDue">Due date</label>' +
          '<input class="wf-input" id="iDue" type="date" value="' + esc(from || '') + '"></div>' +
      '</div>' +
      '<div class="wf-group"><label class="wf-label" for="iNote">Note on the invoice</label>' +
        '<input class="wf-input" id="iNote" maxlength="200" placeholder="Optional"></div>' +
      '<p class="muted small">The number is taken from the platform counter (INV-WX…). The Admin is notified and sees it on their Billing page. ' +
        'The next payment you record closes the oldest unpaid invoice on its own.</p>' +
      '<p id="issErr" class="wf-err" hidden></p>',
    foot: '<button class="btn btn-ghost" id="issCancel" type="button">Cancel</button>' +
          '<button class="btn" id="issSave" type="button">Issue invoice</button>',
  });
  const $ = (id) => m.overlay.querySelector('#' + id);
  const err = $('issErr');

  $('iCur').addEventListener('change', () => { if ($('iCur').value === 'PKR') $('iFx').value = '1'; });
  $('issCancel').addEventListener('click', m.close);
  $('issSave').addEventListener('click', async (e) => {
    const amount = Number($('iAmt').value), fx = Number($('iFx').value);
    if (!$('iFrom').value) return fieldError($('iFrom'), 'Pick the first day of the period.');
    if (!($('iAmt').value !== '' && amount >= 0)) return fieldError($('iAmt'), 'Enter the amount.');
    if (!(fx > 0)) return fieldError($('iFx'), 'Enter a rate above zero.');
    if ($('iTo').value && $('iTo').value < $('iFrom').value) return fieldError($('iTo'), 'The period ends before it starts.');

    e.target.disabled = true; e.target.textContent = 'Issuing…'; err.hidden = true;
    const { error } = await sb.rpc('master_issue_rent_invoice', {
      p_ws: w.id, p_period_from: $('iFrom').value, p_period_to: $('iTo').value || null,
      p_due_date: $('iDue').value || null, p_amount: amount, p_currency: $('iCur').value,
      p_fx: fx, p_notes: $('iNote').value.trim() || null,
    });
    if (error) { err.textContent = error.message; err.hidden = false; e.target.disabled = false; e.target.textContent = 'Issue invoice'; return; }
    m.close(); toast('Invoice issued.'); reload();
  });
}
