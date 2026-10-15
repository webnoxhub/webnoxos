// Notification bell: unread count, dropdown list, mark as read
import { supabase } from './supabase.js';
import { q } from './data.js';
import { esc, icon, toast } from './ui.js';
import { fmtRelative } from './time.js';

const KIND_ICON = { task: 'tasks', review: 'check', lead: 'target', client: 'briefcase', finance: 'wallet', project: 'folder', approval: 'shield', info: 'bell' };
let lastSeenAt = null;
let panel = null;

export function mountBell(slot) {
  slot.innerHTML = `<button class="btn btn-ghost btn-icon bell" id="bell" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">${icon('bell', 18)}<span class="dot hidden" id="bell-dot"></span></button>`;
  const btn = slot.querySelector('#bell');
  const dot = slot.querySelector('#bell-dot');

  async function refresh() {
    try {
      const { count } = await q(supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null));
      dot.textContent = count > 99 ? '99+' : String(count || '');
      dot.classList.toggle('hidden', !count);
      const latest = await q(supabase.from('notifications').select('id, title, text, created_at').order('created_at', { ascending: false }).limit(1));
      const top = latest[0];
      if (top && lastSeenAt !== null && top.created_at > lastSeenAt) toast(top.title || top.text);
      if (top) lastSeenAt = top.created_at; else if (lastSeenAt === null) lastSeenAt = '';
      if (panel) renderList();
    } catch { /* offline or table not ready */ }
  }

  async function renderList() {
    const list = panel.querySelector('.notif-list');
    const rows = await q(supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(40)).catch(() => []);
    if (!panel) return;
    list.innerHTML = rows.length ? rows.map((n) => `
      <button class="notif ${n.read_at ? '' : 'unread'}" data-id="${n.id}" data-link="${esc(n.link || (n.project_id ? '#/projects?id=' + n.project_id : ''))}">
        <span class="ic ${esc(n.kind)}">${icon(KIND_ICON[n.kind] || 'bell', 15)}</span>
        <span style="flex:1;min-width:0"><div class="t">${esc(n.title || n.text)}</div>${n.body ? `<div class="b">${esc(n.body)}</div>` : ''}<div class="w">${esc(fmtRelative(n.created_at))}</div></span>
        ${n.read_at ? '' : '<span class="u" aria-label="Unread"></span>'}
      </button>`).join('') : '<div class="empty" style="padding:32px 16px"><h3>You\'re all caught up</h3><p>Assignments, reviews and changes that involve you show up here.</p></div>';
  }

  function close() {
    panel?.remove(); panel = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', onKey);
  }
  const outside = (e) => { if (panel && !panel.contains(e.target) && !btn.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  btn.addEventListener('click', () => {
    if (panel) return close();
    panel = document.createElement('div');
    panel.className = 'notif-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Notifications');
    panel.innerHTML = `<div class="notif-head"><b>Notifications</b><button class="linkish" data-all>Mark all as read</button></div><div class="notif-list"><div class="loading-block"><div class="skeleton"></div><div class="skeleton" style="width:70%"></div></div></div>`;
    document.body.append(panel);
    btn.setAttribute('aria-expanded', 'true');
    renderList();
    setTimeout(() => document.addEventListener('click', outside, true), 0);
    document.addEventListener('keydown', onKey);
    panel.querySelector('[data-all]').onclick = async () => {
      await q(supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null)).catch((e) => toast(e.message, 'error'));
      refresh();
    };
    panel.addEventListener('click', async (e) => {
      const item = e.target.closest('.notif'); if (!item) return;
      await q(supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', item.dataset.id).is('read_at', null)).catch(() => {});
      const link = item.dataset.link;
      close(); refresh();
      if (link) { if (location.hash === link) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = link; }
    });
  });

  refresh();
  setInterval(refresh, 30_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('ehos:data-changed', () => setTimeout(refresh, 800));
}
