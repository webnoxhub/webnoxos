// Finance + Invoices inside Webnox (PART 16): codes and numbers per workspace, totals and currency, who sees what,
// salaries hidden from Finance, reminders that happen once, receipts, and the wall between workspaces.
// Run: node tests/finance.test.mjs
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
const mkdb = () => {
  const db = new PGlite();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const ex = (sql) => db.exec(sql);
  async function as(uid, fn) {
    await ex(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
    try { return await fn(); } finally { await ex(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
  }
  return { db, q, ex, as };
};
async function expectErr(fn, msg, pattern) {
  try { await fn(); ok(false, msg + ' (no error thrown)'); }
  catch (e) { ok(!pattern || pattern.test(e.message), msg + ' -> ' + e.message.slice(0, 90)); }
}

{
  const { q, ex, as } = mkdb();
  await ex(PRE); await ex(schema); await ex(schema);
  ok(true, 'schema.sql (with PART 16) ran twice without errors');

  const W1 = (await q(`insert into workspaces(name,slug,short_code) values ('Alpha Co','alpha','AL') returning id`))[0].id;
  const W2 = (await q(`insert into workspaces(name,slug,short_code) values ('Beta Co','beta','BE') returning id`))[0].id;
  await ex(`insert into workspace_roles(workspace_id,role_key,can_edit) values
    ('${W1}','project_manager',true),('${W1}','finance',true),('${W2}','finance',true)`);
  async function person(email, name, ws, type, roles = [], title = null) {
    const [u] = await q(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }]);
    await q(`update profiles set workspace_id=$2, account_type=$3, roles=$4, job_title=$5 where id=$1`, [u.id, ws, type, roles, title]);
    return u.id;
  }
  const A   = await person('boss@alpha.com', 'Boss Admin', W1, 'admin');
  const MG  = await person('mg@alpha.com',   'Mona Manager', W1, 'manager');
  const FIN = await person('fin@alpha.com',  'Fay Finance', W1, 'member', ['finance'], 'Accountant');
  const PM  = await person('pm@alpha.com',   'Pat PM', W1, 'member', ['project_manager']);
  const MEM = await person('mem@alpha.com',  'Max Member', W1, 'member', [], 'Designer');
  const BA  = await person('boss@beta.com',  'Beta Admin', W2, 'admin');
  const BF  = await person('fin@beta.com',   'Bea Finance', W2, 'member', ['finance']);

  console.log('Client invoice codes');
  const mkClient = (uid, name) => as(uid, () => q(`insert into clients(name) values ($1) returning id, invoice_code, buid`, [name])).then(r => r[0]);
  const acme = await mkClient(A, 'Acme Shoes');
  const him  = await mkClient(A, 'Him Fashions');
  const glow = await mkClient(A, 'Glow');
  const asp  = await mkClient(A, 'Alpha Sparks');
  ok(acme.invoice_code === 'AS', 'two words -> first letters (Acme Shoes = AS)');
  ok(him.invoice_code === 'HF', 'Him Fashions = HF');
  ok(glow.invoice_code === 'GW', 'one word -> first and last letter (Glow = GW)');
  ok(asp.invoice_code !== 'AS' && /^[A-Z0-9]{2,4}$/.test(asp.invoice_code), 'a taken code gets another one from the name: ' + asp.invoice_code);
  const bAcme = await mkClient(BA, 'Acme Shoes');
  ok(bAcme.invoice_code === 'AS' && bAcme.buid === 'BUID-1001', 'codes restart per workspace: the other workspace can use AS and BUID-1001 again');
  await q(`update clients set invoice_code='ZZ', buid='BUID-9' where id=$1`, [acme.id]);
  ok((await q(`select invoice_code, buid from clients where id=$1`, [acme.id]))[0].invoice_code === 'AS', 'the code never changes once given');

  console.log('Invoice numbers and totals');
  const inv = (uid, o) => as(uid, () => q(`insert into invoices(client_id, kind, description, items, tax_percent, discount, currency, fx_rate, billing_period, status, due_date)
    values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, coalesce($10,'sent'), $11) returning *`,
    [o.client ?? null, o.kind ?? 'client', o.desc ?? '', JSON.stringify(o.items ?? []), o.tax ?? 0, o.discount ?? 0, o.cur ?? null, o.fx ?? null, o.period ?? '', o.status ?? null, o.due ?? null])).then(r => r[0]);
  const i1 = await inv(A, { client: acme.id, items: [{ description: 'Website', qty: 2, rate: 500 }, { description: 'Logo', qty: 1, rate: 250 }], tax: 10, discount: 50 });
  ok(i1.invoice_number === 'INV-BUID-AS001', 'first invoice of the client: ' + i1.invoice_number);
  ok(Number(i1.amount) === 1320 && Number(i1.amount_original) === 1320, '(2x500 + 250 - 50 discount) + 10% tax = 1320');
  ok(i1.currency === 'USD' && Number(i1.fx_rate) === 1, 'workspace currency needs no rate');
  ok(i1.workspace_id === W1 && i1.created_by === A && i1.issued_by === A && i1.issued_by_name === 'Boss Admin', 'workspace, creator and "issued by" set by the database');
  ok(/^REF-\d{6}-\d{4}$/.test(i1.reference_no), 'reference number: ' + i1.reference_no);
  const i2 = await inv(MG, { client: acme.id, items: [{ description: 'Hosting', qty: 1, rate: 100 }] });
  ok(i2.invoice_number === 'INV-BUID-AS002', 'a manager gets the next number: ' + i2.invoice_number);
  const i3 = await inv(A, { client: him.id, items: [{ description: 'Ads', qty: 1, rate: 100 }] });
  ok(i3.invoice_number === 'INV-BUID-HF001', 'numbers count per client');
  const ib = await inv(BA, { client: bAcme.id, items: [{ description: 'Ads', qty: 1, rate: 100 }] });
  ok(ib.invoice_number === 'INV-BUID-AS001', 'the other workspace starts at 001 too');
  ok((await as(A, () => q(`select invoice_next_number('client', $1) as n`, [acme.id])))[0].n === 'INV-BUID-AS003', 'the form previews the next number');
  const biz = await inv(A, { kind: 'business', items: [{ description: 'Consulting', qty: 1, rate: 300 }] }).catch(e => e);
  ok(String(biz.message || '').includes('who this invoice is for'), 'a business invoice needs a name');
  const biz1 = (await as(A, () => q(`insert into invoices(kind, bill_to, items) values ('business', '{"name":"Walk-in Ltd"}', '[{"description":"Consulting","qty":1,"rate":300}]') returning *`)))[0];
  ok(biz1.invoice_number === 'INV-AC001' && biz1.client_id === null, 'business invoice number uses the company initials: ' + biz1.invoice_number);
  await expectErr(() => as(A, () => q(`insert into invoices(client_id, items) values (null, '[]')`)), 'a client invoice needs a client', /violates check|Choose a client|kind/i);
  await expectErr(() => inv(A, { client: acme.id, items: [{ description: '', qty: 1, rate: 1 }] }), 'every line needs a description', /description/);
  await expectErr(() => inv(A, { client: acme.id, items: [{ description: 'x', qty: 1, rate: 10 }], discount: 99 }), 'discount cannot exceed the total', /discount/);
  await expectErr(() => inv(A, { client: acme.id, items: [{ description: 'x', qty: 1, rate: 10 }], cur: 'EUR' }), 'another currency needs a rate', /exchange rate/);
  const ie = await inv(A, { client: acme.id, items: [{ description: 'Retainer', qty: 1, rate: 100 }], cur: 'eur', fx: 1.25 });
  ok(ie.currency === 'EUR' && Number(ie.amount) === 125 && Number(ie.amount_original) === 100, 'EUR 100 at 1.25 = USD 125 (done by the database)');
  await expectErr(() => as(A, () => q(`insert into invoices(client_id, items) values ($1, '[{"description":"x","qty":1,"rate":1}]')`, [bAcme.id])), 'a client of another workspace is refused', /Client not found|row-level/);

  console.log('Locking');
  await ex(`update invoices set invoice_number='HACK', reference_no='HACK', kind='business' where id=${i1.id}`);
  const lk = (await q(`select invoice_number, reference_no, kind from invoices where id=$1`, [i1.id]))[0];
  ok(lk.invoice_number === 'INV-BUID-AS001' && lk.kind === 'client' && lk.reference_no === i1.reference_no, 'number, reference and kind cannot be changed after saving');
  await expectErr(() => as(A, () => q(`update invoices set invoice_number='X' where id=$1`, [i1.id])), 'the number is not even an editable column', /permission denied/);

  console.log('Paying');
  await as(FIN, () => q(`update invoices set status='paid' where id=$1`, [i1.id]));
  const paid = (await q(`select status, paid_date from invoices where id=$1`, [i1.id]))[0];
  ok(paid.status === 'paid' && paid.paid_date !== null, 'marking paid sets the paid date');
  ok((await q(`select count(*)::int c from activity_logs where action='invoice_paid'`))[0].c === 1, 'activity line written');
  ok((await q(`select count(*)::int c from notifications where user_id in ($1,$2) and title like 'Invoice paid by Acme Shoes%'`, [A, MG]))[0].c === 2, 'Admin and Manager are told');
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title like 'Invoice paid by%'`, [FIN]))[0].c === 0, 'the actor is never notified');
  await as(A, () => q(`update invoices set status='sent' where id=$1`, [i1.id]));
  ok((await q(`select paid_date from invoices where id=$1`, [i1.id]))[0].paid_date === null, 'un-paying clears the date');
  await as(A, () => q(`update invoices set status='paid' where id=$1`, [i1.id]));

  console.log('Who sees invoices');
  await as(FIN, async () => ok((await q(`select id from invoices`)).length === 5, 'Finance sees every invoice of the workspace (client and business)'));
  await as(MEM, async () => ok((await q(`select id from invoices`)).length === 0, 'a member with no finance rights sees none'));
  await as(PM,  async () => ok((await q(`select id from invoices`)).length === 0, 'a Project Manager sees none by default'));
  await as(BA,  async () => ok((await q(`select id from invoices`)).length === 1, 'another workspace sees only its own'));
  await as(BF,  async () => ok((await q(`select id from invoices`)).length === 1, 'the other workspace\'s Finance too'));
  await expectErr(() => as(MEM, () => q(`insert into invoices(client_id, items) values ($1, '[{"description":"x","qty":1,"rate":1}]')`, [acme.id])), 'a member cannot create invoices', /row-level/);
  await expectErr(() => as(BF, () => q(`update invoices set status='paid' where id=$1`, [i2.id]).then(r => { if (!r.length) throw new Error('0 rows'); })), 'another workspace cannot touch the invoice', /0 rows|row-level/);
  await ex(`update clients set project_manager='${PM}' where id=${acme.id}`);
  await ex(`update role_permissions set can_view=true, can_edit=true where workspace_id='${W1}' and role_key='project_manager' and module='finance'`);
  await as(PM, async () => ok((await q(`select id from invoices`)).length === 3, 'a Project Manager the Admin allowed sees their own client\'s invoices only (not business, not other clients)'));
  await as(PM, () => q(`select invoice_next_number('client', $1)`, [acme.id]));
  await ex(`update role_permissions set can_view=false, can_edit=false where workspace_id='${W1}' and role_key='project_manager' and module='finance'`);
  await as(PM, async () => ok((await q(`select id from invoices`)).length === 0, 'switching the permission off takes it away at once'));
  await ex(`update workspace_roles set active=false where workspace_id='${W1}' and role_key='finance'`);
  await as(FIN, async () => ok((await q(`select id from invoices`)).length === 0, 'a role the Master switched off loses finance access'));
  await ex(`update workspace_roles set active=true where workspace_id='${W1}' and role_key='finance'`);

  console.log('Expenses, salaries and currency');
  const ex1 = (await as(MG, () => q(`insert into expenses(title, category, amount) values ('Figma', 'tools', 15) returning *`)))[0];
  ok(ex1.workspace_id === W1 && ex1.created_by === MG && Number(ex1.amount) === 15 && ex1.currency === 'USD', 'expense: workspace, creator and currency set by the database');
  const exg = (await as(FIN, () => q(`insert into expenses(title, category, currency, amount_original, fx_rate) values ('Adobe', 'tools', 'GBP', 20, 1.3) returning *`)))[0];
  ok(Number(exg.amount) === 26, 'GBP 20 at 1.3 = 26');
  await expectErr(() => as(FIN, () => q(`insert into expenses(title, category, amount) values ('Pay', 'salary', 500)`)), 'Finance cannot add a salary', /row-level/);
  await expectErr(() => as(MEM, () => q(`insert into expenses(title, category, amount) values ('x', 'tools', 5)`)), 'a member cannot add an expense', /row-level/);
  await expectErr(() => as(A, () => q(`insert into recurring_expenses(title, category, amount, next_due) values ('Pay', 'salary', 500, current_date)`)), 'a salary needs a team member', /Pick the team member/);
  await expectErr(() => as(A, () => q(`insert into expenses(title, category, amount, payee_member) values ('Pay', 'salary', 5, $1)`, [BA])), 'a person of another workspace cannot be named', /not in this workspace/);
  const sal = (await as(A, () => q(`insert into recurring_expenses(title, category, amount, payee_member, frequency, next_due) values ('Salary', 'salary', 800, $1, 'monthly', current_date + 40) returning id`, [MEM])))[0];
  await as(FIN, async () => {
    ok((await q(`select id from recurring_expenses`)).length === 0, 'Finance does not see salaries (bills)');
    ok((await q(`select id from expenses where category='salary'`)).length === 0, 'Finance does not see salary payments');
  });
  await as(MG, async () => ok((await q(`select id from recurring_expenses`)).length === 1, 'a Manager sees the salary'));
  await as(BA, async () => ok((await q(`select id from expenses`)).length === 0, 'another workspace sees no expense'));
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title like 'New expense: Figma%'`, [A]))[0].c === 1, 'the Admin hears about a new expense');

  console.log('Bills: pay, skip, one-time');
  const today = (await q(`select (now() at time zone 'Asia/Karachi')::date::text as d`))[0].d;
  const mk = async (uid, title, extra = '') => (await as(uid, () => q(`insert into recurring_expenses(title, category, amount, frequency, next_due ${extra.split('|')[0]}) values ('${title}', 'tools', 40, ${extra.split('|')[1] || `'monthly'`}, '${today}' ${extra.split('|')[2] || ''}) returning id`)))[0].id;
  const b1 = await mk(MG, 'Hosting');
  const paidId = (await as(FIN, () => q(`select recurring_mark_paid($1, null, null, null) as id`, [b1])))[0].id;
  ok(paidId !== null && (await q(`select count(*)::int c from expenses where recurring_id=$1`, [b1]))[0].c === 1, 'Mark paid records the expense');
  ok((await q(`select next_due::text d from recurring_expenses where id=$1`, [b1]))[0].d > today, 'and moves the due date forward');
  await as(FIN, () => q(`select recurring_mark_paid($1)`, [b1]));
  ok((await q(`select count(*)::int c from expenses where recurring_id=$1`, [b1]))[0].c === 2, 'the next month can be paid too');
  const once = await mk(MG, 'Domain', `|'once'`);
  await as(FIN, () => q(`select recurring_mark_paid($1)`, [once]));
  ok((await q(`select active from recurring_expenses where id=$1`, [once]))[0].active === false, 'paying a one-time bill closes it');
  await expectErr(() => as(FIN, () => q(`select recurring_skip($1)`, [once])), 'a one-time bill cannot be skipped', /can't be skipped|Bill not found/);
  const b2 = await mk(MG, 'Zoom');
  await as(FIN, () => q(`select recurring_skip($1)`, [b2]));
  ok((await q(`select count(*)::int c from expenses where recurring_id=$1`, [b2]))[0].c === 0 && (await q(`select next_due::text d from recurring_expenses where id=$1`, [b2]))[0].d > today, 'Skip moves on without an expense');
  await expectErr(() => as(MEM, () => q(`select recurring_mark_paid($1)`, [b2])), 'a member cannot pay bills', /permission/);
  await expectErr(() => as(BF, () => q(`select recurring_mark_paid($1)`, [b2])), 'another workspace cannot pay my bill', /Bill not found/);
  ok((await q(`select advance_due('2026-01-31'::date, 'monthly')::text d`))[0].d === '2026-02-28', '31 January + one month = 28 February');
  ok((await q(`select advance_due('2028-01-31'::date, 'monthly')::text d`))[0].d === '2028-02-29', 'a leap year gives 29 February');

  console.log('Reminders happen once');
  await ex(`delete from notifications`);
  const dueToday = await mk(MG, 'Slack');
  const autoB = (await as(MG, () => q(`insert into recurring_expenses(title, category, amount, frequency, next_due, auto_post) values ('Canva', 'tools', 12, 'monthly', '${today}', true) returning id`)))[0].id;
  const salDue = (await as(A, () => q(`insert into recurring_expenses(title, category, amount, payee_member, frequency, next_due) values ('Salary', 'salary', 800, $1, 'monthly', '${today}') returning id`, [MEM])))[0].id;
  await as(A, () => q(`select finance_sweep()`));
  const c1 = (await q(`select count(*)::int c from notifications`))[0].c;
  for (let k = 0; k < 4; k++) await as(A, () => q(`select finance_sweep()`));
  await as(MG, () => q(`select finance_sweep()`));
  ok((await q(`select count(*)::int c from notifications`))[0].c === c1 && c1 > 0, `running the sweep five times sends each reminder once (${c1})`);
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title like 'Due today: Slack%'`, [FIN]))[0].c === 1, 'Finance is reminded of a bill that is due');
  ok((await q(`select count(*)::int c from notifications where title like '%Salary%' and user_id=$1`, [FIN]))[0].c === 0, 'Finance is never told about salaries');
  ok((await q(`select count(*)::int c from notifications where title like '%Salary%' and user_id in ($1,$2)`, [A, MG]))[0].c >= 2, 'Admin and Manager are');
  ok((await q(`select count(*)::int c from expenses where recurring_id=$1`, [autoB]))[0].c === 1, 'an automatic bill is charged once');
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title like 'Charged: Canva%'`, [FIN]))[0].c === 1, '… and Finance is told it was charged');
  const w1n = (await q(`select count(*)::int c from notifications where workspace_id=$1`, [W1]))[0].c;
  await as(BA, () => q(`select finance_sweep()`));
  ok((await q(`select count(*)::int c from notifications where workspace_id=$1`, [W1]))[0].c === w1n, 'another workspace\'s sweep never creates notices here');
  ok((await q(`select count(*)::int c from finance_report_log where workspace_id=$1`, [W1]))[0].c === 1, 'last month\'s report notice is logged once');

  console.log('Numbers');
  const ov = (await as(FIN, () => q(`select finance_overview() as o`)))[0].o;
  ok(ov.currency === 'USD' && Number(ov.revenue_total) === 1320, 'overview counts paid invoices of this workspace only: ' + ov.revenue_total);
  ok(ov.salaries_monthly === null || ov.salaries_monthly === undefined, 'Finance does not get the salary total');
  const ovm = (await as(MG, () => q(`select finance_overview() as o`)))[0].o;
  ok(Number(ovm.salaries_monthly) === 1600, 'a Manager does: ' + ovm.salaries_monthly);
  ok(Number(ovm.expenses_total) >= Number(ov.expenses_total), 'expense totals include salaries only for a Manager');
  const mon = (await q(`select to_char(now() at time zone 'Asia/Karachi','YYYY-MM-01') as m`))[0].m;
  const rp = (await as(FIN, () => q(`select finance_report($1::date) as r`, [mon])))[0].r;
  ok(rp.show_salaries === false && Number(rp.salaries) === 0 && rp.expense_rows.every(e => e.category !== 'salary'), 'the monthly report hides salaries from Finance');
  ok(rp.revenue_rows.some(r => r.client === 'Acme Shoes'), 'revenue rows name the client');
  await expectErr(() => as(MEM, () => q(`select finance_overview()`)), 'a member cannot open finance numbers', /access to finance/);
  const bs = (await as(MG, () => q(`select business_summary() as s`)))[0].s;
  ok(Number(bs.revenue_month) === 1320 && Number(bs.active_clients) + 0 >= 0, 'business_summary for the dashboard: revenue ' + bs.revenue_month);
  await expectErr(() => as(MEM, () => q(`select business_summary()`)), 'a member cannot read it', /access to finance/);
  const bsb = (await as(BA, () => q(`select business_summary() as s`)))[0].s;
  ok(Number(bsb.revenue_total) === 0, 'the other workspace sees its own numbers (0 paid)');
  await expectErr(() => as(MEM, () => q(`select recurring_skip(1)`)), 'sweep-style calls need rights', /permission|not found/i);

  console.log('Receipts');
  await expectErr(() => as(MG, () => q(`update expenses set attachments='[{"path":"x/expense/1/a.pdf","name":"a.pdf","type":"application/pdf"}]'::jsonb where id=$1`, [ex1.id])), 'a path of another row or workspace is refused', /not valid/);
  const okPath = `${W1}/expense/${ex1.id}/receipt.pdf`;
  await as(MG, () => q(`update expenses set attachments=$2::jsonb where id=$1`, [ex1.id, JSON.stringify([{ path: okPath, name: 'receipt.pdf', type: 'application/pdf' }])]));
  ok((await q(`select jsonb_array_length(attachments) n from expenses where id=$1`, [ex1.id]))[0].n === 1, 'a PDF of its own row is accepted');
  await expectErr(() => as(MG, () => q(`update expenses set attachments=$2::jsonb where id=$1`, [ex1.id, JSON.stringify([{ path: okPath, name: 'x.exe', type: 'application/x-msdownload' }])])), 'only PDF or images', /PDF or an image/);
  ok((await as(MG, () => q(`select can_finance_file($1,'view') as ok`, [okPath])))[0].ok === true, 'a Manager may open it');
  ok((await as(FIN, () => q(`select can_finance_file($1,'view') as ok`, [okPath])))[0].ok === true, 'Finance may open it');
  ok((await as(MEM, () => q(`select can_finance_file($1,'view') as ok`, [okPath])))[0].ok === false, 'a member may not');
  ok((await as(BF, () => q(`select can_finance_file($1,'view') as ok`, [okPath])))[0].ok === false, 'another workspace\'s Finance may not');
  const salFile = `${W1}/bill/${sal.id}/contract.pdf`;
  ok((await as(FIN, () => q(`select can_finance_file($1,'view') as ok`, [salFile])))[0].ok === false, 'a salary\'s files are closed to Finance');
  ok((await as(MG, () => q(`select can_finance_file($1,'edit') as ok`, [salFile])))[0].ok === true, 'but open to a Manager');

  console.log('Settings: invoice details');
  await as(A, () => q(`update app_settings set invoice_details='{"address":"1 High St","terms_days":14}'::jsonb where workspace_id=$1`, [W1]));
  ok((await q(`select invoice_details->>'address' a from app_settings where workspace_id=$1`, [W1]))[0].a === '1 High St', 'the Admin saves company details for invoices');
  await expectErr(() => as(MG, () => q(`update app_settings set invoice_details='{"x":1}'::jsonb where workspace_id=$1`, [W1]).then(async () => { const r = await q(`select invoice_details->>'x' x from app_settings where workspace_id=$1`, [W1]); if (r[0].x === '1') throw new Error('changed'); throw new Error('0 rows'); })), 'a Manager cannot change them (Admin only)', /0 rows|row-level/);

  console.log('Deleting');
  await ex(`select purge_workspace('${W2}')`);
  ok((await q(`select count(*)::int c from invoices where workspace_id=$1`, [W2]))[0].c === 0, 'deleting a workspace removes its invoices');
  ok((await q(`select count(*)::int c from invoice_counters where workspace_id=$1`, [W2]))[0].c === 0, '… and its counters');
  ok((await q(`select count(*)::int c from invoices where workspace_id=$1`, [W1]))[0].c > 0, 'the other workspace is untouched');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
