// Rent invoices and the workspace Billing page (PART 18): issuing, numbering, settling,
// voiding, and who may read an invoice — including while the workspace is on hold.
// Run: node tests/billing.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8');
process.on('unhandledRejection', e => { console.log('UNCAUGHT:', String(e.message).slice(0, 300)); process.exit(1); });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

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
const iso = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const inv = async (no) => (await q(`select * from rent_invoices where invoice_no=$1`, [no]))[0];
const invs = (ws) => q(`select * from rent_invoices where workspace_id=$1 order by invoice_no`, [ws]);

await ex(PRE);
const migrationStart = schema.indexOf('-- PART 17 — Master Finance');
const migration = fs.readFileSync(path.join(here, '..', 'supabase', '20261114_master_finance_billing.sql'), 'utf8');
await ex(schema.slice(0, migrationStart));
await ex(migration);
await ex(migration);
ok(true, 'Finance and Billing migration ran twice over the pre-Finance schema');

const mk = async (email, name) =>
  (await q(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }]))[0].id;

const MASTER = await mk('webnoxhub@gmail.com', 'Haseeb Gul');
await q(`select promote_to_master('webnoxhub@gmail.com')`);

const ALPHA = (await q(`insert into workspaces(name,slug,short_code) values ('Alpha Co','alpha','AL') returning id`))[0].id;
const BETA  = (await q(`insert into workspaces(name,slug,short_code) values ('Beta Co','beta','BE') returning id`))[0].id;
const MINE  = (await q(`insert into workspaces(name,slug,short_code,type) values ('Webnox Hub','webnox','WX','master_project') returning id`))[0].id;

const person = async (email, name, ws, type) => {
  const id = await mk(email, name);
  await q(`update profiles set workspace_id=$2, account_type=$3 where id=$1`, [id, ws, type]);
  return id;
};
const A_ADMIN  = await person('boss@alpha.com', 'Alpha Boss', ALPHA, 'admin');
const A_MEMBER = await person('sara@alpha.com', 'Sara', ALPHA, 'member');
const B_ADMIN  = await person('boss@beta.com', 'Beta Boss', BETA, 'admin');

await setToday('2026-01-10');
await as(MASTER, () => q(`select master_change_plan($1,'monthly',50000,'PKR',1,7,null,'Growth')`, [ALPHA]));
await as(MASTER, () => q(`select master_change_plan($1,'quarterly',200,'USD',280,7,null,null)`, [BETA]));

// ── Issuing ──────────────────────────────────────────────────────────────────
console.log('\nIssuing');
await setToday('2026-02-01');
const id1 = (await as(MASTER, () => q(`select master_issue_rent_invoice($1) id`, [ALPHA])))[0].id;
let i1 = (await q(`select * from rent_invoices where id=$1`, [id1]))[0];
ok(i1.invoice_no === 'INV-WX001', 'the first invoice is numbered INV-WX001, not per workspace');
ok(Number(i1.amount_original) === 50000 && i1.currency === 'PKR', 'the amount and currency come from the plan');
ok(iso(i1.period_from) === '2026-02-10' && iso(i1.period_to) === '2026-03-10', 'the period is the cycle the rent is for');
ok(iso(i1.due_date) === '2026-02-10' && iso(i1.issue_date) === '2026-02-01', 'it is due on the day the rent is due');
ok(i1.status === 'sent' && i1.issued_by === MASTER, 'it starts unpaid and records which Master issued it');

const id2 = (await as(MASTER, () => q(`select master_issue_rent_invoice($1) id`, [BETA])))[0].id;
const i2 = (await q(`select * from rent_invoices where id=$1`, [id2]))[0];
ok(i2.invoice_no === 'INV-WX002', 'the counter runs across workspaces: INV-WX002');
ok(Number(i2.amount) === 56000 && Number(i2.amount_original) === 200 && i2.currency === 'USD',
  'an invoice in another currency carries its PKR value too (200 USD x 280)');
ok(iso(i2.period_from) === '2026-04-10' && iso(i2.period_to) === '2026-07-10', 'a quarterly plan bills three months');

await expectErr(() => as(MASTER, () => q(`select master_issue_rent_invoice($1)`, [ALPHA])),
  'the same period cannot be invoiced twice while the first is unpaid', /already exists/);
await expectErr(() => as(MASTER, () => q(`select master_issue_rent_invoice($1)`, [MINE])),
  'a personal workspace is never invoiced', /pays no rent/);
await expectErr(() => as(A_ADMIN, () => q(`select master_issue_rent_invoice($1)`, [ALPHA])),
  'a workspace Admin cannot invoice themselves', /Only a Master/);
await expectErr(() => as(MASTER, () => q(`select master_issue_rent_invoice($1,'2026-06-01','2026-05-01')`, [ALPHA])),
  'a period that ends before it starts is refused', /ends before it starts/);

const id3 = (await as(MASTER, () => q(
  `select master_issue_rent_invoice($1,'2026-03-10','2026-04-10','2026-03-10',60000,'PKR',1,'Price agreed on call') id`, [ALPHA])))[0].id;
ok((await q(`select notes, amount_original a from rent_invoices where id=$1`, [id3]))[0].notes === 'Price agreed on call',
  'every field can be overridden by hand');

// ── A payment settles the oldest open invoice ────────────────────────────────
console.log('\nSettling');
await setToday('2026-02-12');
await as(MASTER, () => q(`select master_record_payment($1,50000,'PKR',1,null,'bank_transfer','TRX-1')`, [ALPHA]));
i1 = await inv('INV-WX001');
ok(i1.status === 'paid' && iso(i1.paid_on) === '2026-02-12', 'recording a payment closes the oldest open invoice');
ok(i1.payment_id !== null, 'the invoice points at the payment that settled it');
ok((await q(`select status from rent_invoices where id=$1`, [id3]))[0].status === 'sent',
  'the next period\'s invoice is left alone');
ok((await q(`select count(*)::int c from master_access_log where workspace_id=$1 and action='invoice_issued'`, [ALPHA]))[0].c === 2,
  'issuing is written to the access log');
ok((await q(`select detail->>'invoice_no' n from master_access_log
             where workspace_id=$1 and action='payment_recorded' order by at desc limit 1`, [ALPHA]))[0].n === 'INV-WX001',
  'the payment log names the invoice it settled');

const bell = (await q(`select title from notifications where user_id=$1 order by created_at desc limit 1`, [A_ADMIN]))[0];
ok(/invoice INV-WX001/i.test((await q(`select body from notifications where user_id=$1 order by created_at desc limit 1`, [A_ADMIN]))[0].body),
  'the Admin is thanked and told which invoice was settled');
ok(!!bell, 'the Admin has a notice');

await setToday('2026-02-20');
await as(MASTER, () => q(`select master_record_payment($1,50000,'PKR',1)`, [ALPHA]));
ok((await q(`select status from rent_invoices where id=$1`, [id3]))[0].status === 'paid',
  'the next payment closes the next invoice');
await as(MASTER, () => q(`select master_record_payment($1,50000,'PKR',1)`, [ALPHA]));
ok((await invs(ALPHA)).every((x) => x.status === 'paid'),
  'a payment with no invoice open changes nothing and still succeeds');

// ── Voiding ──────────────────────────────────────────────────────────────────
console.log('\nVoiding');
await expectErr(() => as(MASTER, () => q(`select master_void_rent_invoice($1,'oops')`, [id1])),
  'a paid invoice cannot be voided', /cannot be voided/);
await as(MASTER, () => q(`select master_void_rent_invoice($1,'Wrong currency')`, [id2]));
const v = await inv('INV-WX002');
ok(v.status === 'void' && /Wrong currency/.test(v.notes), 'an unpaid invoice is voided with its reason kept');
await as(MASTER, () => q(`select master_void_rent_invoice($1,'again')`, [id2]));
ok((await inv('INV-WX002')).status === 'void', 'voiding twice is harmless');
ok((await q(`select count(*)::int c from rent_invoices where id=$1`, [id2]))[0].c === 1, 'a voided invoice is kept, never deleted');
await expectErr(() => as(B_ADMIN, () => q(`select master_void_rent_invoice($1,'x')`, [id2])),
  'a workspace Admin cannot void an invoice', /Only a Master/);

// A voided period can be invoiced again.
await setToday('2026-04-15');
const again = (await as(MASTER, () => q(`select master_issue_rent_invoice($1,'2026-02-10','2026-05-10') id`, [BETA])))[0].id;
ok((await q(`select invoice_no n from rent_invoices where id=$1`, [again]))[0].n === 'INV-WX004',
  'after a void the same period may be invoiced again, with a fresh number');

// ── Who may read ─────────────────────────────────────────────────────────────
console.log('\nWho may read');
ok((await as(A_ADMIN, () => q(`select workspace_id from rent_invoices`))).every((r) => r.workspace_id === ALPHA),
  'an Admin reads their own invoices and no other workspace\'s');
ok((await as(B_ADMIN, () => q(`select workspace_id from rent_invoices`))).every((r) => r.workspace_id === BETA),
  'the other Admin reads only theirs');
ok((await as(A_MEMBER, () => q(`select id from rent_invoices`))).length === 0,
  'an ordinary member sees no invoices at all');
ok((await as(MASTER, () => q(`select id from rent_invoices`))).length === 4, 'the Master sees every invoice');
await expectErr(() => as(B_ADMIN, () => q(`update rent_invoices set status='paid' where id=$1`, [id2])
  .then(async () => {
    const r = await q(`select status from rent_invoices where id=$1`, [id2]);
    throw new Error(r[0].status === 'void' ? '0 rows' : 'changed');
  })), 'an Admin cannot mark one of their own invoices paid', /0 rows|row-level|permission/);
ok((await as(A_ADMIN, () => q(`select key from master_counters`))).length === 0, 'the invoice counter is for Masters only');

// ── On hold, the Billing page still opens ────────────────────────────────────
console.log('\nOn hold');
await q(`update workspaces set status='suspended' where id=$1`, [ALPHA]);
ok((await as(A_ADMIN, () => q(`select id from rent_invoices`))).length === 2,
  'a hold does not hide the invoices from the Admin');
ok((await as(A_ADMIN, () => q(`select workspace_id from subscriptions`))).length === 1,
  '… nor their plan');
ok((await as(A_ADMIN, () => q(`select id from subscription_payments`))).length === 3,
  '… nor what they have already paid');
await q(`update workspaces set status='active' where id=$1`, [ALPHA]);

// ── Deleting ─────────────────────────────────────────────────────────────────
console.log('\nDeleting');
await ex(`select purge_workspace('${BETA}')`);
ok((await q(`select count(*)::int c from rent_invoices where workspace_id=$1`, [BETA]))[0].c === 0,
  'deleting a workspace removes its rent invoices');
ok((await q(`select count(*)::int c from rent_invoices where workspace_id=$1`, [ALPHA]))[0].c === 2,
  'the other workspace keeps its own');
ok((await q(`select last from master_counters where key='rent'`))[0].last === 4,
  'the platform counter never goes backwards, so a number is never reused');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
