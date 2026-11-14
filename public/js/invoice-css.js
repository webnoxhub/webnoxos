// The invoice stylesheet, shared by a workspace's own invoices and by the rent invoices
// Webnox issues to a workspace. Kept in one file so the two documents never drift apart.
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
