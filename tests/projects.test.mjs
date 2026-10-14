// Projects + staffing requests: pure rules, then the real handlers against the real schema (PGlite).
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject, checkRequest, canDecide, canMove, agentFits, itemsLabel, say } from '../lib/project-rules.js';
import { makeFake } from './fake-db.mjs';
import { makeWorkGuard } from '../lib/work-guard.js';
import { makeHandler as makeProjects } from '../api/projects.js';
import { makeHandler as makeInbox } from '../api/inbox.js';

let failed = 0;
const ok = (n, c, why) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' -> ' + (why || ''))); if (!c) failed++; };

// ── pure rules ──────────────────────────────────────────────────────────────
ok('project needs a name', checkProject({}, { create: true }).errors.length === 1);
ok('project status must be known', checkProject({ status: 'zzz' }, { create: false }).errors.length === 1);
ok('empty manager id clears it', checkProject({ manager_id: '' }, { create: false }).value.manager_id === null);
let r = checkRequest({ items: [{ designation: 'Designer', qty: 2 }, { designation: 'designer', qty: 1 }] });
ok('same designation twice refused', r.errors.length === 1);
r = checkRequest({ items: [{ designation: 'Designer', qty: 0 }] });
ok('quantity 0 refused', r.errors.length === 1);
r = checkRequest({ items: [] });
ok('empty request refused', r.errors.length === 1);
r = checkRequest({ items: [{ designation: ' Designer ', qty: '2', department: 'Design' }, { designation: 'Developer', qty: 1 }] });
ok('good request passes', r.errors.length === 0 && r.value.items[0].qty === 2 && itemsLabel(r.value.items) === 'Designer, Developer');
ok('admin and manager may decide, not on their own request', canDecide({ id: 'a', account_type: 'admin' }, 'x') && canDecide({ id: 'm', account_type: 'manager' }, 'x') && !canDecide({ id: 'm', account_type: 'manager' }, 'm') && !canDecide({ id: 'p', account_type: 'member' }, 'x'));
ok('closed requests cannot move; discuss only from pending', !canMove('approved', 'decline') && !canMove('declined', 'approve') && canMove('pending', 'discuss') && !canMove('discussing', 'discuss') && canMove('discussing', 'approve'));
const item = { designation: 'Designer', department: 'Design', qty: 1 };
const ag = { status: 'active', roles: ['project_agent'], account_type: 'member', job_title: 'designer', department: 'DESIGN' };
ok('agent fits by designation and department, case-insensitive', agentFits(ag, item));
ok('agent without the role does not fit', !agentFits({ ...ag, roles: [] }, item));
ok('wrong designation does not fit', !agentFits({ ...ag, job_title: 'Developer' }, item));
ok('wrong department does not fit', !agentFits({ ...ag, department: 'Sales' }, item));
ok('log sentence reads as plain English', say.approved('Ali', 'Designer', 'Web') === 'Ali approved the Designer request on Web' && say.approved('Ali', 'Designer', 'Web', 'your') === 'Ali approved your Designer request on Web');

// ── real schema + handlers ──────────────────────────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8');
const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
`);
await db.exec(schema);

const tokens = {};
const fake = makeFake(db, tokens);
const guard = makeWorkGuard(() => fake);
const projects = makeProjects(guard), inbox = makeInbox(guard);

async function call(h, method, url, token, body) {
  const listeners = {};
  const req = { method, url, headers: token ? { authorization: 'Bearer ' + token } : {}, on: (e, f) => { listeners[e] = f; if (e === 'end') setTimeout(() => { if (listeners.data && body) listeners.data(JSON.stringify(body)); f(); }, 0); } };
  let out = { status: 200, json: null };
  const res = { statusCode: 200, setHeader() {}, end(s) { out = { status: res.statusCode, json: s ? JSON.parse(s) : null }; } };
  await h(req, res);
  return out;
}
const P = (a, id, tok, body, method = 'POST') => call(projects, method, `/api/projects?a=${a}${id ? '&id=' + id : ''}`, tok, body);

const mk = async (email, name) => (await db.query(`insert into auth.users(email, raw_user_meta_data) values ('${email}', '{"name":"${name}"}') returning id`)).rows[0].id;
const ws = (await db.query(`insert into workspaces(name,slug,short_code) values ('Alpha','alpha','AL') returning id`)).rows[0].id;
const ws2 = (await db.query(`insert into workspaces(name,slug,short_code) values ('Beta','beta','BE') returning id`)).rows[0].id;
await db.query(`insert into workspace_roles(workspace_id,role_key) values ('${ws}','project_manager'),('${ws}','project_agent'),('${ws2}','project_manager')`);
const people = {};
for (const [k, email, name, type, roles, title, dept, w] of [
  ['admin', 'adm@x.com', 'Admin Amir', 'admin', '{}', null, null, ws],
  ['mgr', 'mgr@x.com', 'Manager Maya', 'manager', '{}', null, 'Design', ws],
  ['pm', 'pm@x.com', 'PM Sara', 'member', '{project_manager}', null, null, ws],
  ['des', 'des@x.com', 'Designer Dan', 'member', '{project_agent}', 'Designer', 'Design', ws],
  ['dev', 'dev@x.com', 'Dev Dina', 'member', '{project_agent}', 'Developer', 'Development', ws],
  ['plain', 'plain@x.com', 'Plain Pat', 'member', '{}', null, null, ws],
  ['otherAdmin', 'oa@x.com', 'Other Olu', 'admin', '{}', null, null, ws2],
  ['otherPm', 'opm@x.com', 'Other Pam', 'member', '{project_manager}', null, null, ws2],
]) {
  const id = await mk(email, name); people[k] = id; tokens['t_' + k] = id;
  await db.query(`update profiles set workspace_id=$1, account_type=$2, roles=$3, job_title=$4, department=$5 where id=$6`, [w, type, roles, title, dept, id]);
}
const T = (k) => 't_' + k;

// create project
let x = await P('create', null, T('pm'), { name: 'Hack' });
ok('a Project Manager cannot create projects', x.status === 403);
x = await P('create', null, T('admin'), { name: '  ' });
ok('project without a name refused', x.status === 400);
x = await P('create', null, T('admin'), { name: 'Website', client: 'Acme', manager_id: people.des });
ok('manager_id must be a Project Manager', x.status === 400);
x = await P('create', null, T('admin'), { name: 'Website', client: 'Acme', manager_id: people.otherPm });
ok('Project Manager of another workspace refused', x.status === 400);
x = await P('create', null, T('admin'), { name: 'Website', client: 'Acme', manager_id: people.pm });
ok('admin creates a project with a Project Manager', x.status === 201 && x.json.id);
const proj = x.json.id;
let n = await call(inbox, 'GET', '/api/inbox?a=notifications', T('pm'));
ok('the Project Manager is notified of the assignment', n.json.unread === 1 && /assigned PM Sara as Project Manager of Website/.test(n.json.items[0].text));

// visibility
x = await P('get', proj, T('plain'), null, 'GET');
ok('a person outside the project cannot open it', x.status === 404);
x = await P('get', proj, T('otherAdmin'), null, 'GET');
ok('another workspace cannot open it', x.status === 404);
x = await P('list', null, T('plain'), null, 'GET');
ok('list is empty for an outsider', x.json.projects.length === 0);
x = await P('list', null, T('mgr'), null, 'GET');
ok('a Manager sees every project of the workspace', x.json.projects.length === 1 && x.json.pms.length === 1);

// request
x = await P('request', proj, T('admin'), { items: [{ designation: 'Designer', qty: 1 }] });
ok('only the project\'s Project Manager can send a request', x.status === 403);
x = await P('request', proj, T('pm'), { items: [] });
ok('empty request refused', x.status === 400);
x = await P('request', proj, T('pm'), { items: [{ designation: 'Designer', qty: 2, department: 'Design' }, { designation: 'Developer', qty: 1 }], note: 'Need soon' });
ok('Project Manager sends a request', x.status === 201);
const rq = x.json.id;
n = await call(inbox, 'GET', '/api/inbox?a=notifications', T('mgr'));
ok('every Admin and Manager is notified', n.json.unread === 1 && /sent a Designer, Developer request for Website/.test(n.json.items[0].text));
n = await call(inbox, 'GET', '/api/inbox?a=notifications', T('plain'));
ok('a plain member gets nothing', n.json.unread === 0);

// adding before approval
let d = await P('get', proj, T('pm'), null, 'GET');
const slot = d.json.requests[0].items.find((i) => i.designation === 'Designer').id;
x = await P('addmember', proj, T('pm'), { user_id: people.des, item_id: slot });
ok('cannot add people before approval', x.status === 403);

// decisions
x = await P('decide', rq, T('pm'), { decision: 'approve' });
ok('the Project Manager cannot approve his own request', x.status === 403);
x = await P('decide', rq, T('plain'), { decision: 'approve' });
ok('a plain member cannot decide', x.status === 404 || x.status === 403);
x = await P('decide', rq, T('mgr'), { decision: 'discuss', note: 'Do we need 2 designers?' });
ok('a Manager can open a discussion', x.status === 200 && x.json.status === 'discussing');
n = await call(inbox, 'GET', '/api/inbox?a=notifications', T('pm'));
ok('Project Manager hears about the discussion in English', n.json.items.some((i) => i.text === 'Manager Maya opened a discussion on your Designer, Developer request on Website'));
x = await P('comment', rq, T('pm'), { body: 'Yes, two pages in parallel.' });
ok('the Project Manager can reply', x.status === 201);
x = await P('comment', rq, T('plain'), { body: 'hi' });
ok('an outsider cannot comment', x.status >= 400);
x = await P('decide', rq, T('admin'), { decision: 'approve', note: 'Go ahead' });
ok('the Admin approves', x.status === 200 && x.json.status === 'approved');
x = await P('decide', rq, T('mgr'), { decision: 'decline' });
ok('an approved request is closed', x.status === 400);
x = await P('comment', rq, T('pm'), { body: 'late' });
ok('no comments after closing', x.status === 400);
n = await call(inbox, 'GET', '/api/inbox?a=notifications', T('pm'));
ok('approval reaches the Project Manager', n.json.items.some((i) => i.text === 'Admin Amir approved your Designer, Developer request on Website'));
n = await call(inbox, 'GET', '/api/inbox?a=notifications', T('mgr'));
ok('other Managers hear about it too', n.json.items.some((i) => i.text === 'Admin Amir approved the Designer, Developer request on Website'));

// adding people after approval
d = await P('get', proj, T('pm'), null, 'GET');
ok('decision shows who approved', d.json.requests[0].decided_by === 'Admin Amir' && d.json.requests[0].decision_note === 'Go ahead');
ok('only matching agents are offered', d.json.candidates[slot].length === 1 && d.json.candidates[slot][0].name === 'Designer Dan');
x = await P('addmember', proj, T('pm'), { user_id: people.dev, item_id: slot });
ok('a Developer cannot fill a Designer slot', x.status === 400);
x = await P('addmember', proj, T('mgr'), { user_id: people.des, item_id: slot });
ok('only the Project Manager adds people', x.status === 403);
x = await P('addmember', proj, T('pm'), { user_id: people.des, item_id: slot });
ok('Project Manager fills the slot', x.status === 201);
x = await P('addmember', proj, T('pm'), { user_id: people.des, item_id: slot });
ok('same person twice refused', x.status === 400);
n = await call(inbox, 'GET', '/api/inbox?a=notifications', T('des'));
ok('the added agent is notified', n.json.items.some((i) => i.text === 'PM Sara added Designer Dan to Website'));
x = await P('get', proj, T('des'), null, 'GET');
ok('the added agent can now open the project', x.status === 200 && x.json.members.length === 1);
x = await P('list', null, T('des'), null, 'GET');
ok('and sees it in his list', x.json.projects.length === 1);

// decline path
x = await P('request', proj, T('pm'), { items: [{ designation: 'Copywriter', qty: 1 }] });
const rq2 = x.json.id;
x = await P('decide', rq2, T('admin'), { decision: 'decline', note: 'No budget' });
ok('decline works', x.status === 200 && x.json.status === 'declined');
d = await P('get', proj, T('pm'), null, 'GET');
const dr = d.json.requests.find((q) => q.id === rq2);
ok('declined request shows who declined', dr.status === 'declined' && dr.decided_by === 'Admin Amir');
x = await P('addmember', proj, T('pm'), { user_id: people.des, item_id: dr.items[0].id });
ok('declined slots cannot be filled', x.status === 403);

// remove + activity
x = await P('removemember', proj, T('mgr'), { user_id: people.des });
ok('a Manager can remove someone', x.status === 200);
let act = await call(inbox, 'GET', '/api/inbox?a=activity', T('admin'));
ok('activity log says who approved, in English', act.json.items.some((i) => i.text === 'Admin Amir approved the Designer, Developer request on Website'));
ok('activity log has the decline and the removal', act.json.items.some((i) => /declined the Copywriter request/.test(i.text)) && act.json.items.some((i) => /removed Designer Dan from Website/.test(i.text)));
act = await call(inbox, 'GET', '/api/inbox?a=activity', T('pm'));
ok('activity is for Admin and Manager only', act.status === 403);
act = await call(inbox, 'GET', '/api/inbox?a=activity', T('otherAdmin'));
ok('another workspace sees none of it', act.status === 200 && act.json.items.length === 0);

// read state
x = await call(inbox, 'POST', '/api/inbox?a=read', T('pm'), {});
n = await call(inbox, 'GET', '/api/inbox?a=notifications', T('pm'));
ok('mark all read clears the count', x.status === 200 && n.json.unread === 0);
x = await P('list', null, null, null, 'GET');
ok('no token -> 401', x.status === 401);

// database walls
try { await db.query(`insert into project_members(project_id,user_id) values ('${proj}','${people.otherPm}')`); ok('DB refuses a member from another workspace', false); }
catch { ok('DB refuses a member from another workspace', true); }
try { await db.query(`update projects set manager_id='${people.des}' where id='${proj}'`); ok('DB refuses a non-Project-Manager as manager', false); }
catch { ok('DB refuses a non-Project-Manager as manager', true); }
await db.exec(`grant select on all tables in schema public to authenticated; select set_config('request.jwt.claim.sub','${people.pm}',false); set role authenticated;`);
const direct = (await db.query(`select id from projects`)).rows.length
  + (await db.query(`select id from notifications where user_id <> '${people.pm}'`)).rows.length;
await db.exec('reset role;');
ok('browser (RLS) cannot read project tables or others' notifications directly', direct === 0);

console.log(failed ? `\n${failed} FAILED` : '\nProject checks passed');
process.exit(failed ? 1 : 0);
