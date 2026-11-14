// Billing: what this workspace pays for Webnox OS, what it owes, and what it has paid.
// Admin only. This is the one page that still opens while a workspace is on hold.
import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q } from '../data.js';
import { esc, icon, loadingBlock, emptyState, openModal, downloadCSV } from '../ui.js';
import { fmtDate, todayStr, daysBetween } from '../time.js';
import { rentInvoiceDocHTML, printRentInvoice, ensureInvoiceCss, RENT_STATUS } from '/js/rent-invoice.js';

const CYCLE = {
  trial_7: '7-day trial', trial_14: '14-day trial',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly',
};
const METHOD = { bank_transfer: 'Bank transfer', other: 'Other' };
const money = (cur, n) =>
  (cur || 'PKR').toUpperCase() + ' ' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

export async function render({ el }) {
  ensureInvoiceCss();
  el.innerHTML = `
    <div class="page-head"><div><h1>Billing</h1>
      <p>Your Webnox OS subscription — the plan, the invoices and the payments we have recorded.</p></div></div>
    <div id="bill">${loadingBlock(4)}</div>`;
  const box = el.querySelector('#bill');

  let sub, invoices, payments;
  try {
    [sub, invoices, payments] = await Promise.all([
      q(supabase.from('subscriptions').select('*').eq('workspace_id', state.workspace.id).maybeSingle()),
      q(supabase.from('rent_invoices').select('*').eq('workspace_id', state.workspace.id).order('issue_date', { ascending: false })),
      q(supabase.from('subscription_payments').select('*').eq('workspace_id', state.workspace.id).order('paid_on', { ascending: false }).limit(50)),
    ]);
  } catch {
    box.innerHTML = '<p class="note warn" role="alert">Billing could not load. Refresh the page to try again.</p>';
    return;
  }

  if (!sub) {
    box.innerHTML = `<section class="panel">${emptyState('No plan on file',
      'This workspace is not on a rent plan. If that looks wrong, get in touch with Webnox OS.')}</section>`;
    return;
  }

  const today = todayStr();
  const open = invoices.filter((i) => i.status === 'sent');
  const owedByCurrency = new Map();
  for (const invoice of open) {
    owedByCurrency.set(invoice.currency,
      (owedByCurrency.get(invoice.currency) || 0) + Number(invoice.amount_original || 0));
  }
  const owed = [...owedByCurrency].map(([currency, amount]) => money(currency, amount)).join(' · ');
  const st = planState(sub, state.workspace, today);
  const held = state.workspace.status === 'suspended';
  const nextLabel = sub.next_due ? 'Next payment due' : 'Trial ends';
  const nextValue = fmtDate(sub.next_due || sub.trial_ends_on) || '—';

  box.innerHTML = `
    ${held ? `<div class="explain warn">${icon('alert', 14)}
      <span><b>This workspace is on hold.</b> Your team cannot sign in until the rent is received.
      Nothing has been deleted — everything comes back the moment a payment is recorded.</span></div>` : ''}

    <div class="stats" style="margin-bottom:20px">
      <div class="stat"><div class="v">${esc(money(sub.currency, sub.amount_original))}</div>
        <div class="k">${esc(CYCLE[sub.cycle] || sub.cycle)}${sub.plan_name ? ' · ' + esc(sub.plan_name) : ''}</div></div>
      <div class="stat"><div class="v">${esc(nextValue)}</div><div class="k">${esc(nextLabel)}</div></div>
      <div class="stat"><div class="v${owed ? ' warn' : ''}">${owed ? esc(owed) : '—'}</div>
        <div class="k">Outstanding${open.length ? ` · ${open.length} invoice${open.length === 1 ? '' : 's'}` : ''}</div></div>
      <div class="stat"><div class="v"><span class="badge ${st.tone}">${esc(st.label)}</span></div><div class="k">Status</div></div>
    </div>

    <section class="panel">
      <div class="panel-head"><div><h2>Your plan</h2><p>Managed by Webnox OS.</p></div></div>
      <div class="panel-body">
        <table class="table plain">
          <tbody>
            ${row('Plan', esc(CYCLE[sub.cycle] || sub.cycle) + (sub.plan_name ? ` · ${esc(sub.plan_name)}` : ''))}
            ${row('Rent', esc(money(sub.currency, sub.amount_original)))}
            ${row('Started', esc(fmtDate(sub.start_date)))}
            ${row(nextLabel, esc(nextValue))}
            ${row('Grace period', `${esc(sub.grace_days)} days after the due date`)}
            ${row('Member limit', sub.member_limit ? esc(sub.member_limit) + ' people' : 'No limit')}
          </tbody>
        </table>
        <p class="muted small" style="margin-top:14px">To change your plan, reply to any billing notice or write to
          <a href="mailto:webnoxhub@gmail.com">webnoxhub@gmail.com</a>.</p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Invoices</h2>
        ${invoices.length ? '<button class="btn btn-ghost btn-sm" id="invCsv" type="button">Download CSV</button>' : ''}</div>
      <div class="table-wrap" id="invBox"></div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Payments received</h2></div>
      <div class="table-wrap" id="payBox"></div>
    </section>`;

  // ── Invoices ──────────────────────────────────────────────────────────────
  const invBox = box.querySelector('#invBox');
  invBox.innerHTML = invoices.length ? `
    <table class="table">
      <thead><tr><th>Invoice</th><th>Issued</th><th>Period</th><th>Due</th><th class="r">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${invoices.map((i) => {
        const late = i.status === 'sent' && i.due_date < today;
        return `<tr>
          <td><b>${esc(i.invoice_no)}</b></td>
          <td>${esc(fmtDate(i.issue_date))}</td>
          <td>${esc(fmtDate(i.period_from))} – ${esc(fmtDate(i.period_to))}</td>
          <td>${esc(fmtDate(i.due_date))}</td>
          <td class="r">${esc(money(i.currency, i.amount_original))}</td>
          <td><span class="badge ${late ? 'overdue' : i.status === 'paid' ? 'paid' : i.status === 'void' ? 'cancelled' : 'sent'}">${
            late ? `Overdue ${daysBetween(i.due_date, today)}d` : esc(RENT_STATUS[i.status])}</span></td>
          <td><button class="btn btn-ghost btn-sm" type="button" data-inv="${esc(i.id)}">View</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : emptyState('No invoices yet', 'Invoices from Webnox OS will appear here.');

  invBox.querySelectorAll('[data-inv]').forEach((b) => b.addEventListener('click', () => {
    const i = invoices.find((x) => x.id === b.dataset.inv);
    if (i) viewInvoice(i);
  }));

  const csv = box.querySelector('#invCsv');
  if (csv) csv.addEventListener('click', () => downloadCSV('webnox-invoices.csv', [
    ['Invoice', 'Issued', 'Period from', 'Period to', 'Due', 'Currency', 'Amount', 'Amount (PKR)', 'Status', 'Paid on'],
    ...invoices.map((i) => [i.invoice_no, i.issue_date, i.period_from, i.period_to, i.due_date,
      i.currency, i.amount_original, i.amount, RENT_STATUS[i.status], i.paid_on || '']),
  ]));

  // ── Payments ──────────────────────────────────────────────────────────────
  box.querySelector('#payBox').innerHTML = payments.length ? `
    <table class="table">
      <thead><tr><th>Paid on</th><th>Period covered</th><th class="r">Amount</th><th>Method</th><th>Reference</th></tr></thead>
      <tbody>${payments.map((p) => `<tr>
        <td><b>${esc(fmtDate(p.paid_on))}</b></td>
        <td>${p.period_from ? `${esc(fmtDate(p.period_from))} – ${esc(fmtDate(p.period_to))}` : '—'}</td>
        <td class="r">${esc(money(p.currency, p.amount_original))}</td>
        <td>${esc(METHOD[p.method] || p.method)}</td>
        <td>${esc(p.reference || '—')}</td>
      </tr>`).join('')}</tbody>
    </table>` : emptyState('No payments yet', 'Payments recorded by Webnox OS will appear here.');
}

function viewInvoice(inv) {
  const ws = { name: state.workspace.name, slug: state.workspace.slug, short_code: state.workspace.short_code };
  const m = openModal({
    title: esc(inv.invoice_no),
    wide: true,
    body: `<div class="inv-preview">${rentInvoiceDocHTML(inv, { workspace: ws })}</div>`,
    foot: '<button class="btn" data-close type="button">Close</button>'
        + '<button class="btn btn-primary" id="invPrint" type="button">Print / Save PDF</button>',
  });
  m.querySelector('#invPrint').addEventListener('click', () => printRentInvoice(inv, { workspace: ws }));
}

// What the status reads, in the tenant's own words rather than a database value.
function planState(sub, ws, today) {
  if (ws.status === 'suspended') return { label: 'On hold', tone: 'overdue' };
  if (!sub.next_due && sub.trial_ends_on) {
    const d = daysBetween(today, sub.trial_ends_on);
    return { label: d <= 0 ? 'Trial ended' : `Trial · ${d} day${d === 1 ? '' : 's'} left`, tone: d <= 3 ? 'sent' : 'paid' };
  }
  if (!sub.next_due) return { label: 'Active', tone: 'paid' };
  const d = daysBetween(today, sub.next_due);
  if (d < 0) return { label: `Overdue by ${-d} day${d === -1 ? '' : 's'}`, tone: 'overdue' };
  if (d === 0) return { label: 'Due today', tone: 'sent' };
  if (d <= 3) return { label: `Due in ${d} day${d === 1 ? '' : 's'}`, tone: 'sent' };
  return { label: 'Active', tone: 'paid' };
}

const row = (k, v) => `<tr><td class="muted" style="width:190px">${esc(k)}</td><td>${v}</td></tr>`;
