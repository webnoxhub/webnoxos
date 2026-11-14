// Master Finance (PART 17): a rent cycle end to end on test dates, trials, grace and
// auto-suspension, who may see what, and the wall between the Master and the businesses.
// master_today() is replaced with a fixed date so a whole year can be played out in one run.
// Run: node tests/master-finance.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8');
process.on('unhandledRejection', e => { console.log('UNCAUGHT:', String(e.message).slice(0, 300)); process.exit(1); });

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

const PRE = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`;

const db = new PGlite();
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
const setToday = (d) => ex(`create or replace function public.master_today() returns date
  language sql stable as $$ select date '${d}' $$;`);
// PGlite hands a date column back as a Date; compare the plain day.
const iso = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const sub = async (ws) => (await q(`select * from subscriptions where workspace_id=$1`, [ws]))[0];
const wsRow = async (ws) => (await q(`select * from workspaces where id=$1`, [ws]))[0];
const bell = async (uid) => (await q(`select count(*)::int c from notifications where user_id=$1`, [uid]))[0].c;
const sweep = (who) => as(who, () => q(`select master_sweep() n`)).then((r) => r[0].n);

await ex(PRE);
await ex(schema); await ex(schema);
ok(true, 'schema.sql (with PART 17) ran twice without errors');

// ── People and workspaces ────────────────────────────────────────────────────
const mk = async (email, name) =>
  (await q(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }]))[0].id;

const MASTER = await mk('webnoxhub@gmail.com', 'Haseeb Gul');
await q(`select promote_to_master('webnoxhub@gmail.com')`);

const ALPHA = (await q(`insert into workspaces(name,slug,short_code) values ('Alpha Co','alpha','AL') returning id`))[0].id;
const BETA  = (await q(`insert into workspaces(name,slug,short_code) values ('Beta Co','beta','BE') returning id`))[0].id;
const GAMMA = (await q(`insert into workspaces(name,slug,short_code) values ('Gamma Co','gamma','GA') returning id`))[0].id;
const MINE  = (await q(`insert into workspaces(name,slug,short_code,type) values ('Webnox Hub','webnox','WX','master_project') returning id`))[0].id;

const person = async (email, name, ws, type) => {
  const id = await mk(email, name);
  await q(`update profiles set workspace_id=$2, account_type=$3 where id=$1`, [id, ws, type]);
  return id;
};
const A_ADMIN = await person('boss@alpha.com', 'Alpha Boss', ALPHA, 'admin');
const B_ADMIN = await person('boss@beta.com', 'Beta Boss', BETA, 'admin');
const G_ADMIN = await person('boss@gamma.com', 'Gamma Boss', GAMMA, 'admin');

// ── Plans ────────────────────────────────────────────────────────────────────
console.log('\nPlans');
await setToday('2026-01-10');
await as(MASTER, () => q(`select master_change_plan($1,'monthly',50000,'PKR',1,7,null,'Growth')`, [ALPHA]));
let s = await sub(ALPHA);
ok(s && s.cycle === 'monthly' && Number(s.amount) === 50000, 'a first plan can be set from the Finance tab');
ok(iso(s.next_due) === '2026-02-10', 'next due is one month out: ' + iso(s.next_due));
ok(s.grace_days === 7, 'grace days default to 7');

await as(MASTER, () => q(`select master_change_plan($1,'trial_14',30000,'PKR',1,null,null,null)`, [GAMMA]));
s = await sub(GAMMA);
ok(s.cycle === 'trial_14' && s.next_due === null && iso(s.trial_ends_on) === '2026-01-24',
  'a 14-day trial ends on day 14 and owes nothing yet');

await expectErr(() => as(MASTER, () => q(`select master_change_plan($1,'monthly',1000,'PKR',1,null,null,null)`, [MINE])),
  'a personal workspace cannot be put on rent', /pays no rent/);
await expectErr(() => as(A_ADMIN, () => q(`select master_change_plan($1,'monthly',1,'PKR',1,null,null,null)`, [ALPHA])),
  'a workspace Admin cannot change their own plan', /Only a Master/);

// ── Money rules ──────────────────────────────────────────────────────────────
console.log('\nMoney');
await as(MASTER, () => q(`select master_change_plan($1,'monthly',200,'USD',280,null,null,null)`, [ALPHA]));
s = await sub(ALPHA);
ok(Number(s.amount) === 56000 && Number(s.amount_original) === 200 && s.currency === 'USD',
  'rent in another currency is stored in PKR too (200 USD x 280 = ' + s.amount + ')');
ok(iso(s.next_due) === '2026-02-10', 'changing the price does not move the due date');
await as(MASTER, () => q(`select master_change_plan($1,'monthly',50000,'PKR',1,null,null,null)`, [ALPHA]));

// ── A trial turning into a paid cycle ────────────────────────────────────────
console.log('\nTrial');
await setToday('2026-01-20');
ok(await sweep(MASTER) === 1, 'four days before the end, only the trial has something to say');
ok((await q(`select count(*)::int c from billing_log where workspace_id=$1 and kind='trial_countdown'`, [GAMMA]))[0].c === 1,
  'during a trial both sides get a daily countdown');
ok((await bell(G_ADMIN)) > 0, 'the trial workspace Admin is told too');

await setToday('2026-01-25');
await sweep(MASTER);
s = await sub(GAMMA);
ok(!['trial_7', 'trial_14'].includes(s.cycle) && iso(s.next_due) === '2026-01-24',
  'an unpaid trial rolls into the paid cycle on the day it ends');
await as(MASTER, () => q(`select master_record_payment($1,30000,'PKR',1)`, [GAMMA]));
ok(iso((await sub(GAMMA)).next_due) === '2026-02-24', 'the first payment starts the paid cycle from the trial end date');

// ── The sweep: coming up, due today, overdue, on hold ────────────────────────
console.log('\nThe sweep');
await setToday('2026-02-05');
ok(await sweep(MASTER) === 0, 'five days out is too early to say anything');

await setToday('2026-02-08');
await sweep(MASTER);
ok((await sub(ALPHA)).status === 'due_soon', 'two days out the row reads Due soon');
const firstBell = await bell(MASTER);
ok(firstBell > 0, 'the Master is told rent is coming up');
await sweep(MASTER);
ok(await bell(MASTER) === firstBell, 'running the sweep again the same day says nothing twice');

await setToday('2026-02-10');
await sweep(MASTER);
ok((await sub(ALPHA)).status === 'due_today', 'on the day the row reads Due today');
ok((await bell(A_ADMIN)) > 0, 'the workspace Admin is told as well');

await setToday('2026-02-14');
await sweep(MASTER);
ok((await sub(ALPHA)).status === 'overdue', 'after the due date the row reads Overdue');
ok((await wsRow(ALPHA)).status !== 'suspended', 'inside the 7 grace days the workspace stays open');

await setToday('2026-02-17');
await sweep(MASTER);
ok((await wsRow(ALPHA)).status === 'suspended', 'one day past the grace period the workspace goes on hold');
ok((await sub(ALPHA)).suspended_at !== null, 'the hold is stamped on the subscription');
ok((await q(`select count(*)::int c from profiles where workspace_id=$1`, [ALPHA]))[0].c === 1,
  'a hold touches no data: the team is still there');

// ── A payment brings it back ─────────────────────────────────────────────────
console.log('\nPayment');
await setToday('2026-02-18');
const payId = (await as(MASTER, () => q(
  `select master_record_payment($1,50000,'PKR',1,null,'bank_transfer','TRX-1',null,null,'Feb rent',null) id`, [ALPHA])))[0].id;
ok(!!payId, 'the Master records the payment by hand');
s = await sub(ALPHA);
ok(iso(s.next_due) === '2026-03-10', 'the due date moves on by exactly one cycle: ' + iso(s.next_due));
ok(s.status === 'active' && s.suspended_at === null, 'the subscription is active again');
ok((await wsRow(ALPHA)).status === 'active', 'the workspace is open again');
const p = (await q(`select * from subscription_payments where id=$1`, [payId]))[0];
ok(Number(p.amount) === 50000 && p.reference === 'TRX-1' && p.recorded_by === MASTER,
  'the payment records who took it and the reference');
ok(iso(p.period_from) === '2026-02-10' && iso(p.period_to) === '2026-03-10', 'the payment covers the cycle it paid for');

await setToday('2026-02-19');
ok(await sweep(MASTER) === 0 && (await sub(ALPHA)).status === 'active',
  'the day after paying, nothing is overdue any more');

await expectErr(() => as(MASTER, () => q(`select master_record_payment($1,50000,'PKR',1,'2030-01-01')`, [ALPHA])),
  'a payment cannot be dated in the future', /future/);
await expectErr(() => as(MASTER, () => q(`select master_record_payment($1,0,'PKR',1)`, [ALPHA])),
  'a payment of zero is refused', /more than zero/);
await expectErr(() => as(A_ADMIN, () => q(`select master_record_payment($1,50000,'PKR',1)`, [ALPHA])),
  'a workspace Admin cannot record their own rent', /Only a Master/);

// ── Personal space is skipped ────────────────────────────────────────────────
console.log('\nThe Master\'s own space');
ok((await q(`select count(*)::int c from billing_log where workspace_id=$1`, [MINE]))[0].c === 0,
  'the Master\'s own project space is never swept and never charged');
ok((await wsRow(MINE)).status !== 'suspended', '… and never put on hold');
ok((await q(`select count(*)::int c from subscriptions where workspace_id=$1`, [MINE]))[0].c === 0,
  '… and never gets a subscription row');

// ── Dashboard and report numbers ─────────────────────────────────────────────
console.log('\nDashboard and reports');
const ov = (await as(MASTER, () => q(`select master_overview() o`)))[0].o;
ok(Number(ov.collected) === 50000, 'collected this month counts only this month\'s payments');
ok(Number(ov.expected) === 30000, 'expected this month is the rent still due inside the month');
ok(ov.counts.suspended === 0 && ov.counts.active === 2, 'the counts follow the live statuses');
ok(Array.isArray(ov.months) && ov.months.length === 12, 'the dashboard carries 12 months of history');
ok(ov.renewals.some((x) => x.id === GAMMA), 'renewals list what is coming up in the next 30 days');

const rep = (await as(MASTER, () => q(`select master_report('2026-01-01','2026-12-31') r`)))[0].r;
ok(Number(rep.total) === 80000 && rep.count === 2, 'the report totals every payment in the window (50000 + 30000)');
ok(rep.by_workspace.length === 2, 'the report splits by workspace');
ok(rep.by_month.length === 2, 'the report splits by month');
await expectErr(() => as(MASTER, () => q(`select master_report('2026-12-31','2026-01-01')`)),
  'a backwards date range is refused', /start date is after/);

await expectErr(() => as(A_ADMIN, () => q(`select master_overview()`)), 'a workspace Admin cannot read the Master dashboard', /Masters only/);
await expectErr(() => as(A_ADMIN, () => q(`select master_report()`)), 'a workspace Admin cannot read the Master report', /Masters only/);
ok(await sweep(A_ADMIN) === 0, 'a workspace Admin running the sweep changes nothing');

// ── The wall ─────────────────────────────────────────────────────────────────
console.log('\nIsolation');
await as(MASTER, () => q(`select master_change_plan($1,'monthly',20000,'PKR',1,null,null,null)`, [BETA]));
ok((await as(A_ADMIN, () => q(`select workspace_id from subscriptions`))).every((r) => r.workspace_id === ALPHA),
  'an Admin sees their own plan and no other workspace\'s');
ok((await as(A_ADMIN, () => q(`select id from subscription_payments`))).length ===
   (await q(`select count(*)::int c from subscription_payments where workspace_id=$1`, [ALPHA]))[0].c,
  'an Admin sees their own payments and no other workspace\'s');
ok((await as(B_ADMIN, () => q(`select workspace_id from subscriptions`))).every((r) => r.workspace_id === BETA),
  'the other Admin sees only theirs');
ok((await as(MASTER, () => q(`select workspace_id from subscriptions`))).length === 3, 'the Master sees every plan');
ok((await as(A_ADMIN, () => q(`select id from master_access_log`))).length === 0, 'the access log is for Masters only');
await expectErr(() => as(A_ADMIN, () => q(`update subscriptions set amount_original = 1 where workspace_id=$1`, [ALPHA])
  .then(async () => { const r = await q(`select amount_original a from subscriptions where workspace_id=$1`, [ALPHA]);
                      if (Number(r[0].a) === 1) throw new Error('changed'); throw new Error('0 rows'); })),
  'an Admin cannot edit their own rent', /0 rows|row-level|permission/);

// ── The Master's bell ────────────────────────────────────────────────────────
console.log('\nNotifications');
ok((await q(`select count(*)::int c from notifications where workspace_id is null and user_id=$1`, [MASTER]))[0].c > 0,
  'Master notices carry no workspace');
ok((await as(MASTER, () => q(`select id from notifications`))).length ===
   (await q(`select count(*)::int c from notifications where workspace_id is null`))[0].c,
  'the Master reads their own notices and no workspace\'s');
ok((await as(A_ADMIN, () => q(`select id from notifications`))).length ===
   (await q(`select count(*)::int c from notifications where workspace_id=$1 and user_id=$2`, [ALPHA, A_ADMIN]))[0].c,
  'an Admin reads only their own workspace\'s notices');

// ── The audit trail ──────────────────────────────────────────────────────────
console.log('\nAudit');
ok((await q(`select count(*)::int c from master_access_log where workspace_id=$1 and action='payment_recorded'`, [ALPHA]))[0].c === 1,
  'every rent payment is written to the access log');
ok((await q(`select count(*)::int c from master_access_log where workspace_id=$1 and action='plan_changed'`, [ALPHA]))[0].c >= 1,
  'every plan change is written to the access log');
await expectErr(() => q(`update master_access_log set action='opened' where workspace_id='${ALPHA}'`),
  'the access log cannot be rewritten', /append-only/);

// ── Deleting ─────────────────────────────────────────────────────────────────
console.log('\nDeleting');
await ex(`select purge_workspace('${GAMMA}')`);
ok((await q(`select count(*)::int c from subscription_payments where workspace_id=$1`, [GAMMA]))[0].c === 0,
  'deleting a workspace removes its rent payments');
ok((await q(`select count(*)::int c from billing_log where workspace_id=$1`, [GAMMA]))[0].c === 0, '… and its reminder log');
ok((await q(`select count(*)::int c from subscription_payments where workspace_id=$1`, [ALPHA]))[0].c > 0,
  'the other workspace is untouched');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
