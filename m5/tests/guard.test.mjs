// The Master guard must refuse everyone except an active Master. Run: npm run test:guard
import { makeGuard } from '../lib/master-guard.js';
import ping from '../api/master/ping.js';

let failed = 0;
const ok = (n, c, why) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + why)); if (!c) failed++; };

const users = {
  tokM:  { id: 'm',  profile: { is_master: true,  status: 'active' } },
  tokI:  { id: 'mi', profile: { is_master: true,  status: 'inactive' } },
  tokB:  { id: 'b',  profile: { is_master: false, status: 'active' } },
  tokN:  { id: 'n',  profile: null },
};
const fakeAdmin = {
  auth: { getUser: async (t) => users[t] ? { data: { user: { id: users[t].id } }, error: null } : { data: { user: null }, error: { message: 'bad' } } },
  from: () => ({ select: () => ({ eq: (_c, id) => ({ maybeSingle: async () => {
    const u = Object.values(users).find(x => x.id === id);
    return { data: u ? u.profile : null, error: null };
  } }) }) }),
};
const guard = makeGuard(() => fakeAdmin);
const req = (token, method = 'GET') => ({ method, headers: token ? { authorization: 'Bearer ' + token } : {} });

ok('no token -> 401', (await guard(req())).status === 401);
ok('garbage token -> 401', (await guard(req('nope'))).status === 401);
ok('business member -> 403', (await guard(req('tokB'))).status === 403);
ok('inactive Master -> 403', (await guard(req('tokI'))).status === 403);
ok('user without profile -> 403', (await guard(req('tokN'))).status === 403);
ok('active Master -> allowed', (await guard(req('tokM'))).ok === true);
ok('missing server keys -> 500, not a pass', (await makeGuard(() => null)(req('tokM'))).status === 500);
ok('malformed header -> 401', (await guard({ headers: { authorization: 'tokM' } })).status === 401);

// The real route handler, with no server keys configured: must never answer 200.
const out = {};
const res = { setHeader() {}, end(b) { out.body = b; } };
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SECRET_KEY;
await ping(req('tokM'), res);
ok('ping refuses when the server is not configured', res.statusCode !== 200, res.statusCode);
await ping(req('tokM', 'POST'), res);
ok('ping rejects non-GET', res.statusCode === 405);

console.log(failed ? `\n${failed} FAILED` : '\nGuard checks passed');
process.exit(failed ? 1 : 0);
