// The public lead form API: one secret link per workspace, no login.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFake } from './fake-db.mjs';
import { makeFormHandler, makeLeadHandler, resetRate } from '../lib/public-form.js';
import { checkPublicLead } from '../lib/lead-rules.js';

let failed = 0;
const ok = (n, c, why) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + (why || ''))); if (!c) failed++; };
const here = path.dirname(fileURLToPath(import.meta.url));
const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
`);
await db.exec(fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8'));
const fake = makeFake(db, {});
const form = makeFormHandler(() => fake), lead = makeLeadHandler(() => fake);
async function call(h, method, url, body, ip = '1.1.1.1') {
  const l = {};
  const req = { method, url, headers: { 'x-forwarded-for': ip }, on: (e, f) => { l[e] = f; if (e === 'end') setTimeout(() => { if (l.data && body) l.data(JSON.stringify(body)); f(); }, 0); } };
  let out; const res = { statusCode: 200, setHeader() {}, end(s) { out = { status: res.statusCode, json: s ? JSON.parse(s) : null }; } };
  await h(req, res); return out;
}
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const mk = async (email, name) => (await db.query(`insert into auth.users(email, raw_user_meta_data) values ('${email}', '{"name":"${name}"}') returning id`)).rows[0].id;

const W1 = await one(`insert into workspaces(name,slug,short_code) values ('Alpha Co','alpha','AL') returning id, public_form_token`);
const W2 = await one(`insert into workspaces(name,slug,short_code) values ('Beta Co','beta','BE') returning id, public_form_token`);
const W3 = await one(`insert into workspaces(name,slug,short_code) values ('Gamma Co','gamma','GA') returning id, public_form_token`);
await db.query(`update workspaces set status='active'`);
await db.query(`insert into workspace_roles(workspace_id, role_key) values ($1,'lead_gen'),($1,'sales_rep'),($2,'lead_gen')`, [W1.id, W2.id]);
const admin = await mk('a@x.com', 'Boss'); const gen = await mk('g@x.com', 'Gus Gen'); const gen2 = await mk('g2@x.com', 'Zed Gen'); const bgen = await mk('bg@x.com', 'Beta Gen');
await db.query(`update profiles set workspace_id=$1, account_type='admin' where id=$2`, [W1.id, admin]);
await db.query(`update profiles set workspace_id=$1, account_type='member', roles='{lead_gen}' where id=$2`, [W1.id, gen]);
await db.query(`update profiles set workspace_id=$1, account_type='member', roles='{lead_gen}', status='inactive' where id=$2`, [W1.id, gen2]);
await db.query(`update profiles set workspace_id=$1, account_type='member', roles='{lead_gen}' where id=$2`, [W2.id, bgen]);

let r = await call(form, 'GET', `/api/public/form?t=${W1.public_form_token}`);
ok('form returns the workspace name', r.status === 200 && r.json.company === 'Alpha Co');
ok('form lists only active Lead Generation people of that workspace', r.json.agents.length === 1 && r.json.agents[0].id === gen);
r = await call(form, 'GET', `/api/public/form?t=${'a'.repeat(32)}`);
ok('unknown token -> 404', r.status === 404);
r = await call(form, 'GET', `/api/public/form?t=nope`);
ok('malformed token -> 404', r.status === 404);
r = await call(form, 'GET', `/api/public/form?t=${W3.public_form_token}`);
ok('a workspace without Lead Generation people still has a form (agents empty, typed name only)', r.status === 200 && r.json.agents.length === 0);
await db.query(`update workspaces set status='suspended' where id=$1`, [W2.id]);
r = await call(form, 'GET', `/api/public/form?t=${W2.public_form_token}`);
ok('suspended workspace has no form', r.status === 404);
await db.query(`update workspaces set status='active' where id=$1`, [W2.id]);

const good = { t: W1.public_form_token, contact_name: 'tariq  MEHMOOD', company: 'Mehmood Footwear', email: 'tariq@m.com', agent_id: gen, budget: 5000, currency: 'pkr' };
r = await call(lead, 'POST', '/api/public/lead', good);
ok('a good lead is accepted', r.status === 201, JSON.stringify(r.json));
const saved = await one(`select * from leads where company='Mehmood Footwear'`);
ok(saved && saved.workspace_id === W1.id && saved.contact_name === 'Tariq Mehmood' && saved.currency === 'PKR' && saved.agent_id === gen && saved.created_by === null, 'saved in the token\'s workspace, name tidied, no creator');
ok((await one(`select count(*)::int c from notifications where user_id=$1`, [admin])).c >= 1, 'the Admin is notified');

r = await call(lead, 'POST', '/api/public/lead', { ...good, workspace_id: W2.id, company: 'Sneak Co' });
ok('a workspace_id in the body is ignored', r.status === 201 && (await one(`select workspace_id from leads where company='Sneak Co'`)).workspace_id === W1.id);
r = await call(lead, 'POST', '/api/public/lead', { ...good, agent_id: bgen, company: 'Cross Agent' });
ok('an agent from another workspace is refused', r.status === 400 && !(await one(`select 1 x from leads where company='Cross Agent'`)));
r = await call(lead, 'POST', '/api/public/lead', { ...good, agent_id: gen2, company: 'Inactive Agent' });
ok('an inactive agent is refused', r.status === 400);
r = await call(lead, 'POST', '/api/public/lead', { ...good, t: 'b'.repeat(32), company: 'Bad Token' });
ok('bad token on submit -> 404 and nothing saved', r.status === 404 && !(await one(`select 1 x from leads where company='Bad Token'`)));
r = await call(lead, 'POST', '/api/public/lead', { ...good, company: '' });
ok('missing company -> 400', r.status === 400);
r = await call(lead, 'POST', '/api/public/lead', { ...good, email: 'nope', company: 'Bad Mail' });
ok('bad email -> 400', r.status === 400);
r = await call(lead, 'POST', '/api/public/lead', { ...good, agent_id: undefined, agent_name: 'walk in', company: 'Typed Agent' });
ok('a typed agent name is accepted', r.status === 201 && (await one(`select agent_name from leads where company='Typed Agent'`)).agent_name === 'Walk In');
r = await call(lead, 'POST', '/api/public/lead', { ...good, hp: 'x', company: 'Robot Co' });
ok('honeypot: looks fine to the bot, nothing saved', r.status === 200 && !(await one(`select 1 x from leads where company='Robot Co'`)));
r = await call(lead, 'GET', '/api/public/lead');
ok('GET on the submit route -> 405', r.status === 405);
r = await call(lead, 'POST', '/api/public/lead', { ...good, status: 'won', priority: 'urgent', company: 'Stage Co' });
ok('a form lead cannot start as won', (await one(`select status from leads where company='Stage Co'`)).status === 'new');

resetRate();
let last; for (let i = 0; i < 17; i++) last = await call(lead, 'POST', '/api/public/lead', { ...good, hp: 'x' }, '9.9.9.9');
ok('the 16th submission from one address in 10 minutes is refused', last.status === 429);

const a = [{ id: 'u1', name: 'X' }];
ok('rules: agent required', checkPublicLead({ contact_name: 'a', company: 'b' }, a).errors.length === 1);
ok('rules: budget must be a number', checkPublicLead({ contact_name: 'a', company: 'b', agent_name: 'c', budget: -5 }, a).errors[0] === 'Budget must be a number');

console.log(failed ? `\n${failed} FAILED` : '\nPublic form checks passed');
process.exit(failed ? 1 : 0);
