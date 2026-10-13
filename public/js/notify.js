// Notification bell in the top bar (business world only).
import { esc, icon } from '/js/ui.js';
import { api } from '/js/modal.js';

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(iso).toLocaleDateString();
};

export function mountBell(sb, wrap) {
  if (!wrap) return;
  wrap.innerHTML =
    '<button class="bell" id="bell" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Notifications">' +
      icon('bell', 20) + '<span class="bell-dot" id="bellDot" hidden></span></button>' +
    '<div class="menu bell-menu" id="bellMenu" hidden></div>';
  const btn = wrap.querySelector('#bell'), dot = wrap.querySelector('#bellDot'), menu = wrap.querySelector('#bellMenu');
  let items = [];

  const paint = () => {
    menu.innerHTML =
      '<div class="bell-head"><strong>Notifications</strong><button class="link-btn" id="readAll" type="button">Mark all read</button></div>' +
      (items.length ? '<ul class="bell-list">' + items.map((n) =>
        '<li><button class="bell-item' + (n.read_at ? '' : ' is-new') + '" type="button" data-id="' + esc(n.id) + '" data-p="' + esc(n.project_id || '') + '">' +
          '<span class="bell-text">' + esc(n.text) + '</span><span class="muted small">' + esc(ago(n.created_at)) + '</span></button></li>').join('') + '</ul>'
        : '<p class="muted small bell-empty">Nothing yet.</p>');
    menu.querySelector('#readAll').addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await api(sb, '/api/inbox?a=read', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
      items = items.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })); dot.hidden = true; paint();
    });
    menu.querySelectorAll('.bell-item').forEach((b) => b.addEventListener('click', async () => {
      try { await api(sb, '/api/inbox?a=read', { method: 'POST', body: JSON.stringify({ id: b.dataset.id }) }); } catch { /* ignore */ }
      menu.hidden = true; btn.setAttribute('aria-expanded', 'false');
      if (b.dataset.p) location.hash = '#/projects?id=' + b.dataset.p;
      load();
    }));
  };

  async function load() {
    try {
      const d = await api(sb, '/api/inbox?a=notifications');
      items = d.items; dot.hidden = !d.unread; dot.textContent = d.unread > 9 ? '9+' : String(d.unread);
      if (!menu.hidden) paint();
    } catch { /* stay quiet: the bell is a convenience */ }
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
    if (open) { paint(); load(); }
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 45000);
}
