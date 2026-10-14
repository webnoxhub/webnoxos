// Workspace app shell: boot, role-based navigation, hash router.
// Started by /js/app.js once it knows the person belongs to a workspace.
import { supabase } from './supabase.js';
import { state, computePerms, can, canAny } from './state.js';
import { q, withManager } from './data.js';
import { setTimezone } from './time.js';
import { startTracking, endTracking } from './tracker.js';
import { refreshTimer, mountTimerPill } from './timer.js';
import { esc, icon, avatar, fullName, closeDrawer, ROLE_ICONS, toast } from './ui.js';

// Pages that exist so far. Each phase adds its pages here.
const READY = new Set(['admin-dashboard', 'member-home', 'team', 'tasks', 'my-tasks', 'tracking', 'logins', 'logs', 'my-activity', 'profile', 'settings']);

const ADMIN_NAV = [
  { route: 'dashboard', label: 'Dashboard', icon: 'dashboard', page: 'admin-dashboard' },
  { route: 'team', label: 'Team', icon: 'users', page: 'team' },
  { route: 'permissions', label: 'Permissions', icon: 'shield', page: 'permissions', owner: true },
  { route: 'tasks', label: 'Tasks', icon: 'tasks', page: 'tasks' },
  { route: 'leads', label: 'Leads', icon: 'target', page: 'leads' },
  { route: 'clients', label: 'Clients', icon: 'briefcase', page: 'clients' },
  { route: 'projects', label: 'Projects', icon: 'folder', page: 'projects' },
  { route: 'finance', label: 'Finance', icon: 'wallet', page: 'finance' },
  { route: 'tracking', label: 'Work tracking', icon: 'chart', page: 'tracking' },
  { route: 'logins', label: 'Login history', icon: 'login', page: 'logins' },
  { route: 'logs', label: 'Activity logs', icon: 'activity', page: 'logs' },
  { route: 'settings', label: 'Settings', icon: 'settings', page: 'settings', owner: true },
];
// Extra items a manager (non-admin) gets for their own work
const MANAGER_SELF = [
  { route: 'my-tasks', label: 'My tasks', icon: 'tasks', page: 'my-tasks' },
  { route: 'my-time', label: 'My work time', icon: 'clock', page: 'tracking' },
  { route: 'profile', label: 'Profile', icon: 'user', page: 'profile' },
];
function memberNav() {
  return [
    { route: 'home', label: 'Dashboard', icon: 'home', page: 'member-home' },
    { route: 'my-tasks', label: 'My tasks', icon: 'tasks', page: 'my-tasks' },
    { route: 'team', label: 'Team', icon: 'users', page: 'team' },
    can('leads') && { route: 'leads', label: 'Leads', icon: 'target', page: 'leads' },
    (canAny('clients') || state.agentOf?.length) && { route: 'clients', label: state.perms.clients?.view ? 'Clients' : 'My clients', icon: 'briefcase', page: 'clients' },
    (canAny('projects') || state.projectOf.length) && { route: 'projects', label: can('projects') ? 'Projects' : 'My projects', icon: 'folder', page: 'projects' },
    can('finance') && { route: 'finance', label: 'Finance', icon: 'wallet', page: 'finance' },
    { route: 'my-time', label: 'My work time', icon: 'clock', page: 'tracking' },
    { route: 'my-activity', label: 'My activity', icon: 'activity', page: 'my-activity' },
    { route: 'profile', label: 'Profile', icon: 'user', page: 'profile' },
  ].filter(Boolean);
}

const MARK = '<svg class="ws-mark" viewBox="0 0 64 40" aria-hidden="true"><defs><linearGradient id="wg" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#22D3EE"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs>' +
  '<path d="M8 4l2.2 5.8L16 12l-5.8 2.2L8 20l-2.2-5.8L0 12l5.8-2.2z" fill="#22D3EE"/>' +
  '<path d="M26 6h9l-9 28h-9zM42 6h9l-9 28h-9z" fill="url(#wg)"/></svg>';
const logoHtml = (src) => (src ? `<img class="brand-logo" alt="" src="${esc(src)}">` : MARK);

const PILL = { admin: 'Admin', manager: 'Manager' };
let signingOut = false;
let cleanup = null;
let routeSeq = 0;

export async function start({ profile: boot, workspace }) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return location.replace('/login.html');
  state.user = session.user;
  state.workspace = workspace;

  const [profile, roles, settings] = await Promise.all([
    q(supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle()),
    q(supabase.from('team_roles').select('*').order('sort')),
    q(supabase.from('app_settings').select('*').eq('workspace_id', workspace.id).maybeSingle()),
  ]);
  if (!profile || profile.status !== 'active') { await supabase.auth.signOut(); return location.replace('/login.html?m=inactive'); }

  state.profile = profile;
  state.myRoles = withManager(profile).sort((a, b) => roles.findIndex((x) => x.key === a) - roles.findIndex((x) => x.key === b));
  state.roles = roles;
  state.settings = settings || { workspace_id: workspace.id, timezone: 'Asia/Karachi', idle_minutes: 5, company_name: workspace.name, currency: 'USD' };
  state.isOwner = profile.account_type === 'admin';
  state.isAdmin = state.isOwner || profile.account_type === 'manager';
  state.permRows = [];
  state.agentOf = [];
  state.projectOf = [];
  computePerms();
  setTimezone(state.settings.timezone);

  // A sign-in that happened a moment ago is a "login"; reopening the app later is a "resume".
  const fresh = Date.now() - Date.parse(session.user.last_sign_in_at || 0) < 90_000;
  await startTracking({ userId: profile.id, idleMinutes: state.settings.idle_minutes, via: fresh ? 'login' : 'resume' });

  renderShell();
  await refreshTimer();
  window.addEventListener('hashchange', route);
  route();

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && !signingOut) location.replace(loginUrl());
  });
  window.addEventListener('ehos:account-inactive', async () => {
    signingOut = true;
    await supabase.auth.signOut();
    location.replace('/login.html?m=inactive');
  });
  // keep the timer pill honest if the server paused it (e.g. after a long sleep)
  setInterval(refreshTimer, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshTimer(); });
}

const loginUrl = () => '/login.html' + (state.workspace?.slug ? '?w=' + encodeURIComponent(state.workspace.slug) : '');
const roleLine = () => `${PILL[state.profile.account_type] || 'Member'} of ${state.workspace.name}`;

function navItems() {
  const keep = (n) => READY.has(n.page);
  if (!state.isAdmin) return memberNav().filter(keep);
  const items = ADMIN_NAV.filter((n) => (!n.owner || state.isOwner) && keep(n));
  return state.isOwner ? items.concat([{ route: 'profile', label: 'Profile', icon: 'user', page: 'profile', hidden: true }]) : items.concat(MANAGER_SELF);
}

function renderShell() {
  const p = state.profile;
  const nav = navItems();
  const roleLinks = !state.isOwner && state.myRoles.length ? `
    <div class="nav-title">My roles</div>
    ${state.myRoles.map((key) => {
      const r = state.roles.find((x) => x.key === key);
      return `<a href="#/role/${esc(key)}" data-route="role/${esc(key)}" title="${esc(r?.name || key)}">${icon(ROLE_ICONS[key] || 'briefcase')}<span style="flex:1">${esc(r?.name || key)}</span><span class="role-dot" data-role="${esc(key)}"></span></a>`;
    }).join('')}` : '';

  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar" aria-label="Main navigation">
        <div class="brand ws-brand">
          <div class="brand-logo-box" id="brandLogo">${logoHtml(state.workspace.logo_url)}</div>
          <div class="brand-name">${esc(fullName(p))}<small>${esc(roleLine())}</small></div>
        </div>
        <nav class="nav">
          ${nav.filter((n) => !n.hidden).map((n) => `${n.route === 'my-tasks' && state.isAdmin ? '<div class="nav-title">My work</div>' : ''}<a href="#/${n.route}" data-route="${n.route}" title="${n.label}">${icon(n.icon)}<span>${n.label}</span></a>`).join('')}
          ${roleLinks}
        </nav>
        <div class="sidebar-foot">
          <p class="tracking-note">${icon('shield', 13)}<span>Sign-ins, active time and task timers are recorded. ${state.isOwner ? '' : '<a href="#/my-activity">See your records</a>'}</span></p>
          <div class="me">
            <div class="who">${avatar(p)}<div><div class="name">${esc(fullName(p))}</div><div class="sub">${state.isOwner ? 'Admin' : state.isAdmin ? 'Manager' : esc(p.job_title || 'Team member')}</div></div></div>
            <button class="btn btn-ghost btn-icon btn-sm" id="signout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn btn-ghost btn-icon menu-btn" id="menu" aria-label="Open menu">${icon('menu', 18)}</button>
          <button class="btn btn-ghost btn-icon collapse-btn" id="collapse" aria-label="Collapse sidebar" title="Collapse sidebar">${icon('sidebar', 18)}</button>
          <div class="page-title" id="page-title"></div>
          <div class="spacer"></div>
          <div id="timer-slot"></div>
          <div id="bell-slot"></div>
          <div class="pmenu-wrap">
            <button class="pmenu-btn" id="pmenu" aria-haspopup="true" aria-expanded="false" aria-label="Your account">${avatar(p)}</button>
          </div>
        </header>
        <main class="content" id="content"></main>
        <footer class="app-foot">© 2026 Powered by Webnox OS. All rights reserved.</footer>
      </div>
    </div>`;

  const shell = document.querySelector('.shell');
  document.getElementById('menu').onclick = () => shell.classList.toggle('nav-open');
  shell.addEventListener('click', (e) => {
    if (shell.classList.contains('nav-open') && (e.target.closest('.nav a') || e.target === shell)) shell.classList.remove('nav-open');
  });
  document.getElementById('signout').onclick = signOut;

  // Collapse / expand the sidebar (desktop), remembered per browser
  const setCollapsed = (on) => {
    shell.classList.toggle('collapsed', on);
    const b = document.getElementById('collapse');
    b.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar'); b.title = b.getAttribute('aria-label');
    try { localStorage.setItem('ehos.sidebar', on ? 'collapsed' : 'open'); } catch { /* ignore */ }
  };
  let startCollapsed = false;
  try { startCollapsed = localStorage.getItem('ehos.sidebar') === 'collapsed'; } catch { /* ignore */ }
  setCollapsed(startCollapsed);
  document.getElementById('collapse').onclick = () => setCollapsed(!shell.classList.contains('collapsed'));

  // Account menu (top right)
  const pbtn = document.getElementById('pmenu');
  let pmenu = null;
  const closeMenu = () => { pmenu?.remove(); pmenu = null; pbtn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outsideMenu, true); };
  const outsideMenu = (e) => { if (pmenu && !pmenu.contains(e.target) && !pbtn.contains(e.target)) closeMenu(); };
  pbtn.onclick = () => {
    if (pmenu) return closeMenu();
    pmenu = document.createElement('div');
    pmenu.className = 'pmenu';
    pmenu.setAttribute('role', 'menu');
    pmenu.innerHTML = `
      <div class="pmenu-head">${avatar(p, 'lg')}<div style="min-width:0"><div class="name">${esc(fullName(p))}</div><div class="sub">${esc(p.email)}</div>
        <div class="sub">${esc(roleLine())}</div></div></div>
      <a role="menuitem" href="#/profile">${icon('user', 16)}My profile</a>
      ${state.isOwner && READY.has('settings') ? `<a role="menuitem" href="#/settings">${icon('settings', 16)}Settings</a>` : ''}
      ${state.isOwner && READY.has('permissions') ? `<a role="menuitem" href="#/permissions">${icon('shield', 16)}Permissions</a>` : ''}
      <a role="menuitem" href="#/profile">${icon('key', 16)}Change password</a>
      ${state.isOwner ? `<button role="menuitem" data-logo>${icon('image', 16)}Workspace logo</button>` : ''}
      ${state.isOwner ? '' : `<a role="menuitem" href="#/my-activity">${icon('activity', 16)}My activity</a>`}
      <div class="pmenu-sep"></div>
      <button role="menuitem" class="danger" data-signout>${icon('logout', 16)}Sign out</button>`;
    document.body.append(pmenu);
    pbtn.setAttribute('aria-expanded', 'true');
    pmenu.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));
    pmenu.querySelector('[data-signout]').onclick = () => { closeMenu(); signOut(); };
    const lg = pmenu.querySelector('[data-logo]');
    if (lg) lg.onclick = () => {
      closeMenu();
      import('./logo.js').then((m) => m.openLogoModal(state.workspace.logo_url || '', (logo) => {
        state.workspace.logo_url = logo || '';
        document.getElementById('brandLogo').innerHTML = logoHtml(state.workspace.logo_url);
      }));
    };
    setTimeout(() => document.addEventListener('click', outsideMenu, true), 0);
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pmenu) closeMenu(); });

  import('./notify.js').then((m) => m.mountBell(document.getElementById('bell-slot')));
  mountTimerPill(document.getElementById('timer-slot'), async (taskId) => {
    const { openTaskDrawer } = await import('./task-drawer.js');
    openTaskDrawer(taskId);
  });
}

// Clicking anywhere on a date field opens the calendar
document.addEventListener('click', (e) => {
  const i = e.target.closest?.('input[type="date"]');
  if (i && !i.disabled && !i.readOnly && typeof i.showPicker === 'function') { try { i.showPicker(); } catch { /* not allowed here */ } }
});

async function signOut() {
  signingOut = true;
  const btn = document.getElementById('signout');
  if (btn) btn.disabled = true;
  await endTracking();
  await supabase.auth.signOut();
  location.replace(loginUrl());
}

async function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const nav = navItems();
  let item = nav.find((n) => n.route === path);
  let arg = null;

  if (!item && !state.isOwner && path.startsWith('role/')) {
    arg = path.slice(5);
    if (state.myRoles.includes(arg)) item = { route: path, page: 'my-tasks', label: state.roles.find((r) => r.key === arg)?.name };
  }
  if (!item) { location.replace(`#/${nav[0].route}`); return; }

  document.querySelectorAll('.nav a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.route === item.route));
  document.querySelectorAll('.nav a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
  closeDrawer();
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;

  const el = document.getElementById('content');
  const title = document.getElementById('page-title');
  title.textContent = item.label || '';
  el.innerHTML = '';
  window.scrollTo(0, 0);
  const seq = ++routeSeq;
  try {
    const mod = await import(`./pages/${item.page}.js`);
    const c = await mod.render({ el, params, arg, route: item.route, setTitle: (t) => { title.textContent = t; } });
    if (seq === routeSeq) cleanup = c; else if (typeof c === 'function') c();
  } catch (e) {
    el.innerHTML = `<div class="panel"><div class="empty"><h3>This page didn't load</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`;
  }
}

export { toast };
