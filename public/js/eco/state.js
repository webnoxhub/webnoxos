// Shared app state, filled once at boot by app.js
export const state = {
  user: null,       // Supabase auth user
  profile: null,    // row from profiles
  myRoles: [],      // ['cold_caller', ...]
  roles: [],        // team_roles rows
  settings: null,   // app_settings row
  isOwner: false,   // the admin account (settings + permissions)
  isAdmin: false,   // admin OR manager role: workspace-wide management screens
  perms: {},        // { leads: {view, edit, delete}, clients: {...}, finance: {...} }
  pmPerms: {},      // what the Project Manager role allows on assigned clients
  permRows: [],     // raw role_permissions rows
  projectOf: [],    // project ids the user is an approved member of
};
export const roleName = (key) => state.roles.find((r) => r.key === key)?.name || key;

export const MODULES = ['leads', 'clients', 'finance', 'projects'];

export function computePerms() {
  const all = { view: true, edit: true, delete: true };
  const none = () => ({ view: false, edit: false, delete: false });
  state.perms = {}; state.pmPerms = {};
  for (const m of MODULES) {
    if (state.isAdmin) { state.perms[m] = { ...all }; state.pmPerms[m] = { ...all }; continue; }
    const p = none(); const pm = none();
    for (const r of state.permRows.filter((x) => x.module === m && state.myRoles.includes(x.role_key))) {
      const target = r.role_key === 'project_manager' ? pm : p;
      target.view ||= r.can_view; target.edit ||= r.can_edit; target.delete ||= r.can_delete;
    }
    state.perms[m] = p; state.pmPerms[m] = pm;
  }
}
// can('leads', 'view') — workspace-wide; canAny also counts Project Manager access to assigned clients
export const can = (module, action = 'view') => Boolean(state.perms[module]?.[action]);
export const canAny = (module, action = 'view') => can(module, action) || Boolean(state.pmPerms[module]?.[action]);

export function money(n, { compact = false } = {}) {
  const cur = state.settings?.currency || 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 0, maximumFractionDigits: compact || Number.isInteger(Number(n)) ? 0 : 2, notation: compact ? 'compact' : 'standard' }).format(Number(n) || 0);
  } catch { return `${cur} ${Number(n || 0).toLocaleString()}`; }
}
