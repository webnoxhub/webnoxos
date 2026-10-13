// Runs supabase/schema.sql against an in-memory Postgres (PGlite) and checks the rules.
// Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8');

const db = new PGlite();
let failed = 0;
const pass = (n) => console.log('PASS ' + n);
const fail = (n, why) => { failed++; console.log('FAIL ' + n + (why ? ' -> ' + why : '')); };
const ok = (n, cond, why) => (cond ? pass(n) : fail(n, why));

async function throws(name, sql, match) {
  try { await db.query(sql); fail(name, 'did not throw'); }
  catch (e) { (!match || String(e.message).includes(match)) ? pass(name) : fail(name, e.message); }
}
async function as(uid, sql) {               // run a query as a signed-in user
  await db.exec(`select set_config('request.jwt.claim.sub','${uid}',false); set role authenticated;`);
  try { return (await db.query(sql)).rows; } finally { await db.exec('reset role;'); }
}

// Minimal Supabase stand-ins so the file can run outside Supabase.
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);

// 1. runs twice with no error
try { await db.exec(schema); await db.exec(schema); pass('schema runs twice without error'); }
catch (e) { fail('schema runs twice without error', e.message); console.log(e); process.exit(1); }
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);

const mk = async (email) => (await db.query(`insert into auth.users(email) values ('${email}') returning id`)).rows[0].id;
const m1 = await mk('Webnoxhub@gmail.com'), m2 = await mk('b@x.com'), m3 = await mk('c@x.com'), m4 = await mk('d@x.com');
const a1 = await mk('admin-a@x.com'), a2 = await mk('admin-b@x.com'), mem = await mk('member-a@x.com');

ok('new auth user gets a profile row', (await db.query(`select count(*)::int n from profiles`)).rows[0].n === 7);
ok('profile email is lower-cased', (await db.query(`select email from profiles where id='${m1}'`)).rows[0].email === 'webnoxhub@gmail.com');

// 2. Masters: promote, idempotent, cap of 3
ok('promote_to_master (case-insensitive email)', (await db.query(`select promote_to_master('WEBNOXHUB@gmail.com') r`)).rows[0].r.startsWith('Promoted'));
ok('promoting again is harmless', (await db.query(`select promote_to_master('webnoxhub@gmail.com') r`)).rows[0].r === 'Already a Master');
await db.query(`select promote_to_master('b@x.com')`);
await db.query(`select promote_to_master('c@x.com')`);
await throws('4th Master is refused', `select promote_to_master('d@x.com')`, 'Maximum 3');
await throws('4th Master refused even by a direct update', `update profiles set is_master = true where id='${m4}'`, 'Maximum 3');
await throws('unknown email is refused', `select promote_to_master('nobody@x.com')`, 'No user');

// 3. Workspaces, slug and short_code rules
const wsA = (await db.query(`insert into workspaces(name,slug,short_code) values ('Alpha Co','  Alpha  Co!! ','al') returning id, slug, short_code`)).rows[0];
const wsB = (await db.query(`insert into workspaces(name,slug,short_code,type) values ('Beta','beta','BT','master_project') returning id`)).rows[0];
ok('slug is lower-cased, hyphenated and cleaned', wsA.slug === 'alpha-co', wsA.slug);
ok('short_code is upper-cased', wsA.short_code === 'AL');
ok('public_form_token is generated', (await db.query(`select length(public_form_token) l from workspaces where id='${wsA.id}'`)).rows[0].l === 32);
await throws('duplicate slug refused', `insert into workspaces(name,slug,short_code) values ('x','alpha-co','ZZ')`);
await throws('bad short_code refused', `insert into workspaces(name,slug,short_code) values ('x','x1','a1')`);

// 4. profiles rules
await throws('a Master cannot carry a workspace', `update profiles set workspace_id='${wsA.id}' where id='${m1}'`, 'master_has_no_workspace');
await db.query(`update profiles set workspace_id='${wsA.id}', account_type='admin' where id='${a1}'`);
await db.query(`update profiles set workspace_id='${wsB.id}', account_type='admin' where id='${a2}'`);
await db.query(`update profiles set workspace_id='${wsA.id}' where id='${mem}'`);
await throws('one active admin per workspace', `update profiles set account_type='admin' where id='${mem}'`, 'one_admin_per_workspace');
await throws('last active admin cannot be deactivated', `update profiles set status='inactive' where id='${a1}'`, 'last active admin');
await throws('last active admin cannot be demoted', `update profiles set account_type='member' where id='${a1}'`, 'last active admin');

// 5. RLS isolation (as signed-in users)
ok('member sees own workspace only', (await as(mem, `select id from workspaces`)).length === 1);
ok('member sees nobody outside their workspace', (await as(mem, `select id from profiles`)).every(r => true) && (await as(mem, `select id from profiles where workspace_id='${wsB.id}'`)).length === 0);
ok('plain member cannot read profile rows of colleagues (no emails)', (await as(mem, `select id from profiles`)).length === 1);
ok('team_directory shows the two people of workspace A to a member', (await as(mem, `select id from team_directory()`)).length === 2);
ok('team_directory has no email or phone column', !(await as(mem, `select * from team_directory()`)).some(r => 'email' in r || 'phone' in r));
ok('Admin of A reads the two profiles of A', (await as(a1, `select id from profiles`)).length === 2);
ok('team_directory of B never contains A', (await as(a2, `select id from team_directory()`)).length === 1);
ok('Master gets nothing from team_directory', (await as(m1, `select id from team_directory()`)).length === 0);
await throws('role not activated in the workspace is refused', `update profiles set roles='{finance}' where id='${mem}'`, 'not activated');
await db.query(`insert into workspace_roles(workspace_id,role_key,active) values ('${wsA.id}','finance',true)`);
await db.query(`update profiles set roles='{finance}', phone='0300', joining_date='2026-10-13' where id='${mem}'`);
ok('an activated role can be held', (await db.query(`select roles from profiles where id='${mem}'`)).rows[0].roles[0] === 'finance');
await throws('unknown role key is refused', `update profiles set roles='{ceo}' where id='${mem}'`, 'not activated');
// Part 6: Project Agent + reports_to
await db.query(`insert into workspace_roles(workspace_id,role_key,active) values ('${wsA.id}','project_agent',true)`);
await db.query(`update profiles set roles='{finance,project_agent}', reports_to='${a1}' where id='${mem}'`);
ok('a Project Agent can report to the admin of his workspace', (await db.query(`select reports_to from profiles where id='${mem}'`)).rows[0].reports_to === a1);
await throws('cannot report to himself', `update profiles set reports_to='${mem}' where id='${mem}'`, 'himself');
await throws('cannot report to a plain member', `update profiles set reports_to='${mem}' where id='${a1}'`, 'Reports-to');
await throws('cannot report to someone of another workspace', `update profiles set reports_to='${a2}' where id='${mem}'`, 'Reports-to');
ok('team_directory carries reports_to', (await as(mem, `select reports_to from team_directory() where id='${mem}'`))[0].reports_to === a1);
ok('Master reads every workspace', (await as(m1, `select id from workspaces`)).length === 2);
ok('Master reads his own profile (login check)', (await as(m1, `select is_master from profiles where id='${m1}'`))[0]?.is_master === true);
ok('Master cannot read member profiles directly', (await as(m1, `select id from profiles where id='${mem}'`)).length === 0);
ok('master_member_list: Master sees the 4 non-Master people, no Master rows', (await as(m1, `select id from master_member_list`)).length === 4);
ok('master_member_list is empty for a non-Master', (await as(mem, `select id from master_member_list`)).length === 0);
ok('master_member_list has no email column', !(await db.query(`select column_name from information_schema.columns where table_name='master_member_list'`)).rows.some(r => r.column_name === 'email'));
ok('a user can read their own profile', (await as(mem, `select id from profiles where id='${mem}'`)).length === 1);
async function asThrows(name, uid, sql, match) {   // expect an error when run as a signed-in user
  try { await as(uid, sql); fail(name, 'did not throw'); }
  catch (e) { (!match || String(e.message).includes(match)) ? pass(name) : fail(name, e.message); }
}
const self = await as(mem, `update profiles set is_master = true where id='${mem}' returning id`);
ok('member cannot self-promote to Master (no row updated)', self.length === 0);
ok('member self-promotion changed nothing', (await db.query(`select is_master from profiles where id='${mem}'`)).rows[0].is_master === false);
await asThrows('browser cannot call promote_to_master', mem, `select promote_to_master('d@x.com')`, 'permission denied');

// 6. billing tables
await db.query(`insert into subscriptions(workspace_id,cycle,amount_original,currency,fx_rate,amount,start_date)
                values ('${wsA.id}','monthly',100,'USD',280,0,'2026-10-13')`);
ok('subscription amount converted by trigger', Number((await db.query(`select amount from subscriptions`)).rows[0].amount) === 28000);
await db.query(`insert into subscription_payments(workspace_id,amount_original,currency,fx_rate,amount,paid_on,recorded_by)
                values ('${wsA.id}',50,'USD',281.5,0,'2026-10-13','${m1}')`);
ok('payment amount converted by trigger', Number((await db.query(`select amount from subscription_payments`)).rows[0].amount) === 14075);
ok('Admin of A reads A billing', (await as(a1, `select 1 from subscriptions`)).length === 1);
ok('Admin of B cannot read A billing', (await as(a2, `select 1 from subscriptions`)).length === 0);
ok('plain member cannot read billing', (await as(mem, `select 1 from subscriptions`)).length === 0);
ok('Master reads billing', (await as(m1, `select 1 from subscriptions`)).length === 1);
await db.query(`insert into master_access_log(workspace_id,master_id,action) values ('${wsA.id}','${m1}','opened')`);
await throws('access log cannot be updated', `update master_access_log set action='archived'`, 'append-only');
await throws('access log cannot be deleted', `delete from master_access_log`, 'append-only');
await throws('negative rent refused', `insert into subscriptions(workspace_id,cycle,amount_original,currency,fx_rate,amount,start_date) values ('${wsB.id}','monthly',-1,'USD',1,0,'2026-10-13')`);

// 7. master_create_workspace: role switches (use / edit)
const created = (await db.query(`select public.master_create_workspace(
  'Switch Co','switch-co','SWC','rented','setup',null,'trial_7',0,'PKR',1,current_date,
  '[{"role":"sales_rep","edit":true},{"role":"finance","edit":false}]'::jsonb, '${m1}') as id`)).rows[0].id;
const rr = (await db.query(`select role_key, active, can_edit from workspace_roles where workspace_id='${created}' order by role_key`)).rows;
ok('create RPC stores only the roles switched on', rr.length === 2 && rr.every(r => r.active));
ok('create RPC stores allow-to-edit per role', rr.find(r => r.role_key === 'sales_rep').can_edit === true && rr.find(r => r.role_key === 'finance').can_edit === false);
ok('create RPC makes a trial subscription row', (await db.query(`select 1 from subscriptions where workspace_id='${created}'`)).rows.length === 1);
await throws('create RPC refuses an unknown role', `select public.master_create_workspace('Bad Co','bad-co','BAD','rented','setup',null,null,null,'PKR',1,current_date,'[{"role":"ceo","edit":true}]'::jsonb,'${m1}')`);
await asThrows('browser cannot call master_create_workspace', mem, `select master_create_workspace('X','x-co','XX')`, 'permission denied');

console.log(failed ? `\n${failed} FAILED` : '\nAll database checks passed');
process.exit(failed ? 1 : 0);
