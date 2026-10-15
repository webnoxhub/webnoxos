// Revenue + pipeline block (admin, manager, finance)
import { rpc } from './data.js';
import { money } from './state.js';
import { esc, icon } from './ui.js';
import { statsStrip, moneyBars } from './components.js';

export const loadBusiness = () => rpc('business_summary');

export function businessPanel(b, { compact = false } = {}) {
  const diff = Number(b.revenue_last_month) ? Math.round(((b.revenue_month - b.revenue_last_month) / b.revenue_last_month) * 100) : null;
  return `
    ${statsStrip([[
      { v: money(b.revenue_month), k: 'Revenue this month', dot: 'timer' },
      { v: money(b.revenue_last_month), k: diff === null ? 'Last month' : `Last month (this month ${diff >= 0 ? '+' : ''}${diff}%)` },
      { v: money(b.revenue_total), k: 'Total revenue' },
      { v: money(b.outstanding), k: 'Unpaid invoices' },
      { v: b.overdue_count, k: b.overdue_count ? `Overdue (${money(b.overdue_amount)})` : 'Overdue', cls: b.overdue_count ? 'warn' : '' },
    ], [
      { v: b.active_clients, k: 'Active clients' },
      { v: money(b.mrr), k: 'Monthly retainers' },
      { v: b.leads_open, k: 'Open leads' },
      { v: b.leads_month, k: 'Leads this month' },
      { v: b.won_month, k: 'Won this month' },
    ]])}
    ${compact ? '' : `<section class="panel" style="margin-top:14px">
      <div class="panel-head"><div><h2>Revenue</h2><p>Paid invoices per month, last 12 months</p></div><a class="btn btn-sm btn-ghost" href="#/finance">${icon('wallet', 14)}Finance</a></div>
      <div class="panel-body">${moneyBars(b.months, money)}</div>
    </section>`}`;
}
export const businessError = (e) => `<div class="note warn">${esc(e.message)}</div>`;
