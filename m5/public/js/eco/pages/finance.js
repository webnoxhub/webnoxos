// Finance: business dashboard, expenses, recurring bills & salaries (with reminders), investments, invoices, monthly report.
// Salaries are only visible to the admin and managers (enforced in the database too).
import { supabase } from '../supabase.js';
import { state, can, money } from '../state.js';
import { q, rpc, loadDirectory, dirName } from '../data.js';
import { attachFieldHTML, bindAttachments, saveAttachments, removeAllAttachments, attachChip, showAttachments } from '../attachments.js';
import { esc, icon, emptyState, loadingBlock, on, openModal, confirmDialog, toast, busy, downloadCSV } from '../ui.js';
import { fmtDate, todayStr, daysBetween } from '../time.js';
import { moneyFieldsHTML, bindMoneyFields, fmtCur, fmtPaid, baseCurrency, fetchRate } from '../currency.js';
import { invoiceBadge, invoiceState, INVOICE_STATUS, invAmount, partyName, openInvoiceEditor, openInvoiceView } from '../invoices.js';

export const CATS = {
  tools: 'Tools & software', salary: 'Salaries', rent: 'Rent & office', ads: 'Ads & marketing', freelancers: 'Freelancers',
  utilities: 'Internet & utilities', equipment: 'Equipment', travel: 'Travel & meals', taxes: 'Taxes & fees', other: 'Other',
};
const CAT_COLOR = { tools: '#4F46E5', salary: '#0EA5E9', rent: '#F59E0B', ads: '#DB2777', freelancers: '#8B5CF6', utilities: '#14B8A6', equipment: '#64748B', travel: '#F97316', taxes: '#DC2626', other: '#94A3B8' };
const FREQ = { once: 'One time', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Every 3 months', yearly: 'Yearly' };
const KIND = { capital: 'Capital', loan: 'Loan', grant: 'Grant', other: 'Other' };
const TABS = [['overview', 'Dashboard', 'dashboard'], ['expenses', 'Expenses', 'wallet'], ['recurring', 'Bills & salaries', 'calendar'], ['investments', 'Investments', 'trending'], ['invoices', 'Client invoices', 'file'], ['biz-invoices', 'Business invoices', 'briefcase'], ['report', 'Monthly report', 'chart']];
const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
const catName = (k) => CATS[k] || k;
const salaryOk = () => state.isAdmin;
const bizCode = () => { const w = String(state.settings?.company_name || state.workspace?.name || 'Company').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean); return !w.length ? 'CL' : w.length > 1 ? w[0][0] + w[1][0] : w[0][0] + w[0].slice(-1); };
const monthLabel = (ym) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`));
const shortMonth = (ym) => new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`));
const shiftMonth = (ym, n) => { const d = new Date(`${ym}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };
function addFreq(d, f) {
  const [y, m, day] = d.split('-').map(Number);
  if (f === 'weekly') { const x = new Date(Date.UTC(y, m - 1, day + 7)); return x.toISOString().slice(0, 10); }
  const months = f === 'quarterly' ? 3 : f === 'yearly' ? 12 : 1;
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(day, last))).toISOString().slice(0, 10);
}
const pct = (a, b) => (Number(b) ? Math.round(((a - b) / Math.abs(b)) * 100) : null);
const delta = (a, b, goodUp = true) => { const p = pct(a, b); if (p === null) return ''; const good = goodUp ? p >= 0 : p <= 0; return `<span class="delta ${good ? 'up' : 'down'}">${p >= 0 ? '+' : ''}${p}%</span>`; };

export async function render({ el, params }) {
  let tab = params.get('tab') || 'overview';
  let reportMonth = params.get('month') || todayStr().slice(0, 7);
  let expMonth = todayStr().slice(0, 7); let expCat = ''; let expSearch = '';
  let invFilter = 'all'; let invSearch = '';
  let dir = [];
  const edit = can('finance', 'edit'); const del = can('finance', 'delete');

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Finance</h1><p>Money in, money out, what's due, and where the business stands.</p></div>
      <div class="actions" id="fin-actions"></div>
    </div>
    <div class="tabs-line ws-tabs" role="tablist" id="fin-tabs"></div>
    <div id="fin-body">${loadingBlock(5)}</div>`;
  const body = el.querySelector('#fin-body');

  function drawTabs() {
    el.querySelector('#fin-tabs').innerHTML = TABS.map(([k, v, ic]) => `<button data-tab="${k}" aria-pressed="${tab === k}">${icon(ic, 14)}${v}</button>`).join('');
    el.querySelector('#fin-actions').innerHTML = edit ? `
      <button class="btn" data-add="investment">${icon('trending', 15)}Add investment</button>
      <button class="btn" data-add="bill">${icon('calendar', 15)}Add bill or salary</button>
      <button class="btn btn-primary" data-add="expense">${icon('plus', 15)}Add expense</button>` : '';
  }

  async function load() {
    dir = await loadDirectory();
    if (tab === 'overview') await overview();
    else if (tab === 'expenses') await expenses();
    else if (tab === 'recurring') await recurring();
    else if (tab === 'investments') await investments();
    else if (tab === 'invoices') await invoicesTab('client');
    else if (tab === 'biz-invoices') await invoicesTab('business');
    else await report();
  }

  // ---------- Dashboard ----------
  async function overview() {
    const [o, recent] = await Promise.all([rpc('finance_overview'), q(supabase.from('expenses').select('*').order('spent_on', { ascending: false }).order('id', { ascending: false }).limit(6))]);
    const net = o.revenue_month - o.expenses_month; const netLast = o.revenue_last - o.expenses_last;
    const catTotal = o.by_category.reduce((a, c) => a + Number(c.total), 0);
    body.innerHTML = `
      <div class="fin-kpis">
        <div class="kpi big"><span>Cash in the business</span><b class="${o.cash < 0 ? 'neg' : ''}">${money(o.cash)}</b><small>${money(o.invested_total)} invested + ${money(o.revenue_total)} earned − ${money(o.expenses_total)} spent</small></div>
        <div class="kpi"><span>Revenue this month</span><b class="pos">${money(o.revenue_month)}</b><small>Last month ${money(o.revenue_last)} ${delta(o.revenue_month, o.revenue_last)}</small></div>
        <div class="kpi"><span>Expenses this month</span><b>${money(o.expenses_month)}</b><small>Last month ${money(o.expenses_last)} ${delta(o.expenses_month, o.expenses_last, false)}</small></div>
        <div class="kpi"><span>${net >= 0 ? 'Profit' : 'Loss'} this month</span><b class="${net >= 0 ? 'pos' : 'neg'}">${money(Math.abs(net))}</b><small>Last month ${netLast >= 0 ? 'profit' : 'loss'} ${money(Math.abs(netLast))}</small></div>
        <div class="kpi"><span>Fixed costs / month</span><b>${money(o.monthly_fixed)}</b><small>${o.salaries_monthly != null ? `Salaries ${money(o.salaries_monthly)} · ` : ''}${o.runway_months != null ? `Runway ${o.runway_months} months` : 'Tools, salaries, rent'}</small></div>
        <div class="kpi"><span>Unpaid invoices</span><b>${money(o.outstanding)}</b><small><button class="linkish" data-goto="invoices">See invoices</button></small></div>
      </div>
      <div class="grid-3-1" style="margin-top:18px">
        <section class="panel"><div class="panel-head"><div><h2>Money in vs money out</h2><p>Last 12 months</p></div>
          <div class="legend"><span><i style="background:var(--success)"></i>Revenue</span><span><i style="background:#F87171"></i>Expenses</span></div></div>
          <div class="panel-body">${twinBars(o.months)}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Spent this month</h2><p>${money(catTotal)} by category</p></div></div>
          <div class="panel-body">${o.by_category.length ? `<div class="cat-bars">${o.by_category.map((c) => `
            <div class="cat-row"><div class="cat-top"><span><i style="background:${CAT_COLOR[c.category] || '#94A3B8'}"></i>${esc(catName(c.category))}</span><b>${money(c.total)}</b></div>
              <div class="cat-track"><div style="width:${catTotal ? (c.total / catTotal) * 100 : 0}%;background:${CAT_COLOR[c.category] || '#94A3B8'}"></div></div></div>`).join('')}</div>`
            : '<p class="muted small">No expenses this month yet.</p>'}</div></section>
      </div>
      <div class="grid-2" style="margin-top:18px">
        <section class="panel"><div class="panel-head"><div><h2>Coming up</h2><p>Bills and salaries due in the next 30 days</p></div><button class="btn btn-sm btn-ghost" data-goto="recurring">All bills</button></div>
          <div class="list">${o.upcoming.length ? o.upcoming.map((u) => upcomingRow(u)).join('') : `<div class="panel-body"><p class="muted small">Nothing due in the next 30 days.</p></div>`}</div></section>
        <section class="panel"><div class="panel-head"><div><h2>Recent expenses</h2></div><button class="btn btn-sm btn-ghost" data-goto="expenses">All expenses</button></div>
          <div class="list">${recent.length ? recent.map((x) => `<div class="list-item" style="padding:10px 16px"><span class="cat-dot" style="background:${CAT_COLOR[x.category] || '#94A3B8'}"></span>
            <div class="grow"><div class="title">${esc(x.category === 'salary' ? `Salary: ${dirName(dir, x.payee_member) || x.title}` : x.title)}</div><div class="meta"><span>${esc(catName(x.category))}</span><span>${esc(fmtDate(x.spent_on))}</span>${x.recurring_id ? '<span>Recurring</span>' : ''}</div></div>
            <b class="money">${fmtPaid(x, money)}</b></div>`).join('') : `<div class="panel-body"><p class="muted small">No expenses recorded yet.</p></div>`}</div></section>
      </div>`;
  }
  function upcomingRow(u) {
    const d = daysBetween(todayStr(), u.next_due);
    const when = d < 0 ? `<span class="due over">Overdue ${-d}d</span>` : d === 0 ? '<span class="due soon">Due today</span>' : `<span class="due ${d <= 3 ? 'soon' : ''}">In ${d} days, ${esc(fmtDate(u.next_due))}</span>`;
    return `<div class="list-item" style="padding:10px 16px;flex-wrap:wrap"><span class="cat-dot" style="background:${CAT_COLOR[u.category] || '#94A3B8'}"></span>
      <div class="grow" style="min-width:150px"><div class="title">${esc(u.title)}</div><div class="meta">${when}${u.auto_post ? '<span>Charged automatically</span>' : ''}</div></div>
      <b class="money">${money(u.amount)}</b>${edit && !u.auto_post ? `<button class="btn btn-sm" data-pay="${u.id}">${icon('check', 13)}Mark paid</button>` : ''}</div>`;
  }

  // ---------- Expenses ----------
  async function expenses() {
    const from = `${expMonth}-01`; const to = `${shiftMonth(expMonth, 1)}-01`;
    const rows = await q(supabase.from('expenses').select('*').gte('spent_on', from).lt('spent_on', to).order('spent_on', { ascending: false }).order('id', { ascending: false }));
    const s = expSearch.toLowerCase();
    const list = rows.filter((x) => (!expCat || x.category === expCat) && (!s || `${x.title} ${x.vendor || ''} ${dirName(dir, x.payee_member)}`.toLowerCase().includes(s)));
    const total = list.reduce((a, x) => a + Number(x.amount), 0);
    body.innerHTML = `
      <div class="toolbar">
        <div class="month-pick"><button class="btn btn-icon btn-ghost" data-exp-month="-1" aria-label="Previous month">${icon('chevronL', 16)}</button><b>${esc(monthLabel(expMonth))}</b><button class="btn btn-icon btn-ghost" data-exp-month="1" aria-label="Next month">${icon('chevronR', 16)}</button></div>
        <select class="select" id="exp-cat" style="width:auto" aria-label="Category"><option value="">All categories</option>${Object.entries(CATS).filter(([k]) => k !== 'salary' || salaryOk()).map(([k, v]) => `<option value="${k}" ${expCat === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <div class="search grow">${icon('search', 15)}<input class="input" id="exp-q" value="${esc(expSearch)}" placeholder="Search expenses" aria-label="Search expenses"></div>
        <button class="btn" data-exp-csv>${icon('download', 15)}CSV</button>
      </div>
      <section class="panel"><div class="table-wrap">${list.length ? `<table class="table">
        <thead><tr><th>Expense</th><th>Category</th><th>Date</th><th>Paid by</th><th class="r">Amount</th><th></th></tr></thead>
        <tbody>${list.map((x) => `<tr>
          <td><div style="font-weight:500">${esc(x.category === 'salary' ? `Salary: ${dirName(dir, x.payee_member) || x.title}` : x.title)}${attachChip(x, `e${x.id}`)}</div><div class="small muted">${esc([x.vendor, x.notes].filter(Boolean).join(' · '))}${x.recurring_id ? ' <span class="chip">Recurring</span>' : ''}</div></td>
          <td><span class="cat-tag"><i style="background:${CAT_COLOR[x.category] || '#94A3B8'}"></i>${esc(catName(x.category))}</span></td>
          <td class="small">${esc(fmtDate(x.spent_on))}</td>
          <td class="small">${esc(dirName(dir, x.paid_by) || '—')}</td>
          <td class="r money"><b>${fmtPaid(x, money)}</b></td>
          <td class="r nowrap">${edit ? `<button class="btn btn-sm btn-ghost btn-icon" data-edit-exp="${x.id}" aria-label="Edit">${icon('edit', 13)}</button>` : ''}${del ? `<button class="btn btn-sm btn-ghost btn-icon btn-danger" data-del-exp="${x.id}" aria-label="Delete">${icon('trash', 13)}</button>` : ''}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">Total${expCat ? ` (${esc(catName(expCat))})` : ''}</td><td class="r money">${money(total)}</td><td></td></tr></tfoot></table>`
        : emptyState(rows.length ? 'Nothing matches' : `No expenses in ${monthLabel(expMonth)}`, edit ? 'Add tools, rent, ads, freelancers and anything else the business pays for.' : '', edit ? '<button class="btn btn-primary" data-add="expense">Add expense</button>' : '')}</div></section>`;
    body.querySelector('#exp-cat').onchange = (e) => { expCat = e.target.value; expenses(); };
    const qi = body.querySelector('#exp-q');
    qi.oninput = () => { expSearch = qi.value.trim(); clearTimeout(qi._t); qi._t = setTimeout(() => expenses().then(() => { const n = body.querySelector('#exp-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }), 250); };
    body.querySelector('[data-exp-csv]').onclick = () => downloadCSV(`expenses-${expMonth}.csv`, [['Date', 'Expense', 'Category', 'Vendor', 'Paid by', 'For', 'Currency', 'Amount paid', 'Rate', `Amount (${baseCurrency()})`, 'Notes'],
      ...list.map((x) => [x.spent_on, x.title, catName(x.category), x.vendor || '', dirName(dir, x.paid_by), dirName(dir, x.payee_member), x.currency || baseCurrency(), x.amount_original ?? x.amount, x.fx_rate ?? 1, x.amount, x.notes])]);
    body.querySelectorAll('[data-edit-exp]').forEach((b) => b.onclick = () => expenseForm(rows.find((x) => x.id === Number(b.dataset.editExp))));
    body.querySelectorAll('[data-attach]').forEach((b) => b.onclick = () => { const x = rows.find((r) => `e${r.id}` === b.dataset.attach); if (x) showAttachments(x, x.title); });
    body.querySelectorAll('[data-del-exp]').forEach((b) => b.onclick = async () => {
      const x = rows.find((r) => r.id === Number(b.dataset.delExp));
      if (!await confirmDialog({ title: `Delete ${x.title}?`, text: `${money(x.amount)} on ${fmtDate(x.spent_on)}`, confirm: 'Delete', danger: true })) return;
      try { await removeAllAttachments(x); await q(supabase.from('expenses').delete().eq('id', x.id)); toast('Expense deleted'); changed(); } catch (e) { toast(e.message, 'error'); }
    });
  }

  // ---------- Bills & salaries ----------
  async function recurring() {
    const rows = await q(supabase.from('recurring_expenses').select('*').order('active', { ascending: false }).order('next_due'));
    const perMonth = (r) => (r.frequency === 'once' ? 0 : r.frequency === 'weekly' ? r.amount * 52 / 12 : r.frequency === 'quarterly' ? r.amount / 3 : r.frequency === 'yearly' ? r.amount / 12 : Number(r.amount));
    const groups = [
      ['Tools & subscriptions', rows.filter((r) => r.category === 'tools')],
      salaryOk() && ['Salaries', rows.filter((r) => r.category === 'salary')],
      ['Other fixed costs', rows.filter((r) => !['tools', 'salary'].includes(r.category))],
    ].filter(Boolean);
    const row = (r) => {
      const d = daysBetween(todayStr(), r.next_due);
      const name = r.category === 'salary' ? (dirName(dir, r.payee_member) || r.title) : r.title;
      const once = r.frequency === 'once';
      const left = d > 0 ? `${d} day${d === 1 ? '' : 's'} left` : d === 0 ? 'today' : `${-d} day${d === -1 ? '' : 's'} overdue`;
      const when = once
        ? (r.active ? `<span class="due ${d < 0 ? 'over' : d <= r.remind_days ? 'soon' : ''}">Due ${esc(fmtDate(r.next_due))} · ${left}</span>` : `<span>Paid ${esc(fmtDate(r.next_due))}</span>`)
        : r.active ? `<span class="due ${d < 0 ? 'over' : d <= r.remind_days ? 'soon' : ''}">Renews ${esc(fmtDate(r.next_due))} · ${left}</span>` : '';
      return `<div class="list-item bill ${r.active || once ? '' : 'off'}" style="flex-wrap:wrap">
        <span class="cat-dot" style="background:${CAT_COLOR[r.category] || '#94A3B8'}"></span>
        <div class="grow" style="min-width:180px"><div class="title">${esc(name)}${attachChip(r, `b${r.id}`)}${r.active ? '' : once ? ' <span class="badge paid">Paid</span>' : ' <span class="badge paused">Paused</span>'}</div>
          <div class="meta"><span>${fmtPaid(r, money)} ${esc(FREQ[r.frequency].toLowerCase())}</span>${r.vendor ? `<span>${esc(r.vendor)}</span>` : ''}${when}
            ${r.active ? `<span>${r.auto_post ? 'Charged automatically' : `Reminder ${r.remind_days} day${r.remind_days === 1 ? '' : 's'} before`}</span>` : ''}</div></div>
        ${edit && r.active ? `<button class="btn btn-sm" data-pay="${r.id}">${icon('check', 13)}${r.category === 'salary' ? 'Mark paid' : 'Paid'}</button>${once ? '' : `<button class="btn btn-sm btn-ghost" data-skip="${r.id}" title="Skip this one">Skip</button>`}` : ''}
        ${edit ? `<button class="btn btn-sm btn-ghost btn-icon" data-edit-bill="${r.id}" aria-label="Edit">${icon('edit', 13)}</button>` : ''}
        ${del ? `<button class="btn btn-sm btn-ghost btn-icon btn-danger" data-del-bill="${r.id}" aria-label="Delete">${icon('trash', 13)}</button>` : ''}
      </div>`;
    };
    body.innerHTML = `
      <div class="note info" style="margin-bottom:14px">${icon('bell', 13)} Reminders go to the admin and all managers${salaryOk() ? '. Salary reminders go only to them' : ''}; tool and other bill reminders also go to the Finance team. Bills set to <b>charge automatically</b> are added as an expense on the renewal date. The rest wait for <b>Mark paid</b>.</div>
      ${groups.map(([title, list]) => `
        <section class="panel" style="margin-bottom:16px"><div class="panel-head"><div><h2>${title}</h2><p>${list.filter((r) => r.active).length} active · ${money(list.filter((r) => r.active).reduce((a, r) => a + perMonth(r), 0))} a month</p></div>
          ${edit ? `<button class="btn btn-sm" data-add="${title === 'Salaries' ? 'salary' : title.startsWith('Tools') ? 'bill' : 'other-bill'}">${icon('plus', 13)}Add</button>` : ''}</div>
          <div class="list">${list.length ? list.map(row).join('') : `<div class="panel-body"><p class="muted small">${title === 'Salaries' ? 'Add each team member\'s monthly salary to get a reminder on payday.' : 'None yet.'}</p></div>`}</div></section>`).join('')}`;
    body.querySelectorAll('[data-edit-bill]').forEach((b) => b.onclick = () => billForm({ bill: rows.find((r) => r.id === Number(b.dataset.editBill)) }));
    body.querySelectorAll('[data-attach]').forEach((b) => b.onclick = () => { const r = rows.find((x) => `b${x.id}` === b.dataset.attach); if (r) showAttachments(r, r.title); });
    body.querySelectorAll('[data-skip]').forEach((b) => b.onclick = async () => {
      const r = rows.find((x) => x.id === Number(b.dataset.skip));
      if (!await confirmDialog({ title: `Skip the payment due ${fmtDate(r.next_due)}?`, text: 'No expense is recorded and the next due date moves on.', confirm: 'Skip' })) return;
      try { await rpc('recurring_skip', { p_id: r.id }); toast('Skipped'); changed(); } catch (e) { toast(e.message, 'error'); }
    });
    body.querySelectorAll('[data-del-bill]').forEach((b) => b.onclick = async () => {
      const r = rows.find((x) => x.id === Number(b.dataset.delBill));
      if (!await confirmDialog({ title: `Remove ${r.category === 'salary' ? 'this salary' : r.title}?`, text: 'Past payments stay in Expenses. To stop it for a while, edit it and turn it off instead.', confirm: 'Remove', danger: true })) return;
      try { await removeAllAttachments(r); await q(supabase.from('recurring_expenses').delete().eq('id', r.id)); toast('Removed'); changed(); } catch (e) { toast(e.message, 'error'); }
    });
    bindPay(rows);
  }

  // ---------- Investments ----------
  async function investments() {
    const rows = await q(supabase.from('investments').select('*').order('invested_on', { ascending: false }));
    const total = rows.reduce((a, r) => a + Number(r.amount), 0);
    const by = {};
    rows.forEach((r) => { const k = dirName(dir, r.investor_id) || r.source; by[k] = (by[k] || 0) + Number(r.amount); });
    body.innerHTML = `
      <div class="fin-kpis" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        <div class="kpi big"><span>Total invested</span><b>${money(total)}</b><small>${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</small></div>
        ${Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `<div class="kpi"><span>${esc(k)}</span><b>${money(v)}</b><small>${total ? Math.round((v / total) * 100) : 0}% of the total</small></div>`).join('')}
      </div>
      <section class="panel" style="margin-top:16px"><div class="table-wrap">${rows.length ? `<table class="table">
        <thead><tr><th>From</th><th>Type</th><th>Date</th><th>Notes</th><th class="r">Amount</th><th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td style="font-weight:500">${esc(dirName(dir, r.investor_id) || r.source)}</td><td><span class="chip">${esc(KIND[r.kind] || r.kind)}</span></td>
          <td class="small">${esc(fmtDate(r.invested_on))}</td><td class="small muted">${esc(r.notes || '')}</td><td class="r money"><b>${fmtPaid(r, money)}</b></td>
          <td class="r nowrap">${edit ? `<button class="btn btn-sm btn-ghost btn-icon" data-edit-inv-x="${r.id}" aria-label="Edit">${icon('edit', 13)}</button>` : ''}${del ? `<button class="btn btn-sm btn-ghost btn-icon btn-danger" data-del-inv-x="${r.id}" aria-label="Delete">${icon('trash', 13)}</button>` : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">Total</td><td class="r money">${money(total)}</td><td></td></tr></tfoot></table>`
        : emptyState('No investments yet', 'Record money the owners or anyone else put into the business.', edit ? '<button class="btn btn-primary" data-add="investment">Add investment</button>' : '')}</div></section>`;
    body.querySelectorAll('[data-edit-inv-x]').forEach((b) => b.onclick = () => investmentForm(rows.find((r) => r.id === Number(b.dataset.editInvX))));
    body.querySelectorAll('[data-del-inv-x]').forEach((b) => b.onclick = async () => {
      const r = rows.find((x) => x.id === Number(b.dataset.delInvX));
      if (!await confirmDialog({ title: 'Delete this investment?', text: `${money(r.amount)} from ${r.source}`, confirm: 'Delete', danger: true })) return;
      try { await q(supabase.from('investments').delete().eq('id', r.id)); toast('Investment deleted'); changed(); } catch (e) { toast(e.message, 'error'); }
    });
  }

  // ---------- Invoices (client / business) ----------
  async function invoicesTab(kind) {
    const biz = kind === 'business';
    const invoices = await q(supabase.from('invoices').select('*, client:clients(id, name, buid)').eq('kind', kind).order('issue_date', { ascending: false }).order('id', { ascending: false }).limit(3000));
    const groups = { unpaid: (i) => i.status === 'sent', overdue: (i) => invoiceState(i) === 'overdue', paid: (i) => i.status === 'paid', draft: (i) => i.status === 'draft', all: () => true };
    const s = invSearch.toLowerCase();
    const list = invoices.filter(groups[invFilter]).filter((i) => !s || `${partyName(i)} ${i.client?.buid || ''} ${i.invoice_number || ''} ${i.reference_no || ''} ${i.bill_to?.name || ''}`.toLowerCase().includes(s));
    const total = list.reduce((a, i) => a + Number(i.amount), 0);
    body.innerHTML = `
      <p class="muted small" style="margin:0 0 12px">${biz
        ? 'Our own invoices for people who aren\'t clients in this workspace. Numbers run INV-' + esc(bizCode()) + '001, 002… Paid ones count as revenue.'
        : 'Invoices for clients. Numbers come from the client\'s business ID: INV-BUID-HF001, HF002… Paid ones count as revenue.'}</p>
      <div class="toolbar"><div class="seg" role="group" aria-label="Invoice status">${[['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['draft', 'Draft'], ['all', 'All']]
        .map(([k, v]) => `<button data-f="${k}" aria-pressed="${invFilter === k}">${v}<span class="count">${invoices.filter(groups[k]).length}</span></button>`).join('')}</div>
        <div class="search grow">${icon('search', 15)}<input class="input" id="inv-q" value="${esc(invSearch)}" placeholder="${biz ? 'Search name or invoice number' : 'Search client, BUID or invoice number'}" aria-label="Search invoices"></div>
        <button class="btn" data-inv-csv>${icon('download', 15)}CSV</button>${edit ? `<button class="btn btn-primary" data-new-invoice>${icon('plus', 15)}New ${biz ? 'business' : 'client'} invoice</button>` : ''}</div>
      <section class="panel"><div class="table-wrap">${list.length ? `<table class="table">
        <thead><tr><th>Invoice</th><th>${biz ? 'Billed to' : 'Client'}</th><th>Issued</th><th>Due</th><th>Status</th><th class="r">Amount</th></tr></thead>
        <tbody>${list.map((i) => `<tr class="clickable" data-inv="${i.id}" tabindex="0">
          <td><div style="font-weight:500">${esc(i.invoice_number || `#${i.id}`)}</div><div class="small muted">${esc(i.description || i.reference_no || '')}</div></td>
          <td>${esc(partyName(i))}${!biz && i.client?.buid ? `<div class="small muted">${esc(i.client.buid)}</div>` : biz && i.bill_to?.company && i.bill_to?.name ? `<div class="small muted">${esc(i.bill_to.name)}</div>` : ''}</td>
          <td class="small">${esc(fmtDate(i.issue_date))}</td><td class="small">${esc(fmtDate(i.due_date))}</td>
          <td>${invoiceBadge(i)}</td><td class="r money"><b>${invAmount(i)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5">Total (${esc(state.settings.currency || 'USD')})</td><td class="r money">${money(total)}</td></tr></tfoot></table>`
        : emptyState(invoices.length ? 'No invoices here' : 'No invoices yet', invoices.length ? '' : biz ? 'Create one with New business invoice.' : 'Create one with New client invoice: pick the client, add the lines, done.')}</div></section>`;
    body.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { invFilter = b.dataset.f; invoicesTab(kind); });
    const qi = body.querySelector('#inv-q');
    qi.oninput = () => { invSearch = qi.value.trim(); clearTimeout(qi._t); qi._t = setTimeout(() => invoicesTab(kind).then(() => { const n = body.querySelector('#inv-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }), 250); };
    body.querySelector('[data-new-invoice]')?.addEventListener('click', () => openInvoiceEditor({ kind }));
    body.querySelector('[data-inv-csv]').onclick = () => downloadCSV(`${biz ? 'business' : 'client'}-invoices.csv`, [['Invoice', 'Reference', biz ? 'Billed to' : 'Client', 'BUID', 'Description', 'Issued', 'Due', 'Status', 'Paid on', 'Currency', 'Amount', `Amount (${state.settings.currency || 'USD'})`, 'Issued by'],
      ...list.map((i) => [i.invoice_number || i.id, i.reference_no || '', partyName(i), i.client?.buid || '', i.description, i.issue_date, i.due_date || '', invoiceState(i) === 'overdue' ? 'Overdue' : INVOICE_STATUS[i.status], i.paid_date || '', i.currency || '', i.amount_original ?? i.amount, i.amount, [i.issued_by_name, i.issued_by_title].filter(Boolean).join(', ')])]);
    body.querySelectorAll('tr[data-inv]').forEach((tr) => {
      tr.onclick = () => openInvoiceView(Number(tr.dataset.inv));
      tr.onkeydown = (e) => { if (e.key === 'Enter') openInvoiceView(Number(tr.dataset.inv)); };
    });
  }

  // ---------- Monthly report ----------
  async function report() {
    const r = await rpc('finance_report', { p_month: `${reportMonth}-01` });
    const isFuture = reportMonth > todayStr().slice(0, 7);
    const catTotal = r.by_category.reduce((a, c) => a + Number(c.total), 0);
    const prevNet = r.prev.revenue - r.prev.expenses;
    body.innerHTML = `
      <div class="toolbar no-print">
        <div class="month-pick"><button class="btn btn-icon btn-ghost" data-rep-month="-1" aria-label="Previous month">${icon('chevronL', 16)}</button><b>${esc(monthLabel(reportMonth))}</b><button class="btn btn-icon btn-ghost" data-rep-month="1" aria-label="Next month" ${isFuture ? 'disabled' : ''}>${icon('chevronR', 16)}</button></div>
        <span class="grow"></span>
        <button class="btn" data-rep-csv>${icon('download', 15)}CSV</button><button class="btn btn-primary" data-print>${icon('file', 15)}Print / save PDF</button>
      </div>
      <article class="report" id="report">
        <header class="report-head"><div><small>${esc(state.settings.company_name || state.workspace?.name || 'Company')} · Finance report</small><h2>${esc(monthLabel(reportMonth))}</h2></div>
          <div class="report-net ${r.net >= 0 ? 'pos' : 'neg'}"><span>${r.net >= 0 ? 'Profit' : 'Loss'}</span><b>${money(Math.abs(r.net))}</b><small>Last month: ${prevNet >= 0 ? 'profit' : 'loss'} ${money(Math.abs(prevNet))}</small></div></header>
        <div class="fin-kpis report-kpis">
          <div class="kpi"><span>Revenue (paid invoices)</span><b class="pos">${money(r.revenue)}</b><small>${delta(r.revenue, r.prev.revenue)} vs last month</small></div>
          <div class="kpi"><span>Expenses</span><b>${money(r.expenses)}</b><small>${delta(r.expenses, r.prev.expenses, false)} vs last month</small></div>
          <div class="kpi"><span>Salaries</span><b>${money(r.salaries)}</b><small>Part of expenses</small></div>
          <div class="kpi"><span>Invested this month</span><b>${money(r.investments)}</b><small>Invoiced: ${money(r.invoiced)}</small></div>
          <div class="kpi"><span>Cash at month end</span><b class="${r.cash_end < 0 ? 'neg' : ''}">${money(r.cash_end)}</b><small>All money in − all money out</small></div>
        </div>
        <div class="grid-2" style="margin-top:16px">
          <section class="panel"><div class="panel-head"><h2>Where the money went</h2></div><div class="panel-body">${r.by_category.length ? `<div class="cat-bars">${r.by_category.map((c) => `
            <div class="cat-row"><div class="cat-top"><span><i style="background:${CAT_COLOR[c.category] || '#94A3B8'}"></i>${esc(catName(c.category))} <span class="muted">(${c.count})</span></span><b>${money(c.total)}</b></div>
            <div class="cat-track"><div style="width:${catTotal ? (c.total / catTotal) * 100 : 0}%;background:${CAT_COLOR[c.category] || '#94A3B8'}"></div></div></div>`).join('')}</div>` : '<p class="muted small">No expenses this month.</p>'}</div></section>
          <section class="panel"><div class="panel-head"><h2>Money in</h2><span class="muted small">${r.revenue_rows.length} paid invoice${r.revenue_rows.length === 1 ? '' : 's'}</span></div>
            <div class="list">${r.revenue_rows.length ? r.revenue_rows.map((x) => `<div class="list-item" style="padding:9px 16px"><div class="grow"><div class="title">${esc(x.client || 'Client')}</div><div class="meta"><span>${esc(x.invoice)}</span><span>Paid ${esc(fmtDate(x.paid_date))}</span></div></div><b class="money pos">${money(x.amount)}</b></div>`).join('') : '<div class="panel-body"><p class="muted small">No invoices paid this month.</p></div>'}
            ${r.investment_rows.map((x) => `<div class="list-item" style="padding:9px 16px"><div class="grow"><div class="title">${esc(x.source)}</div><div class="meta"><span>Investment (${esc(KIND[x.kind] || x.kind)})</span><span>${esc(fmtDate(x.invested_on))}</span></div></div><b class="money">${money(x.amount)}</b></div>`).join('')}</div></section>
        </div>
        <section class="panel" style="margin-top:16px"><div class="panel-head"><h2>All expenses</h2><span class="muted small">${r.expense_rows.length} entries</span></div>
          <div class="table-wrap">${r.expense_rows.length ? `<table class="table"><thead><tr><th>Date</th><th>Expense</th><th>Category</th><th class="r">Amount</th></tr></thead>
          <tbody>${r.expense_rows.map((x) => `<tr><td class="small">${esc(fmtDate(x.spent_on))}</td><td>${esc(x.category === 'salary' && x.payee ? `Salary: ${x.payee}` : x.title)}${x.vendor ? ` <span class="small muted">${esc(x.vendor)}</span>` : ''}</td><td class="small">${esc(catName(x.category))}</td><td class="r money">${money(x.amount)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="3">Total</td><td class="r money">${money(r.expenses)}</td></tr></tfoot></table>` : '<div class="panel-body"><p class="muted small">Nothing recorded.</p></div>'}</div></section>
        ${r.show_salaries ? '' : '<p class="small muted" style="margin-top:10px">Salary details are only shown to the admin and managers. Totals include them.</p>'}
      </article>`;
    body.querySelectorAll('[data-rep-month]').forEach((b) => b.onclick = () => { reportMonth = shiftMonth(reportMonth, Number(b.dataset.repMonth)); setUrl(); report(); });
    body.querySelector('[data-print]').onclick = () => window.print();
    body.querySelector('[data-rep-csv]').onclick = () => downloadCSV(`finance-report-${reportMonth}.csv`, [
      ['Finance report', monthLabel(reportMonth)], [], ['Revenue', r.revenue], ['Expenses', r.expenses], ['Salaries', r.salaries], [r.net >= 0 ? 'Profit' : 'Loss', Math.abs(r.net)], ['Invested', r.investments], ['Cash at month end', r.cash_end], [],
      ['Category', 'Total', 'Entries'], ...r.by_category.map((c) => [catName(c.category), c.total, c.count]), [],
      ['Date', 'Expense', 'Category', 'Vendor', 'Amount'], ...r.expense_rows.map((x) => [x.spent_on, x.category === 'salary' && x.payee ? `Salary: ${x.payee}` : x.title, catName(x.category), x.vendor || '', x.amount]), [],
      ['Paid on', 'Client', 'Invoice', 'Amount'], ...r.revenue_rows.map((x) => [x.paid_date, x.client || '', x.invoice, x.amount])]);
  }

  // ---------- shared events ----------
  function bindPay(rows = null) {
    body.querySelectorAll('[data-pay]').forEach((b) => b.onclick = async () => {
      const list = rows || await q(supabase.from('recurring_expenses').select('*').eq('id', Number(b.dataset.pay)));
      const r = list.find((x) => x.id === Number(b.dataset.pay));
      if (r) payForm(r);
    });
  }
  function setUrl() {
    const qs = tab === 'overview' ? '' : `?tab=${tab}${tab === 'report' ? `&month=${reportMonth}` : ''}`;
    try { history.replaceState(null, '', `#/finance${qs}`); } catch { /* ignore */ }
  }
  async function go(next) { tab = next; setUrl(); drawTabs(); body.innerHTML = loadingBlock(5); await safe(); }

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]'); if (t && el.querySelector('#fin-tabs').contains(t)) return go(t.dataset.tab);
    const g = e.target.closest('[data-goto]'); if (g) return go(g.dataset.goto);
    const a = e.target.closest('[data-add]');
    if (a) {
      const k = a.dataset.add;
      if (k === 'expense') expenseForm();
      else if (k === 'investment') investmentForm();
      else billForm({ kind: k === 'salary' ? 'salary' : k === 'other-bill' ? 'other' : 'tools' });
    }
    const m = e.target.closest('[data-exp-month]'); if (m) { expMonth = shiftMonth(expMonth, Number(m.dataset.expMonth)); expenses(); }
  });
  body.addEventListener('click', (e) => { if (tab === 'overview' && e.target.closest('[data-pay]')) { const b = e.target.closest('[data-pay]'); q(supabase.from('recurring_expenses').select('*').eq('id', Number(b.dataset.pay))).then((l) => l[0] && payForm(l[0])).catch((x) => toast(x.message, 'error')); } });

  async function safe() { try { await load(); } catch (e) { body.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; } }
  drawTabs();
  if (!TABS.some(([k]) => k === tab)) tab = 'overview';
  await safe();
  window.addEventListener('ehos:data-changed', safe);
  return () => window.removeEventListener('ehos:data-changed', safe);

  // ---------- Forms ----------
  function membersOptions(sel = '', { managersOnly = false } = {}) {
    return dir.filter((d) => d.status !== 'inactive' && (!managersOnly || d.is_admin || d.roles.includes('manager')))
      .map((d) => `<option value="${d.id}" ${sel === d.id ? 'selected' : ''}>${esc(d.name)}${d.job_title ? ` (${esc(d.job_title)})` : ''}</option>`).join('');
  }

  function expenseForm(x = null) {
    const e0 = x || { title: '', category: 'tools', amount: '', spent_on: todayStr(), vendor: '', notes: '', paid_by: '', payee_member: '' };
    const m = openModal({
      title: x ? 'Edit expense' : 'Add expense', icon: 'wallet', wide: true,
      body: `<form id="xf" class="form-grid" novalidate>
        <div class="field span-2"><label for="xf-title">What was it for?</label><input id="xf-title" class="input" maxlength="200" value="${esc(e0.title)}" placeholder="e.g. Canva Pro, office rent, Fiverr designer"></div>
        <div class="field"><label for="xf-cat">Category</label><select id="xf-cat" class="select">${Object.entries(CATS).filter(([k]) => k !== 'salary' || salaryOk()).map(([k, v]) => `<option value="${k}" ${e0.category === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="xf-date">Paid on</label><input id="xf-date" class="input" type="date" value="${esc(e0.spent_on)}"></div>
        ${moneyFieldsHTML({ id: 'xf', currency: x?.currency, amount: x ? (x.amount_original ?? x.amount) : '', rate: x?.fx_rate })}
        <div class="field"><label for="xf-vendor">Paid to (vendor)</label><input id="xf-vendor" class="input" maxlength="120" value="${esc(e0.vendor || '')}" placeholder="Canva, landlord, Upwork…"></div>
        <div class="field xf-salary ${e0.category === 'salary' ? '' : 'hidden'}"><label for="xf-payee">Salary for</label><select id="xf-payee" class="select"><option value="">Choose a member</option>${membersOptions(e0.payee_member)}</select></div>
        <div class="field"><label for="xf-paidby">Paid by</label><select id="xf-paidby" class="select"><option value="">Business account</option>${membersOptions(e0.paid_by, { managersOnly: true })}</select><span class="hint">Pick a co-founder if they paid from their own pocket.</span></div>
        <div class="field span-2"><label for="xf-notes">Notes</label><textarea id="xf-notes" class="textarea" rows="2">${esc(e0.notes || '')}</textarea></div>
        ${attachFieldHTML('xf')}
        <div class="form-error hidden span-2" id="xf-err"></div></form>`,
      foot: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${x ? 'Save' : 'Add expense'}</button>`,
    });
    const xm = bindMoneyFields(m, { id: 'xf', money });
    const xa = bindAttachments(m, 'xf', x?.attachments);
    const cat = m.querySelector('#xf-cat');
    cat.onchange = () => m.querySelector('.xf-salary').classList.toggle('hidden', cat.value !== 'salary');
    m.querySelector('[data-cancel]').onclick = () => m.close();
    const err = m.querySelector('#xf-err');
    m.querySelector('[data-save]').onclick = (ev) => busy(ev.currentTarget, async () => {
      const v = (s) => m.querySelector(s).value.trim();
      const mv = xm.read();
      const p = { title: v('#xf-title'), category: v('#xf-cat'), currency: mv.currency, amount_original: mv.amount_original, fx_rate: mv.fx_rate, amount: mv.amount, spent_on: v('#xf-date') || todayStr(), vendor: v('#xf-vendor') || null,
        paid_by: v('#xf-paidby') || null, payee_member: v('#xf-cat') === 'salary' ? (v('#xf-payee') || null) : null, notes: v('#xf-notes') };
      const fail = (t) => { err.textContent = t; err.classList.remove('hidden'); };
      if (p.category === 'salary' && !p.title && p.payee_member) p.title = `Salary – ${dirName(dir, p.payee_member)}`;
      if (!p.title) return fail('Write what the expense was for.');
      if (mv.error) return fail(mv.error);
      try {
        const id = x ? x.id : (await q(supabase.from('expenses').insert(p).select('id').single())).id;
        if (x) await q(supabase.from('expenses').update(p).eq('id', x.id));
        await saveAttachments('expense', id, xa);
        toast(x ? 'Expense saved' : 'Expense added'); m.close(); changed();
      } catch (e) { fail(e.message); }
    });
  }

  async function billForm({ bill = null, kind = 'tools' } = {}) {
    const b0 = bill || { title: '', category: kind === 'salary' ? 'salary' : kind === 'other' ? 'rent' : 'tools', amount: '', frequency: 'monthly', next_due: todayStr(), vendor: '', payee_member: '', auto_post: kind === 'tools', remind_days: 3, active: true, notes: '' };
    const isSal = b0.category === 'salary';
    // When was it last paid? (new: today; edit: the latest payment recorded for this bill)
    let lastPaid = null;
    if (bill) lastPaid = (await q(supabase.from('expenses').select('spent_on').eq('recurring_id', bill.id).order('spent_on', { ascending: false }).limit(1)).catch(() => []))[0]?.spent_on || null;
    const startUnpaid = bill ? (bill.frequency === 'once' ? bill.active : !lastPaid) : false;
    const startDate = bill ? (startUnpaid ? bill.next_due : (bill.frequency === 'once' ? bill.next_due : lastPaid)) : todayStr();
    const m = openModal({
      title: bill ? 'Edit' : isSal ? 'Add a salary' : 'Add a bill', icon: 'calendar', wide: true,
      body: `<form id="bf" class="form-grid" novalidate>
        ${isSal ? `<div class="field span-2"><label for="bf-payee">Team member</label><select id="bf-payee" class="select"><option value="">Choose a member</option>${membersOptions(b0.payee_member)}</select></div>`
          : `<div class="field"><label for="bf-title">Name</label><input id="bf-title" class="input" maxlength="200" value="${esc(b0.title)}" placeholder="e.g. Canva Pro, Shopify, ChatGPT, office rent"></div>
             <div class="field"><label for="bf-cat">Category</label><select id="bf-cat" class="select">${Object.entries(CATS).filter(([k]) => k !== 'salary').map(([k, v]) => `<option value="${k}" ${b0.category === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`}
        ${moneyFieldsHTML({ id: 'bf', label: isSal ? 'Salary' : 'Amount', currency: bill?.currency, amount: bill ? (bill.amount_original ?? bill.amount) : '', rate: bill?.fx_rate })}
        <div class="field"><label for="bf-freq">How often</label><select id="bf-freq" class="select">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${b0.frequency === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="bf-date" id="bf-date-label">${startUnpaid ? 'Due on' : 'Paid on'}</label><input id="bf-date" class="input" type="date" value="${esc(startDate || '')}"></div>
        <label class="check span-2"><input type="checkbox" id="bf-unpaid" ${startUnpaid ? 'checked' : ''}> <span>Not paid yet. Pick the date it's due instead.</span></label>
        <div class="renew-box span-2" id="bf-renew" aria-live="polite"></div>
        <div class="field"><label for="bf-remind">Remind me</label><select id="bf-remind" class="select">${[0, 1, 2, 3, 5, 7, 14].map((d) => `<option value="${d}" ${Number(b0.remind_days) === d ? 'selected' : ''}>${d ? `${d} day${d === 1 ? '' : 's'} before` : 'On the day'}</option>`).join('')}</select></div>
        ${isSal ? '<div></div>' : `<div class="field"><label for="bf-vendor">Vendor</label><input id="bf-vendor" class="input" maxlength="120" value="${esc(b0.vendor || '')}" placeholder="Canva, Meta, landlord…"></div>`}
        <label class="check span-2"><input type="checkbox" id="bf-auto" ${b0.auto_post ? 'checked' : ''}> <span><b>Charged automatically</b> (card subscription). It's added as an expense on the renewal date. Leave off to get a reminder and press Mark paid yourself.</span></label>
        ${bill && bill.frequency !== 'once' ? `<label class="check span-2"><input type="checkbox" id="bf-active" ${b0.active ? 'checked' : ''}> <span><b>Active</b>. Turn off to pause reminders and charges.</span></label>` : ''}
        <div class="field span-2"><label for="bf-notes">Notes</label><textarea id="bf-notes" class="textarea" rows="2">${esc(b0.notes || '')}</textarea></div>
        ${attachFieldHTML('bf')}
        <div class="form-error hidden span-2" id="bf-err"></div></form>`,
      foot: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${bill ? 'Save' : 'Add'}</button>`,
    });
    m.querySelector('[data-cancel]').onclick = () => m.close();
    const bm = bindMoneyFields(m, { id: 'bf', money });
    const ba = bindAttachments(m, 'bf', bill?.attachments);
    const err = m.querySelector('#bf-err');
    const freq = m.querySelector('#bf-freq'); const date = m.querySelector('#bf-date'); const unpaid = m.querySelector('#bf-unpaid'); const box = m.querySelector('#bf-renew');
    let touched = !bill;
    // next due date from what's in the form (null = no renewal)
    const plan = () => {
      const d = date.value; const f = freq.value;
      if (!d) return null;
      if (unpaid.checked) return { next: d, paid: null };
      return { next: f === 'once' ? d : addFreq(d, f), paid: d };
    };
    const drawRenew = () => {
      m.querySelector('#bf-date-label').textContent = unpaid.checked ? 'Due on' : 'Paid on';
      const pl = plan();
      if (!pl) { box.innerHTML = `<span class="muted">Pick the ${unpaid.checked ? 'due' : 'paid'} date.</span>`; return; }
      const left = daysBetween(todayStr(), pl.next);
      const leftTxt = left > 0 ? `<b>${left}</b> day${left === 1 ? '' : 's'} left` : left === 0 ? '<b>Today</b>' : `<b class="neg">${-left}</b> day${left === -1 ? '' : 's'} overdue`;
      if (freq.value === 'once') {
        box.innerHTML = unpaid.checked
          ? `${icon('calendar', 15)}<div><span class="lbl">One-time payment, due on</span><b>${esc(fmtDate(pl.next))}</b></div><div class="left ${left < 0 ? 'over' : left <= 3 ? 'soon' : ''}">${leftTxt}</div>`
          : `${icon('check', 15)}<div><span class="lbl">One-time payment, paid on</span><b>${esc(fmtDate(pl.paid))}</b></div><div class="left">No renewal</div>`;
      } else {
        box.innerHTML = `${icon('refresh', 15)}<div><span class="lbl">${unpaid.checked ? 'First payment due on' : `Paid ${esc(fmtDate(pl.paid))} · renews on`}</span><b>${esc(fmtDate(pl.next))}</b></div>
          <div class="left ${left < 0 ? 'over' : left <= 3 ? 'soon' : ''}">${leftTxt}</div>`;
      }
    };
    [freq, date, unpaid].forEach((x) => x.addEventListener('change', () => { touched = true; drawRenew(); }));
    date.addEventListener('input', () => { touched = true; drawRenew(); });
    drawRenew();

    m.querySelector('[data-save]').onclick = (ev) => busy(ev.currentTarget, async () => {
      const v = (s) => m.querySelector(s)?.value.trim() ?? '';
      const fail = (t) => { err.textContent = t; err.classList.remove('hidden'); };
      const payee = isSal ? v('#bf-payee') : null;
      const mv = bm.read();
      const pl = plan();
      const p = { title: isSal ? `Salary – ${dirName(dir, payee)}` : v('#bf-title'), category: isSal ? 'salary' : v('#bf-cat'), currency: mv.currency, amount_original: mv.amount_original, fx_rate: mv.fx_rate, amount: mv.amount,
        frequency: freq.value, remind_days: Number(v('#bf-remind')), vendor: isSal ? null : (v('#bf-vendor') || null),
        payee_member: payee || null, auto_post: m.querySelector('#bf-auto').checked, notes: v('#bf-notes') };
      if (isSal && !payee) return fail('Choose the team member.');
      if (!isSal && !p.title) return fail('Give the bill a name.');
      if (mv.error) return fail(mv.error);
      if (!pl) return fail(unpaid.checked ? 'Pick the date it\'s due.' : 'Pick the date it was paid.');
      if (pl.paid && pl.paid > todayStr()) return fail('The paid date is in the future. Tick "Not paid yet" for a payment that\'s coming up.');
      if (touched) p.next_due = pl.next;
      const closedOnce = freq.value === 'once' && !unpaid.checked;
      if (closedOnce) p.active = false;
      else if (bill && m.querySelector('#bf-active')) p.active = m.querySelector('#bf-active').checked;
      else if (!bill || bill.frequency === 'once') p.active = true;
      try {
        let id = bill?.id;
        if (bill) await q(supabase.from('recurring_expenses').update(p).eq('id', bill.id));
        else id = (await q(supabase.from('recurring_expenses').insert(p).select('id').single())).id;
        await saveAttachments('bill', id, ba);
        // A new bill that's already paid: record that payment as an expense on the paid date
        if (!bill && pl.paid) {
          await q(supabase.from('expenses').insert({ title: p.title, category: p.category, currency: p.currency, amount_original: p.amount_original, fx_rate: p.fx_rate, amount: p.amount,
            spent_on: pl.paid, vendor: p.vendor, payee_member: p.payee_member, recurring_id: id, period: pl.paid, notes: freq.value === 'once' ? 'One-time payment' : `Paid ${pl.paid}, renews ${pl.next}` }));
        }
        toast(bill ? 'Saved' : pl.paid ? (freq.value === 'once' ? 'One-time payment recorded' : `Payment recorded. Renews on ${fmtDate(pl.next)}`) : 'Added. Reminders are on.');
        m.close(); changed();
        rpc('finance_sweep').catch(() => {});
      } catch (e) { fail(e.message); }
    });
  }

  function payForm(r) {
    const name = r.category === 'salary' ? `salary of ${dirName(dir, r.payee_member) || 'member'}` : r.title;
    const cur = (r.currency || baseCurrency()).toUpperCase(); const base = baseCurrency();
    const m = openModal({
      title: `Mark ${name} as paid`, icon: 'check',
      body: `<form class="form-grid" novalidate>
        <div class="field"><label for="pf-amount">Amount paid (${esc(cur)})</label><div class="money-input"><span>${esc(cur)}</span><input id="pf-amount" class="input" type="number" min="0" step="0.01" value="${esc(r.amount_original ?? r.amount)}"></div></div>
        <div class="field"><label for="pf-date">Paid on</label><input id="pf-date" class="input" type="date" value="${esc(todayStr())}"></div>
        ${cur !== base ? `<div class="field span-2"><label for="pf-rate">Exchange rate</label><div class="fx-line"><span>1 <b>${esc(cur)}</b> =</span><input id="pf-rate" class="input" type="number" min="0" step="any" value="${esc(r.fx_rate || '')}" style="max-width:160px"><span>${esc(base)}</span><span class="fx-eq" id="pf-eq"></span></div>
          <span class="hint" id="pf-hint">Last rate used for this bill. Change it to the rate you actually paid.</span></div>` : ''}
        ${attachFieldHTML('pf')}
        <p class="small muted span-2">This records an expense for the payment due ${esc(fmtDate(r.next_due))}, ${r.frequency === 'once' ? 'and the bill is closed (one-time).' : `and it renews on ${esc(fmtDate(addFreq(r.next_due, r.frequency)))}.`}</p></form>`,
      foot: '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Mark paid</button>',
    });
    const amt = m.querySelector('#pf-amount'); const rate = m.querySelector('#pf-rate');
    const pa = bindAttachments(m, 'pf', []);
    const eq = () => { const e = m.querySelector('#pf-eq'); if (e) e.textContent = Number(rate.value) > 0 && amt.value !== '' ? `≈ ${money(Number(amt.value) * Number(rate.value))}` : ''; };
    if (rate) {
      amt.oninput = eq; rate.oninput = eq; eq();
      fetchRate(cur).then((live) => { if (live && m.isConnected) { const h = m.querySelector('#pf-hint'); h.textContent = `Today's rate is about ${Number(live.toPrecision(6))} ${base}. Last time you used ${r.fx_rate}.`; } });
    }
    m.querySelector('[data-cancel]').onclick = () => m.close();
    m.querySelector('[data-save]').onclick = (ev) => busy(ev.currentTarget, async () => {
      const a = Number(amt.value);
      if (amt.value === '' || !(a >= 0)) return toast('Enter the amount', 'error');
      if (rate && !(Number(rate.value) > 0)) return toast('Add the exchange rate', 'error');
      try {
        const expId = await rpc('recurring_mark_paid', { p_id: r.id, p_amount: a, p_paid_on: m.querySelector('#pf-date').value || null, p_fx_rate: rate ? Number(rate.value) : null });
        if (expId && pa.changed) await saveAttachments('expense', expId, pa);
        toast('Payment recorded'); m.close(); changed();
      }
      catch (e) { toast(e.message, 'error'); }
    });
  }

  function investmentForm(x = null) {
    const i0 = x || { source: '', investor_id: '', kind: 'capital', amount: '', invested_on: todayStr(), notes: '' };
    const m = openModal({
      title: x ? 'Edit investment' : 'Add investment', icon: 'trending', wide: true,
      body: `<form class="form-grid" novalidate>
        <div class="field span-2"><label for="if-who">Who invested</label><select id="if-who" class="select"><option value="">Someone outside the team</option>${membersOptions(i0.investor_id, { managersOnly: true })}</select></div>
        <div class="field span-2 ${i0.investor_id ? 'hidden' : ''}" id="if-src-wrap"><label for="if-src">Name</label><input id="if-src" class="input" maxlength="200" value="${esc(i0.investor_id ? '' : i0.source)}" placeholder="Investor or lender name"></div>
        ${moneyFieldsHTML({ id: 'if', currency: x?.currency, amount: x ? (x.amount_original ?? x.amount) : '', rate: x?.fx_rate })}
        <div class="field"><label for="if-date">Date</label><input id="if-date" class="input" type="date" value="${esc(i0.invested_on)}"></div>
        <div class="field"><label for="if-kind">Type</label><select id="if-kind" class="select">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${i0.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field span-2"><label for="if-notes">Notes</label><textarea id="if-notes" class="textarea" rows="2">${esc(i0.notes || '')}</textarea></div>
        <div class="form-error hidden span-2" id="if-err"></div></form>`,
      foot: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${x ? 'Save' : 'Add investment'}</button>`,
    });
    const im = bindMoneyFields(m, { id: 'if', money });
    const who = m.querySelector('#if-who');
    who.onchange = () => m.querySelector('#if-src-wrap').classList.toggle('hidden', Boolean(who.value));
    m.querySelector('[data-cancel]').onclick = () => m.close();
    const err = m.querySelector('#if-err');
    m.querySelector('[data-save]').onclick = (ev) => busy(ev.currentTarget, async () => {
      const v = (s) => m.querySelector(s).value.trim();
      const fail = (t) => { err.textContent = t; err.classList.remove('hidden'); };
      const mv = im.read();
      const p = { investor_id: v('#if-who') || null, source: v('#if-who') ? dirName(dir, v('#if-who')) : v('#if-src'), currency: mv.currency, amount_original: mv.amount_original, fx_rate: mv.fx_rate, amount: mv.amount,
        invested_on: v('#if-date') || todayStr(), kind: v('#if-kind'), notes: v('#if-notes') };
      if (!p.source) return fail('Who invested?');
      if (mv.error) return fail(mv.error);
      try {
        if (x) await q(supabase.from('investments').update(p).eq('id', x.id)); else await q(supabase.from('investments').insert(p));
        toast(x ? 'Saved' : 'Investment added'); m.close(); changed();
      } catch (e) { fail(e.message); }
    });
  }
}

// Revenue (green) vs expenses (red) per month
function twinBars(rows) {
  const max = Math.max(1, ...rows.map((r) => Math.max(Number(r.revenue), Number(r.expenses))));
  return `<div class="tbars">${rows.map((r, i) => `<div class="col ${i === rows.length - 1 ? 'now' : ''}" title="${esc(monthLabel(r.month))}: revenue ${esc(money(r.revenue))}, expenses ${esc(money(r.expenses))}">
      <div class="pair"><div class="bar in" style="height:${(r.revenue / max) * 100}%"></div><div class="bar out" style="height:${(r.expenses / max) * 100}%"></div></div></div>`).join('')}</div>
    <div class="mlabels">${rows.map((r) => `<span>${shortMonth(r.month)}</span>`).join('')}</div>`;
}
