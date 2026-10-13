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
