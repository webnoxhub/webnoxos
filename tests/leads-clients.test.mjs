// Leads + Clients inside Webnox (PART 13): per-workspace permissions, the wall between workspaces,
// lead -> client, BUID per workspace, files, public-form insert, notifications.
// Run: node tests/leads-clients.test.mjs
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
await ex(schema); await ex(schema);
ok(true, 'schema.sql (with PART 13) ran twice without errors');

const W1 = (await q(`insert into workspaces(name,slug,short_code) values ('Alpha Co','alpha','AL') returning id`))[0].id;
const W2 = (await q(`insert into workspaces(name,slug,short_code) values ('Beta Co','beta','BE') returning id`))[0].id;
await ex(`insert into workspace_roles(workspace_id,role_key,can_edit) values
  ('${W1}','sales_rep',true),('${W1}','lead_gen',true),('${W1}','cold_caller',false),('${W1}','finance',true),('${W1}','project_manager',true),('${W1}','project_agent',true),
  ('${W2}','sales_rep',true),('${W2}','project_manager',true)`);
async function person(email, name, ws, type, roles = []) {
  const [u] = await q(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }]);
  await q(`update profiles set workspace_id=$2, account_type=$3, roles=$4 where id=$1`, [u.id, ws, type, roles]);
  return u.id;
}
const A   = await person('boss@alpha.com', 'Boss Admin', W1, 'admin');
const REP = await person('rep@alpha.com',  'Rita Rep',   W1, 'member', ['sales_rep']);
const GEN = await person('gen@alpha.com',  'Gus Gen',    W1, 'member', ['lead_gen']);
const CC  = await person('cc@alpha.com',   'Cal Caller', W1, 'member', ['cold_caller']);
const FIN = await person('fin@alpha.com',  'Fay Fin',    W1, 'member', ['finance']);
const PM  = await person('pm@alpha.com',   'Pat PM',     W1, 'member', ['project_manager']);
const PM2 = await person('pm2@alpha.com',  'Pia PM',     W1, 'member', ['project_manager']);
const AG  = await person('ag@alpha.com',   'Ann Agent',  W1, 'member', ['project_agent']);
const MG  = await person('mg@alpha.com',   'Mona Manager', W1, 'manager');
const BA  = await person('boss@beta.com',  'Beta Admin', W2, 'admin');
const BREP = await person('brep@beta.com', 'Bob Rep',    W2, 'member', ['sales_rep']);
const BPM  = await person('bpm@beta.com',  'Bea PM',     W2, 'member', ['project_manager']);

console.log('Defaults are seeded per workspace');
ok((await q(`select count(*)::int c from role_permissions where workspace_id=$1`, [W1]))[0].c === 18, 'workspace Alpha has 6 roles x 3 modules');
ok((await q(`select count(*)::int c from role_permissions where workspace_id=$1`, [W2]))[0].c === 18, 'workspace Beta has its own copy');
const W3 = (await q(`insert into workspaces(name,slug,short_code) values ('Gamma','gamma','GA') returning id`))[0].id;
ok((await q(`select count(*)::int c from role_permissions where workspace_id=$1`, [W3]))[0].c === 18, 'a new workspace is seeded by trigger');

console.log('Leads — who may do what');
const [l1] = await as(A, () => q(`insert into leads (company, contact_name, source) values ('Acme Shoes', 'Tariq', 'Cold Call') returning id, workspace_id, created_by, status`));
ok(l1.workspace_id === W1 && l1.created_by === A && l1.status === 'new', 'admin adds a lead (workspace + creator set by the database)');
await as(CC, async () => {
  ok((await q(`select id from leads`)).length === 1, 'cold caller can view leads');
  const [cl] = await q(`insert into leads (company) values ('Cal Lead') returning id`);
  ok(!!cl.id, 'cold caller can add leads by default (EcomHub default)');
});
const [l3] = await as(REP, () => q(`insert into leads (company, assigned_to) values ('Rep Lead', $1) returning id`, [REP]));
ok(!!l3.id, 'sales rep adds a lead and assigns it to themselves');
await as(GEN, async () => {
  const [x] = await q(`insert into leads (company) values ('Gen Lead') returning id`);
  ok(!!x.id, 'lead generation can add leads');
  await expectErr(() => q(`delete from leads where id=$1`, [x.id]).then(r => { if (!r.length) throw new Error('row-level: nothing deleted'); }), 'lead generation cannot delete leads', /row-level|nothing/);
});
await as(FIN, async () => { ok((await q(`select id from leads`)).length === 0, 'finance cannot see leads by default'); });
await as(PM,  async () => { ok((await q(`select id from leads`)).length === 0, 'project manager cannot see leads'); });
await expectErr(() => as(REP, () => q(`insert into leads (company, assigned_to) values ('Bad', $1)`, [GEN])), 'a lead can only go to a Sales Representative', /Sales Representative/);
await expectErr(() => as(GEN, () => q(`insert into leads (company, assigned_to) values ('Bad', $1)`, [REP])), 'lead generation cannot hand leads out', /Only a Sales Representative/);
await expectErr(() => as(A, () => q(`insert into leads (company, assigned_to) values ('Cross', $1)`, [BREP])), 'cannot assign to a person of another workspace', /row-level|Sales Representative|not in this workspace/);

console.log('Admin changes a role — it applies at once');
await expectErr(() => as(REP, () => q(`delete from leads where id=$1`, [l3.id]).then(r => { if (!r.length) throw new Error('row-level: nothing deleted'); })), 'sales rep cannot delete by default', /row-level|nothing/);
await as(A, () => q(`update role_permissions set can_delete=true where role_key='sales_rep' and module='leads'`));
await as(REP, async () => { const r = await q(`delete from leads where id=$1 returning id`, [l3.id]); ok(r.length === 1, 'after the admin allows it, sales rep can delete'); });
ok((await q(`select count(*)::int c from role_permissions where workspace_id=$1 and role_key='sales_rep' and can_delete`, [W2]))[0].c === 0, "Beta's permissions did not change");
ok((await q(`select count(*)::int c from activity_logs where action='permission_changed' and workspace_id=$1`, [W1]))[0].c === 1, 'permission change is in the audit trail');
await as(REP, async () => {
  const r = await q(`update role_permissions set can_edit=true where role_key='cold_caller' returning 1`).catch(() => []);
  ok(r.length === 0, 'a member cannot change permissions');
});

console.log('Master switches a role off');
await ex(`update workspace_roles set active=false where workspace_id='${W1}' and role_key='lead_gen'`);
await as(GEN, async () => { ok((await q(`select id from leads`)).length === 0, 'a role the Master switched off gives no access'); });
await ex(`update workspace_roles set active=true where workspace_id='${W1}' and role_key='lead_gen'`);

console.log('Won lead -> client');
await expectErr(() => as(REP, () => q(`select lead_convert($1)`, [l1.id])), 'cannot convert a lead that is not won', /Mark the lead as won/);
await as(A, () => q(`update leads set status='won' where id=$1`, [l1.id]));
const cid = (await as(REP, () => q(`select lead_convert($1) as id`, [l1.id])))[0].id;
const c1 = (await q(`select * from clients where id=$1`, [cid]))[0];
ok(c1.name === 'Acme Shoes' && c1.workspace_id === W1 && c1.lead_id === l1.id, 'client created from the lead in the same workspace');
ok(c1.buid === 'BUID-1001', 'first client gets BUID-1001');
ok((await as(REP, () => q(`select lead_convert($1) as id`, [l1.id])))[0].id === cid, 'converting twice returns the same client');
ok((await q(`select client_id from leads where id=$1`, [l1.id]))[0].client_id === cid, 'lead points at its client');
ok((await q(`select count(*)::int c from notifications where kind='client' and user_id=$1`, [A]))[0].c >= 1, 'managers are told about the new client');
await expectErr(() => as(BA, () => q(`select lead_convert($1)`, [l1.id])), 'another workspace cannot convert my lead', /not found|Lead not found/i);

console.log('BUID is counted inside each workspace');
const [c2] = await as(A, () => q(`insert into clients (name) values ('Second Client') returning id, buid`));
ok(c2.buid === 'BUID-1002', 'second client in Alpha is BUID-1002');
const [bc] = await as(BA, () => q(`insert into clients (name) values ('Beta First') returning id, buid, workspace_id`));
ok(bc.buid === 'BUID-1001' && bc.workspace_id === W2, 'Beta starts again at BUID-1001');
await as(A, () => q(`update clients set name='Renamed', buid='BUID-9' where id=$1`, [c2.id]));
ok((await q(`select buid from clients where id=$1`, [c2.id]))[0].buid === 'BUID-1002', 'a BUID never changes');

console.log('Clients — project manager sees only assigned');
await expectErr(() => as(A, () => q(`update clients set project_manager=$2 where id=$1`, [c2.id, GEN])), 'project manager must hold the role', /Project Manager role/);
await expectErr(() => as(A, () => q(`update clients set project_manager=$2 where id=$1`, [c2.id, BPM])), 'project manager from another workspace refused', /Project Manager role|row-level/);
await as(A, () => q(`update clients set project_manager=$2 where id=$1`, [c2.id, PM]));
await as(PM, async () => {
  const rows = await q(`select id from clients`);
  ok(rows.length === 1 && rows[0].id === c2.id, 'project manager sees only the client assigned to them');
  const r = await q(`update clients set notes='kickoff done' where id=$1 returning id`, [c2.id]);
  ok(r.length === 1, 'and can edit it (role allows)');
  const d = await q(`delete from clients where id=$1 returning id`, [c2.id]);
  ok(d.length === 0, 'but not delete it');
});
await as(PM2, async () => { ok((await q(`select id from clients`)).length === 0, 'another project manager sees none'); });
await as(AG,  async () => { ok((await q(`select id from clients`)).length === 0, 'a project agent sees no clients'); });
await as(REP, async () => { ok((await q(`select id from clients`)).length === 2, 'sales rep sees all clients (default view)'); });
ok((await q(`select count(*)::int c from notifications where user_id=$1 and title like 'Client assigned to you%'`, [PM]))[0].c === 1, 'project manager is notified of the assignment');

console.log('Files');
const [f1] = await as(A, () => q(`insert into client_files (client_id, kind, name, storage_path) values ($1,'contract','nda.pdf',$2) returning id, workspace_id, uploaded_by`, [c2.id, `${W1}/${c2.id}/nda.pdf`]));
ok(f1.workspace_id === W1 && f1.uploaded_by === A, 'file row gets workspace and uploader from the database');
await as(PM, async () => {
  ok((await q(`select id from client_files`)).length === 1, 'assigned project manager sees the client files');
  const [g] = await q(`insert into client_files (client_id, kind, name, storage_path) values ($1,'document','brief.pdf',$2) returning id`, [c2.id, `${W1}/${c2.id}/brief.pdf`]);
  ok(!!g.id, 'and can upload');
});
await as(PM2, async () => { ok((await q(`select id from client_files`)).length === 0, 'other project manager sees no files'); });
await expectErr(() => as(BA, () => q(`insert into client_files (client_id, kind, name, storage_path) values ($1,'document','x',$2)`, [c2.id, 'x/y'])), 'cannot attach a file to another workspace\'s client', /row-level/);

console.log('The wall between workspaces');
await as(BA, async () => {
  ok((await q(`select id from clients`)).length === 1, 'Beta admin sees only Beta clients');
  ok((await q(`select id from leads`)).length === 0, 'Beta admin sees no Alpha leads');
  ok((await q(`select id from client_files`)).length === 0, 'Beta admin sees no Alpha files');
  const u = await q(`update clients set notes='hacked' where id=$1 returning id`, [c2.id]);
  ok(u.length === 0, 'Beta admin cannot update an Alpha client');
  ok((await q(`select count(*)::int c from role_permissions where workspace_id=$1`, [W1]))[0].c === 0, 'Beta admin cannot read Alpha permissions');
});
await expectErr(() => as(BA, () => q(`insert into leads (company, workspace_id) values ('Sneaky', $1)`, [W1])), 'cannot insert a lead into another workspace', /row-level/);

console.log('Public lead form (service role, no login)');
const [pl] = await q(`insert into leads (workspace_id, company, contact_name, agent_id, status) values ($1, 'Web Lead', 'Wanda', $2, 'new') returning id, workspace_id, created_by`, [W1, GEN]);
ok(pl.workspace_id === W1 && pl.created_by === null, 'a form lead lands in the right workspace with no creator');
ok((await q(`select count(*)::int c from notifications where title like 'New lead from the form%' and user_id=$1`, [A]))[0].c === 1, 'admin is told about the form lead');
ok((await q(`select count(*)::int c from notifications where title like 'Lead submitted for you%' and user_id=$1`, [GEN]))[0].c === 1, 'the agent who sent it is told');
ok((await q(`select count(*)::int c from notifications where title like 'New lead to pick up%' and user_id=$1`, [REP]))[0].c >= 1, 'sales reps are told it needs picking up');
ok((await q(`select count(*)::int c from notifications where title like 'New lead from the form%' and user_id in ($1,$2)`, [MG, CC]))[0].c >= 1, 'managers are told too');
await as(A, () => q(`insert into leads (company) values ('Admin Lead')`));
ok((await q(`select count(*)::int c from notifications where title = 'New lead: Admin Lead' and user_id=$1`, [GEN]))[0].c === 1, 'a new lead also notifies Lead Generation');
ok((await q(`select count(*)::int c from notifications where title like 'New lead from the form%' and user_id in ($1,$2)`, [BA, BREP]))[0].c === 0, 'nobody in another workspace is notified');

console.log('Deleting');
await as(A, async () => {
  const d = await q(`delete from clients where id=$1 returning id`, [c2.id]);
  ok(d.length === 1, 'admin deletes a client');
});
ok((await q(`select count(*)::int c from client_files where client_id=$1`, [c2.id]))[0].c === 0, 'its files go with it');
await q(`select purge_person_activity($1)`, [GEN]);
await ex(`delete from auth.users where id='${GEN}'`);
ok((await q(`select agent_id from leads where id=$1`, [pl.id]))[0].agent_id === null, 'deleting a person keeps their leads (agent cleared)');
await q(`select purge_workspace($1)`, [W1]);
ok((await q(`select count(*)::int c from leads where workspace_id=$1`, [W1]))[0].c === 0
   && (await q(`select count(*)::int c from clients where workspace_id=$1`, [W1]))[0].c === 0
   && (await q(`select count(*)::int c from role_permissions where workspace_id=$1`, [W1]))[0].c === 0, 'deleting a workspace removes its leads, clients and permissions');
ok((await q(`select count(*)::int c from clients where workspace_id=$1`, [W2]))[0].c === 1, 'and leaves other workspaces alone');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
