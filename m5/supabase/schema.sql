-- ============================================================================
-- Webnox OS — schema.sql
-- ONE idempotent file. Paste the whole file into Supabase -> SQL Editor -> Run.
-- Safe to re-run. New features are appended as new numbered PARTS at the bottom.
--
--   PART 1  Tenancy core: enums, workspaces, workspace_roles, profiles,
--           helper functions, RLS, guards
--   PART 2  Master billing tables: subscriptions, subscription_payments,
--           master_access_log, billing_log (tables only; master_sweep comes later)
--   PART 3  Master accounts: promote_to_master() with a hard cap of 3
-- ============================================================================


-- ============================================================================
-- PART 1 — Tenancy core
-- ============================================================================

-- 1.1 Enums ------------------------------------------------------------------
do $$ begin create type public.workspace_type   as enum ('master_project','rented');                               exception when duplicate_object then null; end $$;
do $$ begin create type public.workspace_status as enum ('setup','trial','active','suspended','archived');         exception when duplicate_object then null; end $$;
do $$ begin create type public.billing_cycle    as enum ('trial_7','trial_14','monthly','quarterly','yearly');     exception when duplicate_object then null; end $$;
do $$ begin create type public.billing_status   as enum ('trial','active','due_soon','due_today','overdue','suspended','cancelled'); exception when duplicate_object then null; end $$;
do $$ begin create type public.payment_method   as enum ('bank_transfer','other');                                 exception when duplicate_object then null; end $$;

-- 1.2 workspaces -------------------------------------------------------------
-- type 'master_project' = "Personal (non-rented)", 'rented' = "On rent" in the UI.
create table if not exists public.workspaces (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  short_code       text not null unique check (short_code ~ '^[A-Z]{2,4}$'),
  type             public.workspace_type   not null default 'rented',
  status           public.workspace_status not null default 'setup',
  logo_url         text,
  country          text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  archived_at      timestamptz,
  full_access      boolean not null default false,
  full_access_at   timestamptz,
  public_form_token text unique default replace(gen_random_uuid()::text, '-', '')
);

-- 1.3 workspace_roles (admin and manager always exist, so they are not rows) --
create table if not exists public.workspace_roles (
  workspace_id uuid not null references public.workspaces(id),
  role_key     text not null check (role_key in ('sales_rep','lead_gen','cold_caller','finance','project_manager')),
  active       boolean not null default true,
  primary key (workspace_id, role_key)
);

-- 1.4 profiles ---------------------------------------------------------------
-- workspace_id is null only for a Master. At most 3 Masters (see guard below).
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  name         text,
  account_type text not null default 'member' check (account_type in ('admin','manager','member')),
  status       text not null default 'active' check (status in ('active','inactive')),
  workspace_id uuid references public.workspaces(id),
  is_master    boolean not null default false,
  job_title    text,
  department   text,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint master_has_no_workspace check (not is_master or workspace_id is null)
);
create index if not exists profiles_workspace_idx on public.profiles (workspace_id);
create unique index if not exists one_admin_per_workspace
  on public.profiles (workspace_id) where account_type = 'admin' and status = 'active';

-- 1.5 Helper functions (security definer, workspace-scoped) -------------------
create or replace function public.current_workspace() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_master() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_master and status = 'active' from public.profiles where id = auth.uid()), false)
$$;

-- admin OF THE CURRENT WORKSPACE
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select account_type = 'admin' and status = 'active' and workspace_id is not null
                   from public.profiles where id = auth.uid()), false)
$$;

-- admin or manager of the current workspace
create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select account_type in ('admin','manager') and status = 'active' and workspace_id is not null
                   from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.workspace_has_role(r text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_roles
                 where workspace_id = public.current_workspace() and role_key = r and active)
$$;

-- Master may read a workspace's business data only while full_access is on.
create or replace function public.master_can_read(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_master() and exists (select 1 from public.workspaces w where w.id = ws and w.full_access)
$$;

revoke all on function public.current_workspace(), public.is_master(), public.is_admin(),
                       public.is_manager(), public.workspace_has_role(text), public.master_can_read(uuid)
  from public, anon;
grant execute on function public.current_workspace(), public.is_master(), public.is_admin(),
                          public.is_manager(), public.workspace_has_role(text), public.master_can_read(uuid)
  to authenticated;

-- 1.6 Triggers and guards ----------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- Converts rent / money rows to the base currency (PKR): amount = original x fx_rate.
create or replace function public.money_before_write() returns trigger
language plpgsql as $$
begin
  new.amount := round(new.amount_original * new.fx_rate, 2);
  return new;
end $$;

-- slug: lowercase, hyphenated, only a-z 0-9 and "-"; short_code uppercased.
create or replace function public.slug_normalise() returns trigger
language plpgsql as $$
begin
  new.slug := regexp_replace(lower(btrim(new.slug)), '\s+', '-', 'g');
  new.slug := regexp_replace(new.slug, '[^a-z0-9-]', '', 'g');
  new.slug := btrim(regexp_replace(new.slug, '-{2,}', '-', 'g'), '-');
  if new.slug = '' then raise exception 'Workspace slug cannot be empty'; end if;
  new.short_code := upper(btrim(new.short_code));
  return new;
end $$;

drop trigger if exists workspaces_slug_normalise on public.workspaces;
create trigger workspaces_slug_normalise before insert or update of slug, short_code on public.workspaces
  for each row execute function public.slug_normalise();

-- A workspace can never lose its last active admin.
create or replace function public.one_admin_guard() returns trigger
language plpgsql as $$
begin
  if old.account_type = 'admin' and old.status = 'active' and old.workspace_id is not null
     and (tg_op = 'DELETE'
          or new.status <> 'active' or new.account_type <> 'admin'
          or new.workspace_id is distinct from old.workspace_id) then
    if not exists (select 1 from public.profiles p
                   where p.workspace_id = old.workspace_id and p.account_type = 'admin'
                     and p.status = 'active' and p.id <> old.id) then
      raise exception 'Cannot remove the last active admin of a workspace';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists profiles_one_admin_guard on public.profiles;
create trigger profiles_one_admin_guard before update or delete on public.profiles
  for each row execute function public.one_admin_guard();

-- At most 3 Masters, enforced for every write path (serialised with an advisory lock).
create or replace function public.master_limit_guard() returns trigger
language plpgsql as $$
begin
  if new.is_master then
    perform pg_advisory_xact_lock(7001);
    if (select count(*) from public.profiles where is_master and id <> new.id) >= 3 then
      raise exception 'Maximum 3 Master accounts';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_master_limit on public.profiles;
create trigger profiles_master_limit before insert or update of is_master on public.profiles
  for each row execute function public.master_limit_guard();

-- A bare profile for every new auth user. Workspace, role and Master flag are
-- never taken from user metadata; only a Master RPC / promote_to_master sets them.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, lower(new.email),
          coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 1.7 Row Level Security -----------------------------------------------------
alter table public.workspaces       enable row level security;
alter table public.workspace_roles  enable row level security;
alter table public.profiles         enable row level security;

-- profiles: you read yourself, and the people of your own workspace.
-- There is no insert/update/delete policy: changes go through RPCs only.
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles for select
  using ( id = auth.uid() );

drop policy if exists profiles_workspace_read on public.profiles;
create policy profiles_workspace_read on public.profiles for select
  using ( workspace_id is not null and workspace_id = public.current_workspace() );

-- workspaces: Master reads all; a member reads only their own.
drop policy if exists workspaces_master on public.workspaces;
create policy workspaces_master on public.workspaces for select
  using ( public.is_master() );

drop policy if exists workspaces_member_read on public.workspaces;
create policy workspaces_member_read on public.workspaces for select
  using ( id = public.current_workspace() );

drop policy if exists workspace_roles_master on public.workspace_roles;
create policy workspace_roles_master on public.workspace_roles for select
  using ( public.is_master() );

drop policy if exists workspace_roles_member_read on public.workspace_roles;
create policy workspace_roles_member_read on public.workspace_roles for select
  using ( workspace_id = public.current_workspace() );

-- Safe member list for the Master: no emails, no phones, never a Master row.
-- The is_master() test is inside the view because views run as their owner.
create or replace view public.master_member_list as
  select workspace_id, id, name, job_title, department, status, last_seen_at
  from public.profiles
  where is_master = false and public.is_master();
revoke all on public.master_member_list from public, anon;
grant select on public.master_member_list to authenticated;


-- ============================================================================
-- PART 2 — Master billing tables
-- ============================================================================

create table if not exists public.subscriptions (
  workspace_id    uuid primary key references public.workspaces(id),
  plan_name       text,
  cycle           public.billing_cycle not null,
  next_cycle      public.billing_cycle,
  amount_original numeric(14,2) not null check (amount_original >= 0),
  currency        text not null,
  fx_rate         numeric(14,6) not null check (fx_rate > 0),
  amount          numeric(14,2) not null,
  start_date      date not null,
  trial_ends_on   date,
  next_due        date,
  grace_days      int not null default 7 check (grace_days >= 0),
  member_limit    int,
  status          public.billing_status not null default 'active',
  suspended_at    timestamptz,
  cancelled_at    timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.subscription_payments (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id),
  amount_original numeric(14,2) not null check (amount_original > 0),
  currency        text not null,
  fx_rate         numeric(14,6) not null check (fx_rate > 0),
  amount          numeric(14,2) not null,
  paid_on         date not null,
  method          public.payment_method not null default 'bank_transfer',
  reference       text,
  period_from     date,
  period_to       date,
  invoice_number  text,
  attachments     jsonb not null default '[]'::jsonb,
  note            text,
  recorded_by     uuid not null,
  created_at      timestamptz not null default now()
);
create index if not exists subscription_payments_ws_idx on public.subscription_payments (workspace_id, paid_on desc);

-- Append-only: never updated, never deleted.
create table if not exists public.master_access_log (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  master_id    uuid,
  action       text not null check (action in ('opened','full_access_on','full_access_off','suspended',
                                               'resumed','archived','plan_changed','role_changed','payment_recorded')),
  detail       jsonb,
  at           timestamptz not null default now()
);
create index if not exists master_access_log_ws_idx on public.master_access_log (workspace_id, at desc);

-- Idempotency guard for billing reminders.
create table if not exists public.billing_log (
  workspace_id uuid not null references public.workspaces(id),
  kind         text not null check (kind in ('trial_countdown','due_soon','due_today','overdue','suspended','payment')),
  for_date     date not null,
  at           timestamptz not null default now(),
  primary key (workspace_id, kind, for_date)
);

create or replace function public.access_log_immutable() returns trigger
language plpgsql as $$ begin raise exception 'master_access_log is append-only'; end $$;

drop trigger if exists master_access_log_no_change on public.master_access_log;
create trigger master_access_log_no_change before update or delete on public.master_access_log
  for each row execute function public.access_log_immutable();

drop trigger if exists subscriptions_money on public.subscriptions;
create trigger subscriptions_money before insert or update on public.subscriptions
  for each row execute function public.money_before_write();

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.set_updated_at();

drop trigger if exists subscription_payments_money on public.subscription_payments;
create trigger subscription_payments_money before insert or update on public.subscription_payments
  for each row execute function public.money_before_write();

alter table public.subscriptions         enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.master_access_log     enable row level security;
alter table public.billing_log           enable row level security;

drop policy if exists subs_master on public.subscriptions;
create policy subs_master on public.subscriptions for all
  using ( public.is_master() ) with check ( public.is_master() );

-- A workspace Admin may see their own billing (the Billing page), never edit it.
drop policy if exists subs_admin_read on public.subscriptions;
create policy subs_admin_read on public.subscriptions for select
  using ( workspace_id = public.current_workspace() and public.is_admin() );

drop policy if exists payments_master on public.subscription_payments;
create policy payments_master on public.subscription_payments for all
  using ( public.is_master() ) with check ( public.is_master() );

drop policy if exists payments_admin_read on public.subscription_payments;
create policy payments_admin_read on public.subscription_payments for select
  using ( workspace_id = public.current_workspace() and public.is_admin() );

drop policy if exists access_log_master_read on public.master_access_log;
create policy access_log_master_read on public.master_access_log for select
  using ( public.is_master() );

drop policy if exists billing_log_master_read on public.billing_log;
create policy billing_log_master_read on public.billing_log for select
  using ( public.is_master() );


-- ============================================================================
-- PART 3 — Master accounts
-- ============================================================================

-- Run by hand in the SQL Editor, once per Master (maximum 3):
--   select public.promote_to_master('webnoxhub@gmail.com');
-- The user must already exist in Authentication -> Users.
create or replace function public.promote_to_master(p_email text) returns text
language plpgsql security definer set search_path = public, auth as $$
declare
  uid uuid;
  n   int;
begin
  select id into uid from auth.users where lower(email) = lower(btrim(p_email)) limit 1;
  if uid is null then
    raise exception 'No user with that email. Create it in Authentication -> Users first.';
  end if;

  insert into public.profiles (id, email, name)
  select u.id, lower(u.email), split_part(u.email, '@', 1) from auth.users u where u.id = uid
  on conflict (id) do nothing;

  if exists (select 1 from public.profiles where id = uid and is_master) then
    return 'Already a Master';
  end if;

  perform pg_advisory_xact_lock(7001);
  select count(*) into n from public.profiles where is_master;
  if n >= 3 then raise exception 'Maximum 3 Master accounts'; end if;

  update public.profiles
     set is_master = true, workspace_id = null, status = 'active'
   where id = uid;
  return 'Promoted. Masters now: ' || (n + 1) || ' of 3';
end $$;

-- Only the SQL Editor / service role may run it. No browser call can.
revoke all on function public.promote_to_master(text) from public, anon, authenticated;

-- Done. Next: create your Master user (Authentication -> Users -> Invite user),
-- then run:  select public.promote_to_master('webnoxhub@gmail.com');


-- ============================================================================
-- PART 4 — Workspace creation RPC
-- ============================================================================
-- Called from the server only (service-role key). The browser never calls
-- this directly; POST /api/master/workspaces calls it with the service key.

-- Roles carry two switches: active = "allow to use", can_edit = "allow to edit".
alter table public.workspace_roles add column if not exists can_edit boolean not null default false;

-- p_roles changed from text[] to jsonb ([{"role":"sales_rep","edit":true}, ...]),
-- so the old signature is dropped first. Safe to run more than once.
drop function if exists public.master_create_workspace(text,text,text,text,text,text,text,numeric,text,numeric,date,text[],uuid);

create or replace function public.master_create_workspace(
  p_name           text,
  p_slug           text,
  p_short_code     text,
  p_type           text    default 'rented',
  p_status         text    default 'setup',
  p_country        text    default null,
  p_plan_cycle     text    default null,
  p_plan_amount    numeric default null,
  p_plan_currency  text    default 'PKR',
  p_plan_fx        numeric default 1,
  p_plan_start     date    default current_date,
  p_roles          jsonb   default '[]'::jsonb,
  p_master_id      uuid    default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  ws_id uuid;
begin
  insert into public.workspaces (name, slug, short_code, type, status, country, created_by)
  values (
    btrim(p_name),
    p_slug,
    p_short_code,
    p_type::public.workspace_type,
    p_status::public.workspace_status,
    p_country,
    p_master_id
  )
  returning id into ws_id;

  -- Subscription row (only when plan provided)
  if p_plan_cycle is not null and p_plan_amount is not null then
    insert into public.subscriptions (
      workspace_id, cycle, amount_original, currency, fx_rate, amount,
      start_date, trial_ends_on, next_due, status
    ) values (
      ws_id,
      p_plan_cycle::public.billing_cycle,
      p_plan_amount,
      p_plan_currency,
      p_plan_fx,
      0,
      p_plan_start,
      case when p_plan_cycle in ('trial_7','trial_14')
           then p_plan_start + (case p_plan_cycle when 'trial_7' then 7 else 14 end)::int
           else null end,
      case when p_plan_cycle not in ('trial_7','trial_14')
           then p_plan_start + (case p_plan_cycle
                                  when 'monthly'   then 30
                                  when 'quarterly' then 90
                                  when 'yearly'    then 365 end)::int
           else null end,
      case when p_plan_cycle in ('trial_7','trial_14') then 'trial' else 'active' end::public.billing_status
    );
  end if;

  -- Role switches: each entry = allowed to use (row exists, active) + allowed to edit
  if jsonb_typeof(p_roles) = 'array' and jsonb_array_length(p_roles) > 0 then
    insert into public.workspace_roles (workspace_id, role_key, active, can_edit)
    select ws_id, r->>'role', true, coalesce((r->>'edit')::boolean, false)
    from jsonb_array_elements(p_roles) r
    on conflict (workspace_id, role_key)
      do update set active = true, can_edit = excluded.can_edit;
  end if;

  -- Audit log
  insert into public.master_access_log (workspace_id, master_id, action)
  values (ws_id, p_master_id, 'opened');

  return ws_id;
end $$;

revoke all on function public.master_create_workspace(text,text,text,text,text,text,text,numeric,text,numeric,date,jsonb,uuid)
  from public, anon, authenticated;


-- ============================================================================
-- PART 5 — Team inside a workspace
-- ============================================================================
-- Admin and Manager add and manage their own people through /api/team/*
-- (server, service key). The browser never writes to profiles.

alter table public.profiles add column if not exists phone        text;
alter table public.profiles add column if not exists joining_date date;
alter table public.profiles add column if not exists roles        text[] not null default '{}';

-- A person can only hold roles this workspace has switched on.
create or replace function public.profile_roles_guard() returns trigger
language plpgsql as $$
declare r text;
begin
  if new.roles is not null and array_length(new.roles, 1) > 0 then
    if new.workspace_id is null then raise exception 'Roles need a workspace'; end if;
    foreach r in array new.roles loop
      if not exists (select 1 from public.workspace_roles w
                     where w.workspace_id = new.workspace_id and w.role_key = r and w.active) then
        raise exception 'Role % is not activated in this workspace', r;
      end if;
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists profiles_roles_guard on public.profiles;
create trigger profiles_roles_guard before insert or update of roles, workspace_id on public.profiles
  for each row execute function public.profile_roles_guard();

-- Full profile rows (email, phone) are visible only to Admin and Manager of the same workspace.
-- Everyone else uses team_directory() below.
drop policy if exists profiles_workspace_read on public.profiles;
create policy profiles_workspace_read on public.profiles for select
  using ( workspace_id is not null and workspace_id = public.current_workspace() and public.is_manager() );

-- Safe directory for every member of a workspace: no email, no phone.
drop function if exists public.team_directory();
create or replace function public.team_directory()
returns table (id uuid, name text, job_title text, department text, account_type text,
               status text, roles text[], last_seen_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.job_title, p.department, p.account_type, p.status, p.roles, p.last_seen_at
  from public.profiles p
  where p.workspace_id is not null
    and p.workspace_id = public.current_workspace()
    and p.is_master = false
$$;
revoke all on function public.team_directory() from public, anon;
grant execute on function public.team_directory() to authenticated;


-- ============================================================================
-- PART 6 — Project Agent role, who a person reports to
-- ============================================================================
-- Run this whole part once in the Supabase SQL Editor.

alter table public.workspace_roles drop constraint if exists workspace_roles_role_key_check;
alter table public.workspace_roles add constraint workspace_roles_role_key_check
  check (role_key in ('sales_rep','lead_gen','cold_caller','finance','project_manager','project_agent'));

-- Existing workspaces get Project Agent switched on (the Master can still turn it off).
insert into public.workspace_roles (workspace_id, role_key, active, can_edit)
select id, 'project_agent', true, false from public.workspaces
on conflict (workspace_id, role_key) do nothing;

-- A person reports to one Manager (or the Admin) of the same workspace.
alter table public.profiles add column if not exists reports_to uuid references public.profiles(id) on delete set null;

create or replace function public.profile_reports_to_guard() returns trigger
language plpgsql as $$
begin
  if new.reports_to is not null then
    if new.reports_to = new.id then raise exception 'A person cannot report to himself'; end if;
    if not exists (select 1 from public.profiles m
                   where m.id = new.reports_to and m.workspace_id is not distinct from new.workspace_id
                     and m.account_type in ('admin','manager')) then
      raise exception 'Reports-to must be a Manager or Admin of the same workspace';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_reports_to_guard on public.profiles;
create trigger profiles_reports_to_guard before insert or update of reports_to, workspace_id on public.profiles
  for each row execute function public.profile_reports_to_guard();

-- Directory now also says who someone reports to.
drop function if exists public.team_directory();
create or replace function public.team_directory()
returns table (id uuid, name text, job_title text, department text, account_type text,
               status text, roles text[], last_seen_at timestamptz, reports_to uuid)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.job_title, p.department, p.account_type, p.status, p.roles, p.last_seen_at, p.reports_to
  from public.profiles p
  where p.workspace_id is not null
    and p.workspace_id = public.current_workspace()
    and p.is_master = false
$$;
revoke all on function public.team_directory() from public, anon;
grant execute on function public.team_directory() to authenticated;


-- ============================================================================
-- PART 7 — Projects, staffing requests, approvals, notifications, activity
-- ============================================================================
-- Run this whole part once in the Supabase SQL Editor.
-- All reads and writes go through /api/projects and /api/inbox (server, service key).
-- RLS is on with no browser policies, so the browser can never touch these tables directly.

create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name         text not null check (char_length(btrim(name)) between 1 and 120),
  client       text check (client is null or char_length(client) <= 120),
  description  text check (description is null or char_length(description) <= 2000),
  status       text not null default 'active' check (status in ('active','on_hold','completed')),
  manager_id   uuid references public.profiles(id) on delete set null,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists projects_ws_idx on public.projects (workspace_id, created_at desc);

create table if not exists public.staffing_requests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id),
  project_id    uuid not null references public.projects(id) on delete cascade,
  requested_by  uuid references public.profiles(id) on delete set null,
  status        text not null default 'pending' check (status in ('pending','discussing','approved','declined')),
  note          text check (note is null or char_length(note) <= 500),
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  created_at    timestamptz not null default now()
);
create index if not exists staffing_requests_project_idx on public.staffing_requests (project_id, created_at desc);

create table if not exists public.staffing_request_items (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.staffing_requests(id) on delete cascade,
  designation text not null check (char_length(btrim(designation)) between 1 and 60),
  department  text check (department is null or char_length(department) <= 60),
  qty         int  not null check (qty between 1 and 20)
);
create index if not exists staffing_items_request_idx on public.staffing_request_items (request_id);

create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  item_id    uuid references public.staffing_request_items(id) on delete set null,
  added_by   uuid references public.profiles(id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table if not exists public.request_comments (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.staffing_requests(id) on delete cascade,
  author_id  uuid references public.profiles(id) on delete set null,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists request_comments_idx on public.request_comments (request_id, created_at);

create table if not exists public.activity_log (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  actor_id     uuid references public.profiles(id) on delete set null,
  text         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists activity_ws_idx on public.activity_log (workspace_id, created_at desc);

create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  text         text not null,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);

-- Integrity guards (the API checks the same things; these make a bug impossible to exploit).
create or replace function public.project_manager_guard() returns trigger
language plpgsql as $$
begin
  if new.manager_id is not null then
    if not exists (select 1 from public.profiles p
                   where p.id = new.manager_id and p.workspace_id = new.workspace_id
                     and p.status = 'active' and 'project_manager' = any(p.roles)) then
      raise exception 'Project manager must be an active Project Manager of this workspace';
    end if;
  end if;
  return new;
end $$;
-- (only on the first-version tables; PART 15 replaces them with workspace-scoped ones)
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'manager_id') then
    drop trigger if exists projects_manager_guard on public.projects;
    create trigger projects_manager_guard before insert or update of manager_id on public.projects
      for each row execute function public.project_manager_guard();
  end if;
end $$;

create or replace function public.project_member_guard() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.projects j join public.profiles p on p.workspace_id = j.workspace_id
                 where j.id = new.project_id and p.id = new.user_id) then
    raise exception 'Member must belong to the same workspace as the project';
  end if;
  return new;
end $$;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_members' and column_name = 'user_id') then
    drop trigger if exists project_members_guard on public.project_members;
    create trigger project_members_guard before insert on public.project_members
      for each row execute function public.project_member_guard();
  end if;
end $$;

alter table public.projects               enable row level security;
alter table public.staffing_requests      enable row level security;
alter table public.staffing_request_items enable row level security;
alter table public.project_members        enable row level security;
alter table public.request_comments       enable row level security;
alter table public.activity_log           enable row level security;
alter table public.notifications          enable row level security;


-- ============================================================================
-- PART 8 — Delete a person / a workspace completely
-- ============================================================================
-- Run this whole part once in the Supabase SQL Editor.
-- Used only by the server (service key). The browser can never call these functions.

-- Every activity line remembers who it is about, so a deleted person leaves no trace in the log.
alter table public.activity_log add column if not exists involved uuid[] not null default '{}';

-- A deleted person takes their comments and their requests with them.
alter table public.request_comments drop constraint if exists request_comments_author_id_fkey;
alter table public.request_comments add constraint request_comments_author_id_fkey
  foreign key (author_id) references public.profiles(id) on delete cascade;
alter table public.staffing_requests drop constraint if exists staffing_requests_requested_by_fkey;
alter table public.staffing_requests add constraint staffing_requests_requested_by_fkey
  foreign key (requested_by) references public.profiles(id) on delete cascade;

-- The Master audit log stays append-only, except while a workspace is being deleted completely.
create or replace function public.access_log_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('webnox.purge', true), '') = 'on' then return old; end if;
  raise exception 'master_access_log is append-only';
end $$;

create or replace function public.one_admin_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('webnox.purge', true), '') = 'on' then return old; end if;
  if old.account_type = 'admin' and old.status = 'active' and old.workspace_id is not null
     and (tg_op = 'DELETE'
          or new.status <> 'active' or new.account_type <> 'admin'
          or new.workspace_id is distinct from old.workspace_id) then
    if not exists (select 1 from public.profiles p
                   where p.workspace_id = old.workspace_id and p.account_type = 'admin'
                     and p.status = 'active' and p.id <> old.id) then
      raise exception 'Cannot remove the last active admin of a workspace';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Removes every activity line that was done by, or is about, one person.
create or replace function public.purge_person_activity(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.activity_log where actor_id = p_id or p_id = any(involved);
$$;
revoke all on function public.purge_person_activity(uuid) from public, anon, authenticated;

-- Deletes a workspace and everything inside it. Returns the ids of the people removed,
-- so the server can delete their sign-in accounts too.
create or replace function public.purge_workspace(p_id uuid) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  perform set_config('webnox.purge', 'on', true);
  select coalesce(array_agg(id), '{}') into ids from public.profiles where workspace_id = p_id and is_master = false;
  delete from public.notifications        where workspace_id = p_id;
  delete from public.activity_log         where workspace_id = p_id;
  delete from public.staffing_requests    where workspace_id = p_id;
  delete from public.projects             where workspace_id = p_id;
  delete from public.workspace_roles      where workspace_id = p_id;
  delete from public.subscription_payments where workspace_id = p_id;
  delete from public.subscriptions        where workspace_id = p_id;
  delete from public.billing_log          where workspace_id = p_id;
  delete from public.master_access_log    where workspace_id = p_id;
  delete from public.profiles             where workspace_id = p_id and is_master = false;
  delete from public.workspaces           where id = p_id;
  return ids;
end $$;
revoke all on function public.purge_workspace(uuid) from public, anon, authenticated;

-- ============================================================================
-- PART 9 — EcomHub core inside every workspace
-- ============================================================================
-- Tasks, task comments, the task timer, login sessions, active/idle tracking,
-- daily reports and the audit trail — one private copy per workspace.
-- Run this whole part once in the Supabase SQL Editor (after PARTs 1-8).
-- Safe to run again.
--
-- How a workspace stays private:
--   * every row carries workspace_id (filled by a trigger, never trusted from the browser)
--   * one RESTRICTIVE policy per table:  workspace_id = my workspace
--   * every function below filters by the caller's workspace as well

-- 9.1 People: the columns the EcomHub screens expect, derived from Webnox profiles --
alter table public.profiles add column if not exists avatar_url    text;
alter table public.profiles add column if not exists employee_code text;
alter table public.profiles add column if not exists updated_at    timestamptz not null default now();
alter table public.profiles add column if not exists first_name text
  generated always as (split_part(btrim(coalesce(name, '')), ' ', 1)) stored;
alter table public.profiles add column if not exists last_name text
  generated always as (btrim(substr(btrim(coalesce(name, '')), length(split_part(btrim(coalesce(name, '')), ' ', 1)) + 1))) stored;
alter table public.profiles add column if not exists role text
  generated always as (case when account_type = 'admin' then 'admin' else 'member' end) stored;
alter table public.profiles add column if not exists joined_on date
  generated always as (joining_date) stored;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.set_updated_at();

-- EMP-0001, EMP-0002 ... counted inside each workspace.
create or replace function public.profiles_employee_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.employee_code is null and new.workspace_id is not null and not new.is_master then
    perform pg_advisory_xact_lock(hashtext(new.workspace_id::text));
    select 'EMP-' || lpad((coalesce(max(substr(p.employee_code, 5)::int), 0) + 1)::text, 4, '0')
      into new.employee_code
      from public.profiles p
     where p.workspace_id = new.workspace_id and p.employee_code ~ '^EMP-[0-9]+$';
  end if;
  return new;
end $$;
drop trigger if exists profiles_employee_code on public.profiles;
create trigger profiles_employee_code before insert or update of workspace_id on public.profiles
  for each row execute function public.profiles_employee_code();

update public.profiles p set employee_code = 'EMP-' || lpad(x.n::text, 4, '0')
  from (select id, row_number() over (partition by workspace_id order by created_at, id) as n
          from public.profiles
         where workspace_id is not null and not is_master and employee_code is null) x
 where p.id = x.id;
create unique index if not exists profiles_employee_code_uq
  on public.profiles (workspace_id, employee_code) where employee_code is not null;

-- 9.2 Team roles (the catalogue) and who holds which ---------------------------
create table if not exists public.team_roles (
  key         text primary key,
  name        text not null,
  description text not null default '',
  sort        int  not null default 0
);
insert into public.team_roles (key, name, description, sort) values
  ('sales_rep',       'Sales Representative', 'Client conversations, proposals and closing deals', 1),
  ('lead_gen',        'Lead Generation',      'Finding and qualifying new prospects',              2),
  ('cold_caller',     'Cold Caller',          'Calling prospects and booking meetings',            3),
  ('finance',         'Finance',              'Invoices, payments and financial records',          4),
  ('manager',         'Manager',              'Coordinating the team and keeping work on track',   5),
  ('project_manager', 'Project Manager',      'Running delivery for the clients assigned to them', 6),
  ('project_agent',   'Project Agent',        'Delivering project work as part of a project team', 7)
on conflict (key) do update set name = excluded.name, description = excluded.description, sort = excluded.sort;

-- A person's roles: the roles they hold, plus "manager" for a Manager account.
create or replace view public.member_roles with (security_invoker = true) as
select p.id as member_id, r.role_key, p.workspace_id
  from public.profiles p, lateral unnest(p.roles) as r(role_key)
 where p.workspace_id is not null
union all
select p.id, 'manager', p.workspace_id
  from public.profiles p
 where p.workspace_id is not null and p.account_type = 'manager';

-- 9.3 Settings: one row per workspace ----------------------------------------
create table if not exists public.app_settings (
  workspace_id uuid primary key references public.workspaces(id),
  company_name text not null default '',
  timezone     text not null default 'Asia/Karachi',
  idle_minutes int  not null default 5 check (idle_minutes between 1 and 60),
  currency     text not null default 'USD',
  updated_at   timestamptz not null default now()
);

create or replace function public.workspace_default_settings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_settings (workspace_id, company_name) values (new.id, new.name)
  on conflict (workspace_id) do nothing;
  return new;
end $$;
drop trigger if exists workspaces_settings on public.workspaces;
create trigger workspaces_settings after insert on public.workspaces
  for each row execute function public.workspace_default_settings();
insert into public.app_settings (workspace_id, company_name)
  select id, name from public.workspaces on conflict (workspace_id) do nothing;

-- 9.4 Tables -------------------------------------------------------------------
create table if not exists public.tasks (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  title         text not null check (char_length(title) between 1 and 200),
  description   text not null default '',
  assigned_to   uuid references public.profiles(id) on delete set null,
  team_role     text references public.team_roles(key) on update cascade,
  created_by    uuid references public.profiles(id) on delete set null,
  priority      text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  status        text not null default 'todo' check (status in ('todo', 'in_progress', 'in_review', 'completed')),
  start_date    date,
  due_date      date,
  review_note   text,
  submitted_at  timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists tasks_ws_idx       on public.tasks (workspace_id, status);
create index if not exists tasks_assignee_idx on public.tasks (assigned_to, status);
create index if not exists tasks_due_idx      on public.tasks (due_date);

create table if not exists public.task_comments (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  task_id       bigint not null references public.tasks(id) on delete cascade,
  author_id     uuid not null references public.profiles(id) on delete cascade,
  author_name   text not null default '',
  body          text not null check (char_length(body) between 1 and 4000),
  created_at    timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments (task_id, created_at);

-- Task timer: one row per start→pause/stop interval. Server timestamps only.
create table if not exists public.task_time_entries (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  task_id       bigint not null references public.tasks(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  end_reason    text check (end_reason in ('pause', 'stop', 'switch', 'logout', 'auto')),
  check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists task_time_one_running on public.task_time_entries (user_id) where ended_at is null;
create index if not exists task_time_user_idx on public.task_time_entries (user_id, started_at);
create index if not exists task_time_task_idx on public.task_time_entries (task_id);
create index if not exists task_time_ws_idx   on public.task_time_entries (workspace_id, started_at);

create table if not exists public.user_sessions (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  started_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  ended_at       timestamptz,
  end_reason     text check (end_reason in ('logout', 'expired', 'inactive', 'disconnected', 'unknown')),
  end_estimated  boolean not null default false,
  state          text not null default 'active' check (state in ('active', 'idle')),
  started_via    text not null default 'login' check (started_via in ('login', 'resume')),
  user_agent     text,
  device         text
);
create index if not exists user_sessions_user_idx on public.user_sessions (user_id, started_at desc);
create index if not exists user_sessions_open_idx on public.user_sessions (last_seen_at) where ended_at is null;
create index if not exists user_sessions_ws_idx   on public.user_sessions (workspace_id, started_at desc);

create table if not exists public.activity_intervals (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  session_id    uuid not null references public.user_sessions(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  state         text not null check (state in ('active', 'idle')),
  started_at    timestamptz not null,
  ended_at      timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists activity_one_open on public.activity_intervals (session_id) where ended_at is null;
create index if not exists activity_user_idx on public.activity_intervals (user_id, started_at);

-- Append-only audit trail (plural: the older activity_log is the staffing-request feed)
create table if not exists public.activity_logs (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  actor_id      uuid references public.profiles(id) on delete set null,
  actor_name    text not null default '',
  subject_id    uuid references public.profiles(id) on delete set null,
  action        text not null,
  entity_type   text,
  entity_id     text,
  description   text not null default '',
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists activity_logs_time_idx    on public.activity_logs (workspace_id, created_at desc);
create index if not exists activity_logs_actor_idx   on public.activity_logs (actor_id, created_at desc);
create index if not exists activity_logs_subject_idx on public.activity_logs (subject_id, created_at desc);
create index if not exists activity_logs_entity_idx  on public.activity_logs (entity_type, entity_id);

-- 9.5 workspace_id is filled by the database ----------------------------------
-- From the row's own parent (person / task / session) when it has one, else from the caller.
create or replace function public.eco_fill_workspace() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_key text;
begin
  if new.workspace_id is not null then return new; end if;
  v_key := to_jsonb(new) ->> tg_argv[0];
  if v_key is not null then
    v_ws := case tg_argv[1]
      when 'profile' then (select workspace_id from public.profiles      where id = v_key::uuid)
      when 'task'    then (select workspace_id from public.tasks         where id = v_key::bigint)
      when 'session' then (select workspace_id from public.user_sessions where id = v_key::uuid)
    end;
  end if;
  new.workspace_id := coalesce(v_ws, public.current_workspace());
  return new;
end $$;

drop trigger if exists aa_ws_fill on public.tasks;
create trigger aa_ws_fill before insert on public.tasks
  for each row execute function public.eco_fill_workspace('assigned_to', 'profile');
drop trigger if exists aa_ws_fill on public.task_comments;
create trigger aa_ws_fill before insert on public.task_comments
  for each row execute function public.eco_fill_workspace('task_id', 'task');
drop trigger if exists aa_ws_fill on public.task_time_entries;
create trigger aa_ws_fill before insert on public.task_time_entries
  for each row execute function public.eco_fill_workspace('user_id', 'profile');
drop trigger if exists aa_ws_fill on public.user_sessions;
create trigger aa_ws_fill before insert on public.user_sessions
  for each row execute function public.eco_fill_workspace('user_id', 'profile');
drop trigger if exists aa_ws_fill on public.activity_intervals;
create trigger aa_ws_fill before insert on public.activity_intervals
  for each row execute function public.eco_fill_workspace('session_id', 'session');
drop trigger if exists aa_ws_fill on public.activity_logs;
create trigger aa_ws_fill before insert on public.activity_logs
  for each row execute function public.eco_fill_workspace('actor_id', 'profile');

-- 9.6 Helpers -------------------------------------------------------------------
create or replace function public.is_manager_id(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p
                  where p.id = p_id and p.status = 'active' and p.workspace_id is not null
                    and p.account_type in ('admin', 'manager'));
$$;

-- Is this person in my workspace?
create or replace function public.same_workspace(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p
                  where p.id = p_user and p.workspace_id is not null and p.workspace_id = current_workspace());
$$;

create or replace function public.app_tz() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select timezone from app_settings where workspace_id = current_workspace()), 'Asia/Karachi');
$$;

create or replace function public.member_name(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(name), ''), email) from profiles where id = p_id;
$$;

-- Raises unless the caller is an active member of a workspace. Returns the caller id.
create or replace function public.assert_active() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_status text; v_ws uuid;
begin
  if v_uid is null then raise exception 'You are not signed in'; end if;
  select status, workspace_id into v_status, v_ws from profiles where id = v_uid;
  if v_status is distinct from 'active' or v_ws is null then raise exception 'Your account is not active'; end if;
  return v_uid;
end $$;

-- Admin and Manager can view anyone in their workspace; everyone else only themselves.
create or replace function public.assert_can_view(p_user uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'You are not signed in'; end if;
  if p_user is not null and not same_workspace(p_user) and p_user is distinct from auth.uid() then
    raise exception 'You can only view your own records';
  end if;
  if not is_manager() and p_user is distinct from auth.uid() then
    raise exception 'You can only view your own records';
  end if;
end $$;

create or replace function public.log_event(
  p_action text, p_entity_type text, p_entity_id text, p_description text,
  p_meta jsonb default '{}'::jsonb, p_subject uuid default null, p_actor uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := coalesce(p_actor, auth.uid()); v_ws uuid;
begin
  select workspace_id into v_ws from profiles where id = v_actor;
  if v_ws is null and p_subject is not null then
    select workspace_id into v_ws from profiles where id = p_subject;
  end if;
  if v_ws is null then return; end if;   -- no workspace (e.g. a Master): nothing to record
  insert into activity_logs (workspace_id, actor_id, actor_name, subject_id, action, entity_type, entity_id, description, meta)
  values (v_ws, v_actor, coalesce(member_name(v_actor), 'System'), p_subject, p_action, p_entity_type, p_entity_id,
          coalesce(p_description, ''), coalesce(p_meta, '{}'::jsonb));
end $$;

-- 9.7 Settings: validate + log ----------------------------------------------------
create or replace function public.settings_before_update() returns trigger
language plpgsql as $$
begin
  perform now() at time zone new.timezone;  -- raises on an unknown timezone
  new.updated_at := now();
  return new;
end $$;

create or replace function public.settings_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    perform log_event('settings_changed', 'settings', new.workspace_id::text, 'Updated app settings',
      jsonb_build_object('from', to_jsonb(old) - 'updated_at' - 'workspace_id', 'to', to_jsonb(new) - 'updated_at' - 'workspace_id'));
  end if;
  return new;
end $$;

drop trigger if exists settings_validate on public.app_settings;
create trigger settings_validate before update on public.app_settings
  for each row execute function public.settings_before_update();
drop trigger if exists settings_log on public.app_settings;
create trigger settings_log after update on public.app_settings
  for each row execute function public.settings_after_update();

-- 9.8 Tasks: validation + automatic audit log ------------------------------------
create or replace function public.tasks_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.workspace_id := old.workspace_id;
  end if;
  new.updated_at := now();

  if new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then new.completed_at := now(); end if;
  if new.status <> 'completed' then new.completed_at := null; end if;
  if new.status = 'in_review' and (tg_op = 'INSERT' or old.status <> 'in_review') then new.submitted_at := now(); end if;

  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    if not exists (select 1 from profiles where id = new.assigned_to and status = 'active'
                      and workspace_id = new.workspace_id) then
      raise exception 'Tasks can only be assigned to active members of this workspace';
    end if;
  end if;

  if new.assigned_to is not null and new.team_role is not null
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to or new.team_role is distinct from old.team_role)
     and not exists (select 1 from member_roles where member_id = new.assigned_to and role_key = new.team_role) then
    raise exception 'This member does not have the % role', (select name from team_roles where key = new.team_role);
  end if;
  return new;
end $$;

create or replace function public.stop_task_timers(p_task_id bigint, p_why text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in update task_time_entries set ended_at = greatest(started_at, now()), end_reason = 'stop'
           where task_id = p_task_id and ended_at is null returning user_id loop
    perform log_event('timer_stopped', 'task', p_task_id::text, 'Timer stopped (' || p_why || ')', '{}'::jsonb, r.user_id);
  end loop;
end $$;

create or replace function public.tasks_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform log_event('task_created', 'task', new.id::text, 'Created task "' || new.title || '"',
      jsonb_build_object('priority', new.priority, 'due_date', new.due_date, 'team_role', new.team_role), new.assigned_to);
    if new.assigned_to is not null then
      perform log_event('task_assigned', 'task', new.id::text,
        'Assigned "' || new.title || '" to ' || member_name(new.assigned_to), '{}'::jsonb, new.assigned_to);
    end if;
    return new;
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    perform stop_task_timers(new.id, 'task reassigned');
    perform log_event('task_reassigned', 'task', new.id::text,
      'Reassigned "' || new.title || '" to ' || coalesce(member_name(new.assigned_to), 'nobody'),
      jsonb_build_object('from', member_name(old.assigned_to), 'to', member_name(new.assigned_to)), new.assigned_to);
  end if;

  if new.status is distinct from old.status then
    if new.status in ('in_review', 'completed') then
      perform stop_task_timers(new.id, case when new.status = 'in_review' then 'submitted for review' else 'task completed' end);
    end if;
    perform log_event(
      case when new.status = 'in_review' then 'task_submitted'
           when old.status = 'in_review' and new.status = 'completed' then 'task_approved'
           when old.status = 'in_review' then 'revision_requested'
           else 'task_status_changed' end,
      'task', new.id::text,
      case when new.status = 'in_review' then 'Submitted "' || new.title || '" for review'
           when old.status = 'in_review' and new.status = 'completed' then 'Approved "' || new.title || '"'
           when old.status = 'in_review' then 'Requested changes on "' || new.title || '"'
           else 'Moved "' || new.title || '" to ' || replace(new.status, '_', ' ') end,
      jsonb_build_object('from', old.status, 'to', new.status), new.assigned_to);
  end if;

  if new.title is distinct from old.title then v_changes := v_changes || jsonb_build_object('title', jsonb_build_array(old.title, new.title)); end if;
  if new.description is distinct from old.description then v_changes := v_changes || jsonb_build_object('description', 'edited'); end if;
  if new.priority is distinct from old.priority then v_changes := v_changes || jsonb_build_object('priority', jsonb_build_array(old.priority, new.priority)); end if;
  if new.due_date is distinct from old.due_date then v_changes := v_changes || jsonb_build_object('due_date', jsonb_build_array(old.due_date, new.due_date)); end if;
  if new.start_date is distinct from old.start_date then v_changes := v_changes || jsonb_build_object('start_date', jsonb_build_array(old.start_date, new.start_date)); end if;
  if new.team_role is distinct from old.team_role then v_changes := v_changes || jsonb_build_object('team_role', jsonb_build_array(old.team_role, new.team_role)); end if;
  if v_changes <> '{}'::jsonb then
    perform log_event('task_updated', 'task', new.id::text, 'Updated "' || new.title || '"', v_changes, new.assigned_to);
  end if;
  return new;
end $$;

drop trigger if exists tasks_before on public.tasks;
create trigger tasks_before before insert or update on public.tasks
  for each row execute function public.tasks_before_write();
drop trigger if exists tasks_after on public.tasks;
create trigger tasks_after after insert or update on public.tasks
  for each row execute function public.tasks_after_write();

create or replace function public.comments_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.author_id := coalesce(auth.uid(), new.author_id);
  new.author_name := coalesce(member_name(new.author_id), '');
  new.created_at := now();
  new.body := trim(new.body);
  return new;
end $$;

drop trigger if exists comments_before on public.task_comments;
create trigger comments_before before insert on public.task_comments
  for each row execute function public.comments_before_insert();

create or replace function public.task_set_status(p_task_id bigint, p_status text, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found or t.assigned_to is distinct from v_uid then raise exception 'Task not found or not assigned to you'; end if;
  if not ((t.status = 'todo' and p_status in ('in_progress', 'in_review'))
       or (t.status = 'in_progress' and p_status in ('todo', 'in_review'))) then
    raise exception 'This task can''t move from % to %', replace(t.status, '_', ' '), replace(p_status, '_', ' ');
  end if;
  update tasks set status = p_status where id = p_task_id;
  if nullif(trim(coalesce(p_note, '')), '') is not null then
    insert into task_comments (task_id, author_id, body) values (p_task_id, v_uid, trim(p_note));
  end if;
end $$;

create or replace function public.task_review(p_task_id bigint, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not is_manager() then raise exception 'Only the admin or a manager can review tasks'; end if;
  select * into t from tasks where id = p_task_id for update;
  if not found or t.workspace_id is distinct from current_workspace() then raise exception 'Task not found'; end if;
  if t.status <> 'in_review' then raise exception 'This task is not waiting for review'; end if;
  if not p_approve and v_note is null then raise exception 'Add a note so the member knows what to change'; end if;
  update tasks set status = case when p_approve then 'completed' else 'in_progress' end, review_note = v_note
   where id = p_task_id;
  if v_note is not null then
    insert into task_comments (task_id, author_id, body)
    values (p_task_id, v_uid, case when p_approve then 'Approved: ' else 'Changes requested: ' end || v_note);
  end if;
end $$;

-- 9.9 Sessions, heartbeats, active / idle ------------------------------------------
create or replace function public.close_session(p_session_id uuid, p_reason text, p_at timestamptz, p_estimated boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare s user_sessions%rowtype; r record;
begin
  select * into s from user_sessions where id = p_session_id for update;
  if not found or s.ended_at is not null then return; end if;
  p_at := greatest(s.started_at, least(p_at, now()));
  update activity_intervals set ended_at = greatest(started_at, p_at) where session_id = s.id and ended_at is null;
  update user_sessions
     set ended_at = p_at, end_reason = p_reason, end_estimated = p_estimated, last_seen_at = greatest(last_seen_at, p_at)
   where id = s.id;
  -- an explicit logout / deactivation pauses the running task timer
  if p_reason in ('logout', 'inactive')
     and not exists (select 1 from user_sessions where user_id = s.user_id and ended_at is null) then
    for r in update task_time_entries t set ended_at = greatest(t.started_at, p_at), end_reason = 'logout'
             where t.user_id = s.user_id and t.ended_at is null returning t.task_id loop
      perform log_event('timer_paused', 'task', r.task_id::text, 'Timer paused (signed out)', '{}'::jsonb, s.user_id, s.user_id);
    end loop;
  end if;
end $$;

-- Ends sessions that stopped sending heartbeats (browser closed, offline, laptop asleep)
-- and pauses timers left running with nobody in the app for 20+ minutes.
-- Called by a signed-in person, it only touches that person's workspace.
create or replace function public.sweep_stale_sessions() returns void
language plpgsql security definer set search_path = public as $$
declare s record; t record; v_ws uuid := case when auth.uid() is null then null else current_workspace() end;
begin
  for s in select id, last_seen_at from user_sessions
            where ended_at is null and last_seen_at < now() - interval '3 minutes'
              and (v_ws is null or workspace_id = v_ws)
            for update skip locked loop
    perform close_session(s.id, 'disconnected', s.last_seen_at, true);
  end loop;

  for t in
    select te.id, te.user_id, te.task_id, te.started_at, ls.last_end
      from task_time_entries te
      join lateral (
        select max(coalesce(us.ended_at, us.last_seen_at)) as last_end, bool_or(us.ended_at is null) as has_open
          from user_sessions us where us.user_id = te.user_id
      ) ls on true
     where te.ended_at is null
       and (v_ws is null or te.workspace_id = v_ws)
       and not coalesce(ls.has_open, false)
       and coalesce(ls.last_end, te.started_at) < now() - interval '20 minutes'
  loop
    update task_time_entries
       set ended_at = greatest(t.started_at, coalesce(t.last_end, t.started_at)), end_reason = 'auto'
     where id = t.id and ended_at is null;
    perform log_event('timer_paused', 'task', t.task_id::text,
      'Timer paused automatically (the app was closed)', '{}'::jsonb, t.user_id, t.user_id);
  end loop;
end $$;

create or replace function public.session_start(p_user_agent text default null, p_device text default null, p_via text default 'login')
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_status text; v_ws uuid; v_id uuid; v_first boolean;
begin
  if v_uid is null then raise exception 'You are not signed in'; end if;
  select status, workspace_id into v_status, v_ws from profiles where id = v_uid for update;
  if v_status is null then raise exception 'No profile found for this account'; end if;
  if v_ws is null then raise exception 'This account does not belong to a workspace'; end if;
  if v_status <> 'active' then raise exception 'Your account is %. Contact the admin.', v_status; end if;

  perform sweep_stale_sessions();
  v_first := not exists (select 1 from user_sessions where user_id = v_uid);

  insert into user_sessions (user_id, user_agent, device, started_via)
  values (v_uid, left(p_user_agent, 300), left(p_device, 80), case when p_via = 'login' then 'login' else 'resume' end)
  returning id into v_id;
  insert into activity_intervals (session_id, user_id, state, started_at) values (v_id, v_uid, 'active', now());

  if v_first then
    perform log_event('invite_accepted', 'member', v_uid::text, member_name(v_uid) || ' joined the workspace', '{}'::jsonb, v_uid);
  end if;
  if p_via = 'login' then
    perform log_event('login', 'session', v_id::text, 'Signed in' || coalesce(' on ' || nullif(p_device, ''), ''), '{}'::jsonb, v_uid);
  end if;
  return v_id;
end $$;

create or replace function public.session_heartbeat(p_session_id uuid, p_state text, p_idle_for int default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  s user_sessions%rowtype;
  o activity_intervals%rowtype;
  v_now timestamptz := now();
  v_switch timestamptz;
begin
  if v_uid is null then raise exception 'You are not signed in'; end if;
  if p_state not in ('active', 'idle') then raise exception 'Invalid state'; end if;

  select * into s from user_sessions where id = p_session_id and user_id = v_uid for update;
  if not found or s.ended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'ended', 'server_now', v_now);
  end if;
  if v_now - s.last_seen_at > interval '3 minutes' then
    perform close_session(s.id, 'disconnected', s.last_seen_at, true);
    return jsonb_build_object('ok', false, 'reason', 'ended', 'server_now', v_now);
  end if;

  select * into o from activity_intervals where session_id = s.id and ended_at is null for update;
  if o.id is null or o.state <> p_state then
    v_switch := v_now;
    if p_state = 'idle' then
      v_switch := greatest(coalesce(o.started_at, s.started_at),
                           v_now - make_interval(secs => least(greatest(coalesce(p_idle_for, 0), 0), 3600)));
    end if;
    if o.id is not null then update activity_intervals set ended_at = v_switch where id = o.id; end if;
    insert into activity_intervals (session_id, user_id, state, started_at) values (s.id, v_uid, p_state, v_switch);
  end if;

  update user_sessions set last_seen_at = v_now, state = p_state where id = s.id;
  update profiles set last_seen_at = v_now where id = v_uid;
  perform sweep_stale_sessions();
  return jsonb_build_object('ok', true, 'server_now', v_now);
end $$;

create or replace function public.session_end(p_session_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not exists (select 1 from user_sessions where id = p_session_id and user_id = v_uid and ended_at is null) then return; end if;
  perform close_session(p_session_id, 'logout', now(), false);
  perform log_event('logout', 'session', p_session_id::text, 'Signed out', '{}'::jsonb, v_uid);
end $$;

-- Used by the server when a person is switched off: ends every open session of theirs.
create or replace function public.close_member_sessions(p_member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  for s in select id from user_sessions where user_id = p_member and ended_at is null loop
    perform close_session(s.id, 'inactive', now(), false);
  end loop;
end $$;

-- 9.10 Task timer ---------------------------------------------------------------------
create or replace function public.timer_start(p_task_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype; r task_time_entries%rowtype; v_last text; v_started timestamptz;
begin
  perform 1 from profiles where id = v_uid for update;   -- one timer change per member at a time
  select * into t from tasks where id = p_task_id for update;
  if not found or t.assigned_to is distinct from v_uid then raise exception 'Task not found or not assigned to you'; end if;
  if t.status in ('in_review', 'completed') then
    raise exception 'This task is % — the timer is closed', replace(t.status, '_', ' ');
  end if;

  select * into r from task_time_entries where user_id = v_uid and ended_at is null;
  if found then
    if r.task_id = p_task_id then
      return jsonb_build_object('task_id', r.task_id, 'started_at', r.started_at, 'server_now', now());
    end if;
    update task_time_entries set ended_at = greatest(started_at, now()), end_reason = 'switch' where id = r.id;
    perform log_event('timer_paused', 'task', r.task_id::text, 'Timer paused (switched to another task)', '{}'::jsonb, v_uid);
  end if;

  select end_reason into v_last from task_time_entries
   where user_id = v_uid and task_id = p_task_id order by started_at desc limit 1;
  insert into task_time_entries (task_id, user_id, started_at) values (p_task_id, v_uid, now())
  returning started_at into v_started;
  if t.status = 'todo' then update tasks set status = 'in_progress' where id = p_task_id; end if;

  if v_last is not null and v_last <> 'stop' then
    perform log_event('timer_resumed', 'task', p_task_id::text, 'Timer resumed on "' || t.title || '"', '{}'::jsonb, v_uid);
  else
    perform log_event('timer_started', 'task', p_task_id::text, 'Timer started on "' || t.title || '"', '{}'::jsonb, v_uid);
  end if;
  return jsonb_build_object('task_id', p_task_id, 'started_at', v_started, 'server_now', now());
end $$;

create or replace function public.timer_pause() returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); v_task bigint;
begin
  update task_time_entries set ended_at = greatest(started_at, now()), end_reason = 'pause'
   where user_id = v_uid and ended_at is null returning task_id into v_task;
  if v_task is null then raise exception 'No timer is running'; end if;
  perform log_event('timer_paused', 'task', v_task::text, 'Timer paused', '{}'::jsonb, v_uid);
end $$;

create or replace function public.timer_stop(p_task_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); v_id bigint;
begin
  update task_time_entries set ended_at = greatest(started_at, now()), end_reason = 'stop'
   where user_id = v_uid and task_id = p_task_id and ended_at is null returning id into v_id;
  if v_id is null then
    -- stopping a paused timer only closes it; recorded time is unchanged
    update task_time_entries set end_reason = 'stop'
     where id = (select id from task_time_entries where user_id = v_uid and task_id = p_task_id order by started_at desc limit 1)
       and end_reason is distinct from 'stop'
    returning id into v_id;
  end if;
  if v_id is null then raise exception 'There is no timer to stop on this task'; end if;
  perform log_event('timer_stopped', 'task', p_task_id::text, 'Timer stopped', '{}'::jsonb, v_uid);
end $$;

create or replace function public.my_timer() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'server_now', now(),
    'running', (select jsonb_build_object('task_id', te.task_id, 'title', t.title, 'started_at', te.started_at)
                  from task_time_entries te join tasks t on t.id = te.task_id
                 where te.user_id = auth.uid() and te.ended_at is null limit 1));
$$;

create or replace view public.task_time_totals with (security_invoker = true) as
select task_id, user_id,
       coalesce(sum(extract(epoch from coalesce(ended_at, now()) - started_at)), 0)::int as total_seconds,
       bool_or(ended_at is null) as running,
       (array_agg(end_reason order by started_at desc))[1] as last_end_reason,
       max(started_at) filter (where ended_at is null) as running_since
  from public.task_time_entries
 group by task_id, user_id;

-- 9.11 Presence, session list, reports (always inside the caller's workspace) -------
create or replace function public.team_presence()
returns table (user_id uuid, presence text, last_seen_at timestamptz, session_started_at timestamptz,
               timer_task_id bigint, timer_task_title text, timer_started_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not is_manager() then raise exception 'Only the admin or a manager can view team presence'; end if;
  perform sweep_stale_sessions();
  return query
  select p.id,
         coalesce(s.state, 'offline'),
         coalesce(s.last_seen_at, (select max(coalesce(x.ended_at, x.last_seen_at)) from user_sessions x where x.user_id = p.id)),
         s.started_at,
         te.task_id, t.title, te.started_at
    from profiles p
    left join lateral (
      select us.state, us.last_seen_at, us.started_at from user_sessions us
       where us.user_id = p.id and us.ended_at is null
       order by us.last_seen_at desc limit 1) s on true
    left join task_time_entries te on te.user_id = p.id and te.ended_at is null
    left join tasks t on t.id = te.task_id
   where p.role = 'member' and p.workspace_id = current_workspace() and p.status = 'active';
end $$;

create or replace function public.list_sessions(p_from date, p_to date, p_user uuid default null)
returns table (id uuid, user_id uuid, member_name text, started_at timestamptz, last_seen_at timestamptz,
               ended_at timestamptz, end_reason text, end_estimated boolean, status text,
               duration_seconds int, active_seconds int, idle_seconds int, device text, user_agent text, started_via text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_ws uuid := current_workspace(); v_tz text := app_tz();
begin
  perform assert_can_view(p_user);
  perform sweep_stale_sessions();
  return query
  with base as (
    select s.*, coalesce(s.ended_at, s.last_seen_at) as end_at,
           (select coalesce(sum(extract(epoch from greatest(coalesce(i.ended_at, s.last_seen_at), i.started_at) - i.started_at)), 0)
              from activity_intervals i where i.session_id = s.id and i.state = 'active') as act
      from user_sessions s
     where s.started_at >= (p_from::timestamp at time zone v_tz)
       and s.started_at <  ((p_to + 1)::timestamp at time zone v_tz)
       and (p_user is null or s.user_id = p_user) and s.workspace_id = v_ws
  )
  select b.id, b.user_id, member_name(b.user_id), b.started_at, b.last_seen_at, b.ended_at, b.end_reason, b.end_estimated,
         case when b.ended_at is not null then 'ended' else b.state end,
         extract(epoch from b.end_at - b.started_at)::int,
         least(b.act, extract(epoch from b.end_at - b.started_at))::int,
         greatest(extract(epoch from b.end_at - b.started_at) - b.act, 0)::int,
         b.device, b.user_agent, b.started_via
    from base b
   order by b.started_at desc
   limit 2000;
end $$;

create or replace function public.report_daily(p_from date, p_to date, p_user uuid default null)
returns table (day date, user_id uuid, session_seconds int, active_seconds int, idle_seconds int, timer_seconds int, sessions int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_ws uuid := current_workspace(); v_tz text := app_tz(); v_start timestamptz; v_end timestamptz;
begin
  perform assert_can_view(p_user);
  if p_to < p_from or p_to - p_from > 370 then raise exception 'Choose a date range of up to one year'; end if;
  perform sweep_stale_sessions();
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;

  return query
  with days as (
    select g::date as d,
           (g::date)::timestamp at time zone v_tz as ds,
           (g::date + 1)::timestamp at time zone v_tz as de
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ),
  raw as (
    select s.user_id as uid, 'session'::text as kind, s.started_at as t0, coalesce(s.ended_at, s.last_seen_at) as t1
      from user_sessions s
     where s.started_at < v_end and coalesce(s.ended_at, s.last_seen_at) > v_start
       and (p_user is null or s.user_id = p_user) and s.workspace_id = v_ws
    union all
    select i.user_id, 'active', i.started_at, coalesce(i.ended_at, s2.last_seen_at)
      from activity_intervals i join user_sessions s2 on s2.id = i.session_id
     where i.state = 'active' and i.started_at < v_end and coalesce(i.ended_at, s2.last_seen_at) > v_start
       and (p_user is null or i.user_id = p_user) and i.workspace_id = v_ws
    union all
    select te.user_id, 'timer', te.started_at, coalesce(te.ended_at, now())
      from task_time_entries te
     where te.started_at < v_end and coalesce(te.ended_at, now()) > v_start
       and (p_user is null or te.user_id = p_user) and te.workspace_id = v_ws
  ),
  clipped as (
    select r.uid, r.kind, d.d, greatest(r.t0, d.ds) as t0, least(r.t1, d.de) as t1
      from raw r join days d on r.t0 < d.de and r.t1 > d.ds
     where r.t1 > r.t0
  ),
  marked as (
    select c.*,
           case when max(c.t1) over w is null or max(c.t1) over w < c.t0 then 1 else 0 end as is_new
      from clipped c
    window w as (partition by c.uid, c.kind, c.d order by c.t0, c.t1 rows between unbounded preceding and 1 preceding)
  ),
  grouped as (
    select m.*, sum(m.is_new) over (partition by m.uid, m.kind, m.d order by m.t0, m.t1 rows unbounded preceding) as grp
      from marked m
  ),
  merged as (
    select g.uid, g.kind, g.d, extract(epoch from max(g.t1) - min(g.t0)) as secs
      from grouped g group by g.uid, g.kind, g.d, g.grp
  ),
  totals as (
    select m.uid, m.d,
           coalesce(sum(m.secs) filter (where m.kind = 'session'), 0) as ses,
           coalesce(sum(m.secs) filter (where m.kind = 'active'), 0)  as act,
           coalesce(sum(m.secs) filter (where m.kind = 'timer'), 0)   as tim
      from merged m group by m.uid, m.d
  ),
  starts as (
    select s.user_id as uid, (s.started_at at time zone v_tz)::date as d, count(*) as n
      from user_sessions s
     where s.started_at >= v_start and s.started_at < v_end and (p_user is null or s.user_id = p_user) and s.workspace_id = v_ws
     group by 1, 2
  )
  select coalesce(t.d, st.d), coalesce(t.uid, st.uid),
         round(coalesce(t.ses, 0))::int,
         round(least(coalesce(t.act, 0), coalesce(t.ses, 0)))::int,
         round(greatest(coalesce(t.ses, 0) - coalesce(t.act, 0), 0))::int,
         round(coalesce(t.tim, 0))::int,
         coalesce(st.n, 0)::int
    from totals t
    full join starts st on st.uid = t.uid and st.d = t.d
   order by 1, 2;
end $$;

create or replace function public.report_tasks(p_from date, p_to date, p_user uuid default null)
returns table (task_id bigint, title text, user_id uuid, team_role text, status text, seconds int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_ws uuid := current_workspace(); v_tz text := app_tz(); v_start timestamptz; v_end timestamptz;
begin
  perform assert_can_view(p_user);
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
  select t.id, t.title, te.user_id, t.team_role, t.status,
         round(sum(extract(epoch from least(coalesce(te.ended_at, now()), v_end) - greatest(te.started_at, v_start))))::int
    from task_time_entries te join tasks t on t.id = te.task_id
   where te.started_at < v_end and coalesce(te.ended_at, now()) > v_start
     and (p_user is null or te.user_id = p_user) and te.workspace_id = v_ws
   group by t.id, t.title, te.user_id, t.team_role, t.status
   order by 6 desc;
end $$;

create or replace function public.day_timeline(p_day date, p_user uuid default null)
returns table (user_id uuid, kind text, start_sec int, end_sec int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_ws uuid := current_workspace(); v_tz text := app_tz(); v_ds timestamptz; v_de timestamptz;
begin
  perform assert_can_view(p_user);
  v_ds := p_day::timestamp at time zone v_tz;
  v_de := (p_day + 1)::timestamp at time zone v_tz;
  return query
  with blocks as (
    select i.user_id as uid, i.state as k, i.started_at as t0, coalesce(i.ended_at, s.last_seen_at) as t1
      from activity_intervals i join user_sessions s on s.id = i.session_id
     where i.started_at < v_de and coalesce(i.ended_at, s.last_seen_at) > v_ds
       and (p_user is null or i.user_id = p_user) and i.workspace_id = v_ws
    union all
    select te.user_id, 'timer', te.started_at, coalesce(te.ended_at, now())
      from task_time_entries te
     where te.started_at < v_de and coalesce(te.ended_at, now()) > v_ds
       and (p_user is null or te.user_id = p_user) and te.workspace_id = v_ws
  )
  select b.uid, b.k,
         floor(extract(epoch from greatest(b.t0, v_ds) - v_ds))::int,
         ceil(extract(epoch from least(b.t1, v_de) - v_ds))::int
    from blocks b
   where b.t1 > b.t0
   order by b.uid, b.t0;
end $$;

-- 9.12 Row Level Security ----------------------------------------------------------
alter table public.app_settings       enable row level security;
alter table public.team_roles         enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_comments      enable row level security;
alter table public.task_time_entries  enable row level security;
alter table public.user_sessions      enable row level security;
alter table public.activity_intervals enable row level security;
alter table public.activity_logs      enable row level security;

-- The wall between workspaces. Restrictive = it must hold in addition to every policy below.
do $$
declare t text;
begin
  foreach t in array array['app_settings','tasks','task_comments','task_time_entries',
                           'user_sessions','activity_intervals','activity_logs'] loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I as restrictive for all to authenticated
                      using (workspace_id = (select public.current_workspace()))
                      with check (workspace_id = (select public.current_workspace()))', t);
  end loop;
end $$;

drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select to authenticated using (true);
drop policy if exists settings_admin_update on public.app_settings;
create policy settings_admin_update on public.app_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- The catalogue shows only roles this workspace has switched on ("manager" always exists).
drop policy if exists roles_read on public.team_roles;
create policy roles_read on public.team_roles for select to authenticated
  using (key = 'manager' or exists (select 1 from public.workspace_roles w
          where w.workspace_id = (select public.current_workspace()) and w.role_key = team_roles.key and w.active));

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (assigned_to = (select auth.uid()) or (select public.is_manager()));
drop policy if exists tasks_admin_insert on public.tasks;
create policy tasks_admin_insert on public.tasks for insert to authenticated with check ((select public.is_manager()));
drop policy if exists tasks_admin_update on public.tasks;
create policy tasks_admin_update on public.tasks for update to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));
drop policy if exists tasks_admin_delete on public.tasks;
create policy tasks_admin_delete on public.tasks for delete to authenticated using ((select public.is_manager()));

drop policy if exists comments_read on public.task_comments;
create policy comments_read on public.task_comments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id
                  and (t.assigned_to = (select auth.uid()) or (select public.is_manager()))));
drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert to authenticated
  with check (author_id = (select auth.uid())
              and exists (select 1 from public.tasks t where t.id = task_id
                           and (t.assigned_to = (select auth.uid()) or (select public.is_manager()))));

drop policy if exists time_read on public.task_time_entries;
create policy time_read on public.task_time_entries for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists sessions_read on public.user_sessions;
create policy sessions_read on public.user_sessions for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists intervals_read on public.activity_intervals;
create policy intervals_read on public.activity_intervals for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists logs_read on public.activity_logs;
create policy logs_read on public.activity_logs for select to authenticated
  using ((select public.is_manager()) or actor_id = (select auth.uid()) or subject_id = (select auth.uid()));

-- 9.13 Privileges: browsers read; every change goes through the functions or the server --
revoke all on public.app_settings, public.team_roles, public.tasks, public.task_comments,
              public.task_time_entries, public.user_sessions, public.activity_intervals,
              public.activity_logs, public.task_time_totals, public.member_roles
  from anon, authenticated;

grant select on public.app_settings, public.team_roles, public.tasks, public.task_comments,
                public.task_time_entries, public.user_sessions, public.activity_intervals,
                public.activity_logs, public.task_time_totals, public.member_roles
  to authenticated;
grant update (company_name, timezone, idle_minutes, currency) on public.app_settings to authenticated;
grant insert, update, delete on public.tasks to authenticated;
grant insert on public.task_comments to authenticated;

-- Functions: nobody by default; the browser gets only the ones it should call.
revoke execute on function
  public.eco_fill_workspace(), public.profiles_employee_code(), public.workspace_default_settings(),
  public.is_manager_id(uuid), public.same_workspace(uuid), public.app_tz(), public.member_name(uuid),
  public.assert_active(), public.assert_can_view(uuid),
  public.log_event(text, text, text, text, jsonb, uuid, uuid),
  public.settings_before_update(), public.settings_after_update(),
  public.tasks_before_write(), public.stop_task_timers(bigint, text), public.tasks_after_write(),
  public.comments_before_insert(), public.close_session(uuid, text, timestamptz, boolean),
  public.close_member_sessions(uuid),
  public.sweep_stale_sessions(), public.session_start(text, text, text),
  public.session_heartbeat(uuid, text, int), public.session_end(uuid),
  public.timer_start(bigint), public.timer_pause(), public.timer_stop(bigint), public.my_timer(),
  public.task_set_status(bigint, text, text), public.task_review(bigint, boolean, text),
  public.team_presence(), public.list_sessions(date, date, uuid), public.report_daily(date, date, uuid),
  public.report_tasks(date, date, uuid), public.day_timeline(date, uuid)
  from public, anon, authenticated;

grant execute on function
  public.sweep_stale_sessions(), public.session_start(text, text, text),
  public.session_heartbeat(uuid, text, int), public.session_end(uuid),
  public.timer_start(bigint), public.timer_pause(), public.timer_stop(bigint), public.my_timer(),
  public.task_set_status(bigint, text, text), public.task_review(bigint, boolean, text),
  public.team_presence(), public.list_sessions(date, date, uuid), public.report_daily(date, date, uuid),
  public.report_tasks(date, date, uuid), public.day_timeline(date, uuid)
  to authenticated;

-- 9.14 Deleting a person or a workspace also removes this data --------------------------
create or replace function public.purge_person_activity(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.activity_log  where actor_id = p_id or p_id = any(involved);
  delete from public.activity_logs where actor_id = p_id or subject_id = p_id;
$$;
revoke all on function public.purge_person_activity(uuid) from public, anon, authenticated;

create or replace function public.purge_workspace(p_id uuid) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  perform set_config('webnox.purge', 'on', true);
  select coalesce(array_agg(id), '{}') into ids from public.profiles where workspace_id = p_id and is_master = false;
  delete from public.activity_logs        where workspace_id = p_id;
  delete from public.activity_intervals   where workspace_id = p_id;
  delete from public.user_sessions        where workspace_id = p_id;
  delete from public.task_time_entries    where workspace_id = p_id;
  delete from public.task_comments        where workspace_id = p_id;
  delete from public.tasks                where workspace_id = p_id;
  delete from public.app_settings         where workspace_id = p_id;
  delete from public.notifications        where workspace_id = p_id;
  delete from public.activity_log         where workspace_id = p_id;
  delete from public.staffing_requests    where workspace_id = p_id;
  delete from public.projects             where workspace_id = p_id;
  delete from public.workspace_roles      where workspace_id = p_id;
  delete from public.subscription_payments where workspace_id = p_id;
  delete from public.subscriptions        where workspace_id = p_id;
  delete from public.billing_log          where workspace_id = p_id;
  delete from public.master_access_log    where workspace_id = p_id;
  delete from public.profiles             where workspace_id = p_id and is_master = false;
  delete from public.workspaces           where id = p_id;
  return ids;
end $$;
revoke all on function public.purge_workspace(uuid) from public, anon, authenticated;

-- ============================================================================
-- PART 10 — Notifications for tasks, and deleting a task
-- ============================================================================
-- Run this whole part once in the Supabase SQL Editor (after PART 9). Safe to run again.
-- The same bell now serves the staffing-request approvals and the task alerts.

alter table public.notifications add column if not exists kind  text not null default 'info';
alter table public.notifications add column if not exists title text;
alter table public.notifications add column if not exists body  text not null default '';
alter table public.notifications add column if not exists link  text;
alter table public.notifications alter column text drop not null;

alter table public.notifications enable row level security;
drop policy if exists tenant_isolation on public.notifications;
create policy tenant_isolation on public.notifications as restrictive for all to authenticated
  using (workspace_id = (select public.current_workspace()))
  with check (workspace_id = (select public.current_workspace()));
drop policy if exists notifications_own_read on public.notifications;
create policy notifications_own_read on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists notifications_own_update on public.notifications;
create policy notifications_own_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- A person reads their own bell and can only mark things as read.
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- "Ali Khan (Designer)" — name plus designation, used in notifications.
create or replace function public.member_label(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select member_name(p.id) || coalesce(' (' || nullif(p.job_title, '') || ')',
           case when p.account_type = 'admin' then ' (Admin)' else '' end)
    from profiles p where p.id = p_id;
$$;

-- Send a notification: never to the person who caused it, never to someone switched off,
-- never across workspaces.
create or replace function public.notify(p_user uuid, p_kind text, p_title text, p_body text default '', p_link text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  if p_user is null or p_user = auth.uid() then return; end if;
  select workspace_id into v_ws from profiles where id = p_user and status = 'active';
  if v_ws is null then return; end if;
  if auth.uid() is not null and v_ws is distinct from current_workspace() then return; end if;
  insert into notifications (workspace_id, user_id, kind, title, body, link, text)
  values (v_ws, p_user, p_kind, left(p_title, 200), left(coalesce(p_body, ''), 500), p_link, left(p_title, 200));
end $$;

create or replace function public.notify_managers(p_kind text, p_title text, p_body text default '', p_link text default null, p_ws uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_ws uuid := coalesce(p_ws, current_workspace());
begin
  if v_ws is null then return; end if;
  for r in select p.id from profiles p
            where p.workspace_id = v_ws and p.status = 'active' and p.account_type in ('admin', 'manager') loop
    perform notify(r.id, p_kind, p_title, p_body, p_link);
  end loop;
end $$;

create or replace function public.notify_role(p_role text, p_kind text, p_title text, p_body text default '', p_link text default null, p_ws uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_ws uuid := coalesce(p_ws, current_workspace());
begin
  if v_ws is null then return; end if;
  for r in select m.member_id as id from member_roles m join profiles p on p.id = m.member_id
            where m.role_key = p_role and p.workspace_id = v_ws and p.status = 'active' loop
    perform notify(r.id, p_kind, p_title, p_body, p_link);
  end loop;
end $$;

create or replace function public.tasks_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/my-tasks';
begin
  if tg_op = 'INSERT' then
    perform notify(new.assigned_to, 'task', 'New task: ' || new.title,
      'Assigned by ' || coalesce(member_label(auth.uid()), 'your manager'), v_link);
    return new;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform notify(new.assigned_to, 'task', 'New task: ' || new.title,
      'Assigned by ' || coalesce(member_label(auth.uid()), 'your manager'), v_link);
  end if;
  if new.status is distinct from old.status then
    if new.status = 'in_review' then
      perform notify_managers('review', 'Ready for review: ' || new.title,
        'Submitted by ' || coalesce(member_name(new.assigned_to), 'a member'), '#/tasks?status=in_review', new.workspace_id);
    elsif old.status = 'in_review' and new.status = 'completed' then
      perform notify(new.assigned_to, 'task', 'Approved: ' || new.title, coalesce(new.review_note, ''), v_link);
    elsif old.status = 'in_review' then
      perform notify(new.assigned_to, 'task', 'Changes requested: ' || new.title, coalesce(new.review_note, ''), v_link);
    elsif new.assigned_to is not distinct from old.assigned_to then
      perform notify(new.assigned_to, 'task', 'Task moved to ' || replace(new.status, '_', ' ') || ': ' || new.title, '', v_link);
    end if;
  elsif new.assigned_to is not distinct from old.assigned_to
        and (new.title, new.description, new.priority, new.due_date) is distinct from (old.title, old.description, old.priority, old.due_date) then
    perform notify(new.assigned_to, 'task', 'Task updated: ' || new.title, 'Check the latest details', v_link);
  end if;
  return new;
end $$;

drop trigger if exists tasks_notify on public.tasks;
create trigger tasks_notify after insert or update on public.tasks
  for each row execute function public.tasks_notify();

-- A normal delete is blocked when a task has tracked time. The admin or a manager can force it:
-- the task, its comments and its timer entries go, and one audit line keeps the record.
alter table public.task_time_entries drop constraint if exists task_time_entries_task_id_fkey;
alter table public.task_time_entries add constraint task_time_entries_task_id_fkey
  foreign key (task_id) references public.tasks(id);

create or replace function public.task_force_delete(p_task bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype; v_secs bigint; v_entries int; v_comments int;
begin
  if not is_manager() then raise exception 'Only the admin or a manager can force delete a task'; end if;
  select * into t from tasks where id = p_task for update;
  if not found or t.workspace_id is distinct from current_workspace() then raise exception 'Task not found'; end if;
  select count(*), coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - started_at))), 0)::bigint
    into v_entries, v_secs from task_time_entries where task_id = p_task;
  select count(*) into v_comments from task_comments where task_id = p_task;
  perform log_event('task_force_deleted', 'task', p_task::text,
    'Force deleted task "' || t.title || '"' || case when v_entries > 0 then ' with ' || round(v_secs / 3600.0, 2) || 'h tracked' else '' end,
    jsonb_build_object('title', t.title, 'assigned_to', t.assigned_to, 'status', t.status,
                       'time_entries', v_entries, 'tracked_seconds', v_secs, 'comments', v_comments),
    t.assigned_to);
  delete from task_time_entries where task_id = p_task;
  delete from tasks where id = p_task;   -- comments go with it (on delete cascade)
end $$;

revoke execute on function
  public.member_label(uuid), public.notify(uuid, text, text, text, text),
  public.notify_managers(text, text, text, text, uuid), public.notify_role(text, text, text, text, text, uuid),
  public.tasks_notify(), public.task_force_delete(bigint)
  from public, anon, authenticated;
grant execute on function public.task_force_delete(bigint) to authenticated;

-- =============================================================================
-- PART 11 — more than one Admin per workspace
-- The Master can add another Admin to a workspace and edit people inside it.
-- The API still refuses to switch off or demote the last active Admin.
-- =============================================================================
drop index if exists public.one_admin_per_workspace;

-- =============================================================================
-- PART 12 — Employee IDs carry the workspace slug (EMP-WEBNOX-001); logo-only branding
-- =============================================================================
create or replace function public.profiles_employee_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.employee_code is null and new.workspace_id is not null and not new.is_master then
    perform pg_advisory_xact_lock(hashtext(new.workspace_id::text));
    new.employee_code := 'EMP-' || upper((select slug from public.workspaces where id = new.workspace_id)) || '-' ||
      lpad((select coalesce(max(substring(p.employee_code from '([0-9]+)$')::int), 0) + 1
              from public.profiles p
             where p.workspace_id = new.workspace_id and p.employee_code ~ '^EMP-.+-[0-9]+$')::text, 3, '0');
  end if;
  return new;
end $$;

-- Existing people: EMP-0001 becomes EMP-<SLUG>-001 (same order, same numbers).
update public.profiles p
   set employee_code = 'EMP-' || upper(w.slug) || '-' || lpad(substring(p.employee_code from 5)::int::text, 3, '0')
  from public.workspaces w
 where w.id = p.workspace_id and p.employee_code ~ '^EMP-[0-9]+$';

-- A logo that already contains the business name: show only the logo, never the name as text.
alter table public.workspaces add column if not exists logo_only boolean not null default false;

-- ============================================================================
-- PART 13 — Leads, Clients, files and the public lead form (inside every workspace)
-- ============================================================================
-- Run this whole part once in the Supabase SQL Editor (after PARTs 1-12). Safe to run again.
--
-- Who can do what:
--   * Admin and Manager accounts: everything.
--   * Everyone else: what the Admin allows for their role on the Permissions page
--     (role_permissions, one private copy per workspace) — and only for roles the Master has
--     switched on. "Edit" and "delete" also need the Master's "allow to edit" switch for that role.
--   * A Project Manager sees/edits only the clients assigned to them (if the role allows it).

-- 13.1 eco_fill_workspace learns about clients ---------------------------------------
create or replace function public.eco_fill_workspace() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_key text;
begin
  if new.workspace_id is not null then return new; end if;
  v_key := to_jsonb(new) ->> tg_argv[0];
  if v_key is not null then
    v_ws := case tg_argv[1]
      when 'profile' then (select workspace_id from public.profiles      where id = v_key::uuid)
      when 'task'    then (select workspace_id from public.tasks         where id = v_key::bigint)
      when 'session' then (select workspace_id from public.user_sessions where id = v_key::uuid)
      when 'client'  then (select workspace_id from public.clients       where id = v_key::bigint)
    end;
  end if;
  new.workspace_id := coalesce(v_ws, public.current_workspace());
  return new;
end $$;

-- 13.2 What each role may do — per workspace ------------------------------------------
create table if not exists public.role_permissions (
  workspace_id uuid not null references public.workspaces(id),
  role_key     text not null references public.team_roles(key) on update cascade on delete cascade,
  module       text not null check (module in ('leads', 'clients', 'finance')),
  can_view     boolean not null default false,
  can_edit     boolean not null default false,
  can_delete   boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, role_key, module)
);

-- A workspace that already has the EcomHub shape (no workspace_id yet) is upgraded in place.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'role_permissions' and column_name = 'role_key')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'role_permissions' and column_name = 'workspace_id') then
    raise exception 'role_permissions exists without workspace_id; drop it (it is empty in Webnox) and run PART 13 again';
  end if;
end $$;

create or replace function public.seed_role_permissions(p_ws uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.role_permissions (workspace_id, role_key, module, can_view, can_edit, can_delete)
  select p_ws, d.role_key, d.module, d.v, d.e, d.x
    from (values
      ('lead_gen',        'leads',   true,  true,  false), ('lead_gen',        'clients', false, false, false), ('lead_gen',        'finance', false, false, false),
      ('sales_rep',       'leads',   true,  true,  false), ('sales_rep',       'clients', true,  false, false), ('sales_rep',       'finance', false, false, false),
      ('cold_caller',     'leads',   true,  true,  false), ('cold_caller',     'clients', false, false, false), ('cold_caller',     'finance', false, false, false),
      ('finance',         'leads',   false, false, false), ('finance',         'clients', true,  false, false), ('finance',         'finance', true,  true,  true),
      ('project_manager', 'leads',   false, false, false), ('project_manager', 'clients', true,  true,  false), ('project_manager', 'finance', false, false, false),
      ('project_agent',   'leads',   false, false, false), ('project_agent',   'clients', false, false, false), ('project_agent',   'finance', false, false, false)
    ) d(role_key, module, v, e, x)
  on conflict (workspace_id, role_key, module) do nothing;
$$;

create or replace function public.workspaces_seed_permissions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_role_permissions(new.id);
  return new;
end $$;
drop trigger if exists workspaces_permissions on public.workspaces;
create trigger workspaces_permissions after insert on public.workspaces
  for each row execute function public.workspaces_seed_permissions();
select public.seed_role_permissions(id) from public.workspaces;

-- Admin changes are written to the audit trail
create or replace function public.permissions_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform log_event('permission_changed', 'settings', new.role_key || ':' || new.module,
    'Changed ' || coalesce((select name from team_roles where key = new.role_key), new.role_key) || ' access to ' || new.module,
    jsonb_build_object('view', new.can_view, 'edit', new.can_edit, 'delete', new.can_delete));
  return new;
end $$;
drop trigger if exists role_permissions_log on public.role_permissions;
create trigger role_permissions_log after update on public.role_permissions
  for each row execute function public.permissions_after_update();

-- Workspace-wide permission from the caller's roles. A role counts only while the Master has it on
-- for this workspace; edit/delete also need the Master's "allow to edit" switch.
create or replace function public.perm(p_module text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_manager() or exists (
    select 1 from member_roles mr
      join profiles p          on p.id = mr.member_id and p.status = 'active'
      join workspace_roles wr  on wr.workspace_id = p.workspace_id and wr.role_key = mr.role_key and wr.active
      join role_permissions rp on rp.workspace_id = p.workspace_id and rp.role_key = mr.role_key and rp.module = p_module
     where mr.member_id = auth.uid() and mr.role_key <> 'project_manager'
       and case p_action when 'view'   then rp.can_view
                         when 'edit'   then rp.can_edit   and wr.can_edit
                         when 'delete' then rp.can_delete and wr.can_edit
                         else false end);
$$;

-- What the Project Manager role allows on the clients assigned to the caller
create or replace function public.pm_perm(p_module text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from member_roles mr
      join profiles p          on p.id = mr.member_id and p.status = 'active'
      join workspace_roles wr  on wr.workspace_id = p.workspace_id and wr.role_key = mr.role_key and wr.active
      join role_permissions rp on rp.workspace_id = p.workspace_id and rp.role_key = mr.role_key and rp.module = p_module
     where mr.member_id = auth.uid() and mr.role_key = 'project_manager'
       and case p_action when 'view'   then rp.can_view
                         when 'edit'   then rp.can_edit   and wr.can_edit
                         when 'delete' then rp.can_delete and wr.can_edit
                         else false end);
$$;

-- 13.3 Leads ----------------------------------------------------------------------------
create table if not exists public.leads (
  id               bigint generated always as identity primary key,
  workspace_id     uuid not null references public.workspaces(id),
  company          text not null check (char_length(company) between 1 and 200),
  contact_name     text,
  email            text,
  phone            text,
  website          text,
  country          text,
  industry         text,
  source           text,
  service          text,
  notes            text not null default '',
  status           text not null default 'new'
                   check (status in ('new', 'contacted', 'qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost')),
  priority         text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  estimated_value  numeric(12, 2),
  budget           numeric(12, 2),
  currency         text not null default 'USD',
  next_follow_up   date,
  assigned_to      uuid references public.profiles(id) on delete set null,
  agent_id         uuid references public.profiles(id) on delete set null,
  agent_name       text,
  created_by       uuid references public.profiles(id) on delete set null,
  client_id        bigint,
  won_at           timestamptz,
  converted_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists leads_ws_status_idx on public.leads (workspace_id, status, created_at desc);
create index if not exists leads_assigned_idx  on public.leads (assigned_to);
create index if not exists leads_agent_idx     on public.leads (agent_id);

-- 13.4 Clients ---------------------------------------------------------------------------
create table if not exists public.clients (
  id                bigint generated always as identity primary key,
  workspace_id      uuid not null references public.workspaces(id),
  buid              text,
  name              text not null check (char_length(name) between 1 and 200),
  contact_name      text,
  email             text,
  phone             text,
  website           text,
  country           text,
  address           text check (address is null or length(address) <= 300),
  services          text,
  notes             text not null default '',
  status            text not null default 'onboarding' check (status in ('onboarding', 'active', 'paused', 'churned')),
  onboarding_date   date default current_date,
  monthly_retainer  numeric(12, 2),
  project_manager   uuid references public.profiles(id) on delete set null,
  lead_id           bigint references public.leads(id) on delete set null,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists clients_ws_idx on public.clients (workspace_id, created_at desc);
create index if not exists clients_pm_idx on public.clients (project_manager);
create unique index if not exists clients_buid_uq on public.clients (workspace_id, buid);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_client_fk') then
    alter table public.leads add constraint leads_client_fk foreign key (client_id) references public.clients(id) on delete set null;
  end if;
end $$;

-- Tasks can belong to a client
alter table public.tasks add column if not exists client_id bigint references public.clients(id) on delete set null;
create index if not exists tasks_client_idx on public.tasks (client_id);

-- 13.5 Contracts and documents -----------------------------------------------------------
create table if not exists public.client_files (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  client_id     bigint not null references public.clients(id) on delete cascade,
  kind          text not null default 'document' check (kind in ('contract', 'document', 'invoice', 'other')),
  name          text not null,
  storage_path  text not null unique,
  size_bytes    bigint,
  uploaded_by   uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists client_files_client_idx on public.client_files (client_id);

drop trigger if exists aa_ws_fill on public.leads;
create trigger aa_ws_fill before insert on public.leads
  for each row execute function public.eco_fill_workspace('assigned_to', 'profile');
drop trigger if exists aa_ws_fill on public.clients;
create trigger aa_ws_fill before insert on public.clients
  for each row execute function public.eco_fill_workspace('project_manager', 'profile');
drop trigger if exists aa_ws_fill on public.client_files;
create trigger aa_ws_fill before insert on public.client_files
  for each row execute function public.eco_fill_workspace('client_id', 'client');

-- 13.6 Can the caller view / edit / delete this client (and its files)? ----------------------
create or replace function public.can_client(p_client bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from clients c
                  where c.id = p_client and c.workspace_id = current_workspace()
                    and (perm('clients', p_action) or (c.project_manager = auth.uid() and pm_perm('clients', p_action))));
$$;

-- 13.7 Validation, timestamps, audit trail ----------------------------------------------------
create or replace function public.biz_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if tg_op = 'INSERT' then
    if tg_table_name = 'client_files' then new.uploaded_by := coalesce(auth.uid(), new.uploaded_by);
    else new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now(); end if;
  else
    new.workspace_id := old.workspace_id;           -- a row never moves between workspaces
  end if;
  if tg_table_name <> 'client_files' then new.updated_at := now(); end if;

  if tg_table_name = 'leads' then
    if new.assigned_to is not null and not exists (select 1 from profiles where id = new.assigned_to and workspace_id = new.workspace_id) then
      raise exception 'That person is not in this workspace';
    end if;
    if new.agent_id is not null and not exists (select 1 from profiles where id = new.agent_id and workspace_id = new.workspace_id) then
      raise exception 'That person is not in this workspace';
    end if;
    if new.status = 'won' and (tg_op = 'INSERT' or old.status <> 'won') then new.won_at := now(); end if;
    if new.status <> 'won' then new.won_at := null; end if;
  elsif tg_table_name = 'clients' then
    if new.project_manager is not null and (tg_op = 'INSERT' or new.project_manager is distinct from old.project_manager)
       and not exists (select 1 from member_roles where member_id = new.project_manager and role_key = 'project_manager'
                          and workspace_id = new.workspace_id) then
      raise exception 'Pick a member with the Project Manager role';
    end if;
    -- BUID-1001, BUID-1002 ... counted inside each workspace, never changed once given
    if tg_op = 'INSERT' then new.buid := null; else new.buid := old.buid; end if;
    if new.buid is null then
      perform pg_advisory_xact_lock(hashtext('buid:' || new.workspace_id::text));
      select coalesce(max(substr(c.buid, 6)::int), 1000) + 1 into v_n
        from clients c where c.workspace_id = new.workspace_id and c.buid ~ '^BUID-[0-9]+$';
      new.buid := 'BUID-' || v_n;
    end if;
  end if;
  return new;
end $$;

create or replace function public.biz_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_client text;
begin
  if tg_table_name = 'leads' then
    if tg_op = 'INSERT' then
      perform log_event('lead_created', 'lead', new.id::text, 'Added lead "' || new.company || '"', jsonb_build_object('source', new.source), new.assigned_to, coalesce(auth.uid(), new.agent_id));
    elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
      perform log_event(case when new.status = 'won' then 'lead_won' when new.status = 'lost' then 'lead_lost' else 'lead_status_changed' end,
        'lead', new.id::text, 'Moved lead "' || new.company || '" to ' || new.status,
        jsonb_build_object('from', old.status, 'to', new.status), new.assigned_to);
    elsif tg_op = 'DELETE' then
      perform log_event('lead_deleted', 'lead', old.id::text, 'Deleted lead "' || old.company || '"');
    end if;
  elsif tg_table_name = 'clients' then
    if tg_op = 'INSERT' then
      perform log_event('client_created', 'client', new.id::text, 'Added client "' || new.name || '"', '{}'::jsonb, new.project_manager);
    elsif tg_op = 'UPDATE' and new.project_manager is distinct from old.project_manager and new.project_manager is not null then
      perform log_event('client_pm_assigned', 'client', new.id::text,
        'Assigned "' || new.name || '" to ' || member_name(new.project_manager), '{}'::jsonb, new.project_manager);
    elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
      perform log_event('client_status_changed', 'client', new.id::text, 'Moved client "' || new.name || '" to ' || new.status,
        jsonb_build_object('from', old.status, 'to', new.status), new.project_manager);
    elsif tg_op = 'DELETE' then
      perform log_event('client_deleted', 'client', old.id::text, 'Deleted client "' || old.name || '"');
    end if;
  elsif tg_table_name = 'client_files' then
    select name into v_client from clients where id = coalesce(new.client_id, old.client_id);
    if tg_op = 'INSERT' then
      perform log_event('file_uploaded', 'client', new.client_id::text, 'Uploaded ' || new.kind || ' "' || new.name || '" for ' || coalesce(v_client, 'client'));
    elsif tg_op = 'DELETE' then
      perform log_event('file_deleted', 'client', old.client_id::text, 'Deleted ' || old.kind || ' "' || old.name || '"');
    end if;
  end if;
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['leads', 'clients', 'client_files'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_before', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.biz_before_write()', t || '_before', t);
    execute format('drop trigger if exists %I on public.%I', t || '_after', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.biz_after_write()', t || '_after', t);
  end loop;
end $$;

-- Only a Sales Representative can be given a lead; only a Sales Rep, Manager or Admin can hand them out
create or replace function public.leads_assign_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.assigned_to is not null) or (tg_op = 'UPDATE' and new.assigned_to is distinct from old.assigned_to) then
    if auth.uid() is not null and not (is_manager() or exists (select 1 from member_roles where member_id = auth.uid() and role_key = 'sales_rep')) then
      raise exception 'Only a Sales Representative, a manager or the admin can assign leads';
    end if;
    if new.assigned_to is not null and not exists (select 1 from member_roles m join profiles p on p.id = m.member_id
                      where m.member_id = new.assigned_to and m.role_key = 'sales_rep' and p.status = 'active') then
      raise exception 'Leads can only be assigned to a Sales Representative';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists leads_assign_check on public.leads;
create trigger leads_assign_check before insert or update on public.leads
  for each row execute function public.leads_assign_check();

-- 13.8 Notifications ------------------------------------------------------------------------------
create or replace function public.leads_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/leads?open=' || new.id;
        v_who text := coalesce(member_label(auth.uid()), coalesce('Lead form (' || coalesce(member_name(new.agent_id), new.agent_name) || ')', 'Lead form'));
begin
  if tg_op = 'INSERT' then
    perform notify_managers('lead', case when auth.uid() is null then 'New lead from the form: ' else 'New lead: ' end || new.company,
      'Added by ' || v_who || case when new.assigned_to is null then '. Not assigned yet.' else '' end, v_link, new.workspace_id);
    if new.assigned_to is null then
      perform notify_role('sales_rep', 'lead', 'New lead to pick up: ' || new.company, 'Added by ' || v_who, '#/leads?scope=unassigned', new.workspace_id);
    else
      perform notify(new.assigned_to, 'lead', 'New lead assigned: ' || new.company, 'Added by ' || v_who, v_link);
    end if;
    if auth.uid() is null then
      perform notify(new.agent_id, 'lead', 'Lead submitted for you: ' || new.company, 'Came in through the lead form', v_link);
    end if;
    return new;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform notify(new.assigned_to, 'lead', 'Lead assigned to you: ' || new.company, 'By ' || v_who, v_link);
    perform notify(old.assigned_to, 'lead', 'Lead moved to someone else: ' || new.company, 'By ' || v_who, v_link);
  end if;
  if new.status is distinct from old.status then
    if new.status in ('won', 'lost') then
      perform notify_managers('lead', 'Lead ' || new.status || ': ' || new.company,
        'By ' || v_who || case when new.status = 'won' then '. Convert it to a client.' else '' end, v_link, new.workspace_id);
    end if;
    perform notify(new.assigned_to, 'lead', new.company || ' moved to ' || new.status, 'By ' || v_who, v_link);
    perform notify(coalesce(new.agent_id, new.created_by), 'lead', 'Your lead ' || new.company || ' is ' || new.status, 'By ' || v_who, v_link);
  end if;
  return new;
end $$;
drop trigger if exists leads_notify on public.leads;
create trigger leads_notify after insert or update on public.leads
  for each row execute function public.leads_notify();

create or replace function public.clients_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/clients?open=' || new.id; v_who text := coalesce(member_label(auth.uid()), 'System');
begin
  if tg_op = 'INSERT' then
    perform notify(new.project_manager, 'client', 'Client assigned to you: ' || new.name, 'By ' || v_who, v_link);
    return new;
  end if;
  if new.project_manager is distinct from old.project_manager then
    perform notify(new.project_manager, 'client', 'Client assigned to you: ' || new.name, 'By ' || v_who, v_link);
  elsif (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    perform notify(new.project_manager, 'client', 'Client updated: ' || new.name, 'By ' || v_who, v_link);
    if new.project_manager = auth.uid() then
      perform notify_managers('client', 'Client updated: ' || new.name, 'By ' || v_who || ' (project manager)', v_link, new.workspace_id);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists clients_notify on public.clients;
create trigger clients_notify after insert or update on public.clients
  for each row execute function public.clients_notify();

create or replace function public.files_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare c clients%rowtype;
begin
  select * into c from clients where id = coalesce(new.client_id, old.client_id);
  if c.id is null then return coalesce(new, old); end if;
  perform notify(c.project_manager, 'client',
    case when tg_op = 'INSERT' then 'New ' || new.kind || ' on ' || c.name else 'File removed from ' || c.name end,
    coalesce(new.name, old.name), '#/clients?open=' || c.id);
  return coalesce(new, old);
end $$;
drop trigger if exists files_notify on public.client_files;
create trigger files_notify after insert or delete on public.client_files
  for each row execute function public.files_notify();

-- 13.9 Won lead -> client -----------------------------------------------------------------------
create or replace function public.lead_convert(p_lead bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); l leads%rowtype; v_client bigint; v_cur text;
begin
  if not perm('leads', 'edit') then raise exception 'You don''t have permission to convert leads'; end if;
  select * into l from leads where id = p_lead and workspace_id = current_workspace() for update;
  if not found then raise exception 'Lead not found'; end if;
  if l.status <> 'won' then raise exception 'Mark the lead as won before converting it'; end if;
  if l.client_id is not null then return l.client_id; end if;
  select currency into v_cur from app_settings where workspace_id = l.workspace_id;
  insert into clients (workspace_id, name, contact_name, email, phone, website, country, services, notes, lead_id, monthly_retainer, created_by)
  values (l.workspace_id, coalesce(nullif(l.company, ''), l.contact_name), l.contact_name, l.email, l.phone, l.website, l.country, l.service, l.notes, l.id,
          case when upper(l.currency) = upper(coalesce(v_cur, 'USD')) then l.budget end, v_uid)
  returning id into v_client;
  update leads set client_id = v_client, converted_at = now() where id = p_lead;
  perform log_event('lead_converted', 'lead', p_lead::text, 'Converted "' || l.company || '" to a client', jsonb_build_object('client_id', v_client));
  perform notify_managers('client', 'New client: ' || l.company, member_name(v_uid) || ' converted a won lead. Assign a project manager.', '#/clients?open=' || v_client, l.workspace_id);
  return v_client;
end $$;

-- 13.10 Row Level Security ----------------------------------------------------------------------------
alter table public.role_permissions enable row level security;
alter table public.leads            enable row level security;
alter table public.clients          enable row level security;
alter table public.client_files     enable row level security;

do $$ declare t text; begin
  foreach t in array array['role_permissions', 'leads', 'clients', 'client_files'] loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I as restrictive for all to authenticated
                      using (workspace_id = (select public.current_workspace()))
                      with check (workspace_id = (select public.current_workspace()))', t);
  end loop;
end $$;

drop policy if exists perms_read on public.role_permissions;
create policy perms_read on public.role_permissions for select to authenticated using (true);
drop policy if exists perms_admin_update on public.role_permissions;
create policy perms_admin_update on public.role_permissions for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists leads_read on public.leads;
create policy leads_read on public.leads for select to authenticated using ((select public.perm('leads', 'view')));
drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads for insert to authenticated with check ((select public.perm('leads', 'edit')));
drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads for update to authenticated
  using ((select public.perm('leads', 'edit'))) with check ((select public.perm('leads', 'edit')));
drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads for delete to authenticated using ((select public.perm('leads', 'delete')));

drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using ((select public.perm('clients', 'view')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'view'))));
drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients for insert to authenticated with check ((select public.perm('clients', 'edit')));
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update to authenticated
  using ((select public.perm('clients', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'edit'))))
  with check ((select public.perm('clients', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'edit'))));
drop policy if exists clients_delete on public.clients;
create policy clients_delete on public.clients for delete to authenticated using ((select public.perm('clients', 'delete')));

drop policy if exists files_read on public.client_files;
create policy files_read on public.client_files for select to authenticated using (public.can_client(client_id, 'view'));
drop policy if exists files_insert on public.client_files;
create policy files_insert on public.client_files for insert to authenticated with check (public.can_client(client_id, 'edit'));
drop policy if exists files_delete on public.client_files;
create policy files_delete on public.client_files for delete to authenticated using (public.can_client(client_id, 'delete'));

revoke all on public.role_permissions, public.leads, public.clients, public.client_files from anon, authenticated;
grant select on public.role_permissions, public.leads, public.clients, public.client_files to authenticated;
grant update (can_view, can_edit, can_delete) on public.role_permissions to authenticated;
grant insert, update, delete on public.leads, public.clients to authenticated;
grant insert, delete on public.client_files to authenticated;

revoke execute on function
  public.seed_role_permissions(uuid), public.workspaces_seed_permissions(), public.permissions_after_update(),
  public.biz_before_write(), public.biz_after_write(), public.leads_assign_check(), public.leads_notify(),
  public.clients_notify(), public.files_notify(), public.perm(text, text), public.pm_perm(text, text),
  public.can_client(bigint, text), public.lead_convert(bigint)
  from public, anon, authenticated;
grant execute on function
  public.perm(text, text), public.pm_perm(text, text), public.can_client(bigint, text), public.lead_convert(bigint)
  to authenticated;

-- 13.11 Storage for contracts and documents (Supabase only). Files live at <workspace>/<client>/<file>.
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('client-files', 'client-files', false, 26214400)
    on conflict (id) do nothing;
    execute 'drop policy if exists "client files read" on storage.objects';
    execute 'create policy "client files read" on storage.objects for select to authenticated using (bucket_id = ''client-files'' and (storage.foldername(name))[1] = public.current_workspace()::text and public.can_client(((storage.foldername(name))[2])::bigint, ''view''))';
    execute 'drop policy if exists "client files upload" on storage.objects';
    execute 'create policy "client files upload" on storage.objects for insert to authenticated with check (bucket_id = ''client-files'' and (storage.foldername(name))[1] = public.current_workspace()::text and public.can_client(((storage.foldername(name))[2])::bigint, ''edit''))';
    execute 'drop policy if exists "client files delete" on storage.objects';
    execute 'create policy "client files delete" on storage.objects for delete to authenticated using (bucket_id = ''client-files'' and (storage.foldername(name))[1] = public.current_workspace()::text and public.can_client(((storage.foldername(name))[2])::bigint, ''delete''))';
  end if;
end $$;

-- 13.12 Deleting a person or a workspace also removes this data ---------------------------------------------
create or replace function public.purge_person_activity(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.activity_log  where actor_id = p_id or p_id = any(involved);
  delete from public.activity_logs where actor_id = p_id or subject_id = p_id;
$$;
revoke all on function public.purge_person_activity(uuid) from public, anon, authenticated;

create or replace function public.purge_workspace(p_id uuid) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  perform set_config('webnox.purge', 'on', true);
  select coalesce(array_agg(id), '{}') into ids from public.profiles where workspace_id = p_id and is_master = false;
  delete from public.activity_logs        where workspace_id = p_id;
  delete from public.activity_intervals   where workspace_id = p_id;
  delete from public.user_sessions        where workspace_id = p_id;
  delete from public.task_time_entries    where workspace_id = p_id;
  delete from public.task_comments        where workspace_id = p_id;
  delete from public.tasks                where workspace_id = p_id;
  delete from public.client_files         where workspace_id = p_id;
  delete from public.leads                where workspace_id = p_id;
  delete from public.clients              where workspace_id = p_id;
  delete from public.role_permissions     where workspace_id = p_id;
  delete from public.app_settings         where workspace_id = p_id;
  delete from public.notifications        where workspace_id = p_id;
  delete from public.activity_log         where workspace_id = p_id;
  delete from public.staffing_requests    where workspace_id = p_id;
  delete from public.projects             where workspace_id = p_id;
  delete from public.workspace_roles      where workspace_id = p_id;
  delete from public.subscription_payments where workspace_id = p_id;
  delete from public.subscriptions        where workspace_id = p_id;
  delete from public.billing_log          where workspace_id = p_id;
  delete from public.master_access_log    where workspace_id = p_id;
  delete from public.profiles             where workspace_id = p_id and is_master = false;
  delete from public.workspaces           where id = p_id;
  return ids;
end $$;
revoke all on function public.purge_workspace(uuid) from public, anon, authenticated;

-- ============================================================================
-- PART 14 — Same rules as EcomHub: roles need no extra "edit" switch; new leads tell the whole sales side
-- ============================================================================
-- Run once in the Supabase SQL Editor (after PART 13). Safe to run again.

-- A role works while the Master has it switched on; what it may do is decided by the Admin's
-- Permissions (view / edit / delete), exactly like EcomHub.
create or replace function public.perm(p_module text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_manager() or exists (
    select 1 from member_roles mr
      join profiles p          on p.id = mr.member_id and p.status = 'active'
      join workspace_roles wr  on wr.workspace_id = p.workspace_id and wr.role_key = mr.role_key and wr.active
      join role_permissions rp on rp.workspace_id = p.workspace_id and rp.role_key = mr.role_key and rp.module = p_module
     where mr.member_id = auth.uid() and mr.role_key <> 'project_manager'
       and case p_action when 'view' then rp.can_view when 'edit' then rp.can_edit when 'delete' then rp.can_delete else false end);
$$;

create or replace function public.pm_perm(p_module text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from member_roles mr
      join profiles p          on p.id = mr.member_id and p.status = 'active'
      join workspace_roles wr  on wr.workspace_id = p.workspace_id and wr.role_key = mr.role_key and wr.active
      join role_permissions rp on rp.workspace_id = p.workspace_id and rp.role_key = mr.role_key and rp.module = p_module
     where mr.member_id = auth.uid() and mr.role_key = 'project_manager'
       and case p_action when 'view' then rp.can_view when 'edit' then rp.can_edit when 'delete' then rp.can_delete else false end);
$$;

-- A new lead: Admin, Managers, Sales Representatives and Lead Generation all hear about it.
create or replace function public.leads_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/leads?open=' || new.id;
        v_who text := coalesce(member_label(auth.uid()), coalesce('Lead form (' || coalesce(member_name(new.agent_id), new.agent_name) || ')', 'Lead form'));
        v_title text;
begin
  if tg_op = 'INSERT' then
    v_title := case when auth.uid() is null then 'New lead from the form: ' else 'New lead: ' end || new.company;
    perform notify_managers('lead', v_title, 'Added by ' || v_who || case when new.assigned_to is null then '. Not assigned yet.' else '' end, v_link, new.workspace_id);
    perform notify_role('sales_rep', 'lead', case when new.assigned_to is null then 'New lead to pick up: ' || new.company else v_title end,
      'Added by ' || v_who, case when new.assigned_to is null then '#/leads?scope=unassigned' else v_link end, new.workspace_id);
    perform notify_role('lead_gen', 'lead', v_title, 'Added by ' || v_who, v_link, new.workspace_id);
    if new.assigned_to is not null then
      perform notify(new.assigned_to, 'lead', 'New lead assigned: ' || new.company, 'Added by ' || v_who, v_link);
    end if;
    if auth.uid() is null then
      perform notify(new.agent_id, 'lead', 'Lead submitted for you: ' || new.company, 'Came in through the lead form', v_link);
    end if;
    return new;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform notify(new.assigned_to, 'lead', 'Lead assigned to you: ' || new.company, 'By ' || v_who, v_link);
    perform notify(old.assigned_to, 'lead', 'Lead moved to someone else: ' || new.company, 'By ' || v_who, v_link);
  end if;
  if new.status is distinct from old.status then
    if new.status in ('won', 'lost') then
      perform notify_managers('lead', 'Lead ' || new.status || ': ' || new.company,
        'By ' || v_who || case when new.status = 'won' then '. Convert it to a client.' else '' end, v_link, new.workspace_id);
    end if;
    perform notify(new.assigned_to, 'lead', new.company || ' moved to ' || new.status, 'By ' || v_who, v_link);
    perform notify(coalesce(new.agent_id, new.created_by), 'lead', 'Your lead ' || new.company || ' is ' || new.status, 'By ' || v_who, v_link);
  end if;
  return new;
end $$;

revoke execute on function public.perm(text, text), public.pm_perm(text, text), public.leads_notify() from public, anon, authenticated;
grant execute on function public.perm(text, text), public.pm_perm(text, text) to authenticated;

-- ============================================================================
-- PART 15 — Projects (EcomHub's 7-tab projects) + staffing requests (Project Agents)
-- ============================================================================
-- Run once in the Supabase SQL Editor (after PART 14). Safe to run again.
--
-- How a project gets people:
--   * Admin / Manager creates the project for a client and picks the Project Manager.
--   * The Project Manager asks for people ("2 x Designer, 1 x Developer"); the Admin / a Manager
--     can Approve, Decline or Discuss it.
--   * After approval the Project Manager fills each slot with a matching Project Agent.
--   * Admin / Manager can also add or remove people directly.
-- Test projects from the first Webnox version are moved across (each becomes a client + a project).

-- 15.0 Old (uuid) tables are renamed out of the way; they are moved across at the end -------
do $$ declare t text; ix text; begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'id' and data_type = 'uuid') then
    alter table public.notifications drop column if exists project_id;
    alter table public.notifications drop column if exists request_id;
    alter table public.activity_log  drop column if exists project_id;
    alter table public.activity_log  drop column if exists request_id;
    drop trigger if exists projects_manager_guard on public.projects;
    drop trigger if exists project_members_guard on public.project_members;
    foreach t in array array['projects', 'staffing_requests', 'staffing_request_items', 'project_members', 'request_comments'] loop
      for ix in select indexname from pg_indexes where schemaname = 'public' and tablename = t loop
        execute format('alter index public.%I rename to %I', ix, 'legacy_' || ix);
      end loop;
      execute format('alter table public.%I rename to %I', t, 'legacy_' || t);
    end loop;
  end if;
end $$;

-- (a full re-run of the file would put PART 7's old guards back on the new tables)
do $$ begin
  if to_regclass('public.projects') is not null then
    drop trigger if exists projects_manager_guard on public.projects;
  end if;
  if to_regclass('public.project_members') is not null then
    drop trigger if exists project_members_guard on public.project_members;
  end if;
end $$;

-- 15.1 eco_fill_workspace learns about projects and staffing requests -------------------------
create or replace function public.eco_fill_workspace() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_key text;
begin
  if new.workspace_id is not null then return new; end if;
  v_key := to_jsonb(new) ->> tg_argv[0];
  if v_key is not null then
    v_ws := case tg_argv[1]
      when 'profile' then (select workspace_id from public.profiles      where id = v_key::uuid)
      when 'task'    then (select workspace_id from public.tasks         where id = v_key::bigint)
      when 'session' then (select workspace_id from public.user_sessions where id = v_key::uuid)
      when 'client'  then (select workspace_id from public.clients       where id = v_key::bigint)
      when 'project' then (select workspace_id from public.projects      where id = v_key::bigint)
      when 'request' then (select workspace_id from public.staffing_requests where id = v_key::bigint)
    end;
  end if;
  new.workspace_id := coalesce(v_ws, public.current_workspace());
  return new;
end $$;

-- 15.2 Permissions: a "projects" module ---------------------------------------------------------
alter table public.role_permissions drop constraint if exists role_permissions_module_check;
alter table public.role_permissions add constraint role_permissions_module_check
  check (module in ('leads', 'clients', 'finance', 'projects'));

create or replace function public.seed_role_permissions(p_ws uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.role_permissions (workspace_id, role_key, module, can_view, can_edit, can_delete)
  select p_ws, d.role_key, d.module, d.v, d.e, d.x
    from (values
      ('lead_gen',        'leads',   true,  true,  false), ('lead_gen',        'clients', false, false, false), ('lead_gen',        'finance', false, false, false), ('lead_gen',        'projects', false, false, false),
      ('sales_rep',       'leads',   true,  true,  false), ('sales_rep',       'clients', true,  false, false), ('sales_rep',       'finance', false, false, false), ('sales_rep',       'projects', false, false, false),
      ('cold_caller',     'leads',   true,  true,  false), ('cold_caller',     'clients', false, false, false), ('cold_caller',     'finance', false, false, false), ('cold_caller',     'projects', false, false, false),
      ('finance',         'leads',   false, false, false), ('finance',         'clients', true,  false, false), ('finance',         'finance', true,  true,  true),  ('finance',         'projects', false, false, false),
      ('project_manager', 'leads',   false, false, false), ('project_manager', 'clients', true,  true,  false), ('project_manager', 'finance', false, false, false), ('project_manager', 'projects', true,  true,  false),
      ('project_agent',   'leads',   false, false, false), ('project_agent',   'clients', false, false, false), ('project_agent',   'finance', false, false, false), ('project_agent',   'projects', false, false, false)
    ) d(role_key, module, v, e, x)
  on conflict (workspace_id, role_key, module) do nothing;
$$;
select public.seed_role_permissions(id) from public.workspaces;

-- 15.3 Tables ----------------------------------------------------------------------------------------
create table if not exists public.projects (
  id               bigint generated always as identity primary key,
  workspace_id     uuid not null references public.workspaces(id),
  client_id        bigint not null references public.clients(id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 200),
  description      text not null default '',
  status           text not null default 'planning' check (status in ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  project_manager  uuid references public.profiles(id) on delete set null,
  start_date       date default current_date,
  due_date         date,
  website_url      text,
  socials          jsonb not null default '{}'::jsonb check (jsonb_typeof(socials) = 'object'),
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  legacy_id        uuid
);
create index if not exists projects_ws_idx     on public.projects (workspace_id, created_at desc);
create index if not exists projects_client_idx on public.projects (client_id);
create index if not exists projects_pm_idx     on public.projects (project_manager);

-- A request from the Project Manager: "I need these people". Admin / Manager decide.
create table if not exists public.staffing_requests (
  id             bigint generated always as identity primary key,
  workspace_id   uuid not null references public.workspaces(id),
  project_id     bigint not null references public.projects(id) on delete cascade,
  requested_by   uuid references public.profiles(id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending', 'discussing', 'approved', 'declined')),
  note           text check (note is null or char_length(note) <= 500),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or char_length(decision_note) <= 500),
  created_at     timestamptz not null default now(),
  legacy_id      uuid
);
create index if not exists staffing_requests_project_idx on public.staffing_requests (project_id, created_at desc);

create table if not exists public.staffing_request_items (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  request_id    bigint not null references public.staffing_requests(id) on delete cascade,
  designation   text not null check (char_length(btrim(designation)) between 1 and 60),
  department    text check (department is null or char_length(department) <= 60),
  qty           int not null check (qty between 1 and 20),
  legacy_id     uuid
);
create index if not exists staffing_items_request_idx on public.staffing_request_items (request_id);

create table if not exists public.request_comments (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  request_id    bigint not null references public.staffing_requests(id) on delete cascade,
  author_id     uuid references public.profiles(id) on delete cascade,
  body          text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at    timestamptz not null default now()
);
create index if not exists request_comments_req_idx on public.request_comments (request_id, created_at);

-- Who is on a project. 'approved' = on the team now; 'removed' = was on it.
create table if not exists public.project_members (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  project_id    bigint not null references public.projects(id) on delete cascade,
  member_id     uuid not null references public.profiles(id) on delete cascade,
  item_id       bigint references public.staffing_request_items(id) on delete set null,
  role_label    text not null default 'Member',
  status        text not null default 'approved' check (status in ('approved', 'removed')),
  added_by      uuid references public.profiles(id) on delete set null,
  added_at      timestamptz not null default now(),
  removed_by    uuid references public.profiles(id) on delete set null,
  removed_at    timestamptz
);
create unique index if not exists project_members_open_uq on public.project_members (project_id, member_id) where status = 'approved';
create index if not exists project_members_member_idx  on public.project_members (member_id, status);
create index if not exists project_members_project_idx on public.project_members (project_id, status);
create index if not exists project_members_item_idx    on public.project_members (item_id);

create table if not exists public.project_requirements (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null references public.workspaces(id),
  project_id    bigint not null references public.projects(id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 300),
  details       text not null default '',
  is_done       boolean not null default false,
  sort          int not null default 0,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  done_by       uuid references public.profiles(id) on delete set null,
  done_at       timestamptz,
  updated_at    timestamptz not null default now()
);
create index if not exists project_requirements_project_idx on public.project_requirements (project_id, sort, id);

alter table public.tasks        add column if not exists project_id bigint references public.projects(id) on delete set null;
alter table public.client_files add column if not exists project_id bigint references public.projects(id) on delete set null;
create index if not exists tasks_project_idx        on public.tasks (project_id);
create index if not exists client_files_project_idx on public.client_files (project_id);

do $$ declare d record; begin
  for d in select * from (values
      ('projects', 'client_id', 'client'), ('project_members', 'project_id', 'project'), ('project_requirements', 'project_id', 'project'),
      ('staffing_requests', 'project_id', 'project'), ('staffing_request_items', 'request_id', 'request'), ('request_comments', 'request_id', 'request')
    ) v(t, col, kind) loop
    execute format('drop trigger if exists aa_ws_fill on public.%I', d.t);
    execute format('create trigger aa_ws_fill before insert on public.%I for each row execute function public.eco_fill_workspace(%L, %L)', d.t, d.col, d.kind);
  end loop;
end $$;

-- 15.4 Access helpers (all stay inside the caller's workspace) ---------------------------------
create or replace function public.is_project_pm(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = p_project and workspace_id = current_workspace() and project_manager = auth.uid())
     and pm_perm('projects', 'view');
$$;

-- the person who runs this project (no role switch needed: used for staffing)
create or replace function public.is_project_lead(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = p_project and workspace_id = current_workspace() and project_manager = auth.uid());
$$;

create or replace function public.is_project_member(p_project bigint, p_member uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_members where project_id = p_project and member_id = p_member and status = 'approved');
$$;

create or replace function public.is_client_pm(p_client bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from clients where id = p_client and workspace_id = current_workspace() and project_manager = auth.uid())
     and pm_perm('clients', 'view');
$$;

create or replace function public.can_project(p_project bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects pr where pr.id = p_project and pr.workspace_id = current_workspace()
                   and (perm('projects', p_action)
                        or (pr.project_manager = auth.uid() and pm_perm('projects', p_action))
                        or (p_action = 'view' and is_project_member(pr.id, auth.uid()))));
$$;

create or replace function public.can_manage_project(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects pr where pr.id = p_project and pr.workspace_id = current_workspace()
                   and (perm('projects', 'edit') or (pr.project_manager = auth.uid() and pm_perm('projects', 'edit'))));
$$;

create or replace function public.client_via_project(p_client bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects pr where pr.client_id = p_client and pr.workspace_id = current_workspace()
                   and ((pr.project_manager = auth.uid() and pm_perm('clients', p_action))
                        or (p_action = 'view' and is_project_member(pr.id, auth.uid()))));
$$;

-- Storage paths: "<workspace>/<client>/<file>" or "<workspace>/<client>/p<project>/<file>"
create or replace function public.can_storage_file(p_name text, p_action text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(p_name, '/'); v_client bigint; v_project bigint;
begin
  if parts[1] is distinct from current_workspace()::text then return false; end if;
  if parts[2] is null or parts[2] !~ '^\d+$' then return false; end if;
  v_client := parts[2]::bigint;
  if can_client(v_client, p_action) then return true; end if;
  if array_length(parts, 1) >= 4 and parts[3] ~ '^p\d+$' then
    v_project := substr(parts[3], 2)::bigint;
    return exists (select 1 from projects where id = v_project and client_id = v_client) and can_project(v_project, p_action);
  end if;
  return false;
end $$;

-- Tasks of a project belong to its client; the link is checked inside the workspace
create or replace function public.project_link_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.project_id is not null then
    select client_id into new.client_id from projects where id = new.project_id and workspace_id = new.workspace_id;
    if not found then raise exception 'Project not found'; end if;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['tasks', 'client_files'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_project_link', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.project_link_before()', t || '_project_link', t);
  end loop;
end $$;

-- 15.5 Projects: validation, audit, notifications -------------------------------------------------------
create or replace function public.projects_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
    if not exists (select 1 from clients where id = new.client_id and workspace_id = new.workspace_id) then raise exception 'Client not found'; end if;
  else
    new.created_by := old.created_by; new.created_at := old.created_at; new.client_id := old.client_id; new.workspace_id := old.workspace_id;
  end if;
  new.updated_at := now();
  if new.project_manager is not null and (tg_op = 'INSERT' or new.project_manager is distinct from old.project_manager) then
    if not exists (select 1 from member_roles m join profiles p on p.id = m.member_id
                    where m.member_id = new.project_manager and m.role_key = 'project_manager'
                      and p.workspace_id = new.workspace_id and p.status in ('active', 'invited')) then
      raise exception 'Pick a member with the Project Manager role';
    end if;
  end if;
  if auth.uid() is not null and tg_op = 'UPDATE' and new.project_manager is distinct from old.project_manager and not perm('projects', 'edit') then
    raise exception 'Only the admin or a manager can change the project manager';
  end if;
  if new.due_date is not null and new.start_date is not null and new.due_date < new.start_date then
    raise exception 'The due date is before the start date';
  end if;
  return new;
end $$;
drop trigger if exists projects_before on public.projects;
create trigger projects_before before insert or update on public.projects for each row execute function public.projects_before_write();

create or replace function public.projects_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text; v_who text := coalesce(member_label(auth.uid()), 'System'); v_client text; v_actor text := coalesce(member_name(auth.uid()), 'System');
begin
  if tg_op = 'DELETE' then
    perform log_event('project_deleted', 'project', old.id::text, v_actor || ' deleted the project ' || old.name);
    return old;
  end if;
  v_link := '#/projects?open=' || new.id;
  select name into v_client from clients where id = new.client_id;
  if tg_op = 'INSERT' then
    perform log_event('project_created', 'project', new.id::text, v_actor || ' created the project ' || new.name || ' for ' || coalesce(v_client, 'a client'),
      jsonb_build_object('client_id', new.client_id), new.project_manager);
    perform notify(new.project_manager, 'project', 'Project assigned to you: ' || new.name, 'Client ' || coalesce(v_client, '') || '. By ' || v_who, v_link);
    return new;
  end if;
  if new.project_manager is distinct from old.project_manager then
    perform log_event('project_pm_assigned', 'project', new.id::text,
      v_actor || ' assigned ' || coalesce(member_name(new.project_manager), 'nobody') || ' as Project Manager of ' || new.name,
      jsonb_build_object('from', member_name(old.project_manager), 'to', member_name(new.project_manager)), new.project_manager);
    perform notify(new.project_manager, 'project', 'Project assigned to you: ' || new.name, 'Client ' || coalesce(v_client, '') || '. By ' || v_who, v_link);
    perform notify(old.project_manager, 'project', 'Project moved to another PM: ' || new.name, 'By ' || v_who, v_link);
  end if;
  if new.status is distinct from old.status then
    perform log_event('project_status_changed', 'project', new.id::text, v_actor || ' moved the project ' || new.name || ' to ' || replace(new.status, '_', ' '),
      jsonb_build_object('from', old.status, 'to', new.status), new.project_manager);
    if new.project_manager = auth.uid() then
      perform notify_managers('project', 'Project ' || replace(new.status, '_', ' ') || ': ' || new.name, 'By ' || v_who, v_link, new.workspace_id);
    elsif new.project_manager is not distinct from old.project_manager then
      perform notify(new.project_manager, 'project', 'Project ' || replace(new.status, '_', ' ') || ': ' || new.name, 'By ' || v_who, v_link);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists projects_after on public.projects;
create trigger projects_after after insert or update or delete on public.projects for each row execute function public.projects_after_write();

-- Requirements checklist
create or replace function public.requirements_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  else
    new.created_by := old.created_by; new.created_at := old.created_at; new.project_id := old.project_id; new.workspace_id := old.workspace_id;
  end if;
  new.updated_at := now();
  if new.is_done and (tg_op = 'INSERT' or not old.is_done) then new.done_by := auth.uid(); new.done_at := now(); end if;
  if not new.is_done then new.done_by := null; new.done_at := null; end if;
  return new;
end $$;
drop trigger if exists requirements_before on public.project_requirements;
create trigger requirements_before before insert or update on public.project_requirements for each row execute function public.requirements_before_write();

create or replace function public.requirements_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select name into v_name from projects where id = coalesce(new.project_id, old.project_id);
  if tg_op = 'INSERT' then
    perform log_event('requirement_added', 'project', new.project_id::text, 'Added requirement "' || new.title || '" to ' || coalesce(v_name, 'project'));
  elsif tg_op = 'UPDATE' and new.is_done is distinct from old.is_done then
    perform log_event(case when new.is_done then 'requirement_done' else 'requirement_reopened' end, 'project', new.project_id::text,
      case when new.is_done then 'Completed requirement "' else 'Reopened requirement "' end || new.title || '"');
  elsif tg_op = 'DELETE' then
    perform log_event('requirement_deleted', 'project', old.project_id::text, 'Removed requirement "' || old.title || '"');
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists requirements_after on public.project_requirements;
create trigger requirements_after after insert or update or delete on public.project_requirements for each row execute function public.requirements_after_write();

-- 15.6 Staffing requests --------------------------------------------------------------------------------
-- Can this person fill an approved slot? Active Project Agent, same designation (and department, if asked).
create or replace function public.agent_fits(p_member uuid, p_item bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p, staffing_request_items i
     where p.id = p_member and i.id = p_item and p.workspace_id = i.workspace_id
       and p.status = 'active' and p.account_type = 'member' and 'project_agent' = any(p.roles)
       and lower(btrim(coalesce(p.job_title, ''))) = lower(btrim(i.designation))
       and (i.department is null or lower(btrim(coalesce(p.department, ''))) = lower(btrim(i.department))));
$$;

create or replace function public.staffing_label(p_request bigint) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(string_agg(designation, ', ' order by id), '') from staffing_request_items where request_id = p_request;
$$;

create or replace function public.staffing_request_create(p_project bigint, p_items jsonb, p_note text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); pr projects%rowtype; v_id bigint; it jsonb; v_des text; v_qty int; v_seen text[] := '{}';
        v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), ''); v_dept text; v_label text;
begin
  select * into pr from projects where id = p_project and workspace_id = current_workspace() for update;
  if not found then raise exception 'Project not found'; end if;
  if pr.project_manager is distinct from v_uid then raise exception 'Only the Project Manager of this project can ask for people'; end if;
  if pr.status not in ('planning', 'active') then raise exception 'This project is not active'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one requirement'; end if;
  if jsonb_array_length(p_items) > 8 then raise exception 'At most 8 requirements per request'; end if;
  insert into staffing_requests (workspace_id, project_id, requested_by, note) values (pr.workspace_id, p_project, v_uid, v_note) returning id into v_id;
  for it in select * from jsonb_array_elements(p_items) loop
    v_des := left(btrim(coalesce(it ->> 'designation', '')), 60);
    v_dept := nullif(left(btrim(coalesce(it ->> 'department', '')), 60), '');
    v_qty := case when (it ->> 'qty') ~ '^\d{1,3}$' then (it ->> 'qty')::int end;
    if v_des = '' then raise exception 'Every requirement needs a designation'; end if;
    if v_qty is null or v_qty < 1 or v_qty > 20 then raise exception 'Quantity must be 1 to 20'; end if;
    if lower(v_des) = any(v_seen) then raise exception 'Each designation can be listed once: %', v_des; end if;
    v_seen := v_seen || lower(v_des);
    insert into staffing_request_items (workspace_id, request_id, designation, department, qty) values (pr.workspace_id, v_id, v_des, v_dept, v_qty);
  end loop;
  v_label := staffing_label(v_id);
  perform log_event('staffing_requested', 'project', p_project::text,
    member_name(v_uid) || ' sent a ' || v_label || ' request for ' || pr.name, jsonb_build_object('request_id', v_id), v_uid);
  perform notify_managers('approval', member_name(v_uid) || ' sent a ' || v_label || ' request for ' || pr.name,
    coalesce(v_note, 'Waiting for your decision'), '#/projects?open=' || p_project || '&tab=team', pr.workspace_id);
  return v_id;
end $$;

create or replace function public.staffing_request_decide(p_id bigint, p_decision text, p_note text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r staffing_requests%rowtype; pr projects%rowtype; v_label text; v_status text;
        v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), ''); v_me text := member_name(auth.uid()); v_verb text; v_link text;
begin
  if not is_manager() then raise exception 'Only the admin or a manager can decide this request'; end if;
  if p_decision not in ('approve', 'decline', 'discuss') then raise exception 'Invalid action'; end if;
  select * into r from staffing_requests where id = p_id and workspace_id = current_workspace() for update;
  if not found then raise exception 'Request not found'; end if;
  if r.requested_by = v_uid then raise exception 'You can''t decide your own request'; end if;
  if r.status in ('approved', 'declined') then raise exception 'This request is already closed'; end if;
  if r.status = 'discussing' and p_decision = 'discuss' then raise exception 'Invalid action'; end if;
  select * into pr from projects where id = r.project_id;
  v_label := staffing_label(r.id);
  v_status := case p_decision when 'approve' then 'approved' when 'decline' then 'declined' else 'discussing' end;
  if p_decision = 'discuss' then
    update staffing_requests set status = v_status where id = r.id;
    if v_note is not null then insert into request_comments (workspace_id, request_id, author_id, body) values (r.workspace_id, r.id, v_uid, v_note); end if;
  else
    update staffing_requests set status = v_status, decided_by = v_uid, decided_at = now(), decision_note = v_note where id = r.id;
  end if;
  v_verb := case p_decision when 'approve' then 'approved' when 'decline' then 'declined' else 'opened a discussion on' end;
  v_link := '#/projects?open=' || r.project_id || '&tab=team';
  perform log_event('staffing_' || v_status, 'project', r.project_id::text,
    v_me || ' ' || v_verb || ' the ' || v_label || ' request on ' || pr.name, jsonb_build_object('request_id', r.id, 'note', v_note), r.requested_by);
  perform notify(r.requested_by, 'approval', v_me || ' ' || v_verb || ' your ' || v_label || ' request on ' || pr.name, coalesce(v_note, ''), v_link);
  perform notify_managers('approval', v_me || ' ' || v_verb || ' the ' || v_label || ' request on ' || pr.name, coalesce(v_note, ''), v_link, r.workspace_id);
  return v_status;
end $$;

create or replace function public.staffing_request_comment(p_id bigint, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r staffing_requests%rowtype; pr projects%rowtype; v_label text; v_me text := member_name(auth.uid());
        v_body text := left(btrim(coalesce(p_body, '')), 1000); v_link text;
begin
  select * into r from staffing_requests where id = p_id and workspace_id = current_workspace() for update;
  if not found then raise exception 'Request not found'; end if;
  if not (is_manager() or r.requested_by = v_uid) then raise exception 'Not allowed'; end if;
  if v_body = '' then raise exception 'Write a comment first'; end if;
  if r.status in ('approved', 'declined') then raise exception 'This request is already closed'; end if;
  select * into pr from projects where id = r.project_id;
  v_label := staffing_label(r.id);
  v_link := '#/projects?open=' || r.project_id || '&tab=team';
  insert into request_comments (workspace_id, request_id, author_id, body) values (r.workspace_id, r.id, v_uid, v_body);
  perform log_event('staffing_commented', 'project', r.project_id::text, v_me || ' commented on the ' || v_label || ' request on ' || pr.name,
    jsonb_build_object('request_id', r.id), r.requested_by);
  perform notify(r.requested_by, 'approval', v_me || ' commented on your ' || v_label || ' request on ' || pr.name, v_body, v_link);
  perform notify_managers('approval', v_me || ' commented on the ' || v_label || ' request on ' || pr.name, v_body, v_link, r.workspace_id);
end $$;

-- 15.7 Project team -----------------------------------------------------------------------------------------
-- Project Manager: only into an approved slot, with a matching Project Agent.
-- Admin / Manager: straight in (with or without a slot).
create or replace function public.project_member_add(p_project bigint, p_member uuid, p_item bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); pr projects%rowtype; v_id bigint; it staffing_request_items%rowtype; rq staffing_requests%rowtype;
        v_label text := 'Member'; v_name text; v_me text := member_name(auth.uid());
begin
  select * into pr from projects where id = p_project and workspace_id = current_workspace() for update;
  if not found then raise exception 'Project not found'; end if;
  if not (is_manager() or pr.project_manager = v_uid) then raise exception 'Only the admin, a manager or the Project Manager can add people'; end if;
  if pr.status in ('completed', 'cancelled') then raise exception 'This project is closed. Reopen it to add people.'; end if;
  if not exists (select 1 from profiles where id = p_member and workspace_id = pr.workspace_id and status = 'active') then raise exception 'Pick an active team member'; end if;
  v_name := member_name(p_member);
  if p_member = pr.project_manager then raise exception '% already runs this project as Project Manager', v_name; end if;
  if exists (select 1 from project_members where project_id = p_project and member_id = p_member and status = 'approved') then
    raise exception '% is already on this project', v_name; end if;
  if p_item is null and not is_manager() then raise exception 'Choose an approved slot to fill'; end if;
  if p_item is not null then
    select * into it from staffing_request_items where id = p_item and workspace_id = pr.workspace_id;
    if not found then raise exception 'Slot not found'; end if;
    select * into rq from staffing_requests where id = it.request_id;
    if rq.project_id <> p_project or rq.status <> 'approved' then raise exception 'This request is not approved'; end if;
    if (select count(*) from project_members where item_id = it.id and status = 'approved') >= it.qty then raise exception 'All slots for this requirement are filled'; end if;
    if not agent_fits(p_member, it.id) then raise exception 'This person does not match the approved requirement'; end if;
    v_label := it.designation;
  end if;
  insert into project_members (workspace_id, project_id, member_id, item_id, role_label, added_by)
  values (pr.workspace_id, p_project, p_member, p_item, v_label, v_uid) returning id into v_id;
  perform log_event('project_member_added', 'project', p_project::text, v_me || ' added ' || v_name || ' to ' || pr.name, '{}'::jsonb, p_member);
  perform notify(p_member, 'project', 'You were added to ' || pr.name, 'As ' || v_label || ', by ' || member_label(v_uid), '#/projects?open=' || p_project);
  perform notify_managers('project', v_name || ' joined ' || pr.name, 'Added by ' || member_label(v_uid), '#/projects?open=' || p_project || '&tab=team', pr.workspace_id);
  return v_id;
end $$;

create or replace function public.project_member_remove(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r project_members%rowtype; pr projects%rowtype;
begin
  select * into r from project_members where id = p_id and workspace_id = current_workspace() for update;
  if not found then raise exception 'Member not found'; end if;
  if r.status <> 'approved' then raise exception 'They are not on this project'; end if;
  select * into pr from projects where id = r.project_id;
  if not (is_manager() or pr.project_manager = v_uid) then raise exception 'Only the admin, a manager or the Project Manager can remove people'; end if;
  update project_members set status = 'removed', removed_by = v_uid, removed_at = now() where id = p_id;
  perform log_event('project_member_removed', 'project', r.project_id::text,
    member_name(v_uid) || ' removed ' || member_name(r.member_id) || ' from ' || pr.name, '{}'::jsonb, r.member_id);
  perform notify(r.member_id, 'project', 'You were removed from ' || pr.name, 'By ' || member_label(v_uid), '#/projects');
end $$;

-- Who can fill each approved slot that still has room (for the Project Manager / Admin)
create or replace function public.project_candidates(p_project bigint)
returns table (item_id bigint, member_id uuid, name text, job_title text, department text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (is_manager() or is_project_lead(p_project)) then return; end if;
  return query
    select i.id, p.id, member_name(p.id), p.job_title, p.department
      from staffing_requests r
      join staffing_request_items i on i.request_id = r.id
      join profiles p on p.workspace_id = r.workspace_id
     where r.project_id = p_project and r.workspace_id = current_workspace() and r.status = 'approved'
       and (select count(*) from project_members m where m.item_id = i.id and m.status = 'approved') < i.qty
       and agent_fits(p.id, i.id)
       and not exists (select 1 from project_members m where m.project_id = p_project and m.member_id = p.id and m.status = 'approved')
       and p.id is distinct from (select project_manager from projects where id = p_project)
     order by i.id, 3;
end $$;

-- 15.8 Tasks: Project Managers run the tasks of their projects ----------------------------------------
create or replace function public.can_see_task(p_task bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tasks t where t.id = p_task and t.workspace_id = current_workspace()
                   and (t.assigned_to = auth.uid() or is_manager()
                        or (t.client_id is not null and is_client_pm(t.client_id))
                        or (t.project_id is not null and is_project_pm(t.project_id))));
$$;

create or replace function public.task_review(p_task_id bigint, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into t from tasks where id = p_task_id for update;
  if not found or t.workspace_id is distinct from current_workspace() then raise exception 'Task not found'; end if;
  if not (is_manager() or (t.client_id is not null and is_client_pm(t.client_id)) or (t.project_id is not null and is_project_pm(t.project_id))) then
    raise exception 'Only the admin, a manager or the project manager can review this task';
  end if;
  if t.status <> 'in_review' then raise exception 'This task is not waiting for review'; end if;
  if not p_approve and v_note is null then raise exception 'Add a note so the member knows what to change'; end if;
  update tasks set status = case when p_approve then 'completed' else 'in_progress' end, review_note = v_note where id = p_task_id;
  if v_note is not null then
    insert into task_comments (task_id, author_id, body)
    values (p_task_id, v_uid, case when p_approve then 'Approved: ' else 'Changes requested: ' end || v_note);
  end if;
end $$;

create or replace function public.tasks_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/my-tasks'; v_pm uuid; v_pm_link text;
begin
  if new.project_id is not null then
    select project_manager into v_pm from projects where id = new.project_id;
    v_pm_link := '#/projects?open=' || new.project_id || '&tab=tasks';
  elsif new.client_id is not null then
    select project_manager into v_pm from clients where id = new.client_id;
    v_pm_link := '#/clients?open=' || new.client_id;
  end if;
  if tg_op = 'INSERT' then
    perform notify(new.assigned_to, 'task', 'New task: ' || new.title, 'Assigned by ' || coalesce(member_label(auth.uid()), 'your manager'), v_link);
    return new;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform notify(new.assigned_to, 'task', 'New task: ' || new.title, 'Assigned by ' || coalesce(member_label(auth.uid()), 'your manager'), v_link);
  end if;
  if new.status is distinct from old.status then
    if new.status = 'in_review' then
      perform notify_managers('review', 'Ready for review: ' || new.title, 'Submitted by ' || coalesce(member_name(new.assigned_to), 'a member'), '#/tasks?status=in_review', new.workspace_id);
      perform notify(v_pm, 'review', 'Ready for review: ' || new.title, 'Submitted by ' || coalesce(member_name(new.assigned_to), 'a member'), v_pm_link);
    elsif old.status = 'in_review' and new.status = 'completed' then
      perform notify(new.assigned_to, 'task', 'Approved: ' || new.title, coalesce(new.review_note, ''), v_link);
    elsif old.status = 'in_review' then
      perform notify(new.assigned_to, 'task', 'Changes requested: ' || new.title, coalesce(new.review_note, ''), v_link);
    elsif new.assigned_to is not distinct from old.assigned_to then
      perform notify(new.assigned_to, 'task', 'Task moved to ' || replace(new.status, '_', ' ') || ': ' || new.title, '', v_link);
    end if;
  elsif new.assigned_to is not distinct from old.assigned_to
        and (new.title, new.description, new.priority, new.due_date) is distinct from (old.title, old.description, old.priority, old.due_date) then
    perform notify(new.assigned_to, 'task', 'Task updated: ' || new.title, 'Check the latest details', v_link);
  end if;
  return new;
end $$;

-- Files on a project go to its Project Manager
create or replace function public.files_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare c clients%rowtype; v_pm uuid; v_pid bigint := coalesce(new.project_id, old.project_id);
begin
  select * into c from clients where id = coalesce(new.client_id, old.client_id);
  if c.id is null then return coalesce(new, old); end if;
  if v_pid is not null then select project_manager into v_pm from projects where id = v_pid; else v_pm := c.project_manager; end if;
  perform notify(v_pm, 'client',
    case when tg_op = 'INSERT' then 'New ' || new.kind || ' on ' || c.name else 'File removed from ' || c.name end,
    coalesce(new.name, old.name), case when v_pid is not null then '#/projects?open=' || v_pid || '&tab=files' else '#/clients?open=' || c.id end);
  return coalesce(new, old);
end $$;

-- A converted lead tells the managers what comes next
create or replace function public.lead_convert(p_lead bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); l leads%rowtype; v_client bigint; v_cur text;
begin
  if not perm('leads', 'edit') then raise exception 'You don''t have permission to convert leads'; end if;
  select * into l from leads where id = p_lead and workspace_id = current_workspace() for update;
  if not found then raise exception 'Lead not found'; end if;
  if l.status <> 'won' then raise exception 'Mark the lead as won before converting it'; end if;
  if l.client_id is not null then return l.client_id; end if;
  select currency into v_cur from app_settings where workspace_id = l.workspace_id;
  insert into clients (workspace_id, name, contact_name, email, phone, website, country, services, notes, lead_id, monthly_retainer, created_by)
  values (l.workspace_id, coalesce(nullif(l.company, ''), l.contact_name), l.contact_name, l.email, l.phone, l.website, l.country, l.service, l.notes, l.id,
          case when upper(l.currency) = upper(coalesce(v_cur, 'USD')) then l.budget end, v_uid)
  returning id into v_client;
  update leads set client_id = v_client, converted_at = now() where id = p_lead;
  perform log_event('lead_converted', 'lead', p_lead::text, 'Converted "' || l.company || '" to a client', jsonb_build_object('client_id', v_client));
  perform notify_managers('client', 'New client: ' || l.company, member_name(v_uid) || ' converted a won lead. Create a project and assign a Project Manager.', '#/clients?open=' || v_client, l.workspace_id);
  return v_client;
end $$;

-- 15.9 Row Level Security -------------------------------------------------------------------------------------
alter table public.projects               enable row level security;
alter table public.project_members        enable row level security;
alter table public.project_requirements   enable row level security;
alter table public.staffing_requests      enable row level security;
alter table public.staffing_request_items enable row level security;
alter table public.request_comments       enable row level security;

do $$ declare t text; begin
  foreach t in array array['projects', 'project_members', 'project_requirements', 'staffing_requests', 'staffing_request_items', 'request_comments'] loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I as restrictive for all to authenticated
                      using (workspace_id = (select public.current_workspace()))
                      with check (workspace_id = (select public.current_workspace()))', t);
  end loop;
end $$;

drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated
  using ((select public.perm('projects', 'view'))
         or (project_manager = (select auth.uid()) and (select public.pm_perm('projects', 'view')))
         or public.is_project_member(id, (select auth.uid())));
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated with check ((select public.perm('projects', 'edit')));
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using ((select public.perm('projects', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('projects', 'edit'))))
  with check ((select public.perm('projects', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('projects', 'edit'))));
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated
  using ((select public.perm('projects', 'delete')) or (project_manager = (select auth.uid()) and (select public.pm_perm('projects', 'delete'))));

drop policy if exists project_members_read on public.project_members;
create policy project_members_read on public.project_members for select to authenticated
  using (member_id = (select auth.uid()) or public.can_project(project_id, 'view'));

-- Requests: the admin / managers and the Project Manager of that project
drop policy if exists staffing_read on public.staffing_requests;
create policy staffing_read on public.staffing_requests for select to authenticated
  using ((select public.is_manager()) or requested_by = (select auth.uid()) or public.is_project_lead(project_id));
drop policy if exists staffing_items_read on public.staffing_request_items;
create policy staffing_items_read on public.staffing_request_items for select to authenticated
  using (exists (select 1 from public.staffing_requests r where r.id = request_id
                  and ((select public.is_manager()) or r.requested_by = (select auth.uid()) or public.is_project_lead(r.project_id))));
drop policy if exists request_comments_read on public.request_comments;
create policy request_comments_read on public.request_comments for select to authenticated
  using (exists (select 1 from public.staffing_requests r where r.id = request_id
                  and ((select public.is_manager()) or r.requested_by = (select auth.uid()) or public.is_project_lead(r.project_id))));

drop policy if exists requirements_read on public.project_requirements;
create policy requirements_read on public.project_requirements for select to authenticated using (public.can_project(project_id, 'view'));
drop policy if exists requirements_insert on public.project_requirements;
create policy requirements_insert on public.project_requirements for insert to authenticated with check (public.can_manage_project(project_id));
drop policy if exists requirements_update on public.project_requirements;
create policy requirements_update on public.project_requirements for update to authenticated
  using (public.can_manage_project(project_id)) with check (public.can_manage_project(project_id));
drop policy if exists requirements_delete on public.project_requirements;
create policy requirements_delete on public.project_requirements for delete to authenticated using (public.can_manage_project(project_id));

-- Clients: the Project Manager / members of one of its projects see (and a PM edits) the client
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using ((select public.perm('clients', 'view'))
         or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'view')))
         or public.client_via_project(id, 'view'));
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update to authenticated
  using ((select public.perm('clients', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'edit'))) or public.client_via_project(id, 'edit'))
  with check ((select public.perm('clients', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'edit'))) or public.client_via_project(id, 'edit'));

-- Files: client-wide files follow the client; project files follow the project
drop policy if exists files_read on public.client_files;
create policy files_read on public.client_files for select to authenticated
  using (public.can_client(client_id, 'view') or (project_id is not null and public.can_project(project_id, 'view')));
drop policy if exists files_insert on public.client_files;
create policy files_insert on public.client_files for insert to authenticated
  with check (public.can_client(client_id, 'edit') or (project_id is not null and public.can_project(project_id, 'edit')));
drop policy if exists files_delete on public.client_files;
create policy files_delete on public.client_files for delete to authenticated
  using (public.can_client(client_id, 'delete') or (project_id is not null and public.can_project(project_id, 'delete')));

-- Tasks: the Project Manager creates and manages tasks for the project's members
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (assigned_to = (select auth.uid()) or (select public.is_manager())
         or (client_id is not null and public.is_client_pm(client_id))
         or (project_id is not null and public.is_project_pm(project_id)));
drop policy if exists tasks_admin_insert on public.tasks;
create policy tasks_admin_insert on public.tasks for insert to authenticated
  with check ((select public.is_manager())
              or (project_id is not null and public.can_manage_project(project_id)
                  and (assigned_to is null or assigned_to = (select auth.uid()) or public.is_project_member(project_id, assigned_to)))
              or (project_id is null and client_id is not null and public.is_client_pm(client_id)));
drop policy if exists tasks_admin_update on public.tasks;
create policy tasks_admin_update on public.tasks for update to authenticated
  using ((select public.is_manager())
         or (project_id is not null and public.can_manage_project(project_id))
         or (client_id is not null and public.is_client_pm(client_id)))
  with check ((select public.is_manager())
              or (project_id is not null and public.can_manage_project(project_id)
                  and (assigned_to is null or assigned_to = (select auth.uid()) or public.is_project_member(project_id, assigned_to)))
              or (project_id is null and client_id is not null and public.is_client_pm(client_id)));
drop policy if exists tasks_admin_delete on public.tasks;
create policy tasks_admin_delete on public.tasks for delete to authenticated
  using ((select public.is_manager())
         or (project_id is not null and public.can_manage_project(project_id) and created_by = (select auth.uid()))
         or (client_id is not null and public.is_client_pm(client_id) and created_by = (select auth.uid())));

drop policy if exists comments_read on public.task_comments;
create policy comments_read on public.task_comments for select to authenticated using (public.can_see_task(task_id));
drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert to authenticated
  with check (author_id = (select auth.uid()) and public.can_see_task(task_id));

revoke all on public.projects, public.project_members, public.project_requirements, public.staffing_requests,
              public.staffing_request_items, public.request_comments from anon, authenticated;
grant select, insert, delete on public.projects to authenticated;
grant update (name, description, status, project_manager, start_date, due_date, website_url, socials) on public.projects to authenticated;
grant select on public.project_members, public.staffing_requests, public.staffing_request_items, public.request_comments to authenticated;
grant select, insert, delete on public.project_requirements to authenticated;
grant update (title, details, is_done, sort) on public.project_requirements to authenticated;

-- Storage: files live under "<workspace>/<client>/<file>" or "<workspace>/<client>/p<project>/<file>"
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute 'drop policy if exists "client files read" on storage.objects';
    execute 'create policy "client files read" on storage.objects for select to authenticated using (bucket_id = ''client-files'' and public.can_storage_file(name, ''view''))';
    execute 'drop policy if exists "client files upload" on storage.objects';
    execute 'create policy "client files upload" on storage.objects for insert to authenticated with check (bucket_id = ''client-files'' and public.can_storage_file(name, ''edit''))';
    execute 'drop policy if exists "client files delete" on storage.objects';
    execute 'create policy "client files delete" on storage.objects for delete to authenticated using (bucket_id = ''client-files'' and public.can_storage_file(name, ''delete''))';
  end if;
end $$;

-- 15.10 Deleting a person or a workspace also removes this data ---------------------------------------
drop table if exists public.activity_log;   -- the old staffing feed; everything now goes to activity_logs

create or replace function public.purge_person_activity(p_id uuid) returns void
language sql security definer set search_path = public as $$
  delete from public.activity_logs where actor_id = p_id or subject_id = p_id;
$$;
revoke all on function public.purge_person_activity(uuid) from public, anon, authenticated;

create or replace function public.purge_workspace(p_id uuid) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  perform set_config('webnox.purge', 'on', true);
  select coalesce(array_agg(id), '{}') into ids from public.profiles where workspace_id = p_id and is_master = false;
  delete from public.activity_logs        where workspace_id = p_id;
  delete from public.activity_intervals   where workspace_id = p_id;
  delete from public.user_sessions        where workspace_id = p_id;
  delete from public.task_time_entries    where workspace_id = p_id;
  delete from public.task_comments        where workspace_id = p_id;
  delete from public.tasks                where workspace_id = p_id;
  delete from public.client_files         where workspace_id = p_id;
  delete from public.request_comments     where workspace_id = p_id;
  delete from public.staffing_request_items where workspace_id = p_id;
  delete from public.staffing_requests    where workspace_id = p_id;
  delete from public.project_members      where workspace_id = p_id;
  delete from public.project_requirements where workspace_id = p_id;
  delete from public.projects             where workspace_id = p_id;
  delete from public.leads                where workspace_id = p_id;
  delete from public.clients              where workspace_id = p_id;
  delete from public.role_permissions     where workspace_id = p_id;
  delete from public.app_settings         where workspace_id = p_id;
  delete from public.notifications        where workspace_id = p_id;
  delete from public.workspace_roles      where workspace_id = p_id;
  delete from public.subscription_payments where workspace_id = p_id;
  delete from public.subscriptions        where workspace_id = p_id;
  delete from public.billing_log          where workspace_id = p_id;
  delete from public.master_access_log    where workspace_id = p_id;
  delete from public.profiles             where workspace_id = p_id and is_master = false;
  delete from public.workspaces           where id = p_id;
  return ids;
end $$;
revoke all on function public.purge_workspace(uuid) from public, anon, authenticated;

-- 15.11 Functions: who may call what ------------------------------------------------------------------------
revoke execute on function
  public.eco_fill_workspace(), public.project_link_before(), public.projects_before_write(), public.projects_after_write(),
  public.requirements_before_write(), public.requirements_after_write(), public.tasks_notify(), public.files_notify(),
  public.agent_fits(uuid, bigint), public.staffing_label(bigint), public.seed_role_permissions(uuid),
  public.is_project_pm(bigint), public.is_project_lead(bigint), public.is_project_member(bigint, uuid), public.is_client_pm(bigint),
  public.can_project(bigint, text), public.can_manage_project(bigint), public.client_via_project(bigint, text),
  public.can_storage_file(text, text), public.can_see_task(bigint), public.task_review(bigint, boolean, text),
  public.staffing_request_create(bigint, jsonb, text), public.staffing_request_decide(bigint, text, text),
  public.staffing_request_comment(bigint, text), public.project_member_add(bigint, uuid, bigint),
  public.project_member_remove(bigint), public.project_candidates(bigint), public.lead_convert(bigint)
  from public, anon, authenticated;
grant execute on function
  public.is_project_pm(bigint), public.is_project_lead(bigint), public.is_project_member(bigint, uuid), public.is_client_pm(bigint),
  public.can_project(bigint, text), public.can_manage_project(bigint), public.client_via_project(bigint, text),
  public.can_storage_file(text, text), public.can_see_task(bigint), public.task_review(bigint, boolean, text),
  public.staffing_request_create(bigint, jsonb, text), public.staffing_request_decide(bigint, text, text),
  public.staffing_request_comment(bigint, text), public.project_member_add(bigint, uuid, bigint),
  public.project_member_remove(bigint), public.project_candidates(bigint), public.lead_convert(bigint)
  to authenticated;

-- 15.12 One-time move of the first Webnox version's test projects ------------------------------------------
-- Each old project becomes a client (named after its "client" text, or the project) + a project; its
-- staffing requests, slots, comments and team come along. Nothing is notified. Runs only once.
do $$
declare lp record; v_client bigint; v_pid bigint;
begin
  if to_regclass('public.legacy_projects') is null then return; end if;
  alter table public.projects disable trigger projects_after;
  alter table public.clients  disable trigger clients_notify;
  for lp in select * from public.legacy_projects order by created_at loop
    select id into v_client from public.clients
     where workspace_id = lp.workspace_id and lower(name) = lower(coalesce(nullif(btrim(lp.client), ''), lp.name)) limit 1;
    if v_client is null then
      insert into public.clients (workspace_id, name, status, created_by)
      values (lp.workspace_id, coalesce(nullif(btrim(lp.client), ''), lp.name), 'active', lp.created_by) returning id into v_client;
    end if;
    insert into public.projects (workspace_id, client_id, name, description, status, project_manager, created_by, created_at, legacy_id)
    values (lp.workspace_id, v_client, lp.name, coalesce(lp.description, ''), lp.status, lp.manager_id, lp.created_by, lp.created_at, lp.id)
    returning id into v_pid;
  end loop;

  insert into public.staffing_requests (workspace_id, project_id, requested_by, status, note, decided_by, decided_at, decision_note, created_at, legacy_id)
  select r.workspace_id, p.id, r.requested_by, r.status, r.note, r.decided_by, r.decided_at, r.decision_note, r.created_at, r.id
    from public.legacy_staffing_requests r join public.projects p on p.legacy_id = r.project_id;

  insert into public.staffing_request_items (workspace_id, request_id, designation, department, qty, legacy_id)
  select n.workspace_id, n.id, i.designation, i.department, i.qty, i.id
    from public.legacy_staffing_request_items i join public.staffing_requests n on n.legacy_id = i.request_id;

  insert into public.request_comments (workspace_id, request_id, author_id, body, created_at)
  select n.workspace_id, n.id, c.author_id, c.body, c.created_at
    from public.legacy_request_comments c join public.staffing_requests n on n.legacy_id = c.request_id;

  insert into public.project_members (workspace_id, project_id, member_id, item_id, role_label, added_by, added_at)
  select p.workspace_id, p.id, m.user_id, ni.id, coalesce(ni.designation, 'Member'), m.added_by, m.added_at
    from public.legacy_project_members m
    join public.projects p on p.legacy_id = m.project_id
    left join public.staffing_request_items ni on ni.legacy_id = m.item_id
   where m.user_id is distinct from p.project_manager;

  alter table public.projects enable trigger projects_after;
  alter table public.clients  enable trigger clients_notify;
  drop table public.legacy_project_members;
  drop table public.legacy_request_comments;
  drop table public.legacy_staffing_request_items;
  drop table public.legacy_staffing_requests;
  drop table public.legacy_projects;
end $$;

drop function if exists public.project_manager_guard();
drop function if exists public.project_member_guard();

-- ============================================================================
-- PART 16 — Finance (expenses, bills, salaries, investments) + Invoices, inside every workspace
-- ============================================================================
-- Run once in the Supabase SQL Editor (after PART 15). Safe to run again.
--
--   * Admin and Manager: everything (salaries are visible only to them).
--   * Finance role and Project Managers: what the Admin allows on the Permissions page (module "finance").
--   * Money is stored as currency + original amount + exchange rate; the converted amount (workspace
--     currency) is calculated by the database, never by the browser.
--   * Invoice numbers, reference numbers and totals are made by the database.
--   * Every row belongs to one workspace; a person of another workspace can never see or touch it.

-- 16.1 Small helpers ------------------------------------------------------------------------------
create or replace function public.num_pad(p bigint, w int) returns text
language sql immutable as $$
  select case when length(p::text) >= w then p::text else lpad(p::text, w, '0') end;
$$;

-- "Him Fashions" -> HF, "Glow" -> GW (first + last letter), "" -> CL
create or replace function public.name_initials(p_name text) returns text
language plpgsql immutable as $$
declare w text[]; l text;
begin
  w := array_remove(regexp_split_to_array(upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9]+', ' ', 'g')), ' '), '');
  l := array_to_string(w, '');
  if l = '' then return 'CL'; end if;
  if array_length(w, 1) >= 2 then return left(w[1], 1) || left(w[2], 1); end if;
  if length(l) = 1 then return l || 'X'; end if;
  return left(l, 1) || right(l, 1);
end $$;

create or replace function public.is_manager_id(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select account_type in ('admin', 'manager') and status = 'active'
                     from public.profiles where id = p_id and workspace_id = public.current_workspace()), false);
$$;

-- "Co-Founder", or "Admin", or the team roles
create or replace function public.issuer_title(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(p.job_title), ''), case when p.account_type = 'admin' then 'Admin' end,
                  (select string_agg(r.name, ', ' order by r.sort) from public.member_roles m join public.team_roles r on r.key = m.role_key where m.member_id = p.id))
    from public.profiles p where p.id = p_id and p.workspace_id = public.current_workspace();
$$;

-- 16.2 Clients get a short invoice code (unique inside the workspace) ---------------------------------
alter table public.clients add column if not exists invoice_code text;
create unique index if not exists clients_invoice_code_uq on public.clients (workspace_id, invoice_code);

-- A code no other client of this workspace has, built from the name
create or replace function public.invoice_initials(p_ws uuid, p_name text, p_exclude bigint default null) returns text
language plpgsql security definer set search_path = public as $$
declare w text[]; l text; c text; cands text[] := '{}'; i int; j int; n int := 2;
begin
  w := array_remove(regexp_split_to_array(upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9]+', ' ', 'g')), ' '), '');
  l := left(array_to_string(w, ''), 24);
  if l = '' then l := 'CL'; w := array['CL']; end if;
  if length(l) = 1 then l := l || 'X'; end if;
  cands := cands || name_initials(p_name);
  cands := cands || (left(l, 1) || right(l, 1));
  for i in 2..length(l) loop cands := cands || (left(l, 1) || substr(l, i, 1)); end loop;
  if array_length(w, 1) >= 3 then cands := cands || (left(w[1], 1) || left(w[2], 1) || left(w[3], 1)); end if;
  for i in 2..length(l) loop for j in i + 1..length(l) loop
    cands := cands || (left(l, 1) || substr(l, i, 1) || substr(l, j, 1));
  end loop; end loop;
  foreach c in array cands loop
    if not exists (select 1 from public.clients where workspace_id = p_ws and invoice_code = c and id is distinct from p_exclude) then return c; end if;
  end loop;
  loop
    c := cands[1] || n;
    if not exists (select 1 from public.clients where workspace_id = p_ws and invoice_code = c and id is distinct from p_exclude) then return c; end if;
    n := n + 1;
  end loop;
end $$;

create or replace function public.clients_codes_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then new.invoice_code := null; else new.invoice_code := old.invoice_code; end if;  -- never changes once given
  if new.invoice_code is null then
    perform pg_advisory_xact_lock(hashtext('invcode:' || new.workspace_id::text));
    new.invoice_code := invoice_initials(new.workspace_id, new.name, new.id);
  end if;
  return new;
end $$;
drop trigger if exists zz_clients_codes on public.clients;
create trigger zz_clients_codes before insert or update on public.clients
  for each row execute function public.clients_codes_before();

-- Existing clients, oldest first (quietly, nobody is notified)
do $$ declare r record; begin
  if exists (select 1 from public.clients where invoice_code is null) then
    alter table public.clients disable trigger clients_notify;
    for r in select id from public.clients where invoice_code is null order by id loop
      update public.clients set invoice_code = null where id = r.id;
    end loop;
    alter table public.clients enable trigger clients_notify;
  end if;
end $$;

-- Company details printed on every invoice (address, email, phone, website, bank / payment details, terms)
alter table public.app_settings add column if not exists invoice_details jsonb not null default '{}'::jsonb
  check (jsonb_typeof(invoice_details) = 'object');
grant update (invoice_details) on public.app_settings to authenticated;

-- 16.3 Tables -----------------------------------------------------------------------------------------
create table if not exists public.recurring_expenses (
  id                    bigint generated always as identity primary key,
  workspace_id          uuid not null references public.workspaces(id),
  title                 text not null check (char_length(title) between 1 and 200),
  category              text not null default 'tools',
  currency              text,
  amount_original       numeric(14, 2),
  fx_rate               numeric(20, 10),
  amount                numeric(12, 2) not null check (amount >= 0),
  frequency             text not null default 'monthly' check (frequency in ('once', 'weekly', 'monthly', 'quarterly', 'yearly')),
  next_due              date not null,
  vendor                text,
  payee_member          uuid references public.profiles(id) on delete set null,
  auto_post             boolean not null default false,
  remind_days           int not null default 3 check (remind_days between 0 and 30),
  active                boolean not null default true,
  notes                 text not null default '',
  attachments           jsonb not null default '[]'::jsonb,
  reminded_upcoming_for date,
  reminded_due_for      date,
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists recurring_ws_due_idx on public.recurring_expenses (workspace_id, active, next_due);

create table if not exists public.expenses (
  id              bigint generated always as identity primary key,
  workspace_id    uuid not null references public.workspaces(id),
  title           text not null check (char_length(title) between 1 and 200),
  category        text not null default 'other',
  currency        text,
  amount_original numeric(14, 2),
  fx_rate         numeric(20, 10),
  amount          numeric(12, 2) not null check (amount >= 0),
  spent_on        date not null default current_date,
  vendor          text,
  notes           text not null default '',
  attachments     jsonb not null default '[]'::jsonb,
  paid_by         uuid references public.profiles(id) on delete set null,
  payee_member    uuid references public.profiles(id) on delete set null,
  recurring_id    bigint references public.recurring_expenses(id) on delete set null,
  period          date,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists expenses_ws_spent_idx on public.expenses (workspace_id, spent_on desc);
create index if not exists expenses_ws_category_idx on public.expenses (workspace_id, category, spent_on);
create unique index if not exists expenses_recurring_period_uq on public.expenses (recurring_id, period) where recurring_id is not null;

create table if not exists public.investments (
  id              bigint generated always as identity primary key,
  workspace_id    uuid not null references public.workspaces(id),
  source          text not null check (char_length(source) between 1 and 200),
  investor_id     uuid references public.profiles(id) on delete set null,
  kind            text not null default 'capital' check (kind in ('capital', 'loan', 'grant', 'other')),
  currency        text,
  amount_original numeric(14, 2),
  fx_rate         numeric(20, 10),
  amount          numeric(12, 2) not null check (amount >= 0),
  invested_on     date not null default current_date,
  notes           text not null default '',
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists investments_ws_date_idx on public.investments (workspace_id, invested_on desc);

create table if not exists public.finance_report_log (
  workspace_id uuid not null references public.workspaces(id),
  month        date not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, month)
);

create table if not exists public.invoices (
  id              bigint generated always as identity primary key,
  workspace_id    uuid not null references public.workspaces(id),
  kind            text not null default 'client' check (kind in ('client', 'business')),
  client_id       bigint references public.clients(id) on delete cascade,
  project_id      bigint references public.projects(id) on delete set null,
  invoice_number  text,
  reference_no    text,
  description     text not null default '',
  bill_to         jsonb not null default '{}'::jsonb check (jsonb_typeof(bill_to) = 'object'),
  items           jsonb not null default '[]'::jsonb,
  tax_percent     numeric(6, 2) not null default 0,
  discount        numeric(14, 2) not null default 0,
  notes           text not null default '',
  billing_period  text not null default '' check (length(billing_period) <= 80),
  currency        text,
  amount_original numeric(14, 2),
  fx_rate         numeric(20, 10),
  amount          numeric(12, 2) not null check (amount >= 0),
  issue_date      date not null default current_date,
  due_date        date,
  status          text not null default 'sent' check (status in ('draft', 'sent', 'paid', 'cancelled')),
  paid_date       date,
  issued_by       uuid references public.profiles(id) on delete set null,
  issued_by_name  text,
  issued_by_title text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (tax_percent between 0 and 100 and discount >= 0),
  check ((kind = 'client') = (client_id is not null))
);
create index if not exists invoices_ws_idx on public.invoices (workspace_id, kind, issue_date desc);
create index if not exists invoices_client_idx on public.invoices (client_id);
create index if not exists invoices_project_idx on public.invoices (project_id);
create index if not exists invoices_status_idx on public.invoices (workspace_id, status, paid_date);

-- Next number per client / per workspace (written only by the database)
create table if not exists public.invoice_counters (
  workspace_id uuid not null references public.workspaces(id),
  key          text not null,
  last         int  not null default 0,
  primary key (workspace_id, key)
);

-- Rows get their workspace from the person (or the client) that creates them
do $$ declare d record; begin
  for d in select * from (values
    ('recurring_expenses', 'created_by', 'profile'), ('expenses', 'created_by', 'profile'),
    ('investments', 'created_by', 'profile'), ('finance_report_log', 'workspace_id', 'profile'),
    ('invoices', 'client_id', 'client')) as x(t, col, kind) loop
    execute format('drop trigger if exists aa_ws_fill on public.%I', d.t);
    execute format('create trigger aa_ws_fill before insert on public.%I for each row execute function public.eco_fill_workspace(%L, %L)', d.t, d.col, d.kind);
  end loop;
end $$;

-- Invoices follow the client's project link like tasks and files do
do $$ declare t text; begin
  foreach t in array array['tasks', 'client_files', 'invoices'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_project_link', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.project_link_before()', t || '_project_link', t);
  end loop;
end $$;

-- 16.4 Who may do what ---------------------------------------------------------------------------------
-- Finance permission; salaries only for the Admin / Managers
create or replace function public.can_money(p_category text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select perm('finance', p_action) and (p_category is distinct from 'salary' or is_manager());
$$;

-- Invoices follow the Finance permission (a Project Manager only if their role allows Finance)
create or replace function public.can_invoice(p_client bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select perm('finance', p_action) or exists (select 1 from clients c where c.id = p_client and c.workspace_id = current_workspace()
                   and c.project_manager = auth.uid() and pm_perm('finance', p_action));
$$;

create or replace function public.can_project_invoice(p_project bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_project is not null
     and exists (select 1 from projects where id = p_project and workspace_id = current_workspace() and project_manager = auth.uid())
     and pm_perm('finance', p_action);
$$;

create or replace function public.fmt_money(p numeric) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select currency from app_settings where workspace_id = current_workspace()), 'USD') || ' ' || to_char(round(coalesce(p, 0)), 'FM999,999,999,990');
$$;

create or replace function public.advance_due(p_date date, p_freq text) returns date
language sql immutable as $$
  select case p_freq when 'once' then p_date
                     when 'weekly' then p_date + 7
                     when 'quarterly' then (p_date + interval '3 months')::date
                     when 'yearly' then (p_date + interval '1 year')::date
                     else (p_date + interval '1 month')::date end;
$$;

-- Tells the Admin, the Managers and (unless it is about salaries) the Finance team. Not skipped for the actor:
-- these are reminders, not "someone did something".
create or replace function public.notify_finance_people(p_ws uuid, p_salary boolean, p_title text, p_body text, p_link text)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select p.id from profiles p
            where p.workspace_id = p_ws and p.status = 'active'
              and (p.account_type in ('admin', 'manager')
                   or (not p_salary and exists (select 1 from member_roles m join workspace_roles wr on wr.workspace_id = p.workspace_id and wr.role_key = m.role_key and wr.active
                                                 where m.member_id = p.id and m.role_key = 'finance'))) loop
    insert into notifications (workspace_id, user_id, kind, title, body, link, text)
    values (p_ws, r.id, 'finance', left(p_title, 200), left(coalesce(p_body, ''), 500), p_link, left(p_title, 200));
  end loop;
end $$;

-- 16.5 Money rows: validation, currency, audit ---------------------------------------------------------
create or replace function public.finance_money_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_base text := upper(coalesce((select currency from app_settings where workspace_id = new.workspace_id), 'USD'));
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  else
    new.workspace_id := old.workspace_id; new.created_by := old.created_by; new.created_at := old.created_at;
    -- an older screen changed only the converted amount: keep the original in step
    if new.amount is distinct from old.amount and new.amount_original is not distinct from old.amount_original then
      new.amount_original := round(new.amount / nullif(coalesce(new.fx_rate, 1), 0), 2);
    end if;
  end if;
  new.updated_at := now();

  -- everyone named on the row must be in this workspace
  if tg_table_name = 'investments' then
    if new.investor_id is not null and not exists (select 1 from profiles where id = new.investor_id and workspace_id = new.workspace_id) then
      raise exception 'That person is not in this workspace'; end if;
  else
    if new.payee_member is not null and not exists (select 1 from profiles where id = new.payee_member and workspace_id = new.workspace_id) then
      raise exception 'That person is not in this workspace'; end if;
  end if;
  if tg_table_name = 'expenses' then
    if new.paid_by is not null and not exists (select 1 from profiles where id = new.paid_by and workspace_id = new.workspace_id) then
      raise exception 'That person is not in this workspace'; end if;
    if new.recurring_id is not null and not exists (select 1 from recurring_expenses where id = new.recurring_id and workspace_id = new.workspace_id) then
      raise exception 'Bill not found'; end if;
  end if;
  if tg_table_name = 'recurring_expenses' then
    if new.category = 'salary' and new.payee_member is null then raise exception 'Pick the team member this salary is for'; end if;
  end if;

  new.currency := upper(coalesce(nullif(trim(new.currency), ''), v_base));
  if new.currency !~ '^[A-Z]{3}$' then raise exception 'Pick a valid currency'; end if;
  new.amount_original := coalesce(new.amount_original, new.amount);
  if new.amount_original is null or new.amount_original < 0 then raise exception 'Enter the amount'; end if;
  if new.currency = v_base then
    new.fx_rate := 1;
  elsif new.fx_rate is null or new.fx_rate <= 0 then
    raise exception 'Add the exchange rate from % to %', new.currency, v_base;
  end if;
  new.amount := round(new.amount_original * new.fx_rate, 2);
  return new;
end $$;

create or replace function public.finance_money_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_who text := coalesce(member_name(auth.uid()), 'System'); v_sal boolean;
begin
  if tg_table_name = 'expenses' then
    v_sal := coalesce(new.category, old.category) = 'salary';
    if tg_op = 'INSERT' then
      perform log_event('expense_added', 'finance', new.id::text,
        case when v_sal then 'Recorded a salary payment' else 'Added expense "' || new.title || '" (' || fmt_money(new.amount) || ')' end);
      if new.recurring_id is null and auth.uid() is not null and not v_sal then
        perform notify_managers('finance', 'New expense: ' || new.title || ' ' || fmt_money(new.amount), 'By ' || v_who, '#/finance?tab=expenses');
      end if;
    elsif tg_op = 'UPDATE' then
      perform log_event('expense_updated', 'finance', new.id::text, case when v_sal then 'Updated a salary payment' else 'Updated expense "' || new.title || '"' end);
    else
      perform log_event('expense_deleted', 'finance', old.id::text, case when v_sal then 'Deleted a salary payment' else 'Deleted expense "' || old.title || '"' end);
    end if;
  elsif tg_table_name = 'recurring_expenses' then
    v_sal := coalesce(new.category, old.category) = 'salary';
    if tg_op = 'INSERT' then
      perform log_event('recurring_added', 'finance', new.id::text, case when v_sal then 'Added a monthly salary' else 'Added recurring bill "' || new.title || '"' end);
    elsif tg_op = 'DELETE' then
      perform log_event('recurring_deleted', 'finance', old.id::text, case when v_sal then 'Removed a salary' else 'Removed recurring bill "' || old.title || '"' end);
    end if;
  elsif tg_table_name = 'investments' then
    if tg_op = 'INSERT' then
      perform log_event('investment_added', 'finance', new.id::text, 'Added investment from ' || new.source || ' (' || fmt_money(new.amount) || ')');
      perform notify_managers('finance', 'New investment: ' || fmt_money(new.amount) || ' from ' || new.source, 'By ' || v_who, '#/finance?tab=investments');
    elsif tg_op = 'DELETE' then
      perform log_event('investment_deleted', 'finance', old.id::text, 'Deleted investment from ' || old.source);
    end if;
  end if;
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['expenses', 'recurring_expenses', 'investments'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_before', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.finance_money_before()', t || '_before', t);
    execute format('drop trigger if exists %I on public.%I', t || '_after', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.finance_money_after()', t || '_after', t);
  end loop;
end $$;

-- Attachments: only files of this very row, only PDF / images, up to 10
create or replace function public.finance_attachments_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_prefix text := new.workspace_id::text || '/' || case when tg_table_name = 'expenses' then 'expense/' else 'bill/' end || new.id || '/'; v_item jsonb;
begin
  new.attachments := coalesce(new.attachments, '[]'::jsonb);
  if jsonb_typeof(new.attachments) <> 'array' then raise exception 'Attachments are not valid'; end if;
  if jsonb_array_length(new.attachments) > 10 then raise exception 'You can attach up to 10 files'; end if;
  for v_item in select value from jsonb_array_elements(new.attachments) loop
    if jsonb_typeof(v_item) <> 'object' or coalesce(v_item ->> 'path', '') not like v_prefix || '%'
       or position('..' in v_item ->> 'path') > 0 or coalesce(trim(v_item ->> 'name'), '') = '' then
      raise exception 'Attachments are not valid';
    end if;
    if coalesce(v_item ->> 'type', '') not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
      raise exception 'Attach a PDF or an image (PNG, JPG, WEBP)';
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists expenses_attachments on public.expenses;
create trigger expenses_attachments before insert or update of attachments on public.expenses for each row execute function public.finance_attachments_check();
drop trigger if exists recurring_attachments on public.recurring_expenses;
create trigger recurring_attachments before insert or update of attachments on public.recurring_expenses for each row execute function public.finance_attachments_check();

-- Storage: <workspace>/expense/<id>/<file> or <workspace>/bill/<id>/<file> -> the same rule as the row itself
create or replace function public.can_finance_file(p_name text, p_action text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare p text[] := string_to_array(coalesce(p_name, ''), '/'); v_cat text;
begin
  if array_length(p, 1) <> 4 or p[1] is distinct from current_workspace()::text or p[3] !~ '^\d{1,18}$' or p[4] = '' then return false; end if;
  if p[2] = 'expense' then select category into v_cat from expenses where id = p[3]::bigint and workspace_id = current_workspace();
  elsif p[2] = 'bill' then select category into v_cat from recurring_expenses where id = p[3]::bigint and workspace_id = current_workspace();
  else return false; end if;
  if not found then return false; end if;
  return can_money(v_cat, p_action);
end $$;

-- 16.6 Bills: pay / skip ---------------------------------------------------------------------------------
-- Internal: records the expense for the bill's current due date (in the bill's currency) and moves it on
create or replace function public.recurring_post(p_id bigint, p_amount numeric, p_paid_on date) returns bigint
language plpgsql security definer set search_path = public as $$
declare r recurring_expenses%rowtype; v_id bigint;
begin
  select * into r from recurring_expenses where id = p_id and workspace_id = current_workspace() for update;
  if not found then raise exception 'Bill not found'; end if;
  insert into expenses (workspace_id, title, category, currency, amount_original, fx_rate, amount, spent_on, vendor, payee_member, recurring_id, period, notes)
  values (r.workspace_id, r.title, r.category, r.currency, coalesce(p_amount, r.amount_original, r.amount), r.fx_rate,
          round(coalesce(p_amount, r.amount_original, r.amount) * coalesce(r.fx_rate, 1), 2),
          coalesce(p_paid_on, r.next_due), r.vendor, r.payee_member, r.id, r.next_due,
          case r.frequency when 'once' then 'One-time payment' when 'monthly' then 'For ' || to_char(r.next_due, 'Mon YYYY') else 'Due ' || to_char(r.next_due, 'DD Mon YYYY') end)
  on conflict (recurring_id, period) where recurring_id is not null do nothing
  returning id into v_id;
  if r.frequency = 'once' then
    update recurring_expenses set active = false where id = p_id;      -- paying a one-time bill closes it
  else
    update recurring_expenses set next_due = advance_due(r.next_due, r.frequency) where id = p_id;
  end if;
  return v_id;
end $$;

create or replace function public.recurring_mark_paid(p_id bigint, p_amount numeric default null, p_paid_on date default null, p_fx_rate numeric default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r recurring_expenses%rowtype; v_id bigint;
begin
  select * into r from recurring_expenses where id = p_id and workspace_id = current_workspace() for update;
  if not found then raise exception 'Bill not found'; end if;
  if not can_money(r.category, 'edit') then raise exception 'You don''t have permission to record this payment'; end if;
  if p_amount is not null and p_amount < 0 then raise exception 'Amount can''t be negative'; end if;
  if p_fx_rate is not null then
    if p_fx_rate <= 0 then raise exception 'The exchange rate must be above zero'; end if;
    update recurring_expenses set fx_rate = p_fx_rate where id = p_id;
  end if;
  v_id := recurring_post(p_id, p_amount, coalesce(p_paid_on, (now() at time zone app_tz())::date));
  perform log_event('recurring_paid', 'finance', p_id::text,
    case when r.category = 'salary' then 'Paid salary of ' || coalesce(member_name(r.payee_member), 'a member') || ' for ' || to_char(r.next_due, 'Mon YYYY')
         else 'Paid "' || r.title || '" due ' || to_char(r.next_due, 'DD Mon YYYY') end);
  return v_id;
end $$;

create or replace function public.recurring_skip(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r recurring_expenses%rowtype;
begin
  select * into r from recurring_expenses where id = p_id and workspace_id = current_workspace() for update;
  if not found then raise exception 'Bill not found'; end if;
  if not can_money(r.category, 'edit') then raise exception 'You don''t have permission to change this bill'; end if;
  if r.frequency = 'once' then raise exception 'A one-time bill can''t be skipped. Delete it instead.'; end if;
  update recurring_expenses set next_due = advance_due(r.next_due, r.frequency) where id = p_id;
  perform log_event('recurring_skipped', 'finance', p_id::text, 'Skipped ' || case when r.category = 'salary' then 'a salary' else '"' || r.title || '"' end || ' due ' || to_char(r.next_due, 'DD Mon YYYY'));
end $$;

-- 16.7 Reminders, auto charges and the monthly report notice --------------------------------------------
-- Safe to call any number of times (the app calls it when someone opens it); each step happens once.
create or replace function public.finance_sweep() returns int
language plpgsql security definer set search_path = public as $$
declare r recurring_expenses%rowtype; v_ws uuid := current_workspace(); v_today date := (now() at time zone app_tz())::date; n int := 0; g int;
        v_sal boolean; v_label text; v_prev date; v_rev numeric; v_exp numeric; v_link text := '#/finance?tab=recurring';
begin
  if auth.uid() is not null then perform assert_active(); end if;
  if v_ws is null then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('webnox_finance_sweep:' || v_ws::text));
  for r in select * from recurring_expenses where workspace_id = v_ws and active and next_due <= v_today + remind_days order by next_due loop
    v_sal := r.category = 'salary';
    v_label := case when v_sal then 'Salary: ' || coalesce(member_name(r.payee_member), r.title) else r.title end;
    if r.auto_post and r.next_due <= v_today then
      g := 0;
      while r.next_due <= v_today and r.active and g < 24 loop
        perform recurring_post(r.id, null, r.next_due);
        perform notify_finance_people(v_ws, v_sal, 'Charged: ' || v_label || ' ' || fmt_money(r.amount),
          'Recorded as an expense for ' || to_char(r.next_due, 'DD Mon YYYY'), '#/finance?tab=expenses');
        select * into r from recurring_expenses where id = r.id;
        g := g + 1; n := n + 1;
      end loop;
    elsif r.next_due <= v_today then
      if r.reminded_due_for is distinct from r.next_due then
        perform notify_finance_people(v_ws, v_sal, case when r.next_due < v_today then 'Overdue: ' else 'Due today: ' end || v_label || ' ' || fmt_money(r.amount),
          'Was due ' || to_char(r.next_due, 'DD Mon YYYY') || '. Mark it paid in Finance.', v_link);
        update recurring_expenses set reminded_due_for = r.next_due where id = r.id;
        n := n + 1;
      end if;
    elsif r.reminded_upcoming_for is distinct from r.next_due then
      perform notify_finance_people(v_ws, v_sal, 'Coming up: ' || v_label || ' ' || fmt_money(r.amount),
        'Due ' || to_char(r.next_due, 'DD Mon YYYY') || ' (in ' || (r.next_due - v_today) || ' days)' || case when r.auto_post then '. Charged automatically.' else '' end, v_link);
      update recurring_expenses set reminded_upcoming_for = r.next_due where id = r.id;
      n := n + 1;
    end if;
  end loop;

  -- Last month's report, once, if there is any money data at all
  v_prev := (date_trunc('month', v_today) - interval '1 month')::date;
  if not exists (select 1 from finance_report_log where workspace_id = v_ws and month = v_prev)
     and (exists (select 1 from expenses where workspace_id = v_ws) or exists (select 1 from invoices where workspace_id = v_ws)
          or exists (select 1 from investments where workspace_id = v_ws)) then
    insert into finance_report_log (workspace_id, month) values (v_ws, v_prev) on conflict do nothing;
    select coalesce(sum(amount), 0) into v_rev from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= v_prev and paid_date < (v_prev + interval '1 month')::date;
    select coalesce(sum(amount), 0) into v_exp from expenses where workspace_id = v_ws and spent_on >= v_prev and spent_on < (v_prev + interval '1 month')::date;
    perform notify_finance_people(v_ws, false, 'Finance report ready: ' || to_char(v_prev, 'FMMonth YYYY'),
      'Revenue ' || fmt_money(v_rev) || ', expenses ' || fmt_money(v_exp) || ', ' || case when v_rev - v_exp >= 0 then 'profit ' else 'loss ' end || fmt_money(abs(v_rev - v_exp)),
      '#/finance?tab=report&month=' || to_char(v_prev, 'YYYY-MM'));
    n := n + 1;
  end if;
  return n;
end $$;

-- 16.8 Numbers for the dashboards and the monthly report -------------------------------------------------
create or replace function public.finance_overview() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := current_workspace(); v_today date := (now() at time zone app_tz())::date; v_m date; v_sal boolean := is_manager(); r jsonb;
        v_inv numeric; v_rev numeric; v_exp numeric; v_burn numeric;
begin
  if not perm('finance', 'view') then raise exception 'You don''t have access to finance'; end if;
  v_m := date_trunc('month', v_today)::date;
  select coalesce(sum(amount), 0) into v_inv from investments where workspace_id = v_ws;
  select coalesce(sum(amount), 0) into v_rev from invoices where workspace_id = v_ws and status = 'paid';
  select coalesce(sum(amount), 0) into v_exp from expenses where workspace_id = v_ws and (v_sal or category <> 'salary');
  select coalesce(sum(amount), 0) / 3 into v_burn from expenses where workspace_id = v_ws and (v_sal or category <> 'salary')
     and spent_on >= (v_m - interval '3 months')::date and spent_on < v_m;
  select jsonb_build_object(
    'currency', (select currency from app_settings where workspace_id = v_ws),
    'month', to_char(v_m, 'YYYY-MM'),
    'revenue_month', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= v_m), 0),
    'expenses_month', coalesce((select sum(amount) from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on >= v_m), 0),
    'revenue_last', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= (v_m - interval '1 month')::date and paid_date < v_m), 0),
    'expenses_last', coalesce((select sum(amount) from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on >= (v_m - interval '1 month')::date and spent_on < v_m), 0),
    'invested_total', v_inv, 'revenue_total', v_rev, 'expenses_total', v_exp, 'cash', v_inv + v_rev - v_exp,
    'burn', round(v_burn, 2), 'runway_months', case when v_burn > 0 then round((v_inv + v_rev - v_exp) / v_burn, 1) end,
    'outstanding', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'sent'), 0),
    'monthly_fixed', coalesce((select sum(case frequency when 'weekly' then amount * 52 / 12 when 'quarterly' then amount / 3 when 'yearly' then amount / 12 when 'once' then 0 else amount end)
                                 from recurring_expenses where workspace_id = v_ws and active and (v_sal or category <> 'salary')), 0),
    'salaries_monthly', case when v_sal then coalesce((select sum(case frequency when 'weekly' then amount * 52 / 12 when 'quarterly' then amount / 3 when 'yearly' then amount / 12 when 'once' then 0 else amount end)
                                 from recurring_expenses where workspace_id = v_ws and active and category = 'salary'), 0) end,
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
                 'revenue', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= m and paid_date < m + interval '1 month'), 0),
                 'expenses', coalesce((select sum(amount) from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on >= m and spent_on < m + interval '1 month'), 0)) order by m), '[]'::jsonb)
               from generate_series(v_m - interval '11 months', v_m, interval '1 month') m),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'total', t) order by t desc), '[]'::jsonb)
               from (select category, sum(amount) t from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on >= v_m group by category) x),
    'upcoming', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', case when category = 'salary' then 'Salary: ' || coalesce(member_name(payee_member), title) else title end,
                 'category', category, 'amount', amount, 'next_due', next_due, 'auto_post', auto_post) order by next_due), '[]'::jsonb)
               from recurring_expenses where workspace_id = v_ws and active and next_due <= v_today + 30 and (category <> 'salary' or v_sal))
  ) into r;
  return r;
end $$;

create or replace function public.finance_report(p_month date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := current_workspace(); v_from date := date_trunc('month', p_month)::date; v_to date; v_prev date; v_sal boolean := is_manager(); r jsonb;
        v_rev numeric; v_exp numeric;
begin
  if not perm('finance', 'view') then raise exception 'You don''t have access to finance'; end if;
  v_to := (v_from + interval '1 month')::date; v_prev := (v_from - interval '1 month')::date;
  select coalesce(sum(amount), 0) into v_rev from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= v_from and paid_date < v_to;
  select coalesce(sum(amount), 0) into v_exp from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on >= v_from and spent_on < v_to;
  select jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'), 'currency', (select currency from app_settings where workspace_id = v_ws), 'show_salaries', v_sal,
    'revenue', v_rev, 'expenses', v_exp, 'net', v_rev - v_exp,
    'salaries', case when v_sal then coalesce((select sum(amount) from expenses where workspace_id = v_ws and category = 'salary' and spent_on >= v_from and spent_on < v_to), 0) else 0 end,
    'invoiced', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status in ('sent', 'paid') and issue_date >= v_from and issue_date < v_to), 0),
    'investments', coalesce((select sum(amount) from investments where workspace_id = v_ws and invested_on >= v_from and invested_on < v_to), 0),
    'cash_end', coalesce((select sum(amount) from investments where workspace_id = v_ws and invested_on < v_to), 0)
              + coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid' and paid_date < v_to), 0)
              - coalesce((select sum(amount) from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on < v_to), 0),
    'prev', jsonb_build_object(
      'revenue', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= v_prev and paid_date < v_from), 0),
      'expenses', coalesce((select sum(amount) from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on >= v_prev and spent_on < v_from), 0)),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'total', t, 'count', c) order by t desc), '[]'::jsonb)
               from (select category, sum(amount) t, count(*) c from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on >= v_from and spent_on < v_to group by category) x),
    'expense_rows', (select coalesce(jsonb_agg(jsonb_build_object('title', title, 'category', category, 'amount', amount, 'spent_on', spent_on, 'vendor', vendor,
                 'payee', case when v_sal then member_name(payee_member) end) order by spent_on, id), '[]'::jsonb)
               from expenses where workspace_id = v_ws and (v_sal or category <> 'salary') and spent_on >= v_from and spent_on < v_to),
    'revenue_rows', (select coalesce(jsonb_agg(jsonb_build_object('client', coalesce(c.name, nullif(i.bill_to ->> 'company', ''), i.bill_to ->> 'name'), 'kind', i.kind,
                 'invoice', coalesce(i.invoice_number, '#' || i.id), 'amount', i.amount, 'paid_date', i.paid_date) order by i.paid_date), '[]'::jsonb)
               from invoices i left join clients c on c.id = i.client_id where i.workspace_id = v_ws and i.status = 'paid' and i.paid_date >= v_from and i.paid_date < v_to),
    'investment_rows', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'kind', kind, 'amount', amount, 'invested_on', invested_on) order by invested_on), '[]'::jsonb)
               from investments where workspace_id = v_ws and invested_on >= v_from and invested_on < v_to)
  ) into r;
  return r;
end $$;

-- The business numbers on the Admin / Manager dashboard
create or replace function public.business_summary() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := current_workspace(); v_tz text := app_tz(); v_today date := (now() at time zone app_tz())::date; v_month date; r jsonb;
begin
  if not (perm('finance', 'view') or is_manager()) then raise exception 'You don''t have access to finance'; end if;
  v_month := date_trunc('month', v_today)::date;
  select jsonb_build_object(
    'currency', (select currency from app_settings where workspace_id = v_ws),
    'revenue_month', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= v_month), 0),
    'revenue_last_month', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= (v_month - interval '1 month')::date and paid_date < v_month), 0),
    'revenue_total', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid'), 0),
    'outstanding', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'sent'), 0),
    'overdue_count', (select count(*) from invoices where workspace_id = v_ws and status = 'sent' and due_date < v_today),
    'overdue_amount', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'sent' and due_date < v_today), 0),
    'mrr', coalesce((select sum(monthly_retainer) from clients where workspace_id = v_ws and status in ('onboarding', 'active')), 0),
    'active_clients', (select count(*) from clients where workspace_id = v_ws and status in ('onboarding', 'active')),
    'leads_open', (select count(*) from leads where workspace_id = v_ws and status not in ('won', 'lost')),
    'leads_month', (select count(*) from leads where workspace_id = v_ws and (created_at at time zone v_tz)::date >= v_month),
    'won_month', (select count(*) from leads where workspace_id = v_ws and status = 'won' and (won_at at time zone v_tz)::date >= v_month),
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
                 'revenue', coalesce((select sum(amount) from invoices where workspace_id = v_ws and status = 'paid' and paid_date >= m and paid_date < m + interval '1 month'), 0)) order by m), '[]'::jsonb)
                 from generate_series(v_month - interval '11 months', v_month, interval '1 month') m)
  ) into r;
  return r;
end $$;

-- 16.9 Invoices: numbers, totals, currency, audit -------------------------------------------------------
-- Runs after the project link (alphabetical trigger order): number, totals, currency, issuer
create or replace function public.invoices_details_before() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_base text := upper(coalesce((select currency from app_settings where workspace_id = new.workspace_id), 'USD'));
        v_item jsonb; v_sub numeric := 0; v_code text; v_seq int; v_qty numeric; v_rate numeric;
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  else
    new.workspace_id := old.workspace_id; new.created_by := old.created_by; new.created_at := old.created_at;
    new.kind := old.kind;
    new.invoice_number := coalesce(old.invoice_number, new.invoice_number);
    new.reference_no := old.reference_no;
    new.issued_by := old.issued_by; new.issued_by_name := old.issued_by_name; new.issued_by_title := old.issued_by_title;
  end if;
  new.updated_at := now();
  if new.status = 'paid' and new.paid_date is null then new.paid_date := (now() at time zone app_tz())::date; end if;
  if new.status <> 'paid' then new.paid_date := null; end if;

  new.kind := coalesce(new.kind, 'client');
  if new.kind = 'business' then
    new.client_id := null; new.project_id := null;
    new.bill_to := coalesce(new.bill_to, '{}'::jsonb);
    if coalesce(trim(new.bill_to ->> 'name'), '') = '' then raise exception 'Enter who this invoice is for'; end if;
  elsif new.client_id is null then
    raise exception 'Choose a client';
  elsif not exists (select 1 from clients where id = new.client_id and workspace_id = new.workspace_id) then
    raise exception 'Client not found';
  end if;

  -- line items -> total (discount first, then tax)
  new.items := coalesce(new.items, '[]'::jsonb);
  if jsonb_typeof(new.items) <> 'array' then raise exception 'Line items are not valid'; end if;
  if jsonb_array_length(new.items) > 100 then raise exception 'An invoice can have up to 100 lines'; end if;
  new.tax_percent := coalesce(new.tax_percent, 0); new.discount := coalesce(new.discount, 0);
  if jsonb_array_length(new.items) > 0 then
    for v_item in select value from jsonb_array_elements(new.items) loop
      if jsonb_typeof(v_item) <> 'object' or coalesce(trim(v_item ->> 'description'), '') = '' then raise exception 'Every line needs a description'; end if;
      v_qty := coalesce(nullif(v_item ->> 'qty', '')::numeric, 1); v_rate := coalesce(nullif(v_item ->> 'rate', '')::numeric, 0);
      if v_qty < 0 or v_rate < 0 then raise exception 'Quantity and price can''t be negative'; end if;
      v_sub := v_sub + round(v_qty * v_rate, 2);
    end loop;
    if new.discount > v_sub then raise exception 'The discount is more than the invoice total'; end if;
    new.amount_original := round((v_sub - new.discount) * (1 + new.tax_percent / 100), 2);
    if coalesce(trim(new.description), '') = '' then new.description := left(new.items -> 0 ->> 'description', 300); end if;
  elsif tg_op = 'UPDATE' and new.amount is distinct from old.amount and new.amount_original is not distinct from old.amount_original then
    new.amount_original := round(new.amount / nullif(coalesce(new.fx_rate, 1), 0), 2);
  end if;

  -- currency: amount = converted to the workspace currency, used in every total
  new.currency := upper(coalesce(nullif(trim(new.currency), ''), v_base));
  if new.currency !~ '^[A-Z]{3}$' then raise exception 'Pick a valid currency'; end if;
  new.amount_original := coalesce(new.amount_original, new.amount);
  if new.amount_original is null or new.amount_original < 0 then raise exception 'Enter the amount'; end if;
  if new.currency = v_base then new.fx_rate := 1;
  elsif new.fx_rate is null or new.fx_rate <= 0 then raise exception 'Add the exchange rate from % to %', new.currency, v_base;
  end if;
  new.amount := round(new.amount_original * new.fx_rate, 2);

  if tg_op = 'INSERT' then
    new.issue_date := coalesce(new.issue_date, (now() at time zone app_tz())::date);
    new.issued_by := coalesce(auth.uid(), new.issued_by, new.created_by);
    new.issued_by_name := coalesce(member_name(new.issued_by), new.issued_by_name);
    new.issued_by_title := coalesce(issuer_title(new.issued_by), new.issued_by_title);
    if coalesce(trim(new.invoice_number), '') = '' then
      if new.kind = 'business' then
        insert into invoice_counters (workspace_id, key, last) values (new.workspace_id, 'business', 1)
          on conflict (workspace_id, key) do update set last = invoice_counters.last + 1 returning last into v_seq;
        new.invoice_number := 'INV-' || name_initials((select company_name from app_settings where workspace_id = new.workspace_id)) || num_pad(v_seq, 3);
      else
        select invoice_code into v_code from clients where id = new.client_id;
        insert into invoice_counters (workspace_id, key, last) values (new.workspace_id, 'client:' || new.client_id, 1)
          on conflict (workspace_id, key) do update set last = invoice_counters.last + 1 returning last into v_seq;
        new.invoice_number := 'INV-BUID-' || coalesce(v_code, 'CL') || num_pad(v_seq, 3);
      end if;
    end if;
    new.reference_no := 'REF-' || to_char(new.issue_date, 'YYMMDD') || '-' || num_pad(new.id, 4);
  end if;
  return new;
end $$;
drop trigger if exists invoices_x_details on public.invoices;
create trigger invoices_x_details before insert or update on public.invoices
  for each row execute function public.invoices_details_before();

-- What the next number will be (shown on the form before saving)
create or replace function public.invoice_next_number(p_kind text, p_client bigint default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid := current_workspace(); v_code text; v_last int;
begin
  if not perm('finance', 'edit') and not (p_client is not null and can_invoice(p_client, 'edit')) then
    raise exception 'You don''t have permission to add invoices';
  end if;
  if p_kind = 'business' then
    select last into v_last from invoice_counters where workspace_id = v_ws and key = 'business';
    return 'INV-' || name_initials((select company_name from app_settings where workspace_id = v_ws)) || num_pad(coalesce(v_last, 0) + 1, 3);
  end if;
  select invoice_code into v_code from clients where id = p_client and workspace_id = v_ws;
  if v_code is null then return null; end if;
  select last into v_last from invoice_counters where workspace_id = v_ws and key = 'client:' || p_client;
  return 'INV-BUID-' || v_code || num_pad(coalesce(v_last, 0) + 1, 3);
end $$;

-- Who the invoice is for (the client's name or the typed name)
create or replace function public.invoice_party(p_client bigint, p_bill_to jsonb) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from clients where id = p_client and workspace_id = current_workspace()),
                  nullif(trim(p_bill_to ->> 'company'), ''), nullif(trim(p_bill_to ->> 'name'), ''), 'business invoice');
$$;

create or replace function public.invoices_log_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_party text := invoice_party(coalesce(new.client_id, old.client_id), coalesce(new.bill_to, old.bill_to));
        v_type text := case when coalesce(new.kind, old.kind) = 'business' then 'finance' else 'client' end;
        v_eid text := coalesce(new.client_id, old.client_id, new.id, old.id)::text;
begin
  if tg_op = 'INSERT' then
    perform log_event('invoice_created', v_type, v_eid,
      'Added invoice ' || coalesce(new.invoice_number, '#' || new.id) || ' for ' || v_party || ' (' || new.currency || ' ' || new.amount_original || ')');
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    perform log_event(case when new.status = 'paid' then 'invoice_paid' else 'invoice_updated' end, v_type, v_eid,
      'Invoice ' || coalesce(new.invoice_number, '#' || new.id) || ' for ' || v_party || ' is ' || new.status);
  elsif tg_op = 'DELETE' then
    perform log_event('invoice_deleted', v_type, v_eid, 'Deleted invoice ' || coalesce(old.invoice_number, '#' || old.id));
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists invoices_after on public.invoices;
create trigger invoices_after after insert or update or delete on public.invoices
  for each row execute function public.invoices_log_after();

-- Notifications: the Admin, Managers, the Finance role and (for a client invoice of their project) the Project Manager
create or replace function public.finance_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_party text; v_title text; v_who text := coalesce(member_name(auth.uid()), 'System'); v_pm uuid; v_tab text;
        v_amt text := coalesce(new.currency, old.currency, '') || ' ' || coalesce(new.amount_original, new.amount, old.amount_original, old.amount);
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'project_id' - 'updated_at') = (to_jsonb(old) - 'project_id' - 'updated_at') then return new; end if;
  v_party := invoice_party(coalesce(new.client_id, old.client_id), coalesce(new.bill_to, old.bill_to));
  v_tab := case when coalesce(new.kind, old.kind) = 'business' then 'biz-invoices' else 'invoices' end;
  v_title := case
    when tg_op = 'INSERT' then 'New invoice for ' || v_party || ': ' || v_amt || coalesce(' (' || new.invoice_number || ')', '')
    when tg_op = 'DELETE' then 'Invoice deleted for ' || v_party
    when new.status = 'paid' and old.status <> 'paid' then 'Invoice paid by ' || v_party || ': ' || v_amt
    else 'Invoice updated for ' || v_party end;
  perform notify_managers('finance', v_title, 'By ' || v_who, '#/finance?tab=' || v_tab);
  perform notify_role('finance', 'finance', v_title, 'By ' || v_who, '#/finance?tab=' || v_tab);
  select project_manager into v_pm from projects where id = coalesce(new.project_id, old.project_id);
  if v_pm is not null and not is_manager_id(v_pm) and not exists (select 1 from member_roles where member_id = v_pm and role_key = 'finance') then
    perform notify(v_pm, 'finance', v_title, 'By ' || v_who, '#/projects?open=' || coalesce(new.project_id, old.project_id) || '&tab=invoices');
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists invoices_notify on public.invoices;
create trigger invoices_notify after insert or update or delete on public.invoices
  for each row execute function public.finance_notify();

-- 16.10 Row Level Security ---------------------------------------------------------------------------------
alter table public.recurring_expenses enable row level security;
alter table public.expenses           enable row level security;
alter table public.investments        enable row level security;
alter table public.finance_report_log enable row level security;
alter table public.invoices           enable row level security;
alter table public.invoice_counters   enable row level security;

do $$ declare t text; begin
  foreach t in array array['recurring_expenses', 'expenses', 'investments', 'finance_report_log', 'invoices', 'invoice_counters'] loop
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format('create policy tenant_isolation on public.%I as restrictive for all to authenticated
                      using (workspace_id = (select public.current_workspace()))
                      with check (workspace_id = (select public.current_workspace()))', t);
  end loop;
  foreach t in array array['expenses', 'recurring_expenses'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.can_money(category, ''view''))', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_money(category, ''edit''))', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_money(category, ''edit'')) with check (public.can_money(category, ''edit''))', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_money(category, ''delete''))', t || '_delete', t);
  end loop;
end $$;

drop policy if exists investments_read on public.investments;
create policy investments_read on public.investments for select to authenticated using ((select public.perm('finance', 'view')));
drop policy if exists investments_insert on public.investments;
create policy investments_insert on public.investments for insert to authenticated with check ((select public.perm('finance', 'edit')));
drop policy if exists investments_update on public.investments;
create policy investments_update on public.investments for update to authenticated
  using ((select public.perm('finance', 'edit'))) with check ((select public.perm('finance', 'edit')));
drop policy if exists investments_delete on public.investments;
create policy investments_delete on public.investments for delete to authenticated using ((select public.perm('finance', 'delete')));

-- A business invoice (no client) is for the Finance side only; a client invoice also for the project's Project Manager
drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices for select to authenticated
  using (public.can_invoice(client_id, 'view') or public.can_project_invoice(project_id, 'view'));
drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices for insert to authenticated
  with check (public.can_invoice(client_id, 'edit') or public.can_project_invoice(project_id, 'edit'));
drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices for update to authenticated
  using (public.can_invoice(client_id, 'edit') or public.can_project_invoice(project_id, 'edit'))
  with check (public.can_invoice(client_id, 'edit') or public.can_project_invoice(project_id, 'edit'));
drop policy if exists invoices_delete on public.invoices;
create policy invoices_delete on public.invoices for delete to authenticated
  using (public.can_invoice(client_id, 'delete') or public.can_project_invoice(project_id, 'delete'));

revoke all on public.recurring_expenses, public.expenses, public.investments, public.finance_report_log,
              public.invoices, public.invoice_counters from anon, authenticated;
grant select, insert, delete on public.expenses, public.recurring_expenses, public.investments, public.invoices to authenticated;
grant update (title, category, currency, amount_original, fx_rate, amount, spent_on, vendor, notes, attachments, paid_by, payee_member) on public.expenses to authenticated;
grant update (title, category, currency, amount_original, fx_rate, amount, frequency, next_due, vendor, payee_member, auto_post, remind_days, active, notes, attachments) on public.recurring_expenses to authenticated;
grant update (source, investor_id, kind, currency, amount_original, fx_rate, amount, invested_on, notes) on public.investments to authenticated;
grant update (client_id, project_id, description, bill_to, items, tax_percent, discount, notes, billing_period, currency, amount_original, fx_rate, amount,
              issue_date, due_date, status, paid_date) on public.invoices to authenticated;

-- 16.11 Storage for receipts and bills -----------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('finance-files', 'finance-files', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists "finance files read" on storage.objects';
    execute 'create policy "finance files read" on storage.objects for select to authenticated using (bucket_id = ''finance-files'' and public.can_finance_file(name, ''view''))';
    execute 'drop policy if exists "finance files upload" on storage.objects';
    execute 'create policy "finance files upload" on storage.objects for insert to authenticated with check (bucket_id = ''finance-files'' and public.can_finance_file(name, ''edit''))';
    execute 'drop policy if exists "finance files delete" on storage.objects';
    execute 'create policy "finance files delete" on storage.objects for delete to authenticated using (bucket_id = ''finance-files'' and public.can_finance_file(name, ''edit''))';
  end if;
end $$;

-- 16.12 Deleting a workspace also removes this data ------------------------------------------------------------
create or replace function public.purge_workspace(p_id uuid) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  perform set_config('webnox.purge', 'on', true);
  select coalesce(array_agg(id), '{}') into ids from public.profiles where workspace_id = p_id and is_master = false;
  delete from public.activity_logs        where workspace_id = p_id;
  delete from public.activity_intervals   where workspace_id = p_id;
  delete from public.user_sessions        where workspace_id = p_id;
  delete from public.task_time_entries    where workspace_id = p_id;
  delete from public.task_comments        where workspace_id = p_id;
  delete from public.tasks                where workspace_id = p_id;
  delete from public.invoices             where workspace_id = p_id;
  delete from public.invoice_counters     where workspace_id = p_id;
  delete from public.expenses             where workspace_id = p_id;
  delete from public.recurring_expenses   where workspace_id = p_id;
  delete from public.investments          where workspace_id = p_id;
  delete from public.finance_report_log   where workspace_id = p_id;
  delete from public.client_files         where workspace_id = p_id;
  delete from public.request_comments     where workspace_id = p_id;
  delete from public.staffing_request_items where workspace_id = p_id;
  delete from public.staffing_requests    where workspace_id = p_id;
  delete from public.project_members      where workspace_id = p_id;
  delete from public.project_requirements where workspace_id = p_id;
  delete from public.projects             where workspace_id = p_id;
  delete from public.leads                where workspace_id = p_id;
  delete from public.clients              where workspace_id = p_id;
  delete from public.role_permissions     where workspace_id = p_id;
  delete from public.app_settings         where workspace_id = p_id;
  delete from public.notifications        where workspace_id = p_id;
  delete from public.workspace_roles      where workspace_id = p_id;
  delete from public.subscription_payments where workspace_id = p_id;
  delete from public.subscriptions        where workspace_id = p_id;
  delete from public.billing_log          where workspace_id = p_id;
  delete from public.master_access_log    where workspace_id = p_id;
  delete from public.profiles             where workspace_id = p_id and is_master = false;
  delete from public.workspaces           where id = p_id;
  return ids;
end $$;
revoke all on function public.purge_workspace(uuid) from public, anon, authenticated;

-- 16.13 Functions: who may call what ---------------------------------------------------------------------------
revoke execute on function
  public.invoice_initials(uuid, text, bigint), public.clients_codes_before(), public.invoices_details_before(),
  public.invoices_log_after(), public.finance_notify(), public.finance_money_before(), public.finance_money_after(),
  public.finance_attachments_check(), public.notify_finance_people(uuid, boolean, text, text, text), public.recurring_post(bigint, numeric, date),
  public.is_manager_id(uuid)
  from public, anon, authenticated;
revoke execute on function
  public.num_pad(bigint, int), public.name_initials(text), public.issuer_title(uuid), public.can_money(text, text), public.can_invoice(bigint, text),
  public.can_project_invoice(bigint, text), public.fmt_money(numeric), public.advance_due(date, text), public.can_finance_file(text, text),
  public.recurring_mark_paid(bigint, numeric, date, numeric), public.recurring_skip(bigint), public.finance_sweep(), public.finance_overview(),
  public.finance_report(date), public.business_summary(), public.invoice_next_number(text, bigint), public.invoice_party(bigint, jsonb)
  from public, anon;
grant execute on function
  public.num_pad(bigint, int), public.name_initials(text), public.issuer_title(uuid), public.can_money(text, text), public.can_invoice(bigint, text),
  public.can_project_invoice(bigint, text), public.fmt_money(numeric), public.advance_due(date, text), public.can_finance_file(text, text),
  public.recurring_mark_paid(bigint, numeric, date, numeric), public.recurring_skip(bigint), public.finance_sweep(), public.finance_overview(),
  public.finance_report(date), public.business_summary(), public.invoice_next_number(text, bigint), public.invoice_party(bigint, jsonb)
  to authenticated;
