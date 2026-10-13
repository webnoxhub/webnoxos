// Boot: config -> session -> profile -> the right world.
import { getClient } from '/js/supabase.js';
import { esc, icon, toast } from '/js/ui.js';

const LOGIN = '/login.html';
const NAV = [
  { path: '/master', label: 'Home', icon: 'home', page: () => import('/js/pages/master-home.js') },
  { path: '/master/workspaces', label: 'Workspaces', icon: 'building', page: () => import('/js/pages/master-workspaces.js') },
  { path: '/master/finance', label: 'Finance', icon: 'wallet' },
  { path: '/master/activity', label: 'Activity', icon: 'pulse' },
  { path: '/master/settings', label: 'Settings', icon: 'cog' },
];

const MEMBER_NAV = [
  { path: '/home', label: 'Home', icon: 'home', page: () => import('/js/pages/home.js') },
  { path: '/projects', label: 'Projects', icon: 'folder', page: () => import('/js/pages/projects.js') },
  { path: '/team', label: 'Team', icon: 'users', page: () => import('/js/pages/team.js') },
  { path: '/activity', label: 'Activity', icon: 'pulse', boss: true, page: () => import('/js/pages/activity.js') },
  { path: '/tasks', label: 'Tasks', icon: 'check' },
  { path: '/leads', label: 'Leads', icon: 'building' },
  { path: '/finance', label: 'Finance', icon: 'wallet' },
];

boot();

async function boot() {
  let sb;
  try { sb = await getClient(); } catch { return fail('We could not start the app. Check your connection and reload.'); }

  let session = null;
  try { const { data } = await sb.auth.getSession(); session = data && data.session; } catch { /* fall through */ }
  if (!session) return location.replace(LOGIN);

  const { data: prof, error } = await sb.from('profiles')
    .select('id,name,email,status,is_master,workspace_id,account_type').eq('id', session.user.id).maybeSingle();
  if (error) return fail('We could not load your account. Reload to try again.');
  if (!prof) return leave(sb, 'noprofile');
  if (prof.status !== 'active') return leave(sb, 'inactive');
  if (prof.is_master) return masterWorld(sb, prof);
  return memberWorld(sb, prof);
}

async function leave(sb, code) {
  try { await sb.auth.signOut(); } catch { /* ignore */ }
  location.replace(LOGIN + '?m=' + code);
}
async function signOut(sb) {
  try { await sb.auth.signOut(); } catch { /* ignore */ }
  location.replace(LOGIN);
}
function fail(msg) {
  const b = document.getElementById('boot');
  if (b) b.innerHTML = '<p>' + esc(msg) + '</p>';
}

// ---------------------------------------------------------------------------
// Business members: their workspace app is built in later phases.
// ---------------------------------------------------------------------------
async function memberWorld(sb, prof) {
  if (!prof.workspace_id) return leave(sb, 'noprofile');
  const { data: ws } = await sb.from('workspaces').select('name,status').eq('id', prof.workspace_id).maybeSingle();
  if (!ws || ws.status === 'archived' || ws.status === 'suspended') return leave(sb, 'closed');
  document.body.dataset.world = 'business';
  document.getElementById('boot').remove();
  const pill = { admin: 'Admin', manager: 'Manager' }[prof.account_type] || 'Member';
  const nav = MEMBER_NAV.filter((n) => !n.boss || ['admin', 'manager'].includes(prof.account_type));
  mountShell(sb, prof, { bell: true, nav, home: '/home', brand: ws.name, pill, suffix: ws.name, ws });
}

// ---------------------------------------------------------------------------
// Master world
// ---------------------------------------------------------------------------
async function masterWorld(sb, prof) {
  await loadCss('/css/master.css');
  document.body.dataset.world = 'master';
  document.getElementById('boot').remove();
  mountShell(sb, prof, { nav: NAV, home: '/master', brand: 'Webnox OS', pill: 'Master', suffix: 'Webnox OS' });
}

// The shared shell: sidebar, top bar, avatar menu and the hash router.
function mountShell(sb, prof, cfg) {
  const NAV_ = cfg.nav;
  const initials = ((prof.name || prof.email || '?').trim().slice(0, 2)).toUpperCase();
  document.getElementById('app').innerHTML =
    '<div class="shell" id="shell">' +
      '<aside class="sb" id="sb" aria-label="Main">' +
        '<div class="sb-head">' +
          '<svg class="sb-mark" viewBox="0 0 64 40" aria-hidden="true"><defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0" stop-color="#22D3EE"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs>' +
          '<path d="M8 4l2.2 5.8L16 12l-5.8 2.2L8 20l-2.2-5.8L0 12l5.8-2.2z" fill="#22D3EE"/>' +
          '<path d="M26 6h9l-9 28h-9zM42 6h9l-9 28h-9z" fill="url(#g1)"/></svg>' +
          '<div class="sb-title"><p class="sb-brand">' + esc(cfg.brand) + '</p><span class="pill">' + esc(cfg.pill) + '</span></div>' +
        '</div>' +
        '<nav class="sb-nav" id="nav">' + NAV_.map((n) => n.page
          ? '<a class="nav-item" href="#' + n.path + '" data-path="' + n.path + '">' + icon(n.icon) + '<span class="nav-label">' + esc(n.label) + '</span></a>'
          : '<span class="nav-item is-soon" aria-disabled="true">' + icon(n.icon) + '<span class="nav-label">' + esc(n.label) +
            '</span><span class="soon">Soon</span></span>').join('') + '</nav>' +
        '<button class="sb-collapse" id="collapse" type="button" aria-label="Collapse sidebar" aria-pressed="false">' + icon('chevrons') + '<span class="nav-label">Collapse</span></button>' +
      '</aside>' +
      '<div class="scrim" id="scrim"></div>' +
      '<div class="main">' +
        '<div class="gline"></div>' +
        '<header class="top">' +
          '<button class="icon-btn menu-btn" id="menu" type="button" aria-label="Open menu">' + icon('menu', 20) + '</button>' +
          '<h1 class="page-title" id="pageTitle"></h1>' +
          (cfg.bell ? '<div class="bell-wrap" id="bellWrap"></div>' : '') +
          '<div class="avatar-wrap">' +
            '<button class="avatar" id="avatar" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">' + esc(initials) + '</button>' +
            '<div class="menu" id="avatarMenu" hidden>' +
              '<p class="menu-name">' + esc(prof.name || '') + '</p><p class="menu-mail">' + esc(prof.email || '') + '</p>' +
              '<button class="menu-item" id="signout" type="button">' + icon('logout', 16) + ' Sign out</button>' +
            '</div>' +
          '</div>' +
        '</header>' +
        '<main class="view" id="view" tabindex="-1"></main>' +
      '</div>' +
    '</div>';

  const shell = document.getElementById('shell');
  const view = document.getElementById('view');
  const setTitle = (t) => { document.getElementById('pageTitle').textContent = t; document.title = t + ' · ' + cfg.suffix; };

  // Sidebar: collapsed preference (desktop) and overlay (mobile)
  try { if (localStorage.getItem('wx_sb') === '1') shell.classList.add('is-collapsed'); } catch { /* ignore */ }
  const colBtn = document.getElementById('collapse');
  colBtn.setAttribute('aria-pressed', String(shell.classList.contains('is-collapsed')));
  colBtn.addEventListener('click', () => {
    const on = shell.classList.toggle('is-collapsed');
    colBtn.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('wx_sb', on ? '1' : '0'); } catch { /* ignore */ }
  });
  const closeNav = () => shell.classList.remove('is-open');
  document.getElementById('menu').addEventListener('click', () => shell.classList.toggle('is-open'));
  document.getElementById('scrim').addEventListener('click', closeNav);

  // Avatar menu
  const av = document.getElementById('avatar'), menu = document.getElementById('avatarMenu');
  const setMenu = (open) => { menu.hidden = !open; av.setAttribute('aria-expanded', String(open)); };
  av.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); closeNav(); } });
  document.getElementById('signout').addEventListener('click', () => signOut(sb));

  if (cfg.bell) import('/js/notify.js').then((m) => m.mountBell(sb, document.getElementById('bellWrap'))).catch(() => {});

  // Router
  async function route() {
    const path = (location.hash.slice(1) || cfg.home).split('?')[0];
    const item = NAV_.find((n) => n.page && n.path === path);
    if (!item) {
      if (location.hash) toast('That page is not available.');
      location.replace('#' + cfg.home);
      return;
    }
    document.querySelectorAll('.nav-item[data-path]').forEach((a) =>
      a.classList.toggle('is-active', a.dataset.path === path));
    closeNav();
    try {
      const mod = await item.page();
      await mod.default({ el: view, sb, profile: prof, setTitle, workspace: cfg.ws });
    } catch {
      view.innerHTML = '<div class="empty"><p>This page could not be loaded.</p></div>';
    }
    view.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);
  route();
}

function loadCss(href) {
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href;
    l.onload = l.onerror = () => resolve();
    document.head.appendChild(l);
  });
}
