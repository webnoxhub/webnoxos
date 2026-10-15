// Invoices: editor (choose client → details → line items), the printable invoice, and the invoice viewer.
// Numbers, reference, date and "Issued by" are made by the database (schema part 10).
// The look of the printed invoice lives in invoiceDocHTML() + INVOICE_CSS — swap these to change the template.
import { supabase } from './supabase.js';
import { state, can, canAny, money, roleName } from './state.js';
import { q, rpc } from './data.js';
import { esc, icon, openModal, confirmDialog, toast, busy } from './ui.js';
import { fmtDate, todayStr, addDays, daysBetween } from './time.js';
import { currencies, currencyName, fmtCur, baseCurrency, fetchRate } from './currency.js';

export const INVOICE_STATUS = { draft: 'Draft', sent: 'Unpaid', paid: 'Paid', cancelled: 'Cancelled' };
export const invoiceState = (inv) => (inv.status === 'sent' && inv.due_date && inv.due_date < todayStr() ? 'overdue' : inv.status);
export const invoiceBadge = (inv) => { const s = invoiceState(inv); return `<span class="badge ${s}">${s === 'overdue' ? `Overdue ${daysBetween(inv.due_date, todayStr())}d` : INVOICE_STATUS[s]}</span>`; };
const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
// Amount in the invoice's own currency, plus the app-currency value when different
export const invAmount = (i) => {
  const cur = (i.currency || baseCurrency()).toUpperCase();
  const orig = i.amount_original ?? i.amount;
  return cur === baseCurrency() ? money(i.amount) : `${esc(fmtCur(orig, cur))} <span class="muted small">≈ ${money(i.amount)}</span>`;
};
export const partyName = (i, client) => client?.name || i.client?.name || i.bill_to?.company || i.bill_to?.name || '—';
const myTitle = () => state.profile?.job_title || (state.profile?.account_type === 'admin' ? 'Admin' : state.profile?.account_type === 'manager' ? 'Manager' : state.myRoles.map(roleName).join(', '));
const myName = () => state.profile?.name || state.profile?.email || '';

// ---------- Totals (same rule as the database: discount first, then tax) ----------
export function invoiceTotals(inv) {
  const items = Array.isArray(inv.items) ? inv.items : [];
  if (!items.length) { const t = n2(inv.amount_original ?? inv.amount); return { sub: t, discount: 0, tax: 0, total: t, lines: [{ description: inv.description || 'Services', qty: 1, rate: t }] }; }
  const lines = items.map((x) => ({ description: x.description, qty: x.qty === '' || x.qty == null ? 1 : Number(x.qty), rate: Number(x.rate) || 0 }));
  const sub = n2(lines.reduce((a, x) => a + n2(x.qty * x.rate), 0));
  const discount = n2(inv.discount); const taxable = sub - discount;
  const tax = n2(taxable * (Number(inv.tax_percent) || 0) / 100);
  return { sub, discount, tax, total: n2(taxable + tax), lines };
}

// ---------- The printed invoice (printed template) ----------
// Company + payment details come from Settings → Invoice details. Empty fields fall back to these.
export const INVOICE_DEFAULTS = { email: '', website: '', phone: '', due_days: 7, pause_days: 14, footer_note: '' };
export const invoiceSettings = () => {
  const d = state.settings?.invoice_details || {};
  const pick = (k) => (d[k] === undefined || d[k] === null || d[k] === '' ? INVOICE_DEFAULTS[k] : d[k]);
  return { ...d, email: pick('email'), website: pick('website'), phone: pick('phone'), due_days: Number(pick('due_days')) || 7, pause_days: Number(pick('pause_days')) || 14, footer_note: d.footer_note ?? INVOICE_DEFAULTS.footer_note };
};
export const termsText = (d = invoiceSettings()) =>
  `Payment is due within ${d.due_days} days. Please use the invoice number as the payment reference. Transfer fees are paid by the sender. Services may pause on invoices more than ${d.pause_days} days overdue, as per our agreement.`;
// "1–31 October 2026" for the month of a date (YYYY-MM-DD)
export function monthPeriod(dateStr) {
  const [y, m] = String(dateStr || todayStr()).split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `1–${last} ${name} ${y}`;
}
const longDate = (d) => { if (!d) return '—'; const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' }); };

export const INVOICE_CSS = `
.inv-doc { --ink:#0F172A; --muted:#64748B; --line:#E2E8F0; --accent:#4F46E5; --soft:#EEF2FF; --canvas:#F8FAFC;
  font-family: 'Geist','Inter',system-ui,-apple-system,'Segoe UI',sans-serif; color: var(--ink); background:#fff;
  max-width: 820px; margin: 0 auto; padding: 40px 44px 28px; font-size: 12.5px; line-height: 1.5; position: relative; }
.inv-doc * { box-sizing: border-box; }
.inv-doc table { border-collapse: collapse; width: 100%; }
.inv-top { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; padding-bottom:20px; border-bottom:3px solid var(--accent); }
.inv-brand { display:flex; gap:12px; align-items:center; }
.inv-mark { width:46px; height:46px; border-radius:11px; background:var(--accent); color:#fff; display:grid; place-items:center; font-weight:700; font-size:17px; flex:none; }
.inv-logo { height:46px; max-width:220px; object-fit:contain; object-position:left center; display:block; flex:none; }
.inv-brand h1 { margin:0; font-size:20px; letter-spacing:-.01em; }
.inv-brand p { margin:1px 0 0; color:var(--muted); font-size:11.5px; white-space:pre-line; }
.inv-title { text-align:right; }
.inv-kicker { font-size:11px; font-weight:700; letter-spacing:.16em; color:var(--accent); }
.inv-title h2 { margin:2px 0 0; font-size:22px; font-weight:700; letter-spacing:-.01em; white-space:nowrap; }
.inv-title h2 span { color:var(--muted); font-weight:500; }
.inv-meta { margin-top:20px; border:1px solid var(--line); border-radius:10px; overflow:hidden; border-collapse:separate !important; border-spacing:0; }
.inv-meta td { padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; width:25%; }
.inv-meta tr:last-child td { border-bottom:0; }
.inv-meta td.k { background:var(--canvas); color:var(--muted); font-weight:600; font-size:11.5px; }
.inv-meta td.v { font-weight:600; }
.inv-label { font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); font-weight:700; margin-bottom:6px; }
.inv-parties { display:grid; grid-template-columns:1.3fr 1fr; gap:24px; margin:22px 0 18px; }
.inv-party b { font-size:15px; display:block; } .inv-party div { color:#334155; white-space:pre-line; }
.inv-buid { display:inline-block; margin-top:6px; font-size:10.5px; font-weight:600; color:var(--accent); background:var(--soft); padding:2px 8px; border-radius:999px; }
.inv-items th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:#fff; font-weight:600; padding:9px 10px; background:var(--accent); }
.inv-items th:first-child { border-radius:8px 0 0 0; } .inv-items th:last-child { border-radius:0 8px 0 0; }
.inv-items td { padding:10px; border-bottom:1px solid var(--line); vertical-align:top; }
.inv-items tbody tr:nth-child(even) td { background:#FCFCFE; }
.inv-items .r { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; } .inv-items .n { color:var(--muted); width:30px; }
.inv-sum { display:flex; justify-content:flex-end; margin-top:12px; }
.inv-sum table { width:300px; }
.inv-sum td { padding:6px 10px; font-variant-numeric:tabular-nums; } .inv-sum td:last-child { text-align:right; white-space:nowrap; font-weight:600; }
.inv-sum .total td { background:var(--accent); color:#fff; font-size:15px; font-weight:700; padding:10px; }
.inv-sum .total td:first-child { border-radius:8px 0 0 8px; } .inv-sum .total td:last-child { border-radius:0 8px 8px 0; }
.inv-pay { margin-top:24px; }
.inv-pay table { border:1px solid var(--line); border-radius:10px; overflow:hidden; border-collapse:separate; border-spacing:0; }
.inv-pay td { padding:8px 12px; border-bottom:1px solid var(--line); width:25%; word-break:break-word; }
.inv-pay tr:last-child td { border-bottom:0; }
.inv-pay td.k { background:var(--canvas); color:var(--muted); font-weight:600; font-size:11.5px; }
.inv-pay td.v { font-weight:500; }
.inv-pay .other { margin-top:8px; color:#334155; white-space:pre-line; }
.inv-terms { margin-top:16px; background:var(--soft); border-left:3px solid var(--accent); border-radius:6px; padding:11px 14px; color:#1E293B; }
.inv-terms b { color:var(--accent); }
.inv-notes { margin-top:14px; white-space:pre-line; color:#334155; }
.inv-small { margin-top:12px; color:var(--muted); font-size:11.5px; }
.inv-sign { display:flex; justify-content:space-between; align-items:flex-end; gap:24px; margin-top:30px; }
.inv-who { min-width:220px; border-top:1.5px solid var(--ink); padding-top:8px; }
.inv-who b { display:block; font-size:14px; } .inv-who span { color:var(--muted); font-size:11.5px; display:block; }
.inv-foot { margin-top:26px; border-top:1px solid var(--line); padding-top:12px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:11.5px; }
.inv-foot .links { display:flex; gap:18px; flex-wrap:wrap; font-weight:600; }
.inv-foot .conf { color:var(--muted); }
.inv-stamp { position:absolute; top:170px; right:44px; transform:rotate(-12deg); border:3px solid; border-radius:8px; padding:4px 14px; font-weight:700; font-size:20px; letter-spacing:.12em; opacity:.8; background:#fff; }
.inv-stamp.paid { color:#16A34A; } .inv-stamp.cancelled { color:#DC2626; } .inv-stamp.draft { color:#94A3B8; }
@media (max-width: 600px) {
  .inv-doc { padding:22px 16px; font-size:12px; }
  .inv-top { flex-direction:column; } .inv-title { text-align:left; } .inv-title h2 { white-space:normal; font-size:19px; }
  .inv-parties { grid-template-columns:1fr; gap:14px; }
  .inv-meta tr, .inv-pay tr { display:grid; grid-template-columns:40% 60%; } .inv-meta td, .inv-pay td { width:auto; }
  .inv-stamp { top:auto; bottom:200px; }
  .inv-items th, .inv-items td { padding:8px 5px; } .inv-items .n { display:none; }
  .inv-sum table { width:100%; } .inv-sign { flex-direction:column; align-items:stretch; }
}
@media print { .inv-doc { padding: 0; max-width: none; font-size: 11.5px; } .inv-top { padding-bottom:14px; } .inv-meta { margin-top:14px; } .inv-meta td, .inv-pay td { padding:6px 10px; } .inv-parties { margin:14px 0 12px; } .inv-items td { padding:7px 10px; } .inv-sum td { padding:4px 10px; } .inv-pay { margin-top:16px; } .inv-terms { margin-top:12px; padding:9px 12px; } .inv-sign { margin-top:18px; } .inv-foot { margin-top:16px; } @page { size: A4; margin: 12mm; } .inv-items tr, .inv-pay, .inv-terms, .inv-sign { break-inside: avoid; } }
`;

// The same template styles inside the app (preview)
if (typeof document !== 'undefined' && !document.getElementById('inv-doc-css')) {
  const st = document.createElement('style'); st.id = 'inv-doc-css'; st.textContent = INVOICE_CSS; document.head.append(st);
}

// Logo is stored in Settings as a small image data URL (png / jpg / webp / svg)
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
export const LOGO_MAX_BYTES = 300 * 1024;
export const safeLogo = (v) => typeof v === 'string' && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length < LOGO_MAX_BYTES * 1.4;

function companyInitials(name) {
  const w = String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!w.length) return 'CO';
  return w.length > 1 ? w[0][0] + w[1][0] : w[0][0] + w[0].slice(-1);
}

export function invoiceDocHTML(inv, { client = null, project = null } = {}) {
  const s = state.settings || {}; const d = invoiceSettings();
  const cur = (inv.currency || baseCurrency()).toUpperCase();
  const f = (v) => esc(fmtCur(v, cur));
  const t = invoiceTotals(inv);
  const company = s.company_name || state.workspace?.name || 'Company';
  const logo = safeLogo(d.logo) ? d.logo : safeLogo(state.workspace?.logo_url) ? state.workspace.logo_url : '';
  const logoHasName = safeLogo(d.logo) ? d.logo_has_name : !!state.workspace?.logo_only;
  const bt = inv.bill_to || {};
  const party = client
    ? { name: client.name, lines: [client.contact_name, [client.address, client.country].filter(Boolean).join(', '), client.email, client.phone].filter(Boolean).join('\n'), buid: client.buid }
    : { name: bt.company || bt.name || '—', lines: [bt.company ? bt.name : '', bt.address, bt.email, bt.phone].filter(Boolean).join('\n'), buid: '' };
  const stamp = { paid: 'PAID', cancelled: 'CANCELLED', draft: 'DRAFT' }[inv.status];
  const tax = Number(inv.tax_percent) || 0;
  const payRows = [
    ['Account title', d.account_title, 'Bank', d.bank],
    ['IBAN', d.iban, 'SWIFT', d.swift],
    ['Wise / Payoneer', d.wallet, 'Reference', inv.invoice_number],
  ].filter((r, k) => k === 2 ? r[1] || d.account_title || d.iban : r[1] || r[3]);
  const hasPay = payRows.length || d.payment;
  return `
  <article class="inv-doc">
    ${stamp ? `<div class="inv-stamp ${inv.status}">${stamp}</div>` : ''}
    <header class="inv-top">
      <div class="inv-brand">${logo ? `<img class="inv-logo" src="${esc(logo)}" alt="${esc(company)} logo">` : `<div class="inv-mark">${esc(companyInitials(company))}</div>`}
        <div>${logoHasName && logo ? '' : `<h1>${esc(company)}</h1>`}${d.address ? `<p>${esc(d.address)}</p>` : ''}</div></div>
      <div class="inv-title"><div class="inv-kicker">${tax ? 'TAX INVOICE' : 'INVOICE'}</div>
        <h2><span>Invoice</span> ${esc(inv.invoice_number || '—')}</h2></div>
    </header>
    <table class="inv-meta">
      <tr><td class="k">Invoice date</td><td class="v">${esc(longDate(inv.issue_date))}</td><td class="k">Due date</td><td class="v">${esc(longDate(inv.due_date))}</td></tr>
      <tr><td class="k">Billing period</td><td class="v">${esc(inv.billing_period || '—')}</td><td class="k">Currency</td><td class="v">${esc(cur)}</td></tr>
      <tr><td class="k">Reference no.</td><td class="v">${esc(inv.reference_no || '—')}</td><td class="k">${inv.status === 'paid' && inv.paid_date ? 'Paid on' : 'Status'}</td><td class="v">${inv.status === 'paid' && inv.paid_date ? esc(longDate(inv.paid_date)) : esc(INVOICE_STATUS[inv.status] || '—')}</td></tr>
    </table>
    <section class="inv-parties">
      <div class="inv-party"><div class="inv-label">Billed to</div><b>${esc(party.name)}</b>${party.lines ? `<div>${esc(party.lines)}</div>` : ''}${party.buid ? `<span class="inv-buid">${esc(party.buid)}</span>` : ''}</div>
      <div class="inv-party">${project ? `<div class="inv-label">Project</div><b>${esc(project.name)}</b>` : ''}</div>
    </section>
    <table class="inv-items">
      <thead><tr><th class="n">#</th><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
      <tbody>${t.lines.map((x, k) => `<tr><td class="n">${k + 1}</td><td>${esc(x.description)}</td><td class="r">${esc(x.qty)}</td><td class="r">${f(x.rate)}</td><td class="r">${f(n2(x.qty * x.rate))}</td></tr>`).join('')}</tbody>
    </table>
    <div class="inv-sum"><table>
      <tr><td>Subtotal</td><td>${f(t.sub)}</td></tr>
      <tr><td>Discount</td><td>${t.discount ? '− ' : ''}${f(t.discount)}</td></tr>
      <tr><td>Tax (${esc(tax)}%)</td><td>${f(t.tax)}</td></tr>
      <tr class="total"><td>Total due</td><td>${f(t.total)}</td></tr>
    </table></div>
    ${hasPay ? `<section class="inv-pay"><div class="inv-label">Payment details</div>
      ${payRows.length ? `<table>${payRows.map((r) => `<tr><td class="k">${esc(r[0])}</td><td class="v">${esc(r[1] || '—')}</td><td class="k">${esc(r[2])}</td><td class="v">${esc(r[3] || '—')}</td></tr>`).join('')}</table>` : ''}
      ${d.payment ? `<div class="other">${esc(d.payment)}</div>` : ''}</section>` : ''}
    <div class="inv-terms"><b>Terms:</b> ${esc(termsText(d))}</div>
    ${inv.notes ? `<div class="inv-notes">${esc(inv.notes)}</div>` : ''}
    <div class="inv-small">${d.footer_note ? `${esc(d.footer_note)} ` : ''}Thank you for your business.</div>
    <div class="inv-sign"><div></div>
      <div class="inv-who"><div class="inv-label">Issued by</div><b>${esc(inv.issued_by_name || '—')}</b><span>${esc(inv.issued_by_title || '')}</span><span>${esc(company)}</span></div></div>
    <footer class="inv-foot"><div class="links">${[d.email, d.website, d.phone].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</div>
      <div class="conf">Confidential — Prepared by ${esc(company)}</div></footer>
  </article>`;
}

// Print through a hidden frame (no pop-up needed). "Save as PDF" is in the print dialog.
export function printInvoice(inv, ctx = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.invoice_number || 'Invoice')}</title>
    <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact}${INVOICE_CSS}</style></head><body>${invoiceDocHTML(inv, ctx)}</body></html>`);
  doc.close();
  const go = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { setTimeout(() => frame.remove(), 1500); } };
  (doc.fonts?.ready || Promise.resolve()).then(() => setTimeout(go, 150));
}

// ---------- Invoice viewer ----------
async function loadCtx(inv) {
  const [client, project] = await Promise.all([
    inv.client_id ? q(supabase.from('clients').select('id, name, buid, contact_name, email, phone, website, country, address').eq('id', inv.client_id).maybeSingle()).catch(() => null) : null,
    inv.project_id ? q(supabase.from('projects').select('id, name').eq('id', inv.project_id).maybeSingle()).catch(() => null) : null,
  ]);
  return { client, project };
}

export async function openInvoiceView(id) {
  let inv = await q(supabase.from('invoices').select('*').eq('id', id).maybeSingle());
  if (!inv) { toast('This invoice was deleted or you can\'t see it', 'error'); return; }
  const ctx = await loadCtx(inv);
  const canEdit = inv.kind === 'business' ? can('finance', 'edit') : canAny('finance', 'edit');
  const canDel = inv.kind === 'business' ? can('finance', 'delete') : canAny('finance', 'delete');
  const m = openModal({
    title: esc(inv.invoice_number || `Invoice #${inv.id}`),
    subtitle: `${esc(partyName(inv, ctx.client))} · ${invoiceBadge(inv)}`,
    wide: true,
    body: `<div class="inv-frame">${invoiceDocHTML(inv, ctx)}</div>`,
    foot: `
      ${canDel ? `<button class="btn btn-ghost btn-danger" data-del>${icon('trash', 14)}Delete</button>` : ''}
      <span style="flex:1"></span>
      ${canEdit && (inv.status === 'sent' || inv.status === 'draft') ? `<button class="btn" data-paid>${icon('check', 14)}Mark paid</button>` : ''}
      ${canEdit ? `<button class="btn" data-edit>${icon('edit', 14)}Edit</button>` : ''}
      <button class="btn btn-primary" data-print>${icon('download', 14)}Print / save PDF</button>`,
  });
  m.classList.add('inv-modal');
  m.querySelector('[data-print]').onclick = () => printInvoice(inv, ctx);
  m.querySelector('[data-edit]')?.addEventListener('click', () => { m.close(); openInvoiceEditor({ invoice: inv }); });
  m.querySelector('[data-paid]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try { await q(supabase.from('invoices').update({ status: 'paid' }).eq('id', inv.id)); toast('Marked as paid'); m.close(); changed(); openInvoiceView(inv.id); }
    catch (err) { toast(err.message, 'error'); }
  }));
  m.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: `Delete ${inv.invoice_number || 'this invoice'}?`, text: 'It stops counting toward revenue. The number is not reused.', confirm: 'Delete invoice', danger: true })) return;
    try { await q(supabase.from('invoices').delete().eq('id', inv.id)); toast('Invoice deleted'); m.close(); changed(); } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- Invoice editor ----------
// kind 'client': choose the client first (unless clientId is given), then the details.
// kind 'business': our own invoice for someone who isn't a client in the app — type who it's for.
export async function openInvoiceEditor({ kind = 'client', clientId = null, projectId = null, invoice = null, onSaved = null } = {}) {
  if (invoice) { kind = invoice.kind || 'client'; clientId = invoice.client_id; }
  if (kind === 'client' && !clientId) return pickClient((id) => openInvoiceEditor({ kind, clientId: id, projectId, onSaved }));

  const base = baseCurrency();
  const [client, projects, nextNo] = await Promise.all([
    kind === 'client' ? q(supabase.from('clients').select('id, name, buid, contact_name, email, phone, website, country, address').eq('id', clientId).maybeSingle()) : null,
    kind === 'client' ? q(supabase.from('projects').select('id, name').eq('client_id', clientId).order('name')).catch(() => []) : [],
    invoice ? null : rpc('invoice_next_number', { p_kind: kind, p_client: clientId }).catch(() => null),
  ]);
  if (kind === 'client' && !client) { toast('Client not found', 'error'); return; }
  const d = invoiceSettings();
  const i = invoice || {
    issue_date: todayStr(), due_date: addDays(todayStr(), d.due_days), billing_period: monthPeriod(todayStr()), status: 'sent', project_id: projectId, currency: localCur() || base,
    items: [{ description: '', qty: 1, rate: '' }], discount: 0, tax_percent: 0, notes: d.terms || '', bill_to: {},
  };
  const items = (Array.isArray(i.items) && i.items.length ? i.items : [{ description: i.description || '', qty: 1, rate: i.amount_original ?? i.amount ?? '' }]).map((x) => ({ ...x }));
  const bt = i.bill_to || {};
  const { top, rest } = currencies();
  const cur0 = (i.currency || base).toUpperCase();
  const opt = (c) => `<option value="${c}" ${c === cur0 ? 'selected' : ''}>${c} · ${esc(currencyName(c))}</option>`;

  const m = openModal({
    title: invoice ? `Edit ${esc(invoice.invoice_number || 'invoice')}` : kind === 'business' ? 'New business invoice' : 'New client invoice',
    subtitle: kind === 'client' ? `${esc(client.name)} · ${esc(client.buid || '')}` : 'For someone who isn\'t a client in this workspace',
    icon: 'file', wide: true,
    body: `
    <form id="ivf" class="stack" novalidate style="gap:16px">
      <div class="inv-autos">
        <div><span>Invoice no.</span><b>${esc(invoice?.invoice_number || nextNo || 'Made on save')}</b></div>
        <div><span>Reference</span><b>${esc(invoice?.reference_no || 'Made on save')}</b></div>
        <div><span>Issued by</span><b>${esc(invoice ? invoice.issued_by_name || '—' : myName())}</b><small>${esc(invoice ? invoice.issued_by_title || '' : myTitle())}</small></div>
      </div>
      ${kind === 'client' ? `
        <div class="inv-billto"><div class="grow"><div class="lbl">Bill to</div><b>${esc(client.name)}</b> <span class="inv-buid-chip">${esc(client.buid || '')}</span>
          <div class="small muted">${esc([client.contact_name, client.address, client.email, client.phone].filter(Boolean).join(' · ') || 'No contact details on the client yet')}</div>
          ${client.address ? '' : '<div class="small" style="color:var(--warning)">No address on this client — add it in Clients → Edit so it prints under "Billed to".</div>'}</div>
          ${invoice ? '' : `<button type="button" class="btn btn-sm btn-ghost" data-change-client>Change client</button>`}</div>
        ${projects.length && !projectId ? `<div class="field"><label for="iv-project">Project</label><select id="iv-project" class="select"><option value="">Whole client (no project)</option>${projects.map((p) => `<option value="${p.id}" ${i.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          <span class="hint">The project manager of that project can see this invoice.</span></div>` : ''}`
      : `<div class="form-grid">
          <div class="field"><label for="bt-name">Name <span class="req">*</span></label><input id="bt-name" class="input" maxlength="120" value="${esc(bt.name || '')}" placeholder="Ali Raza"></div>
          <div class="field"><label for="bt-company">Company</label><input id="bt-company" class="input" maxlength="160" value="${esc(bt.company || '')}" placeholder="Raza Traders"></div>
          <div class="field"><label for="bt-email">Email</label><input id="bt-email" class="input" type="email" maxlength="160" value="${esc(bt.email || '')}"></div>
          <div class="field"><label for="bt-phone">Phone</label><input id="bt-phone" class="input" maxlength="40" value="${esc(bt.phone || '')}"></div>
          <div class="field span-2"><label for="bt-address">Address</label><input id="bt-address" class="input" maxlength="300" value="${esc(bt.address || '')}"></div>
        </div>`}
      <div class="form-grid">
        <div class="field"><label for="iv-issue">Date</label><input id="iv-issue" class="input" type="date" value="${esc(i.issue_date || todayStr())}"></div>
        <div class="field"><label for="iv-due">Due date</label><input id="iv-due" class="input" type="date" value="${esc(i.due_date || '')}"><span class="hint">${esc(d.due_days)} days after the invoice date by default.</span></div>
        <div class="field span-2"><label for="iv-period">Billing period</label><input id="iv-period" class="input" maxlength="80" value="${esc(i.billing_period || '')}" placeholder="1–31 October 2026"><span class="hint">Filled from the invoice month. Change it if this invoice covers something else.</span></div>
        <div class="field"><label for="iv-cur">Currency</label><select id="iv-cur" class="select">${top.map(opt).join('')}<option disabled>──────────</option>${rest.map(opt).join('')}</select></div>
        <div class="field"><label for="iv-status">Status</label><select id="iv-status" class="select">${Object.entries(INVOICE_STATUS).map(([k, v]) => `<option value="${k}" ${i.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field span-2 fx-row ${cur0 === base ? 'hidden' : ''}" data-fx><label for="iv-rate">Exchange rate</label>
          <div class="fx-line"><span>1 <b data-cur-tag>${esc(cur0)}</b> =</span><input id="iv-rate" class="input" type="number" min="0" step="any" value="${esc(invoice && cur0 !== base ? invoice.fx_rate : '')}" style="max-width:160px"><span>${esc(base)}</span></div>
          <span class="hint" data-fx-hint>The client sees the invoice in <span data-cur-tag>${esc(cur0)}</span>. Revenue and reports are in ${esc(base)}.</span></div>
      </div>
      <div>
        <div class="section-title" style="margin:0 0 8px">Items</div>
        <div class="inv-lines" id="iv-lines"></div>
        <button type="button" class="btn btn-sm" data-add-line style="margin-top:8px">${icon('plus', 13)}Add line</button>
      </div>
      <div class="inv-calc">
        <div class="form-grid" style="flex:1">
          <div class="field"><label for="iv-disc">Discount (<span data-cur-tag>${esc(cur0)}</span>)</label><input id="iv-disc" class="input" type="number" min="0" step="0.01" value="${esc(Number(i.discount) || '')}" placeholder="0"></div>
          <div class="field"><label for="iv-tax">Tax %</label><input id="iv-tax" class="input" type="number" min="0" max="100" step="0.01" value="${esc(Number(i.tax_percent) || '')}" placeholder="0"></div>
        </div>
        <div class="inv-totals" id="iv-totals"></div>
      </div>
      <div class="field"><label for="iv-notes">Notes on the invoice</label><textarea id="iv-notes" class="textarea" maxlength="2000" rows="3" placeholder="Optional. The terms and payment details print automatically.">${esc(i.notes || '')}</textarea>
        ${d.account_title || d.iban || d.wallet || d.payment ? '' : `<span class="hint">Add your bank / Wise details once in Settings → Invoice details, and they print on every invoice.</span>`}</div>
      <div class="form-error hidden" id="iv-err"></div>
    </form>`,
    foot: `<button class="btn" data-cancel>Cancel</button><button class="btn" data-preview>${icon('eye', 14)}Preview</button><button class="btn btn-primary" data-save>${invoice ? 'Save invoice' : 'Create invoice'}</button>`,
  });

  const $ = (s) => m.querySelector(s);
  const curSel = $('#iv-cur'); const rate = $('#iv-rate'); const linesEl = $('#iv-lines');
  const drawLines = () => {
    linesEl.innerHTML = items.map((x, k) => `
      <div class="inv-line" data-k="${k}">
        <input class="input" data-f="description" maxlength="300" value="${esc(x.description || '')}" placeholder="Description, e.g. Meta ads management (Oct)" aria-label="Description">
        <input class="input" data-f="qty" type="number" min="0" step="any" value="${esc(x.qty ?? 1)}" aria-label="Quantity" placeholder="Qty">
        <input class="input" data-f="rate" type="number" min="0" step="0.01" value="${esc(x.rate ?? '')}" aria-label="Price" placeholder="Price">
        <b class="inv-line-amt" data-amt></b>
        <button type="button" class="btn btn-ghost btn-icon btn-sm" data-rm aria-label="Remove line" ${items.length === 1 ? 'disabled' : ''}>${icon('x', 14)}</button>
      </div>`).join('');
    recalc();
  };
  const read = () => ({ items: items.filter((x) => String(x.description || '').trim() || Number(x.rate)), discount: Number($('#iv-disc').value) || 0, tax_percent: Number($('#iv-tax').value) || 0 });
  const recalc = () => {
    const cur = curSel.value; const f = (v) => esc(fmtCur(v, cur));
    linesEl.querySelectorAll('.inv-line').forEach((row) => { const x = items[Number(row.dataset.k)]; row.querySelector('[data-amt]').textContent = fmtCur(n2((x.qty === '' ? 1 : Number(x.qty)) * (Number(x.rate) || 0)), cur); });
    const t = invoiceTotals({ ...read(), items: read().items.length ? read().items : [{ description: '-', qty: 0, rate: 0 }] });
    const r = Number(rate.value);
    $('#iv-totals').innerHTML = `
      <div><span>Subtotal</span><b>${f(t.sub)}</b></div>
      ${t.discount ? `<div><span>Discount</span><b>− ${f(t.discount)}</b></div>` : ''}
      ${t.tax ? `<div><span>Tax</span><b>${f(t.tax)}</b></div>` : ''}
      <div class="total"><span>Total</span><b>${f(t.total)}</b></div>
      ${cur !== base && r > 0 ? `<div class="muted small"><span>In ${esc(base)}</span><span>≈ ${money(t.total * r)}</span></div>` : ''}`;
  };
  linesEl.addEventListener('input', (e) => { const row = e.target.closest('.inv-line'); if (!row) return; items[Number(row.dataset.k)][e.target.dataset.f] = e.target.value; recalc(); });
  linesEl.addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (!b || items.length === 1) return; items.splice(Number(b.closest('.inv-line').dataset.k), 1); drawLines(); });
  $('[data-add-line]').onclick = () => { items.push({ description: '', qty: 1, rate: '' }); drawLines(); linesEl.querySelector('.inv-line:last-child input').focus(); };
  $('#iv-disc').oninput = recalc; $('#iv-tax').oninput = recalc; rate.oninput = recalc;
  const onCur = async (fresh) => {
    m.querySelectorAll('[data-cur-tag]').forEach((t) => { t.textContent = curSel.value; });
    $('[data-fx]').classList.toggle('hidden', curSel.value === base);
    try { localStorage.setItem('webnox.invoiceCurrency', curSel.value); } catch { /* ignore */ }
    if (curSel.value !== base && (fresh || !rate.value)) {
      rate.value = ''; const r = await fetchRate(curSel.value);
      if (r) rate.value = Number(r.toPrecision(6));
      else $('[data-fx-hint]').textContent = `Couldn't get a live rate. Type how many ${base} one ${curSel.value} is.`;
    }
    recalc();
  };
  curSel.onchange = () => onCur(true);
  $('[data-cancel]').onclick = () => m.close();
  $('[data-change-client]')?.addEventListener('click', () => { m.close(); openInvoiceEditor({ kind, projectId, onSaved }); });
  if (!invoice) $('#iv-issue').addEventListener('change', (e) => {
    const day = e.target.value; if (!day) return;
    $('#iv-due').value = addDays(day, d.due_days);
    $('#iv-period').value = monthPeriod(day);
  });
  drawLines(); onCur(false);

  const err = $('#iv-err');
  const fail = (t) => { err.textContent = t; err.classList.remove('hidden'); return null; };
  const payload = () => {
    err.classList.add('hidden');
    const v = (s) => $(s)?.value.trim() ?? '';
    const { items: lines, discount, tax_percent } = read();
    if (!lines.length) return fail('Add at least one line with a description and price.');
    if (lines.some((x) => !String(x.description || '').trim())) return fail('Every line needs a description.');
    if (lines.some((x) => Number(x.qty) < 0 || Number(x.rate) < 0)) return fail('Quantity and price can\'t be negative.');
    const cur = curSel.value; const r = cur === base ? 1 : Number(rate.value);
    if (!(r > 0)) return fail(`Add the exchange rate from ${cur} to ${base}.`);
    const t = invoiceTotals({ items: lines, discount, tax_percent });
    if (discount > t.sub) return fail('The discount is more than the invoice total.');
    const p = {
      items: lines.map((x) => ({ description: String(x.description).trim(), qty: x.qty === '' || x.qty == null ? 1 : Number(x.qty), rate: Number(x.rate) || 0 })),
      discount, tax_percent, currency: cur, fx_rate: r, amount_original: t.total, amount: n2(t.total * r),
      issue_date: v('#iv-issue') || todayStr(), due_date: v('#iv-due') || null, billing_period: v('#iv-period'), status: v('#iv-status'), notes: v('#iv-notes'),
      description: String(lines[0].description).trim().slice(0, 300),
    };
    if (p.due_date && p.due_date < p.issue_date) return fail('The due date is before the invoice date.');
    if (kind === 'business') {
      p.bill_to = { name: v('#bt-name'), company: v('#bt-company'), email: v('#bt-email'), phone: v('#bt-phone'), address: v('#bt-address') };
      if (!p.bill_to.name) return fail('Enter who this invoice is for.');
    } else if (!invoice) {
      p.client_id = clientId;
      p.project_id = projectId || (Number(v('#iv-project')) || null);
    } else if ($('#iv-project')) p.project_id = Number(v('#iv-project')) || null;
    if (!invoice) p.kind = kind;
    return p;
  };
  $('[data-preview]').onclick = () => {
    const p = payload(); if (!p) return;
    const draft = { ...(invoice || {}), ...p, invoice_number: invoice?.invoice_number || nextNo, reference_no: invoice?.reference_no || 'Made on save', issued_by_name: invoice?.issued_by_name || myName(), issued_by_title: invoice?.issued_by_title || myTitle() };
    const pv = openModal({ title: 'Preview', wide: true, body: `<div class="inv-frame">${invoiceDocHTML(draft, { client, project: projects.find((x) => x.id === draft.project_id) || null })}</div>`, foot: '<button class="btn btn-primary" data-close-pv>Back to editing</button>' });
    pv.classList.add('inv-modal');
    pv.querySelector('[data-close-pv]').onclick = () => pv.close();
  };
  const save = $('[data-save]');
  const submit = () => busy(save, async () => {
    const p = payload(); if (!p) return;
    try {
      const row = invoice
        ? await q(supabase.from('invoices').update(p).eq('id', invoice.id).select('id').single())
        : await q(supabase.from('invoices').insert(p).select('id').single());
      toast(invoice ? 'Invoice saved' : 'Invoice created');
      m.close(); changed(); onSaved?.(row.id);
      openInvoiceView(row.id);
    } catch (e) { fail(e.message); }
  });
  save.onclick = submit;
  $('#ivf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}
function localCur() { try { return localStorage.getItem('webnox.invoiceCurrency'); } catch { return null; } }

// Step 1: choose the client
async function pickClient(next) {
  const clients = await q(supabase.from('clients').select('id, name, buid, invoice_code, status, contact_name').order('name'));
  const m = openModal({
    title: 'New client invoice', subtitle: 'Step 1 of 2 · Choose the client', icon: 'file', wide: true,
    body: clients.length ? `
      <div class="search">${icon('search', 15)}<input class="input" id="pc-q" placeholder="Search by name or BUID" aria-label="Search clients"></div>
      <div class="pick-list" id="pc-list"></div>` : '<p class="muted">No clients yet. Convert a won lead to a client first.</p>',
  });
  if (!clients.length) return;
  const list = m.querySelector('#pc-list'); const inp = m.querySelector('#pc-q');
  const draw = () => {
    const s = inp.value.trim().toLowerCase();
    const rows = clients.filter((c) => !s || `${c.name} ${c.buid || ''} ${c.contact_name || ''}`.toLowerCase().includes(s));
    list.innerHTML = rows.length ? rows.map((c) => `
      <button type="button" class="pick-row" data-id="${c.id}"><span class="inv-code">${esc(c.invoice_code || '··')}</span>
        <span class="grow"><b>${esc(c.name)}</b><small>${esc([c.buid, c.contact_name].filter(Boolean).join(' · '))}</small></span>${icon('chevronR', 16)}</button>`).join('')
      : '<p class="muted small" style="padding:10px">No client matches.</p>';
  };
  inp.oninput = draw; draw();
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) { m.close(); next(Number(b.dataset.id)); } });
}
