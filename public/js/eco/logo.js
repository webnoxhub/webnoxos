// Admin-only: choose a workspace logo, shrink it in the browser, save it.
import { supabase } from './supabase.js';
import { state } from './state.js';
import { api } from './data.js';
import { esc, openModal, toast } from './ui.js';

function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 400 / img.width, 160 / img.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image.')); };
    img.src = url;
  });
}

export function openLogoModal({ current = '', logoOnly = false } = {}, onDone) {
  let data = null;
  const m = openModal({
    title: 'Workspace logo',
    body: `<p class="muted small">This logo shows in the sidebar and on your team's sign-in page. A PNG with a transparent background looks best.</p>
      <div class="logo-prev" id="lgPrev">${current ? `<img alt="" src="${esc(current)}">` : '<span>No logo yet</span>'}</div>
      <input type="file" id="lgFile" accept="image/png,image/jpeg,image/webp">
      <label class="check" style="margin-top:12px"><input type="checkbox" id="lgOnly" ${logoOnly ? 'checked' : ''}><span>My logo already contains the business name<br><span class="muted small">Show only the logo. The workspace name will not appear as text in the sidebar or on the sign-in page.</span></span></label>
      <div class="form-error hidden" id="lgErr"></div>`,
    foot: `${current ? '<button class="btn btn-ghost" id="lgRemove" type="button" style="margin-right:auto">Remove logo</button>' : ''}<button class="btn" id="lgCancel" type="button">Cancel</button><button class="btn btn-primary" id="lgSave" type="button" disabled>Save logo</button>`,
  });
  const $ = (i) => m.querySelector('#' + i);
  const err = (t) => { $('lgErr').textContent = t; $('lgErr').classList.toggle('hidden', !t); };
  const send = async (logo, btn) => {
    btn.disabled = true; err('');
    const only = !!logo && $('lgOnly').checked;
    try { await api('/team/members?action=logo', { method: 'POST', body: { logo, logo_only: only } }); onDone(logo, only); toast(logo ? 'Logo saved' : 'Logo removed'); m.close(); }
    catch (x) { err(x.message); btn.disabled = false; }
  };
  $('lgFile').addEventListener('change', async () => {
    const f = $('lgFile').files[0]; err(''); data = null; $('lgSave').disabled = true;
    if (!f) return;
    try { data = await shrink(f); $('lgPrev').innerHTML = `<img alt="" src="${data}">`; $('lgSave').disabled = false; }
    catch (x) { err(x.message); }
  });
  $('lgCancel').addEventListener('click', m.close);
  $('lgSave').addEventListener('click', (e) => { const logo = data || current; if (logo) send(logo, e.currentTarget); });
  $('lgOnly').addEventListener('change', () => { if (current || data) $('lgSave').disabled = false; });
  if ($('lgRemove')) $('lgRemove').addEventListener('click', (e) => send(null, e.currentTarget));
}
