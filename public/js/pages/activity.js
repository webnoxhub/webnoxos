import { esc } from '/js/ui.js';
import { api } from '/js/modal.js';

export default async function render({ el, sb, setTitle }) {
  setTitle('Activity');
  el.innerHTML = '<p class="muted pad">Loading…</p>';
  try {
    const d = await api(sb, '/api/inbox?a=activity');
    el.innerHTML = '<div class="page-head"><h2 class="page-title">Activity</h2></div>' +
      (d.items.length
        ? '<div class="card"><ul class="act-list">' + d.items.map((a) =>
          '<li class="act-row"><span class="act-text">' + esc(a.text) + '</span><span class="muted small">' + esc(new Date(a.created_at).toLocaleString()) + '</span></li>').join('') + '</ul></div>'
        : '<div class="empty"><p>No activity yet.</p></div>');
  } catch {
    el.innerHTML = '<div class="empty"><p>Could not load activity.</p></div>';
  }
}
