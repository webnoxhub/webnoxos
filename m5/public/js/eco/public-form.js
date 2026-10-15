// Public lead form: no login. Talks only to /api/public/*
import { leadFormHTML, bindLeadForm, readLeadForm } from './lead-options.js';

const $ = (s) => document.querySelector(s);
const token = new URLSearchParams(location.search).get('t') || '';
let agents = [];

function render() {
  $('#fields').innerHTML = leadFormHTML({ agents, isPublic: true });
  bindLeadForm($('#fields'));
  try { const saved = localStorage.getItem('lead-form.agent'); if (saved && agents.some((a) => a.id === saved)) $('#lf-agent').value = saved; } catch { /* ignore */ }
}

async function init() {
  try {
    const res = await fetch('/api/public/form?t=' + encodeURIComponent(token));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 404 ? 'This form link is not valid. Ask for a new one.' : (data.error || 'The form is not available right now'));
    agents = data.agents || [];
    $('#company').textContent = data.company || 'Lead form';
    document.title = 'Submit a lead · ' + (data.company || '');
    render();
  } catch (e) {
    $('#fields').innerHTML = `<div class="form-error">${String(e.message).replace(/</g, '&lt;')}</div>`;
    $('#submit').disabled = true;
  }
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#lf-err');
  if (!err) return;
  err.classList.add('hidden');
  const r = readLeadForm($('#fields'), { isPublic: true });
  if (r.error) { err.textContent = r.error; err.classList.remove('hidden'); if (r.field) $(r.field)?.focus(); return; }
  const btn = $('#submit');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/public/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...r.payload, t: token, hp: $('#hp').value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't send the lead. Try again.");
    try { if (r.payload.agent_id) localStorage.setItem('lead-form.agent', r.payload.agent_id); } catch { /* ignore */ }
    $('#form').classList.add('hidden'); $('#done').classList.remove('hidden');
  } catch (ex) {
    err.textContent = ex.message; err.classList.remove('hidden');
  } finally { btn.disabled = false; btn.textContent = 'Create lead'; }
});
$('#again').addEventListener('click', () => { render(); $('#done').classList.add('hidden'); $('#form').classList.remove('hidden'); $('#lf-name')?.focus(); });
init();
