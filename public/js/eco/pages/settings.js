import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q } from '../data.js';
import { esc, toast, busy } from '../ui.js';
import { setTimezone } from '../time.js';
import { setIdleMinutes } from '../tracker.js';
import { INVOICE_DEFAULTS, LOGO_TYPES, LOGO_MAX_BYTES, safeLogo } from '../invoices.js';

export async function render({ el }) {
  const s = state.settings;
  const inv = s.invoice_details || {};
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['Asia/Karachi', 'Europe/London', 'America/New_York', 'UTC']; }
  if (!zones.includes(s.timezone)) zones.unshift(s.timezone);

  el.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>${esc(state.workspace?.name || s.company_name)} Workspace · company details, logo, timezone and tracking.</p></div></div>
    <div class="stack" style="max-width:820px">
      <section class="panel">
        <div class="panel-head"><div><h2>Workspace logo</h2><p>Shown in the sidebar and on your team's sign-in page.</p></div>
          <button class="btn" id="chLogo" type="button">Change logo</button></div>
        <div class="panel-body"><div class="logo-prev" id="stLogo"></div>
          <p class="muted small" id="stLogoNote" style="margin-top:8px"></p></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Workspace</h2><p>Changes are recorded in the activity log.</p></div></div>
        <div class="panel-body">
          <form id="ws" class="form-grid" novalidate>
            <div class="field span-2"><label for="ws-name">Company name</label><input id="ws-name" class="input" value="${esc(s.company_name)}" maxlength="80"></div>
            <div class="field"><label for="ws-tz">Timezone</label>
              <select id="ws-tz" class="select">${zones.map((z) => `<option ${z === s.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>
              <span class="hint">Days, weeks and months in reports start at midnight in this timezone.</span></div>
            <div class="field"><label for="ws-idle">Mark idle after (minutes)</label><input id="ws-idle" class="input" type="number" min="1" max="60" value="${esc(s.idle_minutes)}">
              <span class="hint">No click, key press or scroll in Webnox OS for this long counts as idle.</span></div>
            <div class="field"><label for="ws-cur">Currency</label>
              <select id="ws-cur" class="select">${['USD', 'GBP', 'EUR', 'PKR', 'AED', 'CAD', 'AUD', 'SAR'].map((c) => `<option ${c === (s.currency || 'USD') ? 'selected' : ''}>${c}</option>`).join('')}</select>
              <span class="hint">Used for invoices, revenue and lead values.</span></div>
            <div class="span-2"><button class="btn btn-primary" type="submit">Save workspace settings</button></div>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Invoice details</h2><p>Printed on every invoice: contact details, bank / Wise details and terms.</p></div></div>
        <div class="panel-body">
          <form id="invd" class="form-grid" novalidate>
            <div class="field span-2"><label for="id-logo">Logo</label>
              <div class="row wrap" style="gap:12px;align-items:center">
                <div id="id-logo-box" style="height:56px;min-width:56px;max-width:240px;border:1px dashed var(--line-2);border-radius:10px;display:grid;place-items:center;padding:6px;background:#fff"></div>
                <label class="btn btn-sm" for="id-logo">Upload logo</label>
                <input id="id-logo" type="file" accept="${LOGO_TYPES.join(',')}" class="hidden">
                <button type="button" class="btn btn-sm btn-ghost" id="id-logo-rm">Remove</button>
              </div>
              <label class="row" style="gap:8px;margin-top:8px;font-weight:400"><input type="checkbox" id="id-logo-name" ${inv.logo_has_name ? 'checked' : ''}> The logo already shows the company name (hide the name next to it)</label>
              <span class="hint">PNG, JPG, WEBP or SVG, up to 300 KB. A transparent PNG looks best. Printed at the top of every invoice (if empty, your workspace logo is used). Click "Save invoice details" after uploading.</span></div>
            <div class="field span-2"><label for="id-address">Address</label><input id="id-address" class="input" maxlength="300" value="${esc(inv.address || '')}" placeholder="Office, street, city, country"></div>
            <div class="field"><label for="id-email">Email</label><input id="id-email" class="input" type="email" maxlength="160" value="${esc(inv.email ?? INVOICE_DEFAULTS.email)}"></div>
            <div class="field"><label for="id-phone">Phone</label><input id="id-phone" class="input" maxlength="40" value="${esc(inv.phone ?? INVOICE_DEFAULTS.phone)}"></div>
            <div class="field span-2"><label for="id-website">Website</label><input id="id-website" class="input" maxlength="160" value="${esc(inv.website ?? INVOICE_DEFAULTS.website)}"></div>
            <div class="span-2 section-title" style="margin:6px 0 0">Payment details</div>
            <div class="field"><label for="id-title">Account title</label><input id="id-title" class="input" maxlength="120" value="${esc(inv.account_title || '')}"></div>
            <div class="field"><label for="id-bank">Bank</label><input id="id-bank" class="input" maxlength="120" value="${esc(inv.bank || '')}"></div>
            <div class="field"><label for="id-iban">IBAN</label><input id="id-iban" class="input" maxlength="60" value="${esc(inv.iban || '')}"></div>
            <div class="field"><label for="id-swift">SWIFT / BIC</label><input id="id-swift" class="input" maxlength="30" value="${esc(inv.swift || '')}"></div>
            <div class="field span-2"><label for="id-wallet">Wise / Payoneer</label><input id="id-wallet" class="input" maxlength="160" value="${esc(inv.wallet || '')}" placeholder="Email or account ID"></div>
            <div class="field span-2"><label for="id-payment">Other payment details</label><textarea id="id-payment" class="textarea" rows="2" maxlength="1000" placeholder="Optional, e.g. PayPal">${esc(inv.payment || '')}</textarea>
              <span class="hint">The invoice number is printed as the payment reference automatically.</span></div>
            <div class="span-2 section-title" style="margin:6px 0 0">Terms</div>
            <div class="field"><label for="id-due">Payment due within (days)</label><input id="id-due" class="input" type="number" min="0" max="120" value="${esc(inv.due_days ?? INVOICE_DEFAULTS.due_days)}">
              <span class="hint">Sets the due date on new invoices.</span></div>
            <div class="field"><label for="id-pause">Services may pause after (days overdue)</label><input id="id-pause" class="input" type="number" min="0" max="365" value="${esc(inv.pause_days ?? INVOICE_DEFAULTS.pause_days)}"></div>
            <div class="field span-2"><label for="id-footer">Note under the terms</label><input id="id-footer" class="input" maxlength="300" value="${esc(inv.footer_note ?? INVOICE_DEFAULTS.footer_note)}"></div>
            <div class="field span-2"><label for="id-terms">Default note on new invoices</label><textarea id="id-terms" class="textarea" rows="2" maxlength="1000" placeholder="Optional">${esc(inv.terms || '')}</textarea>
              <span class="hint">Filled in on each new invoice. You can change it per invoice.</span></div>
            <div class="span-2"><button class="btn btn-primary" type="submit">Save invoice details</button></div>
          </form>
        </div>
      </section>
    </div>`;

  const paintLogo = () => {
    const w = state.workspace || {};
    el.querySelector('#stLogo').innerHTML = w.logo_url ? `<img alt="" src="${esc(w.logo_url)}">` : '<span>No logo yet</span>';
    el.querySelector('#stLogoNote').textContent = w.logo_url ? (w.logo_only ? 'Logo only: the business name is not shown as text.' : 'The business name is shown next to the logo.') : '';
  };
  paintLogo();
  el.querySelector('#chLogo').addEventListener('click', () => {
    import('../logo.js').then((m) => m.openLogoModal({ current: state.workspace.logo_url || '', logoOnly: !!state.workspace.logo_only }, (logo, only) => {
      state.workspace.logo_url = logo || ''; state.workspace.logo_only = !!only;
      const box = document.getElementById('brandLogo'); if (box) box.innerHTML = logo ? `<img class="brand-logo" alt="" src="${esc(logo)}">` : box.dataset.mark || '';
      document.querySelectorAll('.brand-name small').forEach((n) => { n.textContent = `${state.profile.account_type === 'admin' ? 'Admin' : 'Manager'}${only && logo ? '' : ' of ' + state.workspace.name}`; });
      paintLogo();
      if (!logo) location.reload();
    }));
  });

  const form = el.querySelector('#ws');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = {
      company_name: form.querySelector('#ws-name').value.trim() || state.workspace?.name || 'My company',
      timezone: form.querySelector('#ws-tz').value,
      idle_minutes: Math.min(60, Math.max(1, parseInt(form.querySelector('#ws-idle').value, 10) || 5)),
      currency: form.querySelector('#ws-cur').value,
    };
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        const [row] = await q(supabase.from('app_settings').update(body).eq('workspace_id', state.settings.workspace_id).select());
        Object.assign(state.settings, row || body);
        setTimezone(state.settings.timezone);
        setIdleMinutes(state.settings.idle_minutes);
        toast('Settings saved');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  const invForm = el.querySelector('#invd');
  let logo = safeLogo(inv.logo) ? inv.logo : '';
  const logoBox = invForm.querySelector('#id-logo-box'); const logoIn = invForm.querySelector('#id-logo');
  const drawLogo = () => {
    logoBox.innerHTML = logo ? `<img src="${esc(logo)}" alt="Logo" style="max-height:44px;max-width:228px;object-fit:contain">` : '<span class="muted small" style="padding:0 8px">No logo</span>';
    invForm.querySelector('#id-logo-rm').classList.toggle('hidden', !logo);
  };
  drawLogo();
  logoIn.addEventListener('change', () => {
    const f = logoIn.files?.[0]; logoIn.value = '';
    if (!f) return;
    if (!LOGO_TYPES.includes(f.type)) { toast('Use a PNG, JPG, WEBP or SVG image', 'error'); return; }
    if (f.size > LOGO_MAX_BYTES) { toast('The logo is bigger than 300 KB. Export a smaller version and try again.', 'error'); return; }
    const r = new FileReader();
    r.onload = () => { if (!safeLogo(r.result)) { toast('This image can\'t be used as a logo', 'error'); return; } logo = r.result; drawLogo(); toast('Logo ready. Save invoice details to keep it.'); };
    r.readAsDataURL(f);
  });
  invForm.querySelector('#id-logo-rm').onclick = () => { logo = ''; drawLogo(); };
  invForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (id) => invForm.querySelector(id).value.trim();
    const days = (id, max, def) => { const n = parseInt(v(id), 10); return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : def; };
    const details = {
      address: v('#id-address'), email: v('#id-email'), phone: v('#id-phone'), website: v('#id-website'),
      account_title: v('#id-title'), bank: v('#id-bank'), iban: v('#id-iban'), swift: v('#id-swift'), wallet: v('#id-wallet'), payment: v('#id-payment'),
      due_days: days('#id-due', 120, INVOICE_DEFAULTS.due_days), pause_days: days('#id-pause', 365, INVOICE_DEFAULTS.pause_days),
      footer_note: v('#id-footer'), terms: v('#id-terms'),
      logo, logo_has_name: invForm.querySelector('#id-logo-name').checked,
    };
    busy(invForm.querySelector('[type=submit]'), async () => {
      try {
        const [row] = await q(supabase.from('app_settings').update({ invoice_details: details }).eq('workspace_id', state.settings.workspace_id).select());
        state.settings.invoice_details = row?.invoice_details || details;
        toast('Invoice details saved');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}
