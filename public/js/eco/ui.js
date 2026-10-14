// Small UI toolkit: escaping, icons, toasts, drawer, modal, formatters for chips/badges.

export const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Delegated events: on(root, 'click', '[data-act]', (e, el) => ...)
export function on(root, type, selector, handler) {
  const fn = (e) => {
    const el = e.target.closest(selector);
    if (el && root.contains(el)) handler(e, el);
  };
  root.addEventListener(type, fn);
  return () => root.removeEventListener(type, fn);
}

// ---------- Icons (Lucide, ISC) ----------
const P = {
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  tasks: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  play: '<polygon points="7 4 19 12 7 20 7 4" fill="currentColor"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2" fill="currentColor"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevronL: '<path d="m15 18-6-6 6-6"/>',
  chevronR: '<path d="m9 18 6-6-6-6"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  wallet: '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  briefcase: '<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  board: '<rect width="6" height="16" x="3" y="4" rx="1"/><rect width="6" height="10" x="10" y="4" rx="1"/><rect width="5" height="13" x="17" y="4" rx="1"/>',
  list: '<line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/><path d="M12 15v4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
};

export function icon(name, size = 16, cls = '') {
  return `<svg class="i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

export const ROLE_ICONS = { sales_rep: 'trending', lead_gen: 'target', cold_caller: 'phone', finance: 'wallet', manager: 'users', project_manager: 'briefcase', project_agent: 'folder' };

// ---------- Small renderers ----------
export function initials(p) {
  const a = (p?.first_name || '').trim()[0] || (p?.email || '?')[0];
  const b = (p?.last_name || '').trim()[0] || '';
  return (a + b).toUpperCase();
}
export function fullName(p) {
  if (!p) return 'Unassigned';
  return `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.email || 'Member';
}
export function avatar(p, size = '') {
  return `<span class="avatar ${size}" aria-hidden="true">${esc(initials(p))}</span>`;
}
export function who(p, sub = '') {
  return `<div class="who">${avatar(p)}<div><div class="name">${esc(fullName(p))}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;
}

export const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', completed: 'Completed' };
export const PRIORITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
export const MEMBER_STATUS = { invited: 'Invited', active: 'Active', inactive: 'Inactive', suspended: 'Suspended' };

export const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
export const memberBadge = (s) => `<span class="badge ${esc(s)}">${esc(MEMBER_STATUS[s] || s)}</span>`;
export const prioTag = (p) => `<span class="prio ${esc(p)}">${icon('flag', 12)}${esc(PRIORITY_LABEL[p] || p)}</span>`;

export function roleChip(key, roles) {
  const r = roles?.find((x) => x.key === key);
  if (!key) return '';
  return `<span class="chip" data-role="${esc(key)}"><span class="dot"></span>${esc(r?.name || key)}</span>`;
}
export function presenceTag(presence, label) {
  const text = label || { active: 'Active now', idle: 'Idle', offline: 'Offline' }[presence] || 'Offline';
  return `<span class="presence ${esc(presence || 'offline')}"><i></i>${esc(text)}</span>`;
}

export function emptyState(title, text = '', actionHtml = '') {
  return `<div class="empty"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}${actionHtml}</div>`;
}
export function loadingBlock(lines = 3) {
  return `<div class="loading-block" aria-busy="true">${Array.from({ length: lines }, (_, i) =>
    `<div class="skeleton" style="width:${90 - i * 18}%"></div>`).join('')}</div>`;
}

// ---------- Toasts ----------
export function toast(message, type = 'ok') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check', 16)}<span>${esc(message)}</span>`;
  box.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
}

// ---------- Drawer ----------
let drawerState = null;
export function openDrawer({ title, body = '', foot = '', onClose } = {}) {
  closeDrawer();
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const el = document.createElement('aside');
  el.className = 'drawer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="drawer-head"><h2>${title}</h2><button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="drawer-body">${body}</div>
    ${foot ? `<div class="drawer-foot">${foot}</div>` : ''}`;
  document.body.append(scrim, el);
  const close = () => closeDrawer();
  scrim.addEventListener('click', close);
  el.querySelector('[data-close]').addEventListener('click', close);
  const key = (e) => { if (e.key === 'Escape' && !$('.modal')) close(); };
  document.addEventListener('keydown', key);
  drawerState = { el, scrim, key, onClose };
  el.querySelector('[data-close]').focus();
  return el;
}
export function closeDrawer() {
  if (!drawerState) return;
  const { el, scrim, key, onClose } = drawerState;
  drawerState = null;
  document.removeEventListener('keydown', key);
  el.remove(); scrim.remove();
  onClose?.();
}
export const drawerOpen = () => Boolean(drawerState);

// ---------- Modal ----------
export function openModal({ title, body = '', foot = '', wide = false, onClose, icon: ic = null, subtitle = '' } = {}) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim top';
  const el = document.createElement('div');
  el.className = `modal${wide ? ' wide' : ''}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="modal-head ${ic ? 'lead-head' : ''}">${ic ? `<span class="mh-icon">${icon(ic, 20)}</span>` : ''}<h2>${title}${subtitle ? `<div class="sub">${subtitle}</div>` : ''}</h2><button class="btn btn-ghost btn-icon btn-sm" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}`;
  document.body.append(scrim, el);
  const close = () => {
    document.removeEventListener('keydown', key);
    el.remove(); scrim.remove(); onClose?.();
  };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', key);
  scrim.addEventListener('click', close);
  el.querySelector('[data-close]').addEventListener('click', close);
  setTimeout(() => (el.querySelector('input, textarea, select') || el.querySelector('[data-close]'))?.focus(), 30);
  el.close = close;
  return el;
}

export function confirmDialog({ title, text = '', confirm = 'Confirm', danger = false, note = null }) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title: esc(title),
      body: `${text ? `<p class="muted">${esc(text)}</p>` : ''}${note ? `<div class="field"><label for="dlg-note">${esc(note.label)}</label><textarea id="dlg-note" class="textarea" placeholder="${esc(note.placeholder || '')}"></textarea></div><div class="form-error hidden" data-err></div>` : ''}`,
      foot: `<button class="btn" data-cancel>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirm)}</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    m.querySelector('[data-cancel]').onclick = () => m.close();
    m.querySelector('[data-ok]').onclick = () => {
      const val = note ? m.querySelector('#dlg-note').value.trim() : true;
      if (note?.required && !val) {
        const err = m.querySelector('[data-err]');
        err.textContent = note.requiredText || 'This field is required';
        err.classList.remove('hidden');
        return;
      }
      done = true; m.close(); resolve(val);
    };
  });
}

// ---------- Buttons with loading state ----------
export async function busy(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>${btn.classList.contains('btn-icon') || btn.classList.contains('play') ? '' : html}`;
  try { return await fn(); }
  finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

// ---------- Clipboard & CSV ----------
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

export function downloadCSV(filename, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fatal(title, message) {
  document.body.innerHTML = `<div class="fatal"><h1>${esc(title)}</h1><p>${esc(message)}</p><p style="margin-top:16px"><a href="/login.html">Back to sign in</a></p></div>`;
}
