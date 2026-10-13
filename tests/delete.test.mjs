// Permanent delete of a person and of a whole workspace, against the real schema.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFake } from './fake-db.mjs';
import { makeWorkGuard } from '../lib/work-guard.js';
import { makeTeamGuard } from '../lib/team-guard.js';
import { makeGuard } from '../lib/master-guard.js';
import { makeHandler as makeProjects } from '../api/projects.js';
import { makeHandler as makeMembers } from '../api/team/members.js';
import { makeHandler as makeWorkspace } from '../api/master/workspace.js';

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
await db.exec(fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8'));   // part 8 must also be re-runnable
const tokens = {}; const fake = makeFake(db, tokens);
const projects = makeProjects(makeWorkGuard(() => fake));
const members = makeMembers(makeTeamGuard(() => fake));
const workspaceApi = makeWorkspace(makeGuard(() => fake));

async function call(h, method, url, token, body) {
  const l = {};
  const req = { method, url, headers: token ? { authorization: 'Bearer ' + token } : {}, on: (e, f) => { l[e] = f; if (e === 'end') setTimeout(() => { if (l.data && body) l.data(JSON.stringify(body)); f(); }, 0); } };
  let out; const res = { statusCode: 200, setHeader() {}, end(s) { out = { status: res.statusCode, json: s ? JSON.parse(s) : null }; } };
  await h(req, res); return out;
}
const mk = async (email, name) => (await db.query(`insert into auth.users(email, raw_user_meta_data) values ('${email}', '{"name":"${name}"}') returning id`)).rows[0].id;
const count = async (sql) => (await db.query(sql)).rows[0].n;
const wsA = (await db.query(`insert into workspaces(name,slug,short_code) values ('Demo Co','demo','DC') returning id`)).rows[0].id;
const wsB = (await db.query(`insert into workspaces(name,slug,short_code) values ('Real Co','real','RC') returning id`)).rows[0].id;
await db.query(`insert into workspace_roles(workspace_id,role_key) values ('${wsA}','project_manager'),('${wsA}','project_agent'),('${wsB}','project_manager')`);
const U = {};
for (const [k, e, n, t, roles, w] of [
  ['admin', 'a@x.com', 'Admin Amir', 'admin', '{}', wsA], ['mgr', 'm@x.com', 'Manager Maya', 'manager', '{}', wsA],
  ['pm', 'p@x.com', 'PM Sara', 'member', '{project_manager}', wsA], ['dan', 'd@x.com', 'Dan Ali', 'member', '{project_agent}', wsA],
  ['bAdmin', 'ba@x.com', 'Real Admin', 'admin', '{}', wsB], ['bPm', 'bp@x.com', 'Real Pm', 'member', '{project_manager}', wsB],
]) {
  const id = await mk(e, n); U[k] = id; tokens['t_' + k] = id;
  await db.query(`update profiles set workspace_id=$1, account_type=$2, roles=$3, job_title=$4, department=$5 where id=$6`, [w, t, roles, k === 'dan' ? 'Designer' : null, k === 'dan' ? 'Design' : null, id]);
}
// A project with a request, approval, comment, member: lots of lines that mention Dan or Sara.
const P = (a, id, t, b) => call(projects, 'POST', `/api/projects?a=${a}&id=${id || ''}`, t, b);
const proj = (await P('create', '', 't_admin', { name: 'Site', manager_id: U.pm })).json.id;
const rq = (await P('request', proj, 't_pm', { items: [{ designation: 'Designer', qty: 1 }] })).json.id;
await P('decide', rq, 't_admin', { decision: 'approve' });
const slot = (await db.query(`select id from staffing_request_items where request_id='${rq}'`)).rows[0].id;
await P('addmember', proj, 't_pm', { user_id: U.dan, item_id: slot });
await P('comment', rq, 't_mgr', { body: 'hi' }).catch(() => {});
await db.query(`insert into request_comments(request_id, author_id, body) values ('${rq}','${U.dan}','from dan')`);
await db.query(`insert into activity_log(workspace_id, actor_id, text, involved) values ('${wsA}','${U.dan}','Dan Ali did something','{}')`);
const danLines = await count(`select count(*)::int n from activity_log where actor_id='${U.dan}' or '${U.dan}' = any(involved)`);
ok('there are activity lines about Dan before deleting', danLines >= 2, danLines);

const del = (id, t, confirm) => call(members, 'POST', `/api/team/members?id=${id}&action=delete`, t, { confirm });
let x = await del(U.dan, 't_mgr', 'Dan Ali');
ok('a Manager cannot delete anyone', x.status === 403);
x = await del(U.admin, 't_admin', 'Admin Amir');
ok('nobody deletes himself', x.status === 403);
x = await del(U.dan, 't_admin', 'dan');
ok('wrong name typed is refused', x.status === 400);
x = await del(U.bPm, 't_admin', 'Real Pm');
ok('cannot delete a person of another workspace', x.status === 404);
x = await del(U.dan, 't_admin', ' dan ali ');
ok('Admin deletes Dan (name confirm is case-insensitive)', x.status === 200);
ok('sign-in account is gone', await count(`select count(*)::int n from auth.users where id='${U.dan}'`) === 0);
ok('profile is gone', await count(`select count(*)::int n from profiles where id='${U.dan}'`) === 0);
ok('every activity line about him is gone', await count(`select count(*)::int n from activity_log where actor_id='${U.dan}' or '${U.dan}' = any(involved)`) === 0);
ok('his comments are gone', await count(`select count(*)::int n from request_comments where author_id='${U.dan}'`) === 0);
ok('his project membership is gone', await count(`select count(*)::int n from project_members where user_id='${U.dan}'`) === 0);
ok('the project and other people\'s lines stay', await count(`select count(*)::int n from projects where id='${proj}'`) === 1 && await count(`select count(*)::int n from activity_log where workspace_id='${wsA}'`) >= 3);
// deleting a Project Manager removes his requests too
x = await del(U.pm, 't_admin', 'PM Sara');
ok('Admin deletes the Project Manager', x.status === 200);
ok('his requests are gone, the project stays with no manager', await count(`select count(*)::int n from staffing_requests where requested_by is null or id='${rq}'`) === 0 && (await db.query(`select manager_id from projects where id='${proj}'`)).rows[0].manager_id === null);

// ── workspace
await db.query(`insert into subscriptions(workspace_id,cycle,amount_original,currency,fx_rate,amount,start_date) values ('${wsA}','monthly',10,'USD',1,10,current_date)`);
await db.query(`insert into master_access_log(workspace_id, action) values ('${wsA}','opened')`);
const master = await mk('boss@x.com', 'Boss'); await db.query(`select promote_to_master('boss@x.com')`); tokens.t_master = master;
const delWs = (id, t, confirm) => call(workspaceApi, 'DELETE', `/api/master/workspace?id=${id}`, t, { confirm });
x = await delWs(wsA, 't_admin', 'Demo Co');
ok('a workspace Admin cannot delete a workspace', x.status === 403);
x = await delWs(wsA, 't_master', 'wrong');
ok('wrong business name refused', x.status === 400);
ok('nothing was deleted by the refusal', await count(`select count(*)::int n from workspaces where id='${wsA}'`) === 1);
x = await delWs(wsA, 't_master', 'demo co');
ok('Master deletes the workspace', x.status === 200 && x.json.accounts_left === 0, JSON.stringify(x));
for (const t of ['workspaces where id', 'profiles where workspace_id', 'projects where workspace_id', 'activity_log where workspace_id', 'notifications where workspace_id', 'subscriptions where workspace_id', 'master_access_log where workspace_id', 'workspace_roles where workspace_id', 'staffing_requests where workspace_id'])
  ok('workspace data gone: ' + t.split(' ')[0], await count(`select count(*)::int n from ${t}='${wsA}'`) === 0);
ok('its people can no longer sign in', await count(`select count(*)::int n from auth.users where email in ('a@x.com','m@x.com')`) === 0);
ok('another workspace is untouched', await count(`select count(*)::int n from profiles where workspace_id='${wsB}'`) === 2 && await count(`select count(*)::int n from workspaces where id='${wsB}'`) === 1);
ok('the Master account is untouched', await count(`select count(*)::int n from profiles where id='${master}' and is_master`) === 1);
try { await db.query(`insert into master_access_log(workspace_id, action) values ('${wsB}','opened')`); await db.query(`delete from master_access_log`); ok('audit log stays append-only outside a purge', false); }
catch { ok('audit log stays append-only outside a purge', true); }

console.log(failed ? `\n${failed} FAILED` : '\nDelete checks passed');
process.exit(failed ? 1 : 0);
