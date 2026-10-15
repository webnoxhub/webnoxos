// Projects inside Webnox (PART 15): project manager, staffing requests (approve / decline / discuss),
// filling approved slots with Project Agents, tasks, the wall between workspaces, old-data move.
// Run: node tests/projects.test.mjs
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

// ───────────────────────────────────────── main
{
  const { q, ex, as } = mkdb();
  await ex(PRE); await ex(schema); await ex(schema);
  ok(true, 'schema.sql (with PART 15) ran twice without errors');

  const W1 = (await q(`insert into workspaces(name,slug,short_code) values ('Alpha Co','alpha','AL') returning id`))[0].id;
  const W2 = (await q(`insert into workspaces(name,slug,short_code) values ('Beta Co','beta','BE') returning id`))[0].id;
  await ex(`insert into workspace_roles(workspace_id,role_key,can_edit) values
    ('${W1}','project_manager',true),('${W1}','project_agent',true),('${W1}','finance',true),
    ('${W2}','project_manager',true),('${W2}','project_agent',true)`);
  async function person(email, name, ws, type, roles = [], title = null, dept = null) {
    const [u] = await q(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }]);
    await q(`update profiles set workspace_id=$2, account_type=$3, roles=$4, job_title=$5, department=$6 where id=$1`, [u.id, ws, type, roles, title, dept]);
    return u.id;
  }
  const A   = await person('boss@alpha.com', 'Boss Admin', W1, 'admin');
  const MG  = await person('mg@alpha.com',   'Mona Manager', W1, 'manager');
  const PM  = await person('pm@alpha.com',   'Pat PM',  W1, 'member', ['project_manager']);
  const PM2 = await person('pm2@alpha.com',  'Pia PM',  W1, 'member', ['project_manager']);
  const D1  = await person('d1@alpha.com',   'Dan Designer', W1, 'member', ['project_agent'], 'Designer', 'Creative');
  const D2  = await person('d2@alpha.com',   'Dina Designer', W1, 'member', ['project_agent'], 'designer', 'Creative');
  const D3  = await person('d3@alpha.com',   'Dev Designer', W1, 'member', ['project_agent'], 'Designer', 'Marketing');
  const DEV = await person('dev@alpha.com',  'Devon Dev', W1, 'member', ['project_agent'], 'Developer', 'Tech');
  const FIN = await person('fin@alpha.com',  'Fay Fin', W1, 'member', ['finance'], 'Designer', 'Creative');
  const BA  = await person('boss@beta.com',  'Beta Admin', W2, 'admin');
  const BPM = await person('bpm@beta.com',   'Bea PM', W2, 'member', ['project_manager']);

  console.log('Defaults');
  ok((await q(`select count(*)::int c from role_permissions where workspace_id=$1 and module='projects'`, [W1]))[0].c === 6, 'every role has a projects row');
  ok((await q(`select can_view, can_edit from role_permissions where workspace_id=$1 and module='projects' and role_key='project_manager'`, [W1]))[0].can_edit === true, 'Project Manager may edit projects by default');

  console.log('Creating a project');
  const [cl] = await as(A, () => q(`insert into clients(name) values ('Acme Shoes') returning id`));
  const [pr] = await as(A, () => q(`insert into projects(client_id, name, project_manager) values ($1, 'Acme Website', $2) returning id, workspace_id, status, created_by`, [cl.id, PM]));
  ok(pr.workspace_id === W1 && pr.status === 'planning' && pr.created_by === A, 'admin creates a project (workspace + creator set by the database)');
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title like 'Project assigned to you%'`, [PM]))[0].c === 1, 'the Project Manager is told');
  ok((await q(`select description from activity_logs where action='project_created'`))[0].description === 'Boss Admin created the project Acme Website for Acme Shoes', 'English activity line');
  await expectErr(() => as(A, () => q(`insert into projects(client_id, name, project_manager) values ($1, 'Bad', $2)`, [cl.id, D1])), 'only a Project Manager can run a project', /Project Manager role/);
  await expectErr(() => as(PM, () => q(`insert into projects(client_id, name) values ($1, 'Mine')`, [cl.id])), 'a Project Manager cannot create projects', /row-level/);
  await expectErr(() => as(BA, () => q(`insert into projects(client_id, name) values ($1, 'Cross')`, [cl.id])), 'cannot create a project on another workspace\'s client', /Client not found|row-level/);

  console.log('Who sees the project');
  await as(PM,  async () => ok((await q(`select id from projects`)).length === 1, 'its Project Manager sees it'));
  await as(PM2, async () => ok((await q(`select id from projects`)).length === 0, 'another Project Manager does not'));
  await as(D1,  async () => ok((await q(`select id from projects`)).length === 0, 'an agent not on the team does not'));
  await as(BA,  async () => ok((await q(`select id from projects`)).length === 0, 'another workspace\'s admin does not'));
  await as(PM, async () => ok((await q(`select id from clients`)).length === 1, 'the Project Manager sees the client through the project'));
  await as(PM2, async () => ok((await q(`select id from clients`)).length === 0, 'other Project Manager does not see the client'));

  console.log('Staffing request');
  await expectErr(() => as(PM2, () => q(`select staffing_request_create($1, '[{"designation":"Designer","qty":1}]')`, [pr.id])), 'only this project\'s Project Manager can ask', /Project not found|Only the Project Manager/);
  await expectErr(() => as(A, () => q(`select staffing_request_create($1, '[{"designation":"Designer","qty":1}]')`, [pr.id])), 'admin cannot send a request', /Only the Project Manager/);
  await expectErr(() => as(PM, () => q(`select staffing_request_create($1, '[]')`, [pr.id])), 'at least one requirement', /at least one/);
  await expectErr(() => as(PM, () => q(`select staffing_request_create($1, '[{"designation":"Designer","qty":0}]')`, [pr.id])), 'quantity 1 to 20', /Quantity/);
  await expectErr(() => as(PM, () => q(`select staffing_request_create($1, '[{"designation":"Designer","qty":1},{"designation":"designer","qty":2}]')`, [pr.id])), 'each designation once', /once/);
  const [{ id: rq }] = await as(PM, () => q(`select staffing_request_create($1, '[{"designation":"Designer","department":"Creative","qty":2},{"designation":"Developer","qty":1}]', 'Need them for launch') as id`, [pr.id]));
  ok((await q(`select count(*)::int c from staffing_request_items where request_id=$1`, [rq]))[0].c === 2, 'two requirement lines saved');
  ok((await q(`select count(*)::int c from staffing_requests where legacy_id is null and status='pending'`))[0].c === 1, 'request is pending');
  const sent = 'Pat PM sent a Designer, Developer request for Acme Website';
  ok((await q(`select count(*)::int c from activity_logs where description=$1`, [sent]))[0].c === 1, 'English line in the activity log');
  ok((await q(`select count(*)::int c from notifications where title=$1 and user_id in ($2,$3)`, [sent, A, MG]))[0].c === 2, 'admin and manager are asked to decide');
  await as(PM,  async () => ok((await q(`select id from staffing_requests`)).length === 1, 'PM sees own request'));
  await as(PM2, async () => ok((await q(`select id from staffing_requests`)).length === 0, 'other PM does not'));
  await as(D1,  async () => ok((await q(`select id from staffing_requests`)).length === 0, 'agents do not see requests'));

  console.log('Decisions');
  await expectErr(() => as(PM, () => q(`select staffing_request_decide($1, 'approve')`, [rq])), 'a Project Manager cannot decide', /Only the admin or a manager/);
  await expectErr(() => as(MG, () => q(`select staffing_request_decide($1, 'maybe')`, [rq])), 'unknown action refused', /Invalid action/);
  const r1 = await as(MG, () => q(`select staffing_request_decide($1, 'discuss', 'Can we do 1 designer?') as s`, [rq]));
  ok(r1[0].s === 'discussing', 'manager opens a discussion');
  ok((await q(`select body from request_comments where request_id=$1`, [rq]))[0].body === 'Can we do 1 designer?', 'discussion note saved as a comment');
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title='Mona Manager opened a discussion on your Designer, Developer request on Acme Website'`, [PM]))[0].c === 1, 'requester gets "your" sentence');
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title='Mona Manager opened a discussion on the Designer, Developer request on Acme Website'`, [A]))[0].c === 1, 'admin gets the neutral sentence');
  await expectErr(() => as(MG, () => q(`select staffing_request_decide($1, 'discuss')`, [rq])), 'cannot open the discussion twice', /Invalid action/);
  await as(PM, () => q(`select staffing_request_comment($1, 'Need both, launch is soon')`, [rq]));
  await expectErr(() => as(PM2, () => q(`select staffing_request_comment($1, 'hi')`, [rq])), 'a stranger cannot comment', /Request not found|Not allowed/);
  await expectErr(() => as(PM, () => q(`select staffing_request_comment($1, '   ')`, [rq])), 'empty comment refused', /Write a comment/);
  ok((await q(`select count(*)::int c from request_comments where request_id=$1`, [rq]))[0].c === 2, 'comments kept');
  const r2 = await as(A, () => q(`select staffing_request_decide($1, 'approve', 'Go ahead') as s`, [rq]));
  ok(r2[0].s === 'approved', 'admin approves after the discussion');
  await expectErr(() => as(A, () => q(`select staffing_request_decide($1, 'decline')`, [rq])), 'a closed request cannot move again', /already closed/);
  await expectErr(() => as(PM, () => q(`select staffing_request_comment($1, 'late')`, [rq])), 'no comments once closed', /already closed/);
  ok((await q(`select decided_by, decision_note from staffing_requests where id=$1`, [rq]))[0].decided_by === A, 'decision is recorded');
  // a manager who is also the requester cannot approve their own
  const rq2 = (await as(PM, () => q(`select staffing_request_create($1, '[{"designation":"QA","qty":1}]') as id`, [pr.id])))[0].id;
  const r3 = await as(MG, () => q(`select staffing_request_decide($1, 'decline', 'Not now') as s`, [rq2]));
  ok(r3[0].s === 'declined', 'a request can be declined');
  ok((await q(`select count(*)::int c from activity_logs where description='Mona Manager declined the QA request on Acme Website'`))[0].c === 1, 'decline line in the log');

  console.log('Filling slots');
  await expectErr(() => as(PM, () => q(`select project_member_add($1, $2)`, [pr.id, D1])), 'a Project Manager needs an approved slot', /Choose an approved slot/);
  const items = await q(`select id, designation from staffing_request_items where request_id=$1 order by id`, [rq]);
  const SD = items.find(i => i.designation === 'Designer').id, SV = items.find(i => i.designation === 'Developer').id;
  const cand = await as(PM, () => q(`select item_id, member_id from project_candidates($1)`, [pr.id]));
  ok(cand.some(c => c.member_id === D1 && c.item_id === SD) && cand.some(c => c.member_id === D2 && c.item_id === SD), 'candidates list the matching Designers');
  ok(!cand.some(c => c.member_id === D3) && !cand.some(c => c.member_id === FIN), 'wrong department / not a Project Agent is not offered');
  ok(cand.some(c => c.member_id === DEV && c.item_id === SV), 'the Developer fits the Developer slot');
  await expectErr(() => as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, D3, SD])), 'a Designer from another department does not match', /does not match/);
  await expectErr(() => as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, DEV, SD])), 'a Developer cannot take a Designer slot', /does not match/);
  await expectErr(() => as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, FIN, SD])), 'only Project Agents fill slots', /does not match/);
  await expectErr(() => as(PM2, () => q(`select project_member_add($1, $2, $3)`, [pr.id, D1, SD])), 'another Project Manager cannot add', /Project not found|Only the admin/);
  await as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, D1, SD]));
  await as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, D2, SD]));
  await expectErr(() => as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, D1, SD])), 'cannot add the same person twice', /already on this project|filled/);
  const D4 = await person('d4@alpha.com', 'Dora Designer', W1, 'member', ['project_agent'], 'Designer', 'Creative');
  await expectErr(() => as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, D4, SD])), 'a full slot refuses more', /filled/);
  const declinedItem = (await q(`select id from staffing_request_items where request_id=$1`, [rq2]))[0].id;
  const QA = await person('qa@alpha.com', 'Quinn QA', W1, 'member', ['project_agent'], 'QA', null);
  await expectErr(() => as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, QA, declinedItem])), 'a declined request gives no slots', /not approved/);
  ok((await q(`select count(*)::int c from activity_logs where description='Pat PM added Dan Designer to Acme Website'`))[0].c === 1, 'English "added" line');
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title='You were added to Acme Website'`, [D1]))[0].c === 1, 'the agent is told');
  await as(D1, async () => {
    ok((await q(`select id from projects`)).length === 1, 'the agent now sees the project');
    ok((await q(`select id from clients`)).length === 1, 'and its client (basic details)');
    ok((await q(`select id from staffing_requests`)).length === 0, 'but never the staffing requests');
  });
  await as(A, () => q(`select project_member_add($1, $2)`, [pr.id, FIN]));
  ok((await q(`select count(*)::int c from project_members where project_id=$1 and status='approved'`, [pr.id]))[0].c === 3, 'admin adds a person directly, no slot needed');
  await expectErr(() => as(A, () => q(`select project_member_add($1, $2, $3)`, [pr.id, BPM, SD])), 'cannot add a person of another workspace', /active team member/);

  console.log('Tasks');
  const [t1] = await as(PM, () => q(`insert into tasks(title, project_id, assigned_to) values ('Home page design', $1, $2) returning id, client_id, project_id, workspace_id`, [pr.id, D1]));
  ok(t1.client_id === cl.id && t1.project_id === pr.id && t1.workspace_id === W1, 'Project Manager creates a task; the client follows the project');
  await expectErr(() => as(PM, () => q(`insert into tasks(title, project_id, assigned_to) values ('Bad', $1, $2)`, [pr.id, DEV])), 'tasks go only to project members', /row-level/);
  await expectErr(() => as(PM2, () => q(`insert into tasks(title, project_id, assigned_to) values ('Bad', $1, $2)`, [pr.id, D1])), 'another PM cannot add tasks', /row-level|Project not found/);
  await as(PM, async () => ok((await q(`select id from tasks`)).length === 1, 'PM sees the project\'s tasks'));
  await as(PM2, async () => ok((await q(`select id from tasks`)).length === 0, 'other PM does not'));
  await as(D1, async () => {
    ok((await q(`select id from tasks`)).length === 1, 'assignee sees it');
    await q(`select task_set_status($1, 'in_review')`, [t1.id]);
  });
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title like 'Ready for review%'`, [PM]))[0].c === 1, 'the Project Manager is asked to review');
  await as(PM, () => q(`select task_review($1, true, 'Looks great')`, [t1.id]));
  ok((await q(`select status from tasks where id=$1`, [t1.id]))[0].status === 'completed', 'the Project Manager approves the task');
  await expectErr(() => as(PM2, () => q(`select task_review($1, true)`, [t1.id])), 'another PM cannot review', /not found|can review/);

  console.log('Requirements, files');
  const [rqm] = await as(PM, () => q(`insert into project_requirements(project_id, title) values ($1, 'Logo files') returning id, workspace_id`, [pr.id]));
  ok(rqm.workspace_id === W1, 'requirement saved in the workspace');
  await as(PM, () => q(`update project_requirements set is_done=true where id=$1`, [rqm.id]));
  ok((await q(`select done_by from project_requirements where id=$1`, [rqm.id]))[0].done_by === PM, 'done-by is recorded');
  await expectErr(() => as(D1, () => q(`insert into project_requirements(project_id, title) values ($1, 'x')`, [pr.id])), 'an agent cannot edit requirements', /row-level/);
  await as(D1, async () => ok((await q(`select id from project_requirements`)).length === 1, 'an agent can read them'));
  const [f] = await as(PM, () => q(`insert into client_files(client_id, project_id, kind, name, storage_path) values (null, $1, 'document', 'brief.pdf', $2) returning client_id, workspace_id`, [pr.id, `${W1}/${cl.id}/p${pr.id}/brief.pdf`]).catch(e => { throw e; }));
  ok(f.client_id === cl.id, 'a project file carries the project\'s client');
  ok((await q(`select can_storage_file($1, 'view') as v`, [`${W1}/${cl.id}/p${pr.id}/brief.pdf`]))[0].v === false, 'storage check is false outside a session');
  await as(D1, async () => {
    ok((await q(`select can_storage_file($1, 'view') as v`, [`${W1}/${cl.id}/p${pr.id}/brief.pdf`]))[0].v === true, 'a member can read a project file');
    ok((await q(`select can_storage_file($1, 'edit') as v`, [`${W1}/${cl.id}/p${pr.id}/x.pdf`]))[0].v === false, 'but not upload one');
    ok((await q(`select can_storage_file($1, 'view') as v`, [`${W2}/${cl.id}/p${pr.id}/brief.pdf`]))[0].v === false, 'and not through another workspace path');
  });
  await as(PM, async () => ok((await q(`select can_storage_file($1, 'edit') as v`, [`${W1}/${cl.id}/p${pr.id}/x.pdf`]))[0].v === true, 'the Project Manager can upload to the project'));

  console.log('Status, removal, the wall');
  await as(PM, () => q(`update projects set status='active', website_url='https://acme.test' where id=$1`, [pr.id]));
  ok((await q(`select count(*)::int c from notifications where user_id=$1 and title='Project active: Acme Website'`, [A]))[0].c === 1, 'managers hear when the PM moves the project');
  await expectErr(() => as(PM, () => q(`update projects set project_manager=$2 where id=$1`, [pr.id, PM2])), 'a PM cannot hand the project over', /Only the admin or a manager|row-level/);
  await as(A, () => q(`update projects set project_manager=$2 where id=$1`, [pr.id, PM2]));
  await as(PM, async () => ok((await q(`select id from projects`)).length === 0, 'the old PM loses it'));
  await as(A, () => q(`update projects set project_manager=$2 where id=$1`, [pr.id, PM]));
  const mem = (await q(`select id from project_members where member_id=$1 and status='approved'`, [D2]))[0].id;
  await expectErr(() => as(D1, () => q(`select project_member_remove($1)`, [mem])), 'an agent cannot remove people', /Only the admin/);
  await as(PM, () => q(`select project_member_remove($1)`, [mem]));
  ok((await q(`select status from project_members where id=$1`, [mem]))[0].status === 'removed', 'the Project Manager removes a person');
  await as(D2, async () => ok((await q(`select id from projects`)).length === 0, 'they lose the project'));
  await as(PM, () => q(`select project_member_add($1, $2, $3)`, [pr.id, D2, SD]));
  ok((await q(`select count(*)::int c from project_members where member_id=$1 and status='approved'`, [D2]))[0].c === 1, 'the freed slot can be filled again');
  await as(BA, async () => {
    ok((await q(`select id from projects`)).length === 0 && (await q(`select id from tasks`)).length === 0, 'the other workspace sees nothing');
    ok((await q(`select count(*)::int c from staffing_requests`))[0].c === 0, '… no requests');
  });
  await expectErr(() => as(BPM, () => q(`insert into tasks(title, project_id, assigned_to) values ('Sneaky', $1, $2)`, [pr.id, BPM])), 'cannot attach a task to another workspace\'s project', /row-level|Project not found/);
  await expectErr(() => as(BA, () => q(`select staffing_request_decide($1, 'approve')`, [rq])), 'cannot decide another workspace\'s request', /not found|already closed/);
  await as(A, () => q(`delete from projects where id=$1`, [pr.id]));
  ok((await q(`select count(*)::int c from project_members`))[0].c === 0 && (await q(`select count(*)::int c from staffing_request_items`))[0].c === 0, 'deleting a project removes its team and requests');
  ok((await q(`select project_id from tasks where id=$1`, [t1.id]))[0].project_id === null, 'tasks stay, unlinked');
}

// ───────────────────────────────────────── first-version data moves across
{
  const { q, ex } = mkdb();
  const cut = schema.indexOf('-- ============================================================================\n-- PART 15');
  await ex(PRE); await ex(schema.slice(0, cut));
  const W = (await q(`insert into workspaces(name,slug,short_code) values ('Old Co','old','OC') returning id`))[0].id;
  await ex(`insert into workspace_roles(workspace_id,role_key,can_edit) values ('${W}','project_manager',true),('${W}','project_agent',true)`);
  const mk = async (email, name, type, roles, title) => {
    const [u] = await q(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }]);
    await q(`update profiles set workspace_id=$2, account_type=$3, roles=$4, job_title=$5 where id=$1`, [u.id, W, type, roles, title]);
    return u.id;
  };
  const adm = await mk('a@old.com', 'Old Admin', 'admin', [], null);
  const pm = await mk('p@old.com', 'Old PM', 'member', ['project_manager'], null);
  const ag = await mk('g@old.com', 'Old Agent', 'member', ['project_agent'], 'Designer');
  const [p] = await q(`insert into projects(workspace_id,name,client,status,manager_id,created_by) values ($1,'Old Site','Old Client','active',$2,$3) returning id`, [W, pm, adm]);
  const [rq] = await q(`insert into staffing_requests(workspace_id,project_id,requested_by,status) values ($1,$2,$3,'approved') returning id`, [W, p.id, pm]);
  const [it] = await q(`insert into staffing_request_items(request_id,designation,qty) values ($1,'Designer',2) returning id`, [rq.id]);
  await q(`insert into request_comments(request_id,author_id,body) values ($1,$2,'old comment')`, [rq.id, adm]);
  await q(`insert into project_members(project_id,user_id,item_id,added_by) values ($1,$2,$3,$4)`, [p.id, ag, it.id, pm]);
  await q(`insert into notifications(workspace_id,user_id,text) values ($1,$2,'old note')`, [W, ag]);
  await ex(fs.readFileSync(path.join(here, '..', 'supabase', 'schema.sql'), 'utf8').slice(cut));
  console.log('Moving first-version projects');
  ok((await q(`select count(*)::int c from projects`))[0].c === 1, 'the old project is a project now');
  const np = (await q(`select p.*, c.name as client from projects p join clients c on c.id=p.client_id`))[0];
  ok(np.client === 'Old Client' && np.project_manager === pm && np.status === 'active', 'client created from the old client text, manager kept');
  ok((await q(`select count(*)::int c from staffing_requests where status='approved'`))[0].c === 1, 'the approved request came across');
  ok((await q(`select qty from staffing_request_items`))[0].qty === 2, '… with its slots');
  ok((await q(`select count(*)::int c from request_comments`))[0].c === 1, '… and its comments');
  const m = (await q(`select member_id, item_id, role_label from project_members`))[0];
  ok(m.member_id === ag && m.item_id !== null && m.role_label === 'Designer', 'the team member keeps their slot');
  ok((await q(`select count(*)::int c from notifications`))[0].c === 1, 'no new notifications were sent by the move');
  ok((await q(`select to_regclass('public.legacy_projects') as t`))[0].t === null, 'the old tables are gone');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
