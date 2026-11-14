// The rent invoice: Webnox OS to a workspace. The same paper as a workspace's own
// invoices, with the issuer and the billed party the other way round — so it belongs to
// neither world and imports nothing from either.
import { INVOICE_CSS } from '/js/invoice-css.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const RENT_STATUS = { sent: 'Unpaid', paid: 'Paid', void: 'Cancelled' };

// Who the invoice is from. Edit these once and every rent invoice follows.
export const ISSUER = {
  name: 'Webnox OS',
  address: 'Webnox Hub · webnoxhub.com',
  email: 'webnoxhub@gmail.com',
  website: 'www.webnoxhub.com',
  terms: 'Payment is due by the date shown. A workspace stays open through the grace period; '
       + 'after that it is held until the rent is received. No data is ever deleted.',
};

const money = (cur, n) =>
  (cur || 'PKR').toUpperCase() + ' ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const longDate = (d) => {
  if (!d) return '—';
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(+x) ? String(d)
    : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

const MARK = '<svg viewBox="0 0 64 40" width="46" height="34" aria-hidden="true">'
  + '<defs><linearGradient id="rwg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22D3EE"/>'
  + '<stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs>'
  + '<path d="M8 4l2.2 5.8L16 12l-5.8 2.2L8 20l-2.2-5.8L0 12l5.8-2.2z" fill="#22D3EE"/>'
  + '<path d="M26 6h9l-9 28h-9zM42 6h9l-9 28h-9z" fill="url(#rwg)"/></svg>';

// `inv` is a rent_invoices row; `workspace` is the business being billed.
export function rentInvoiceDocHTML(inv, { workspace = null } = {}) {
  const cur = (inv.currency || 'PKR').toUpperCase();
  const f = (v) => esc(money(cur, v));
  const total = Number(inv.amount_original) || 0;
  const stamp = { paid: 'PAID', void: 'CANCELLED' }[inv.status];
  const period = longDate(inv.period_from) + ' – ' + longDate(inv.period_to);
  const ws = workspace || {};
  const inPkr = cur !== 'PKR' && Number(inv.amount) > 0;

  return `
  <article class="inv-doc">
    ${stamp ? `<div class="inv-stamp ${inv.status === 'void' ? 'cancelled' : 'paid'}">${stamp}</div>` : ''}
    <header class="inv-top">
      <div class="inv-brand">${MARK}
        <div><h1>${esc(ISSUER.name)}</h1><p>${esc(ISSUER.address)}</p></div></div>
      <div class="inv-title"><div class="inv-kicker">RENT INVOICE</div>
        <h2><span>Invoice</span> ${esc(inv.invoice_no || '—')}</h2></div>
    </header>
    <table class="inv-meta">
      <tr><td class="k">Invoice date</td><td class="v">${esc(longDate(inv.issue_date))}</td>
          <td class="k">Due date</td><td class="v">${esc(longDate(inv.due_date))}</td></tr>
      <tr><td class="k">Billing period</td><td class="v">${esc(period)}</td>
          <td class="k">Currency</td><td class="v">${esc(cur)}</td></tr>
      <tr><td class="k">Workspace</td><td class="v">${esc(ws.short_code || ws.slug || '—')}</td>
          <td class="k">${inv.status === 'paid' && inv.paid_on ? 'Paid on' : 'Status'}</td>
          <td class="v">${inv.status === 'paid' && inv.paid_on ? esc(longDate(inv.paid_on)) : esc(RENT_STATUS[inv.status] || '—')}</td></tr>
    </table>
    <section class="inv-parties">
      <div class="inv-party"><div class="inv-label">Billed to</div><b>${esc(ws.name || '—')}</b>
        ${ws.short_code ? `<span class="inv-buid">${esc(ws.short_code)}</span>` : ''}</div>
      <div class="inv-party"><div class="inv-label">For</div><b>Workspace subscription</b></div>
    </section>
    <table class="inv-items">
      <thead><tr><th class="n">#</th><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
      <tbody><tr><td class="n">1</td>
        <td>Webnox OS workspace rent — ${esc(ws.name || 'workspace')}<br><span style="color:#64748B">${esc(period)}</span></td>
        <td class="r">1</td><td class="r">${f(total)}</td><td class="r">${f(total)}</td></tr></tbody>
    </table>
    <div class="inv-sum"><table>
      <tr><td>Subtotal</td><td>${f(total)}</td></tr>
      ${inPkr ? `<tr><td>In PKR (rate ${esc(inv.fx_rate)})</td><td>${esc(money('PKR', inv.amount))}</td></tr>` : ''}
      <tr class="total"><td>Total due</td><td>${f(total)}</td></tr>
    </table></div>
    <div class="inv-terms"><b>Terms:</b> ${esc(ISSUER.terms)}</div>
    ${inv.notes ? `<div class="inv-notes">${esc(inv.notes)}</div>` : ''}
    <div class="inv-small">Thank you for building with ${esc(ISSUER.name)}.</div>
    <footer class="inv-foot"><div class="links"><span>${esc(ISSUER.email)}</span><span>${esc(ISSUER.website)}</span></div>
      <div class="conf">Confidential — issued by ${esc(ISSUER.name)}</div></footer>
  </article>`;
}

// Print through a hidden frame, the same way a workspace prints its own invoices.
// "Save as PDF" is the browser's own option in that dialog.
export function printRentInvoice(inv, ctx = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.invoice_no || 'Invoice')}</title>
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${INVOICE_CSS}</style>
    </head><body>${rentInvoiceDocHTML(inv, ctx)}</body></html>`);
  doc.close();
  const go = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { setTimeout(() => frame.remove(), 1500); } };
  (doc.fonts?.ready || Promise.resolve()).then(() => setTimeout(go, 150));
}

// The same stylesheet inside the app, for the on-screen preview.
export function ensureInvoiceCss() {
  if (typeof document === 'undefined' || document.getElementById('inv-doc-css')) return;
  const st = document.createElement('style');
  st.id = 'inv-doc-css';
  st.textContent = INVOICE_CSS;
  document.head.append(st);
}
