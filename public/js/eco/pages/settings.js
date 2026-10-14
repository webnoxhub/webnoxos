import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q } from '../data.js';
import { esc, toast, busy } from '../ui.js';
import { setTimezone } from '../time.js';
import { setIdleMinutes } from '../tracker.js';

export async function render({ el }) {
  const s = state.settings;
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
}
