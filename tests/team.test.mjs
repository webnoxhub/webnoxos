// Team rules + the Admin/Manager guard + the handler's workspace isolation (fake Supabase).
import { canManage, canAssignType, checkMember, checkLogo } from '../lib/team-rules.js';
import { makeTeamGuard } from '../lib/team-guard.js';

let failed = 0;
const ok = (n, c, why) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + why)); if (!c) failed++; };

// --- who can manage whom
ok('admin manages manager and member', canManage('admin', 'manager') && canManage('admin', 'member'));
ok('admin cannot manage another admin', !canManage('admin', 'admin'));
ok('manager manages members only', canManage('manager', 'member') && !canManage('manager', 'manager') && !canManage('manager', 'admin'));
ok('member manages nobody', !canManage('member', 'member'));
ok('admin may edit himself', canManage('admin', 'admin', true));
ok('manager may add members only', canAssignType('manager', 'member') && !canAssignType('manager', 'manager'));
ok('admin may add managers and members, never admins', canAssignType('admin', 'manager') && canAssignType('admin', 'member') && !canAssignType('admin', 'admin'));

// --- form checks
const active = ['sales_rep', 'finance'];
let r = checkMember({ name: ' Ali Khan ', email: 'Ali@Example.com', roles: ['finance', 'finance'], phone: '+92 300 1234567', joining_date: '2026-10-13' }, active, { create: true });
ok('valid member passes, email lower-cased, roles de-duplicated', r.errors.length === 0 && r.value.email === 'ali@example.com' && r.value.roles.length === 1, r.errors.join());
r = checkMember({ name: 'A', email: 'bad@gmail.cop,' }, active, { create: true });
ok('bad email refused', r.errors.some((e) => /email/i.test(e)));
r = checkMember({ name: 'A', email: 'a@b.com', roles: ['lead_gen'] }, active, { create: true });
ok('role not switched on in this workspace refused', r.errors.some((e) => /Role not available/.test(e)));
r = checkMember({ name: 'A', email: 'a@b.com', roles: ['ceo'] }, active, { create: true });
ok('unknown role refused', r.errors.length > 0);
r = checkMember({ name: 'A', email: 'a@b.com', joining_date: '2026-02-31' }, active, { create: true });
ok('impossible date refused', r.errors.some((e) => /date/i.test(e)));
r = checkMember({ phone: 'abc' }, active, { create: false });
ok('bad phone refused on edit', r.errors.length === 1);
r = checkMember({ department: 'Sales' }, active, { create: false });
ok('edit only checks fields that are present', r.errors.length === 0 && Object.keys(r.value).join() === 'department');
r = checkMember({ account_type: 'admin' }, active, { create: false });
ok('nobody can be set to admin through the form', r.errors.length === 1);

r = checkMember({ roles: ['project_agent'], reports_to: '7f9c24e8-3b1a-4c55-9a6e-1d2b3c4d5e6f' }, ['project_agent'], { create: false });
ok('project_agent role and a manager id are accepted', r.errors.length === 0 && r.value.reports_to);
r = checkMember({ reports_to: 'not-an-id' }, active, { create: false });
ok('garbage manager id refused', r.errors.length === 1);
r = checkMember({ reports_to: '' }, active, { create: false });
ok('empty manager id clears it', r.errors.length === 0 && r.value.reports_to === null);

// --- workspace logo
ok('png data url accepted', checkLogo('data:image/png;base64,iVBORw0KGgo=').error === null);
ok('empty logo clears it', checkLogo('').value === null && checkLogo(null).error === null);
ok('svg / script / other types refused', !!checkLogo('data:image/svg+xml;base64,PHN2Zz4=').error && !!checkLogo('javascript:alert(1)').error);
ok('huge logo refused', !!checkLogo('data:image/png;base64,' + 'A'.repeat(210000)).error);

// --- guard
const tokens = {
  tAdmin: { id: 'a1' }, tMgr: { id: 'm1' }, tMem: { id: 'p1' }, tMaster: { id: 'ms' }, tOff: { id: 'x1' }, tSusp: { id: 's1' },
};
const profiles = {
  a1: { id: 'a1', account_type: 'admin', status: 'active', workspace_id: 'W1', is_master: false },
  m1: { id: 'm1', account_type: 'manager', status: 'active', workspace_id: 'W1', is_master: false },
  p1: { id: 'p1', account_type: 'member', status: 'active', workspace_id: 'W1', is_master: false },
  ms: { id: 'ms', account_type: 'member', status: 'active', workspace_id: null, is_master: true },
  x1: { id: 'x1', account_type: 'admin', status: 'inactive', workspace_id: 'W1', is_master: false },
  s1: { id: 's1', account_type: 'admin', status: 'active', workspace_id: 'W2', is_master: false },
};
const workspaces = { W1: { id: 'W1', name: 'One', slug: 'one', status: 'active' }, W2: { id: 'W2', name: 'Two', slug: 'two', status: 'suspended' } };
const fake = {
  auth: { getUser: async (t) => tokens[t] ? { data: { user: tokens[t] }, error: null } : { data: { user: null }, error: { message: 'bad' } } },
  from: (table) => ({ select: () => ({ eq: (_c, v) => ({ maybeSingle: async () => ({ data: (table === 'profiles' ? profiles : workspaces)[v] || null, error: null }) }) }) }),
};
const guard = makeTeamGuard(() => fake);
const rq = (t) => ({ headers: t ? { authorization: 'Bearer ' + t } : {} });
ok('no token -> 401', (await guard(rq())).status === 401);
ok('garbage token -> 401', (await guard(rq('zzz'))).status === 401);
ok('plain member -> 403', (await guard(rq('tMem'))).status === 403);
ok('Master is not a team manager -> 403', (await guard(rq('tMaster'))).status === 403);
ok('inactive admin -> 403', (await guard(rq('tOff'))).status === 403);
ok('admin of a suspended workspace -> 403', (await guard(rq('tSusp'))).status === 403);
const ga = await guard(rq('tAdmin'));
ok('admin allowed, workspace comes from HIS profile', ga.ok && ga.workspace.id === 'W1');
ok('manager allowed', (await guard(rq('tMgr'))).ok === true);
ok('no server keys -> 500', (await makeTeamGuard(() => null)(rq('tAdmin'))).status === 500);

console.log(failed ? `\n${failed} FAILED` : '\nTeam checks passed');
process.exit(failed ? 1 : 0);
