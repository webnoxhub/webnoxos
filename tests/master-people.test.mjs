// Master adds and edits Admins / Managers inside an existing workspace.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFake } from './fake-db.mjs';
import { makeGuard } from '../lib/master-guard.js';
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
const tokens = {}; const fake = makeFake(db, tokens);
const api = makeWorkspace(makeGuard(() => fake));
async function call(method, url, token, body) {
  const l = {};
  const req = { method, url, headers: token ? { authorization: 'Bearer ' + token } : {}, on: (e, f) => { l[e] = f; if (e === 'end') setTimeout(() => { if (l.data && body) l.data(JSON.stringify(body)); f(); }, 0); } };
  let out; const res = { statusCode: 200, setHeader() {}, end(s) { out = { status: res.statusCode, json: s ? JSON.parse(s) : null }; } };
  await api(req, res); return out;
}
const mk = async (email, name) => (await db.query(`insert into auth.users(email, raw_user_meta_data) values ('${email}', '{"name":"${name}"}') returning id`)).rows[0].id;
const one = async (sql) => (await db.query(sql)).rows[0];
const wsA = (await one(`insert into workspaces(name,slug,short_code) values ('Demo Co','demo','DC') returning id`)).id;
const wsB = (await one(`insert into workspaces(name,slug,short_code) values ('Real Co','real','RC') returning id`)).id;
const adminA = await mk('a@x.com', 'Amir'); const mem = await mk('m@x.com', 'Mem'); const adminB = await mk('b@x.com', 'Bela');
await db.query(`update profiles set workspace_id=$1, account_type='admin' where id=$2`, [wsA, adminA]);
await db.query(`update profiles set workspace_id=$1, account_type='member' where id=$2`, [wsA, mem]);
await db.query(`update profiles set workspace_id=$1, account_type='admin' where id=$2`, [wsB, adminB]);
const master = await mk('boss@x.com', 'Boss'); await db.query(`select promote_to_master('boss@x.com')`);
tokens.t_master = master; tokens.t_admin = adminA;
const URL_ = (ws, extra = '') => `/api/master/workspace?id=${ws}&action=person${extra}`;

let x = await call('POST', URL_(wsA), 't_admin', { name: 'N', email: 'n@x.com', account_type: 'admin' });
ok('a workspace Admin cannot use the Master route', x.status === 403);
x = await call('POST', URL_(wsA), 't_master', { name: 'New Admin', email: 'new@x.com', account_type: 'member' });
ok('Master cannot add a plain member', x.status === 400);
x = await call('POST', URL_(wsA), 't_master', { name: '', email: 'bad', account_type: 'admin' });
ok('name and email are checked', x.status === 400);
x = await call('POST', URL_(wsA), 't_master', { name: 'New Admin', email: 'new@x.com', account_type: 'admin' });
ok('Master adds a second Admin with a set-password link', x.status === 201 && x.json.link && x.json.id, JSON.stringify(x));
const newId = x.json.id;
let p = await one(`select name, account_type, workspace_id, status from profiles where id='${newId}'`);
ok('he lands in the right workspace as Admin with his name', p.account_type === 'admin' && p.workspace_id === wsA && p.name === 'New Admin');
x = await call('POST', URL_(wsA), 't_master', { name: 'Dup', email: 'NEW@x.com', account_type: 'manager' });
ok('same email cannot be added twice', x.status === 409);
x = await call('POST', URL_(wsA), 't_master', { name: 'Mona', email: 'mona@x.com', account_type: 'manager' });
ok('Master adds a Manager', x.status === 201);

// edit
x = await call('PATCH', URL_(wsA, `&user_id=${newId}`), 't_master', { name: 'Renamed Admin', email: 'renamed@x.com' });
ok('Master renames him and changes his email', x.status === 200, JSON.stringify(x));
p = await one(`select name, email from profiles where id='${newId}'`);
ok('profile shows the new name and email', p.name === 'Renamed Admin' && p.email === 'renamed@x.com');
ok('sign-in email changed too', (await one(`select email from auth.users where id='${newId}'`)).email === 'renamed@x.com');
x = await call('PATCH', URL_(wsA, `&user_id=${newId}`), 't_master', { email: 'm@x.com' });
ok('cannot take an email that already has an account', x.status === 409);
x = await call('PATCH', URL_(wsA, `&user_id=${newId}`), 't_master', { account_type: 'manager' });
ok('Master demotes a second Admin to Manager', x.status === 200 && (await one(`select account_type from profiles where id='${newId}'`)).account_type === 'manager');
x = await call('PATCH', URL_(wsA, `&user_id=${adminA}`), 't_master', { status: 'inactive' });
ok('the last active Admin cannot be switched off', x.status === 409, JSON.stringify(x));
x = await call('PATCH', URL_(wsA, `&user_id=${newId}`), 't_master', { account_type: 'admin' });
x = await call('PATCH', URL_(wsA, `&user_id=${adminA}`), 't_master', { status: 'inactive' });
ok('with another Admin in place the first can be switched off', x.status === 200 && (await one(`select status from profiles where id='${adminA}'`)).status === 'inactive');
x = await call('PATCH', URL_(wsA, `&user_id=${adminA}`), 't_master', { status: 'active' });
ok('and switched back on', x.status === 200);
x = await call('PATCH', URL_(wsA, `&user_id=${adminB}`), 't_master', { name: 'Hack' });
ok('cannot edit a person of another workspace through this workspace', x.status === 404);
x = await call('PATCH', URL_(wsA, `&user_id=${master}`), 't_master', { name: 'Hack' });
ok('the Master account itself is not editable here', x.status === 404);
x = await call('GET', `/api/master/workspace?id=${wsA}`, 't_master');
ok('the team list shows full emails to the Master', x.status === 200 && x.json.team.some((t) => t.email === 'renamed@x.com'));

// delete
const D = (id, t, confirm) => call('DELETE', URL_(wsA, `&user_id=${id}`), t, { confirm });
x = await D(newId, 't_admin', 'Renamed Admin');
ok('a workspace Admin cannot use the Master delete', x.status === 403);
x = await D(newId, 't_master', 'wrong');
ok('wrong name typed is refused', x.status === 400);
x = await D(adminB, 't_master', 'Bela');
ok('cannot delete someone of another workspace through this one', x.status === 404);
await db.query(`update profiles set status='inactive' where id='${newId}'`);
x = await D(adminA, 't_master', 'Amir');
ok('the only active Admin cannot be deleted', x.status === 409, JSON.stringify(x));
await db.query(`update profiles set status='active', account_type='admin' where id='${newId}'`);
x = await D(mem, 't_master', ' mem ');
ok('Master deletes a member (name is case-insensitive)', x.status === 200);
ok('his sign-in and profile are gone', (await one(`select count(*)::int n from auth.users where id='${mem}'`)).n === 0 && (await one(`select count(*)::int n from profiles where id='${mem}'`)).n === 0);
x = await D(adminA, 't_master', 'Amir');
ok('an Admin can be deleted while another stays', x.status === 200 && (await one(`select count(*)::int n from profiles where id='${adminA}'`)).n === 0);

console.log(failed ? `\n${failed} FAILED` : '\nMaster people checks passed');
process.exit(failed ? 1 : 0);
