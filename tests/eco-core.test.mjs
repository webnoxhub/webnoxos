// EcomHub core inside Webnox (PART 9): tasks, timer, sessions, tracking, reports — and the wall between workspaces.
// Run: node tests/eco-core.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8');
const db = new PGlite();
process.on('unhandledRejection', e => { console.log('UNCAUGHT:', e.message, e.query || ''); process.exit(1); });
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const ex = (sql) => db.exec(sql);

async function as(uid, fn) {
  await ex(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await ex(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
async function expectErr(fn, msg, pattern) {
  try { await fn(); ok(false, msg + ' (no error thrown)'); }
  catch (e) { ok(!pattern || pattern.test(e.message), msg + ' -> ' + e.message.slice(0, 90)); }
}

// Supabase stand-ins. Default privileges copy what Supabase does for new tables and functions.
await ex(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);

console.log('Schema load (twice, idempotent)');
await ex(schema); await ex(schema);
ok(true, 'schema.sql ran twice without errors');

// ---- two workspaces ----
const W1 = (await q(`insert into workspaces(name,slug,short_code) values ('Alpha Co','alpha','AL') returning id`))[0].id;
const W2 = (await q(`insert into workspaces(name,slug,short_code) values ('Beta Co','beta','BE') returning id`))[0].id;
await ex(`insert into workspace_roles(workspace_id,role_key) values
  ('${W1}','sales_rep'),('${W1}','lead_gen'),('${W1}','cold_caller'),('${W1}','finance'),('${W1}','project_manager'),('${W1}','project_agent'),
  ('${W2}','sales_rep'),('${W2}','finance')`);
ok((await q(`select count(*)::int c from app_settings`))[0].c === 2, 'every workspace gets its own settings row');

async function person(email, name, ws, type, roles = []) {
  const [u] = await q(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }]);
  await q(`update profiles set workspace_id=$2, account_type=$3, roles=$4 where id=$1`, [u.id, ws, type, roles]);
  return u.id;
}
const A  = await person('boss@alpha.com', 'Boss Admin', W1, 'admin');
const M1 = await person('ali@alpha.com',  'Ali Khan',   W1, 'member', ['cold_caller', 'lead_gen']);
const M2 = await person('sara@alpha.com', 'Sara Ahmed', W1, 'member', ['finance']);
const MG = await person('mg@alpha.com',   'Mona Manager', W1, 'manager');
const B  = await person('boss@beta.com',  'Beta Admin', W2, 'admin');
const B1 = await person('bob@beta.com',   'Bob Beta',   W2, 'member', ['sales_rep']);
const MASTER = (await q(`insert into auth.users (email) values ('owner@webnox.com') returning id`))[0].id;
await q(`select promote_to_master('owner@webnox.com')`);

console.log('People (compat columns)');
const pr = (await q(`select first_name, last_name, role, employee_code from profiles where id=$1`, [M1]))[0];
ok(pr.first_name === 'Ali' && pr.last_name === 'Khan' && pr.role === 'member', 'first_name / last_name / role are derived from the Webnox profile');
ok((await q(`select role from profiles where id=$1`, [A]))[0].role === 'admin', 'admin account has role admin');
ok((await q(`select role from profiles where id=$1`, [MG]))[0].role === 'member', 'manager account is a member for the EcomHub screens');
ok((await q(`select employee_code from profiles where id=$1`, [A]))[0].employee_code === 'EMP-ALPHA-001'
   && (await q(`select employee_code from profiles where id=$1`, [B]))[0].employee_code === 'EMP-BETA-001', 'employee codes count inside each workspace');
ok((await q(`select employee_code from profiles where id=$1`, [MASTER]))[0].employee_code === null, 'a Master gets no employee code');
const mr = (await q(`select role_key from member_roles where member_id=$1 order by 1`, [M1])).map(r => r.role_key).join();
ok(mr === 'cold_caller,lead_gen', 'member_roles lists the roles a person holds');
ok((await q(`select role_key from member_roles where member_id=$1`, [MG])).some(r => r.role_key === 'manager'), 'a Manager account holds the manager role');

const late = await person('late@alpha.com', 'Late Joiner', W1, 'member');
ok((await q(`select employee_code from profiles where id=$1`, [late]))[0].employee_code === 'EMP-ALPHA-005', 'the next person in a workspace gets the next number with the slug');
const codes = (await q(`select employee_code from profiles where workspace_id=$1`, [W1])).map(r => r.employee_code);
ok(new Set(codes).size === codes.length && codes.every(c => /^EMP-ALPHA-\d{3}$/.test(c)), 'every code in the workspace is unique and has the slug');
await ex(`delete from auth.users where id='${late}'`);
ok((await q(`select count(*)::int c from workspaces where logo_only`))[0].c === 0, 'logo_only is off by default');

console.log('Tasks (admin)');
const [t1] = await as(A, () => q(`insert into tasks (title, assigned_to, team_role, priority, due_date) values ('Call 50 leads', $1, 'cold_caller', 'high', current_date - 1) returning id, created_by, status, workspace_id`, [M1]));
ok(t1.created_by === A && t1.status === 'todo' && t1.workspace_id === W1, 'admin creates task (created_by and workspace forced)');
const [t2] = await as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('Find 20 prospects', $1, 'lead_gen') returning id`, [M1]));
const [tF] = await as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('Send invoices', $1, 'finance') returning id`, [M2]));
await expectErr(() => as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('x', $1, 'finance')`, [M1])), 'role mismatch blocked', /does not have/);
await expectErr(() => as(M1, () => q(`insert into tasks (title) values ('hack')`)), 'member cannot create tasks', /row-level security|permission/);
const [mt] = await as(MG, () => q(`insert into tasks (title, assigned_to) values ('Manager task', $1) returning id`, [M2]));
ok(!!mt.id, 'a Manager can create tasks');

console.log('Member access');
let S1;
await as(M1, async () => {
  S1 = (await q(`select session_start('Mozilla/5.0 Chrome', 'Chrome on Windows', 'login') as id`))[0].id;
  const mine = await q(`select id from tasks order by id`);
  ok(mine.length === 2, 'member sees only own tasks (' + mine.length + ')');
  ok((await q(`select id from profiles`)).length === 1, 'member sees only own profile');
  const upd = await q(`update tasks set title='changed' where id=$1 returning id`, [t1.id]).catch(e => e);
  ok(upd instanceof Error || upd.length === 0, 'member cannot update tasks directly');
  await expectErr(() => q(`insert into task_time_entries (task_id, user_id) values ($1,$2)`, [t1.id, M1]), 'member cannot write time entries', /permission/);
  await expectErr(() => q(`select team_presence()`), 'member cannot view presence', /admin or a manager/);
  await expectErr(() => q(`select * from report_daily(current_date, current_date, null)`), 'member cannot view team report', /own records/);
  await expectErr(() => q(`select * from report_daily(current_date, current_date, $1)`, [M2]), 'member cannot view another member report', /own records/);
  await expectErr(() => q(`select timer_start($1)`, [tF.id]), 'member cannot time someone else\'s task', /not assigned/);
  await expectErr(() => q(`insert into task_comments (task_id, author_id, body) values ($1,$2,'hi')`, [tF.id, M1]), 'member cannot comment on other task', /row-level/);
});
ok((await q(`select last_seen_at from profiles where id=$1`, [M1]))[0].last_seen_at === null, 'last_seen_at unchanged by starting a session');
ok((await q(`select action from activity_logs where action='invite_accepted'`)).length === 1, 'first sign-in is logged as joined');

console.log('Timer');
await as(M1, async () => {
  const r = (await q(`select timer_start($1) as r`, [t1.id]))[0].r;
  ok(r.task_id == t1.id, 'timer started');
  ok((await q(`select status from tasks where id=$1`, [t1.id]))[0].status === 'in_progress', 'todo -> in progress on timer start');
  const again = (await q(`select timer_start($1) as r`, [t1.id]))[0].r;
  ok(again.started_at === r.started_at, 'starting same task twice is idempotent');
});
await ex(`update task_time_entries set started_at = started_at - interval '30 minutes'`);
await as(M1, async () => {
  await q(`select timer_start($1)`, [t2.id]);
  const rows = await q(`select task_id, end_reason, ended_at is null as running, extract(epoch from coalesce(ended_at, now())-started_at)::int as secs from task_time_entries order by id`);
  ok(rows.length === 2 && rows[0].end_reason === 'switch' && rows[1].running, 'switching task pauses the first');
  ok(Math.abs(rows[0].secs - 1800) < 5, 'first entry ~30 min (' + rows[0].secs + 's)');
  await q(`select timer_pause()`);
  await expectErr(() => q(`select timer_pause()`), 'pause with nothing running errors', /No timer/);
  const tot = await q(`select task_id, running, last_end_reason from task_time_totals order by task_id`);
  ok(tot.length === 2 && tot.every(t => !t.running) && tot[1].last_end_reason === 'pause', 'totals view: paused state visible');
  await q(`select timer_start($1)`, [t2.id]);
  await q(`select timer_stop($1)`, [t2.id]);
  await q(`select timer_stop($1)`, [t1.id]);
  const st = await q(`select last_end_reason from task_time_totals`);
  ok(st.every(s => s.last_end_reason === 'stop'), 'stop works for running and paused timers');
  const acts = (await q(`select action from activity_logs where actor_id=$1`, [M1])).map(l => l.action);
  ok(['timer_started', 'timer_paused', 'timer_resumed', 'timer_stopped'].every(a => acts.includes(a)), 'timer actions logged');
});
await expectErr(() => q(`insert into task_time_entries (task_id,user_id) values ($1,$2),($1,$2)`, [t1.id, M1]), 'unique index blocks two running timers', /duplicate|unique/);
ok((await q(`select count(*)::int c from task_time_entries where workspace_id=$1`, [W1]))[0].c === 3, 'time entries carry their workspace');

console.log('Heartbeats & idle');
await ex(`update user_sessions set started_at = now() - interval '1 hour', last_seen_at = now() - interval '1 minute';
          update activity_intervals set started_at = now() - interval '1 hour';`);
await as(M1, async () => {
  ok((await q(`select session_heartbeat($1, 'active', 0) as r`, [S1]))[0].r.ok === true, 'heartbeat ok');
  await q(`select session_heartbeat($1, 'idle', 300)`, [S1]);
  const iv = await q(`select state, extract(epoch from coalesce(ended_at, now()) - started_at)::int as secs from activity_intervals where session_id=$1 order by id`, [S1]);
  ok(iv.length === 2 && iv[0].state === 'active' && Math.abs(iv[0].secs - 3300) < 5 && iv[1].state === 'idle', 'idle backdated 5 min');
  await q(`select session_heartbeat($1, 'active', 0)`, [S1]);
  const ls = await q(`select status, duration_seconds, idle_seconds from list_sessions(current_date - 1, current_date + 1, $1)`, [M1]);
  ok(ls.length === 1 && Math.abs(ls[0].duration_seconds - 3600) < 5 && Math.abs(ls[0].idle_seconds - 300) < 5, 'list_sessions durations');
});
ok((await q(`select last_seen_at is not null as s from profiles where id=$1`, [M1]))[0].s, 'heartbeat refreshes the directory last-seen time');

console.log('Stale sessions end at last seen');
await ex(`update user_sessions set last_seen_at = now() - interval '10 minutes' where id='${S1}'`);
await as(M1, async () => {
  const hb = (await q(`select session_heartbeat($1, 'active', 0) as r`, [S1]))[0].r;
  ok(hb.ok === false && hb.reason === 'ended', 'stale heartbeat -> session ended');
});
const [s1] = await q(`select end_reason, end_estimated, extract(epoch from ended_at - last_seen_at)::int as d from user_sessions where id=$1`, [S1]);
ok(s1.end_reason === 'disconnected' && s1.end_estimated && s1.d === 0, 'disconnected session ends at last seen (estimated)');

console.log('Timer auto-pause after the app was closed 20+ minutes');
const S2 = await as(M1, async () => {
  const id = (await q(`select session_start('ua','dev','resume') as id`))[0].id;
  await q(`select timer_start($1)`, [t1.id]);
  return id;
});
await ex(`update user_sessions set started_at = now() - interval '2 hours', last_seen_at = now() - interval '30 minutes' where id='${S2}';
          update activity_intervals set started_at = now() - interval '2 hours' where session_id='${S2}';
          update task_time_entries set started_at = now() - interval '90 minutes' where ended_at is null;
          update user_sessions set started_at = now() - interval '3 hours', last_seen_at = now() - interval '40 minutes', ended_at = now() - interval '40 minutes' where id='${S1}';`);
await q(`select sweep_stale_sessions()`);
const [auto] = await q(`select end_reason, extract(epoch from ended_at - started_at)::int as secs from task_time_entries where task_id=$1 order by id desc limit 1`, [t1.id]);
ok(auto.end_reason === 'auto' && Math.abs(auto.secs - 3600) < 5, 'running timer paused at last presence (' + auto.secs + 's)');

console.log('Review workflow');
await as(M1, async () => {
  await q(`select session_start('ua','dev','resume')`);
  await q(`select timer_start($1)`, [t1.id]);
  await q(`select task_set_status($1, 'in_review', 'Done, sheet attached in Drive')`, [t1.id]);
  const [t] = await q(`select status, submitted_at is not null as sub from tasks where id=$1`, [t1.id]);
  ok(t.status === 'in_review' && t.sub, 'member submits for review');
  ok((await q(`select count(*)::int c from task_time_entries where user_id=$1 and ended_at is null`, [M1]))[0].c === 0, 'submitting stops the running timer');
  await expectErr(() => q(`select timer_start($1)`, [t1.id]), 'timer blocked while in review', /in review/);
  await expectErr(() => q(`select task_set_status($1, 'completed')`, [t1.id]), 'member cannot complete', /can't move/);
  await expectErr(() => q(`select task_review($1, true)`, [t1.id]), 'member cannot approve', /admin or a manager/);
});
await as(A, async () => {
  await expectErr(() => q(`select task_review($1, false, '')`, [t1.id]), 'revision needs a note', /note/);
  await q(`select task_review($1, false, 'Add phone numbers')`, [t1.id]);
  ok((await q(`select status from tasks where id=$1`, [t1.id]))[0].status === 'in_progress', 'revision -> in progress');
});
await as(M1, () => q(`select task_set_status($1, 'in_review')`, [t1.id]));
await as(MG, async () => {
  await q(`select task_review($1, true, 'Great work')`, [t1.id]);
  const [t] = await q(`select status, completed_at is not null as c from tasks where id=$1`, [t1.id]);
  ok(t.status === 'completed' && t.c, 'a Manager approves -> completed with timestamp');
});
await as(A, async () => {
  const acts = (await q(`select action from activity_logs where entity_type='task' and entity_id=$1`, [String(t1.id)])).map(r => r.action);
  ok(['task_created', 'task_assigned', 'task_submitted', 'revision_requested', 'task_approved'].every(a => acts.includes(a)), 'task history logged');
  const cm = await q(`select author_name, body from task_comments where task_id=$1 order by id`, [t1.id]);
  ok(cm.length === 3 && cm[1].author_name === 'Boss Admin', 'comments carry the author name');
  await q(`update tasks set assigned_to=$1, team_role=null where id=$2`, [M2, t2.id]);
  ok((await q(`select count(*)::int c from activity_logs where action='task_reassigned'`))[0].c === 1, 'reassignment logged');
});

console.log('Reports: midnight split + overlap merge (Asia/Karachi)');
const Z = await person('zed@alpha.com', 'Zed Zee', W1, 'member');
await ex(`
  insert into user_sessions (user_id, started_at, last_seen_at, ended_at, end_reason, state)
  values ('${Z}', ('2026-10-08 23:00'::timestamp at time zone 'Asia/Karachi'), ('2026-10-09 01:00'::timestamp at time zone 'Asia/Karachi'), ('2026-10-09 01:00'::timestamp at time zone 'Asia/Karachi'), 'logout', 'active'),
         ('${Z}', ('2026-10-09 00:30'::timestamp at time zone 'Asia/Karachi'), ('2026-10-09 02:00'::timestamp at time zone 'Asia/Karachi'), ('2026-10-09 02:00'::timestamp at time zone 'Asia/Karachi'), 'logout', 'active');
  insert into activity_intervals (session_id, user_id, state, started_at, ended_at)
  select id, user_id, 'active', started_at, ended_at from user_sessions where user_id='${Z}';
`);
ok((await q(`select count(*)::int c from user_sessions where user_id=$1 and workspace_id=$2`, [Z, W1]))[0].c === 2, 'rows added by the server pick up the workspace of their person');
ok((await q(`select count(*)::int c from activity_intervals where user_id=$1 and workspace_id=$2`, [Z, W1]))[0].c === 2, 'intervals pick up the workspace of their session');
await as(A, async () => {
  const rows = await q(`select day::text, session_seconds, active_seconds, sessions from report_daily('2026-10-08','2026-10-09',$1) order by day`, [Z]);
  ok(rows.length === 2 && rows[0].session_seconds === 3600 && rows[1].session_seconds === 7200, 'split at midnight + overlap merged');
  ok((await q(`select count(*)::int c from report_daily(current_date - 7, current_date + 1, null)`))[0].c >= 1, 'admin all-member report runs');
  const tl = await q(`select kind, start_sec, end_sec from day_timeline('2026-10-09', $1) order by start_sec`, [Z]);
  ok(tl.length === 2 && tl[0].start_sec === 0 && tl[0].end_sec === 3600, 'day timeline clipped to local midnight');
  ok((await q(`select title, seconds from report_tasks(current_date - 1, current_date + 1, null)`)).length >= 2, 'task-wise report');
  const pres = await q(`select user_id from team_presence()`);
  ok(pres.length === 4 && !pres.some(p => p.user_id === B || p.user_id === B1), 'team presence lists only my workspace (4 members)');
  await expectErr(() => q(`select * from report_daily('2026-01-01','2027-06-01',null)`), 'range > 1 year rejected', /year/);
});

console.log('Settings + logs visibility');
await as(A, async () => {
  await q(`update app_settings set idle_minutes = 7`);
  ok((await q(`select count(*)::int c from activity_logs where action='settings_changed'`))[0].c === 1, 'settings change logged');
  await expectErr(() => q(`update app_settings set timezone='Mars/Base'`), 'invalid timezone rejected');
});
await as(MG, async () => {
  ok((await q(`update app_settings set idle_minutes=9 returning workspace_id`)).length === 0, 'a Manager cannot change workspace settings');
});
await as(M1, async () => {
  const v = await q(`select count(*)::int c from activity_logs where actor_id <> $1::uuid and coalesce(subject_id::text,'') <> $1::text`, [M1]);
  ok(v[0].c === 0, 'member sees only own / own-subject logs');
  await expectErr(() => q(`insert into activity_logs (action) values ('fake')`), 'logs are append-only via server', /permission/);
});
await as(M2, async () => {
  ok((await q(`select count(*)::int c from user_sessions`))[0].c === 0, 'member cannot see other members\' sessions');
});

console.log('Deactivation');
const S4 = await as(M2, async () => { const id = (await q(`select session_start('ua','dev','login') as id`))[0].id; await q(`select timer_start($1)`, [tF.id]); return id; });
await q(`update profiles set status='inactive' where id=$1`, [M2]);
await q(`select close_member_sessions($1)`, [M2]);
ok((await q(`select end_reason from user_sessions where id=$1`, [S4]))[0].end_reason === 'inactive', 'switching a person off ends their open sessions');
ok((await q(`select count(*)::int c from task_time_entries where user_id=$1 and ended_at is null`, [M2]))[0].c === 0, 'and pauses their timer');
await expectErr(() => as(M2, () => q(`select session_start('ua','dev','login')`)), 'inactive member cannot start a session', /inactive/);
await expectErr(() => as(A, () => q(`insert into tasks (title, assigned_to) values ('x', $1)`, [M2])), 'cannot assign to an inactive member', /active/);

console.log('Privileges');
await ex(`set role anon`);
await expectErr(() => q(`select * from tasks`), 'anon cannot read tasks', /permission/);
await expectErr(() => q(`select session_start()`), 'anon cannot call functions', /permission/);
await ex(`reset role`);
await as(M1, () => expectErr(() => q(`select log_event('x','y','z','fake')`), 'members cannot call log_event', /permission/));
await as(M1, () => expectErr(() => q(`select close_session($1,'logout',now(),false)`, [S2]), 'members cannot call close_session', /permission/));
await as(M1, () => expectErr(() => q(`select close_member_sessions($1)`, [M2]), 'members cannot call close_member_sessions', /permission/));
await as(M1, () => expectErr(() => q(`select eco_fill_workspace()`), 'members cannot call trigger helpers', /permission/));

console.log('WALL BETWEEN WORKSPACES');
// Beta has real activity of its own
const [bt] = await as(B, () => q(`insert into tasks (title, assigned_to, team_role) values ('Beta task', $1, 'sales_rep') returning id, workspace_id`, [B1]));
ok(bt.workspace_id === W2, 'Beta task belongs to Beta');
await as(B1, async () => { await q(`select session_start('ua','dev','login')`); await q(`select timer_start($1)`, [bt.id]); });
const aOpen = (await q(`select id from user_sessions where workspace_id=$1 limit 1`, [W1]))[0].id;
await ex(`update user_sessions set ended_at = null, end_reason = null, last_seen_at = now() - interval '10 minutes' where id='${aOpen}'`);

await as(B, async () => {
  ok((await q(`select id from tasks`)).every(t => t.id === bt.id), 'Beta admin sees only Beta tasks');
  ok((await q(`select id from tasks where id=$1`, [t1.id])).length === 0, 'Beta admin cannot read an Alpha task by id');
  ok((await q(`select count(*)::int c from task_comments`))[0].c === 0, 'Beta admin sees no Alpha comments');
  ok((await q(`select count(*)::int c from task_time_entries where workspace_id <> $1`, [W2]))[0].c === 0, 'no Alpha time entries visible');
  ok((await q(`select count(*)::int c from user_sessions where workspace_id <> $1`, [W2]))[0].c === 0, 'no Alpha sessions visible');
  ok((await q(`select count(*)::int c from activity_logs where workspace_id <> $1`, [W2]))[0].c === 0, 'no Alpha audit lines visible');
  ok((await q(`select count(*)::int c from activity_logs`))[0].c > 0, 'Beta sees its own audit lines');
  const st = await q(`select workspace_id from app_settings`);
  ok(st.length === 1 && st[0].workspace_id === W2, 'only Beta settings are visible');
  ok((await q(`update app_settings set currency='EUR' where workspace_id=$1 returning 1`, [W1])).length === 0, 'Beta admin cannot change Alpha settings');
  ok((await q(`select count(*)::int c from member_roles`))[0].c === 1, 'member_roles shows only Beta people');
  ok((await q(`select key from team_roles order by key`)).map(r => r.key).join() === 'finance,manager,sales_rep', 'the role catalogue shows only roles Beta switched on');
  await expectErr(() => q(`select * from report_daily(current_date - 30, current_date + 1, $1)`, [M1]), 'cannot report on an Alpha person', /own records/);
  await expectErr(() => q(`select * from list_sessions(current_date - 30, current_date + 1, $1)`, [Z]), 'cannot list sessions of an Alpha person', /own records/);
  await expectErr(() => q(`select * from day_timeline('2026-10-09', $1)`, [Z]), 'cannot see the day strip of an Alpha person', /own records/);
  ok((await q(`select count(*)::int c from report_daily('2026-10-01', current_date + 1, null) where user_id = any($1::uuid[])`, [[A, M1, M2, Z, MG]]))[0].c === 0, 'the all-people report never contains Alpha people');
  ok((await q(`select count(*)::int c from report_tasks('2026-10-01', current_date + 1, null) where title <> 'Beta task'`))[0].c === 0, 'the task report never contains Alpha tasks');
  ok((await q(`select count(*)::int c from team_presence() where user_id = any($1::uuid[])`, [[A, M1, M2, Z, MG]]))[0].c === 0, 'team presence never contains Alpha people');
  await expectErr(() => q(`select task_review($1, true, 'x')`, [tF.id]), 'cannot review an Alpha task', /not found|not waiting/i);
  await expectErr(() => q(`insert into tasks (title, assigned_to) values ('steal', $1)`, [M1]), 'cannot assign a task to an Alpha person', /row-level|active members of this workspace/);
  await expectErr(() => q(`insert into tasks (workspace_id, title) values ($1, 'smuggle')`, [W1]), 'cannot write a task into Alpha', /row-level/);
  await expectErr(() => q(`insert into task_comments (task_id, author_id, body) values ($1,$2,'hi')`, [tF.id, B]), 'cannot comment on an Alpha task', /row-level/);
  ok((await q(`update tasks set title='pwn' where id=$1 returning id`, [tF.id])).length === 0, 'cannot update an Alpha task');
  ok((await q(`delete from tasks where id=$1 returning id`, [tF.id])).length === 0, 'cannot delete an Alpha task');
  await q(`select sweep_stale_sessions()`);
});
ok((await q(`select ended_at is null as open from user_sessions where id=$1`, [aOpen]))[0].open, 'a Beta sweep leaves Alpha sessions alone');
await q(`select sweep_stale_sessions()`);
ok(!(await q(`select ended_at is null as open from user_sessions where id=$1`, [aOpen]))[0].open, 'the server sweep (no caller) cleans every workspace');
ok((await q(`select count(*)::int c from activity_logs where workspace_id=$1 and (actor_id = any($2::uuid[]))`, [W2, [A, M1, M2, MG, Z]]))[0].c === 0, 'no Alpha person ever appears in Beta\'s log');
ok((await q(`select count(*)::int c from activity_logs where workspace_id=$1 and (actor_id = any($2::uuid[]))`, [W1, [B, B1]]))[0].c === 0, 'no Beta person ever appears in Alpha\'s log');
await as(A, async () => {
  ok((await q(`select count(*)::int c from tasks where title='Beta task'`))[0].c === 0, 'Alpha admin does not see Beta tasks');
  ok((await q(`select count(*)::int c from team_presence() where user_id = any($1::uuid[])`, [[B, B1]]))[0].c === 0, 'Alpha presence never contains Beta people');
});
await as(MASTER, async () => {
  ok((await q(`select count(*)::int c from tasks`))[0].c === 0, 'a Master does not read workspace tasks through the browser');
  await expectErr(() => q(`select session_start()`), 'a Master cannot start a workspace session', /workspace/);
});

console.log('Notifications (PART 10)');
const nOf = (uid) => q(`select kind, title, body, link, read_at from notifications where user_id=$1 order by created_at, id`, [uid]);
const [tN] = await as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('Notify me', $1, 'cold_caller') returning id`, [M1]));
let nn = await nOf(M1);
ok(nn.some(n => n.title === 'New task: Notify me' && n.kind === 'task' && n.body === 'Assigned by Boss Admin (Admin)' && n.link === '#/my-tasks'), 'assignee is told about a new task, with who assigned it');
await as(M1, () => q(`select task_set_status($1, 'in_progress')`, [tN.id]));
await as(M1, () => q(`select task_set_status($1, 'in_review')`, [tN.id]));
ok((await nOf(A)).some(n => n.kind === 'review' && n.title === 'Ready for review: Notify me'), 'admin is told a task is ready for review');
ok((await nOf(MG)).some(n => n.kind === 'review'), 'managers are told too');
ok(!(await nOf(M2)).some(n => n.kind === 'review'), 'other members are not');
await as(A, () => q(`select task_review($1, false, 'Please add numbers')`, [tN.id]));
ok((await nOf(M1)).some(n => n.title === 'Changes requested: Notify me' && n.body === 'Please add numbers'), 'changes requested reaches the assignee with the note');
await as(M1, () => q(`select task_set_status($1, 'in_review')`, [tN.id]));
await as(A, () => q(`select task_review($1, true, null)`, [tN.id]));
ok((await nOf(M1)).some(n => n.title === 'Approved: Notify me'), 'approval reaches the assignee');
await as(A, () => q(`update tasks set priority='urgent' where id=$1`, [tN.id]));
ok((await nOf(M1)).some(n => n.title === 'Task updated: Notify me'), 'editing a task tells the assignee');
await as(M1, async () => {
  ok((await q(`select count(*)::int c from notifications`))[0].c === (await nOf(M1)).length, 'a member reads only his own notifications');
  await expectErr(() => q(`update notifications set title='hacked' where user_id=$1`, [M1]), 'a member cannot rewrite a notification', /permission/);
  const r = await q(`update notifications set read_at=now() where read_at is null returning id`);
  ok(r.length > 0, 'a member can mark his notifications read');
  await expectErr(() => q(`insert into notifications(workspace_id,user_id,text) values ($1,$2,'x')`, [W1, M1]), 'a member cannot create notifications', /permission|policy/);
});
await as(M2, async () => { ok((await q(`select count(*)::int c from notifications where user_id=$1`, [M1]))[0].c === 0, 'nobody reads another member\'s notifications'); });
await as(B, async () => { ok((await q(`select count(*)::int c from notifications where workspace_id=$1`, [W1]))[0].c === 0, 'another workspace reads none of them'); });

console.log('Force delete a task with tracked time');
const [tFD] = await as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('Timed task', $1, 'cold_caller') returning id`, [M1]));
await as(M1, async () => { await q(`select session_start('ua','dev','login')`); await q(`select timer_start($1)`, [tFD.id]); await q(`select timer_stop($1)`, [tFD.id]); });
await as(A, () => expectErr(() => q(`delete from tasks where id=$1`, [tFD.id]), 'a plain delete is blocked when time was tracked', /foreign key|violates|permission/));
await as(M1, () => expectErr(() => q(`select task_force_delete($1)`, [tFD.id]), 'a member cannot force delete', /Only the admin or a manager/));
await as(B, () => expectErr(() => q(`select task_force_delete($1)`, [tFD.id]), 'another workspace cannot force delete', /not found|Task not found|workspace/i));
await as(MG, () => q(`select task_force_delete($1)`, [tFD.id]));
ok((await q(`select count(*)::int c from tasks where id=$1`, [tFD.id]))[0].c === 0, 'a manager can force delete');
ok((await q(`select count(*)::int c from task_time_entries where task_id=$1`, [tFD.id]))[0].c === 0, 'its time entries go with it');
ok((await q(`select count(*)::int c from activity_logs where action='task_force_deleted'`))[0].c === 1, 'one audit line keeps the record');

console.log('Deleting a person and a workspace');
const doomed = await person('gone@alpha.com', 'Gone Guy', W1, 'member', ['cold_caller']);
await as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('Orphan me', $1, 'cold_caller')`, [doomed]));
await as(doomed, async () => { await q(`select session_start('ua','dev','login')`); });
await q(`select purge_person_activity($1)`, [doomed]);
await ex(`delete from auth.users where id='${doomed}'`);
ok((await q(`select count(*)::int c from profiles where id=$1`, [doomed]))[0].c === 0, 'person removed');
ok((await q(`select assigned_to from tasks where title='Orphan me'`))[0].assigned_to === null, 'his task stays, unassigned');
ok((await q(`select count(*)::int c from user_sessions where user_id=$1`, [doomed]))[0].c === 0, 'his sessions are gone');
ok((await q(`select count(*)::int c from activity_logs where actor_id=$1 or subject_id=$1`, [doomed]))[0].c === 0, 'his audit lines are gone');

const ids = (await q(`select purge_workspace($1) as ids`, [W2]))[0].ids;
ok(ids.length === 2, 'purge returns the people to delete from sign-in');
for (const t of ['tasks', 'task_comments', 'task_time_entries', 'user_sessions', 'activity_intervals', 'activity_logs', 'app_settings']) {
  ok((await q(`select count(*)::int c from ${t} where workspace_id=$1`, [W2]))[0].c === 0, 'purge cleared ' + t);
}
ok((await q(`select count(*)::int c from tasks where workspace_id=$1`, [W1]))[0].c >= 3, 'Alpha is untouched by the purge');
ok((await q(`select count(*)::int c from workspaces where id=$1`, [W2]))[0].c === 0, 'workspace row gone');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
