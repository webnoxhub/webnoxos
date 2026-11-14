begin;

-- PART 17 — Master Finance: the rent
-- ============================================================================
-- The Master charges each rented workspace. Everything here lives above the
-- workspaces: a Master reads it all, a workspace Admin reads only their own row.
-- Money follows the rule already in use: currency + amount_original + fx_rate,
-- stored as `amount` in the Master's base currency (PKR).
--
-- 17.1  Master notifications (workspace_id null = a notice for the Masters)
-- 17.2  Helpers: master_today(), master_due_date(), notify_masters(), notify_ws_admins()
-- 17.3  master_record_payment()  — record rent, advance the cycle, resume if held
-- 17.4  master_change_plan()     — takes effect from the next due date
-- 17.5  master_sweep()           — countdowns, due, overdue, auto-suspend
-- 17.6  master_overview()        — the Dashboard tab
-- 17.7  master_report()          — the Reports tab
-- 17.8  Grants

-- 17.1 A notice with no workspace belongs to the Masters -----------------------
alter table public.notifications alter column workspace_id drop not null;

drop policy if exists tenant_isolation on public.notifications;
create policy tenant_isolation on public.notifications as restrictive for all to authenticated
  using      ( workspace_id = (select public.current_workspace())
               or (workspace_id is null and (select public.is_master())) )
  with check ( workspace_id = (select public.current_workspace())
               or (workspace_id is null and (select public.is_master())) );

create index if not exists notifications_master_idx on public.notifications (created_at desc)
  where workspace_id is null;

-- 17.2 Helpers -----------------------------------------------------------------

-- The Master's own day. Dates everywhere in the Master world are Pakistan time,
-- the same as js/time.js, so "due today" means the same thing on both sides.
create or replace function public.master_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Karachi')::date $$;

-- The next due date after p_date for a paid cycle. Trials have no due date.
create or replace function public.master_due_date(p_date date, p_cycle public.billing_cycle) returns date
language sql immutable as $$
  select case p_cycle
           when 'monthly'   then (p_date + interval '1 month')::date
           when 'quarterly' then (p_date + interval '3 months')::date
           when 'yearly'    then (p_date + interval '1 year')::date
           else null end;
$$;

create or replace function public.is_trial_cycle(p_cycle public.billing_cycle) returns boolean
language sql immutable as $$ select p_cycle in ('trial_7','trial_14') $$;

-- Money in words for a notice. fmt_money() reads the CURRENT workspace's currency, which a
-- Master does not have, so the Master world spells its own out.
create or replace function public.money_text(p_currency text, p_amount numeric) returns text
language sql immutable as $$
  select upper(btrim(coalesce(p_currency, 'PKR'))) || ' ' || to_char(round(coalesce(p_amount, 0)), 'FM999,999,999,990')
$$;

create or replace function public.master_money(p_amount numeric) returns text
language sql immutable as $$ select public.money_text('PKR', p_amount) $$;

-- Tells every active Master. These are reminders, so the acting Master is told too.
create or replace function public.notify_masters(p_kind text, p_title text, p_body text default '', p_link text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from profiles where is_master and status = 'active' loop
    insert into notifications (workspace_id, user_id, kind, title, body, link, text)
    values (null, r.id, p_kind, left(p_title, 200), left(coalesce(p_body, ''), 500), p_link, left(p_title, 200));
  end loop;
end $$;

-- Tells a workspace's Admins and Managers. Inserted directly: the Master who
-- triggers it stands outside the workspace, so notify() would refuse.
create or replace function public.notify_ws_admins(p_ws uuid, p_kind text, p_title text, p_body text default '', p_link text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select id from profiles
            where workspace_id = p_ws and status = 'active' and account_type in ('admin','manager') loop
    insert into notifications (workspace_id, user_id, kind, title, body, link, text)
    values (p_ws, r.id, p_kind, left(p_title, 200), left(coalesce(p_body, ''), 500), p_link, left(p_title, 200));
  end loop;
end $$;

-- 17.3 Record a rent payment ----------------------------------------------------
-- Advances next_due by one cycle, ends a trial, and lifts a hold that was only
-- about money. Past payments are never touched.
create or replace function public.master_record_payment(
  p_ws          uuid,
  p_amount      numeric,
  p_currency    text    default 'PKR',
  p_fx          numeric default 1,
  p_paid_on     date    default null,
  p_method      text    default 'bank_transfer',
  p_reference   text    default null,
  p_period_from date    default null,
  p_period_to   date    default null,
  p_note        text    default null,
  p_attachments jsonb   default '[]'::jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s        subscriptions%rowtype;
  w        workspaces%rowtype;
  v_today  date := master_today();
  v_paid   date := coalesce(p_paid_on, master_today());
  v_cycle  public.billing_cycle;
  v_from   date;
  v_next   date;
  v_id     uuid;
  v_inv    text;
begin
  if not is_master() then raise exception 'Only a Master may record rent'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than zero'; end if;
  if p_fx is null or p_fx <= 0 then raise exception 'Exchange rate must be more than zero'; end if;
  if v_paid > v_today then raise exception 'A payment cannot be dated in the future'; end if;

  select * into w from workspaces where id = p_ws;
  if w.id is null then raise exception 'Workspace not found'; end if;
  if w.type = 'master_project' then raise exception 'A personal workspace pays no rent'; end if;

  select * into s from subscriptions where workspace_id = p_ws for update;
  if s.workspace_id is null then raise exception 'This workspace has no plan yet'; end if;

  -- A trial ends at the first payment: the cycle it was sold with takes over.
  v_cycle := case when is_trial_cycle(s.cycle) then coalesce(s.next_cycle, 'monthly'::public.billing_cycle) else s.cycle end;
  v_from  := coalesce(p_period_from, s.next_due, coalesce(s.trial_ends_on, s.start_date));
  v_next  := master_due_date(coalesce(s.next_due, v_from), v_cycle);

  insert into subscription_payments (
    workspace_id, amount_original, currency, fx_rate, amount, paid_on, method, reference,
    period_from, period_to, attachments, note, recorded_by
  ) values (
    p_ws, p_amount, upper(btrim(p_currency)), p_fx, 0, v_paid, p_method::public.payment_method, nullif(btrim(p_reference), ''),
    v_from, coalesce(p_period_to, v_next), coalesce(p_attachments, '[]'::jsonb), nullif(btrim(p_note), ''), auth.uid()
  ) returning id into v_id;

  update subscriptions
     set cycle        = v_cycle,
         next_cycle   = null,
         trial_ends_on= case when is_trial_cycle(s.cycle) then s.trial_ends_on else s.trial_ends_on end,
         next_due     = v_next,
         status       = 'active',
         suspended_at = null
   where workspace_id = p_ws;

  -- A workspace held for money comes back; one archived by hand stays archived.
  if w.status in ('suspended','trial','setup') then
    update workspaces set status = 'active' where id = p_ws;
  end if;

  -- The reminders for this cycle are spent; the next cycle starts clean.
  delete from billing_log where workspace_id = p_ws and kind in ('due_soon','due_today','overdue','suspended','trial_countdown');

  -- If an invoice was issued for this cycle, this payment closes it (PART 18).
  if to_regprocedure('public.settle_rent_invoice(uuid,uuid,date)') is not null then
    execute 'select public.settle_rent_invoice($1,$2,$3)' into v_inv using p_ws, v_id, v_paid;
  end if;

  insert into master_access_log (workspace_id, master_id, action, detail)
  values (p_ws, auth.uid(), 'payment_recorded',
          jsonb_build_object('amount', p_amount, 'currency', upper(btrim(p_currency)), 'paid_on', v_paid,
                             'next_due', v_next, 'invoice_no', v_inv));

  perform notify_masters('billing', 'Rent received: ' || w.name || ' ' || money_text(p_currency, p_amount),
    'Next due ' || to_char(v_next, 'DD Mon YYYY') || '.', '#/master/finance?tab=payments');
  perform notify_ws_admins(p_ws, 'billing', 'Payment received — thank you',
    'We have recorded ' || money_text(p_currency, p_amount) || ' for ' || w.name ||
    coalesce(' against invoice ' || v_inv, '') ||
    '. Your next payment is due ' || to_char(v_next, 'DD Mon YYYY') || '.', '#/billing');

  return v_id;
end $$;

-- 17.4 Change a plan -------------------------------------------------------------
-- The new price and cycle apply from the next due date. Nothing already paid moves.
create or replace function public.master_change_plan(
  p_ws           uuid,
  p_cycle        text,
  p_amount       numeric,
  p_currency     text    default 'PKR',
  p_fx           numeric default 1,
  p_grace_days   int     default null,
  p_member_limit int     default null,
  p_plan_name    text    default null,
  p_notes        text    default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  s       subscriptions%rowtype;
  w       workspaces%rowtype;
  v_new   public.billing_cycle := p_cycle::public.billing_cycle;
  v_today date := master_today();
begin
  if not is_master() then raise exception 'Only a Master may change a plan'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Amount cannot be negative'; end if;
  if p_fx is null or p_fx <= 0 then raise exception 'Exchange rate must be more than zero'; end if;

  select * into w from workspaces where id = p_ws;
  if w.id is null then raise exception 'Workspace not found'; end if;
  if w.type = 'master_project' then raise exception 'A personal workspace pays no rent'; end if;

  select * into s from subscriptions where workspace_id = p_ws for update;

  -- First plan for a workspace that never had one.
  if s.workspace_id is null then
    insert into subscriptions (workspace_id, plan_name, cycle, next_cycle, amount_original, currency, fx_rate, amount,
                               start_date, trial_ends_on, next_due, grace_days, member_limit, status, notes)
    values (p_ws, nullif(btrim(p_plan_name), ''), v_new,
            case when is_trial_cycle(v_new) then 'monthly'::public.billing_cycle else null end,
            p_amount, upper(btrim(p_currency)), p_fx, 0, v_today,
            case when is_trial_cycle(v_new) then v_today + (case v_new when 'trial_7' then 7 else 14 end) else null end,
            case when is_trial_cycle(v_new) then null else master_due_date(v_today, v_new) end,
            coalesce(p_grace_days, 7), p_member_limit,
            case when is_trial_cycle(v_new) then 'trial' else 'active' end::public.billing_status,
            nullif(btrim(p_notes), ''));
  else
    update subscriptions
       set plan_name       = coalesce(nullif(btrim(p_plan_name), ''), plan_name),
           amount_original = p_amount,
           currency        = upper(btrim(p_currency)),
           fx_rate         = p_fx,
           grace_days      = coalesce(p_grace_days, grace_days),
           member_limit    = coalesce(p_member_limit, member_limit),
           notes           = coalesce(nullif(btrim(p_notes), ''), notes),
           -- A running trial keeps its end date; the new cycle begins the day it ends.
           next_cycle      = case when is_trial_cycle(cycle) and not is_trial_cycle(v_new) then v_new
                                  when is_trial_cycle(cycle) then next_cycle
                                  else null end,
           cycle           = case when is_trial_cycle(cycle) then cycle else v_new end
     where workspace_id = p_ws;
  end if;

  insert into master_access_log (workspace_id, master_id, action, detail)
  values (p_ws, auth.uid(), 'plan_changed',
          jsonb_build_object('cycle', p_cycle, 'amount', p_amount, 'currency', upper(btrim(p_currency))));

  perform notify_ws_admins(p_ws, 'billing', 'Your plan has changed',
    'From your next due date: ' || money_text(p_currency, p_amount) || ' ' ||
    replace(p_cycle, '_', ' ') || '. Nothing already paid is affected.', '#/billing');
end $$;

-- 17.5 The sweep -------------------------------------------------------------------
-- Runs when the Master opens the app. Idempotent: billing_log holds one row per
-- workspace, kind and date, so nobody is told the same thing twice in one day.
-- A personal workspace is skipped entirely.
create or replace function public.master_sweep() returns int
language plpgsql security definer set search_path = public as $$
declare
  r        record;
  v_today  date := master_today();
  v_days   int;
  v_gone   int;
  v_due    date;
  v_status public.workspace_status;
  n        int := 0;
  v_link   text := '#/master/finance';
begin
  if not is_master() then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('webnox_master_sweep'));

  for r in
    select w.id, w.name, w.status as ws_status, s.*
      from workspaces w
      join subscriptions s on s.workspace_id = w.id
     where w.type = 'rented'
       and w.status <> 'archived'
       and s.status <> 'cancelled'
     order by s.next_due nulls first
  loop
    v_due := r.next_due;
    v_status := r.ws_status;

    -- A trial: count the days down for the Master and the Admin, every day.
    if is_trial_cycle(r.cycle) and r.trial_ends_on is not null and r.next_due is null then
      v_days := r.trial_ends_on - v_today;
      if v_days >= 0 then
        if not exists (select 1 from billing_log where workspace_id = r.id and kind = 'trial_countdown' and for_date = v_today) then
          insert into billing_log (workspace_id, kind, for_date) values (r.id, 'trial_countdown', v_today);
          perform notify_masters('billing', 'Trial: ' || r.name || ' — ' ||
            case when v_days = 0 then 'ends today' else v_days || ' day' || case when v_days = 1 then '' else 's' end || ' left' end,
            'Record the first payment to start the paid cycle.', v_link);
          perform notify_ws_admins(r.id, 'billing', 'Your trial ' ||
            case when v_days = 0 then 'ends today' else 'ends in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end end,
            'Trial ends ' || to_char(r.trial_ends_on, 'DD Mon YYYY') || '.', '#/billing');
          n := n + 1;
        end if;
      else
        -- The trial is over and nothing was paid: the paid cycle is now due.
        update subscriptions
           set cycle      = coalesce(r.next_cycle, 'monthly'::public.billing_cycle),
               next_cycle = null,
               next_due   = r.trial_ends_on,
               status     = 'due_today'
         where workspace_id = r.id;
        v_due := r.trial_ends_on;
        n := n + 1;
      end if;
    end if;

    if v_due is null then continue; end if;
    v_days := v_due - v_today;
    v_gone := v_today - (v_due + coalesce(r.grace_days, 7));

    -- Past the grace period: the workspace is held until the rent is paid.
    if v_gone >= 0 and v_status <> 'suspended' then
      update workspaces set status = 'suspended' where id = r.id;
      update subscriptions set status = 'suspended', suspended_at = now() where workspace_id = r.id;
      insert into billing_log (workspace_id, kind, for_date) values (r.id, 'suspended', v_today) on conflict do nothing;
      perform notify_masters('billing', 'Suspended: ' || r.name,
        'Rent was due ' || to_char(v_due, 'DD Mon YYYY') || ' and the ' || coalesce(r.grace_days, 7) || ' grace days are over.', v_link);
      perform notify_ws_admins(r.id, 'billing', 'Your workspace is on hold',
        'Rent due ' || to_char(v_due, 'DD Mon YYYY') || ' has not been received. Your data is safe; access returns as soon as payment is recorded.', '#/billing');
      n := n + 1;

    elsif v_days < 0 then
      update subscriptions set status = 'overdue' where workspace_id = r.id and status <> 'overdue';
      if not exists (select 1 from billing_log where workspace_id = r.id and kind = 'overdue' and for_date = v_today) then
        insert into billing_log (workspace_id, kind, for_date) values (r.id, 'overdue', v_today);
        perform notify_masters('billing', 'Overdue: ' || r.name || ' — ' || (-v_days) || ' day' || case when v_days = -1 then '' else 's' end,
          master_money(r.amount) || ' was due ' || to_char(v_due, 'DD Mon YYYY') || '. On hold in ' || greatest(-v_gone, 0) || ' day' || case when -v_gone = 1 then '' else 's' end || '.', v_link);
        perform notify_ws_admins(r.id, 'billing', 'Rent is overdue',
          'Payment was due ' || to_char(v_due, 'DD Mon YYYY') || '. The workspace goes on hold in ' || greatest(-v_gone, 0) || ' day' || case when -v_gone = 1 then '' else 's' end || '.', '#/billing');
        n := n + 1;
      end if;

    elsif v_days = 0 then
      update subscriptions set status = 'due_today' where workspace_id = r.id and status <> 'due_today';
      if not exists (select 1 from billing_log where workspace_id = r.id and kind = 'due_today' and for_date = v_today) then
        insert into billing_log (workspace_id, kind, for_date) values (r.id, 'due_today', v_today);
        perform notify_masters('billing', 'Due today: ' || r.name || ' ' || master_money(r.amount), 'Record the payment once it lands.', v_link);
        perform notify_ws_admins(r.id, 'billing', 'Rent is due today', 'Payment for ' || r.name || ' is due today.', '#/billing');
        n := n + 1;
      end if;

    elsif v_days <= 3 then
      update subscriptions set status = 'due_soon' where workspace_id = r.id and status not in ('due_soon','trial');
      if not exists (select 1 from billing_log where workspace_id = r.id and kind = 'due_soon' and for_date = v_today) then
        insert into billing_log (workspace_id, kind, for_date) values (r.id, 'due_soon', v_today);
        perform notify_masters('billing', 'Due in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end || ': ' || r.name || ' ' || master_money(r.amount),
          'Due ' || to_char(v_due, 'DD Mon YYYY') || '.', v_link);
        perform notify_ws_admins(r.id, 'billing', 'Rent due in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end,
          'Payment is due ' || to_char(v_due, 'DD Mon YYYY') || '.', '#/billing');
        n := n + 1;
      end if;

    else
      update subscriptions set status = 'active' where workspace_id = r.id and status in ('due_soon','due_today','overdue');
    end if;
  end loop;

  return n;
end $$;

-- 17.6 The Dashboard tab -------------------------------------------------------------
create or replace function public.master_overview() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_today date := master_today();
  v_m0    date := date_trunc('month', v_today)::date;
  v_m1    date := (v_m0 + interval '1 month')::date;
  r       jsonb;
begin
  if not is_master() then raise exception 'Masters only'; end if;

  select jsonb_build_object(
    'today', v_today,

    -- Rent expected to land this month, rent that did, and what is still outstanding.
    'expected', coalesce((select sum(s.amount) from subscriptions s join workspaces w on w.id = s.workspace_id
                           where w.type = 'rented' and w.status <> 'archived' and s.status <> 'cancelled'
                             and s.next_due >= v_m0 and s.next_due < v_m1), 0),
    'collected', coalesce((select sum(amount) from subscription_payments where paid_on >= v_m0 and paid_on < v_m1), 0),
    'outstanding', coalesce((select sum(s.amount) from subscriptions s join workspaces w on w.id = s.workspace_id
                              where w.type = 'rented' and w.status <> 'archived' and s.status <> 'cancelled'
                                and s.next_due is not null and s.next_due <= v_today), 0),
    'overdue_amount', coalesce((select sum(s.amount) from subscriptions s join workspaces w on w.id = s.workspace_id
                                 where w.type = 'rented' and w.status <> 'archived' and s.status <> 'cancelled'
                                   and s.next_due is not null and s.next_due < v_today), 0),
    'overdue_count', (select count(*) from subscriptions s join workspaces w on w.id = s.workspace_id
                       where w.type = 'rented' and w.status <> 'archived' and s.status <> 'cancelled'
                         and s.next_due is not null and s.next_due < v_today),

    'counts', jsonb_build_object(
      'active',    (select count(*) from workspaces where type = 'rented' and status = 'active'),
      'trial',     (select count(*) from subscriptions s join workspaces w on w.id = s.workspace_id
                     where w.type = 'rented' and w.status <> 'archived' and is_trial_cycle(s.cycle) and s.next_due is null),
      'due_week',  (select count(*) from subscriptions s join workspaces w on w.id = s.workspace_id
                     where w.type = 'rented' and w.status <> 'archived' and s.status <> 'cancelled'
                       and s.next_due between v_today and v_today + 7),
      'suspended', (select count(*) from workspaces where type = 'rented' and status = 'suspended')
    ),

    -- Everything renewing in the next 30 days, soonest first.
    'renewals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'name', w.name, 'next_due', s.next_due, 'days', s.next_due - v_today,
               'amount', s.amount, 'amount_original', s.amount_original, 'currency', s.currency, 'cycle', s.cycle)
             order by s.next_due)
        from subscriptions s join workspaces w on w.id = s.workspace_id
       where w.type = 'rented' and w.status <> 'archived' and s.status <> 'cancelled'
         and s.next_due between v_today - 30 and v_today + 30), '[]'::jsonb),

    -- Collected per month for the last 12 months, oldest first.
    'months', coalesce((
      select jsonb_agg(jsonb_build_object('month', m, 'amount', amt) order by m)
        from (select to_char(d, 'YYYY-MM') m,
                     coalesce((select sum(p.amount) from subscription_payments p
                                where p.paid_on >= d and p.paid_on < (d + interval '1 month')::date), 0) amt
                from generate_series((v_m0 - interval '11 months')::date, v_m0, interval '1 month') d) x), '[]'::jsonb)
  ) into r;
  return r;
end $$;

-- 17.7 The Reports tab ----------------------------------------------------------------
create or replace function public.master_report(p_from date default null, p_to date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_today date := master_today();
  v_from  date := coalesce(p_from, (date_trunc('month', v_today) - interval '11 months')::date);
  v_to    date := coalesce(p_to, v_today);
  r       jsonb;
begin
  if not is_master() then raise exception 'Masters only'; end if;
  if v_from > v_to then raise exception 'The start date is after the end date'; end if;

  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'total', coalesce((select sum(amount) from subscription_payments where paid_on between v_from and v_to), 0),
    'count', (select count(*) from subscription_payments where paid_on between v_from and v_to),

    'by_month', coalesce((
      select jsonb_agg(jsonb_build_object('month', m, 'amount', amt, 'count', c) order by m)
        from (select to_char(paid_on, 'YYYY-MM') m, sum(amount) amt, count(*) c
                from subscription_payments where paid_on between v_from and v_to
               group by 1) x), '[]'::jsonb),

    'by_workspace', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'amount', amt, 'count', c) order by amt desc)
        from (select w.id, w.name, sum(p.amount) amt, count(*) c
                from subscription_payments p join workspaces w on w.id = p.workspace_id
               where p.paid_on between v_from and v_to
               group by w.id, w.name) y), '[]'::jsonb),

    'outstanding', coalesce((
      select jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'next_due', s.next_due,
                                          'days', v_today - s.next_due, 'amount', s.amount,
                                          'currency', s.currency, 'amount_original', s.amount_original)
             order by s.next_due)
        from subscriptions s join workspaces w on w.id = s.workspace_id
       where w.type = 'rented' and w.status <> 'archived' and s.status <> 'cancelled'
         and s.next_due is not null and s.next_due <= v_today), '[]'::jsonb)
  ) into r;
  return r;
end $$;

-- 17.8 Who may call what ----------------------------------------------------------------
revoke execute on function public.notify_masters(text, text, text, text),
                           public.notify_ws_admins(uuid, text, text, text, text)
  from public, anon, authenticated;

revoke execute on function
  public.master_today(), public.master_due_date(date, public.billing_cycle), public.is_trial_cycle(public.billing_cycle),
  public.money_text(text, numeric), public.master_money(numeric),
  public.master_record_payment(uuid, numeric, text, numeric, date, text, text, date, date, text, jsonb),
  public.master_change_plan(uuid, text, numeric, text, numeric, int, int, text, text),
  public.master_sweep(), public.master_overview(), public.master_report(date, date)
  from public, anon;

grant execute on function
  public.master_today(), public.master_due_date(date, public.billing_cycle), public.is_trial_cycle(public.billing_cycle),
  public.money_text(text, numeric), public.master_money(numeric),
  public.master_record_payment(uuid, numeric, text, numeric, date, text, text, date, date, text, jsonb),
  public.master_change_plan(uuid, text, numeric, text, numeric, int, int, text, text),
  public.master_sweep(), public.master_overview(), public.master_report(date, date)
  to authenticated;


-- ============================================================================
-- PART 18 — Rent invoices and the workspace Billing page
-- ============================================================================
-- The Master issues an invoice for a workspace's rent. It is numbered on a
-- Master-level counter (INV-WX001, INV-WX002 …), so the numbers run across every
-- workspace and never collide with a tenant's own invoice numbers.
--
-- The workspace Admin reads their own plan, invoices and payments on a Billing
-- page inside their workspace — the one page that still opens while a workspace
-- is on hold, so a business can always see what it owes and what it has paid.
--
-- 18.1  master_counters + rent_invoices
-- 18.2  Numbering
-- 18.3  master_issue_rent_invoice()
-- 18.4  master_void_rent_invoice()
-- 18.5  Settling: a recorded payment closes the oldest open invoice
-- 18.6  RLS
-- 18.7  Deleting a workspace takes its invoices
-- 18.8  Grants

-- 18.1 Tables ------------------------------------------------------------------
create table if not exists public.master_counters (
  key  text primary key,
  last int  not null default 0
);
alter table public.master_counters enable row level security;

create table if not exists public.rent_invoices (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces(id) on delete cascade,
  invoice_no      text not null unique,
  status          text not null default 'sent' check (status in ('sent','paid','void')),
  issue_date      date not null,
  due_date        date not null,
  period_from     date not null,
  period_to       date not null,
  currency        text not null default 'PKR',
  amount_original numeric(14,2) not null check (amount_original >= 0),
  fx_rate         numeric(14,6) not null default 1 check (fx_rate > 0),
  amount          numeric(14,2) not null default 0,
  payment_id      uuid references public.subscription_payments(id) on delete set null,
  paid_on         date,
  notes           text,
  issued_by       uuid,
  created_at      timestamptz not null default now()
);
create index if not exists rent_invoices_ws_idx     on public.rent_invoices (workspace_id, issue_date desc);
create index if not exists rent_invoices_open_idx   on public.rent_invoices (workspace_id, period_from) where status = 'sent';

drop trigger if exists rent_invoices_money on public.rent_invoices;
create trigger rent_invoices_money before insert or update on public.rent_invoices
  for each row execute function public.money_before_write();

-- Issuing and voiding join the actions the access log already records.
alter table public.master_access_log drop constraint if exists master_access_log_action_check;
alter table public.master_access_log add constraint master_access_log_action_check
  check (action in ('opened','full_access_on','full_access_off','suspended','resumed','archived',
                    'plan_changed','role_changed','payment_recorded','invoice_issued','invoice_voided'));

-- 18.2 Numbering -----------------------------------------------------------------
-- One counter for the whole platform: INV-WX001, INV-WX002 …
create or replace function public.master_next_invoice_no() returns text
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into master_counters (key, last) values ('rent', 1)
    on conflict (key) do update set last = master_counters.last + 1
    returning last into v;
  return 'INV-WX' || num_pad(v, 3);
end $$;

-- 18.3 Issue an invoice -------------------------------------------------------------
-- Everything but the workspace is optional: the plan supplies the rest.
create or replace function public.master_issue_rent_invoice(
  p_ws          uuid,
  p_period_from date    default null,
  p_period_to   date    default null,
  p_due_date    date    default null,
  p_amount      numeric default null,
  p_currency    text    default null,
  p_fx          numeric default null,
  p_notes       text    default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s      subscriptions%rowtype;
  w      workspaces%rowtype;
  v_from date;
  v_to   date;
  v_due  date;
  v_amt  numeric;
  v_cur  text;
  v_fx   numeric;
  v_no   text;
  v_id   uuid;
begin
  if not is_master() then raise exception 'Only a Master may issue a rent invoice'; end if;

  select * into w from workspaces where id = p_ws;
  if w.id is null then raise exception 'Workspace not found'; end if;
  if w.type = 'master_project' then raise exception 'A personal workspace pays no rent'; end if;

  select * into s from subscriptions where workspace_id = p_ws;
  if s.workspace_id is null then raise exception 'This workspace has no plan yet'; end if;

  v_from := coalesce(p_period_from, s.next_due, s.trial_ends_on, s.start_date);
  v_to   := coalesce(p_period_to, master_due_date(v_from,
              case when is_trial_cycle(s.cycle) then coalesce(s.next_cycle, 'monthly'::public.billing_cycle) else s.cycle end),
              v_from);
  v_due  := coalesce(p_due_date, v_from);
  v_amt  := coalesce(p_amount, s.amount_original);
  v_cur  := upper(btrim(coalesce(p_currency, s.currency)));
  v_fx   := coalesce(p_fx, s.fx_rate);

  if v_amt is null or v_amt < 0 then raise exception 'Amount cannot be negative'; end if;
  if v_fx is null or v_fx <= 0 then raise exception 'Exchange rate must be more than zero'; end if;
  if v_to < v_from then raise exception 'The period ends before it starts'; end if;

  -- One open invoice per period: issuing twice for the same month is a mistake, not an intent.
  if exists (select 1 from rent_invoices
              where workspace_id = p_ws and status = 'sent' and period_from = v_from) then
    raise exception 'An unpaid invoice for this period already exists';
  end if;

  v_no := master_next_invoice_no();
  insert into rent_invoices (workspace_id, invoice_no, status, issue_date, due_date, period_from, period_to,
                             currency, amount_original, fx_rate, amount, notes, issued_by)
  values (p_ws, v_no, 'sent', master_today(), v_due, v_from, v_to,
          v_cur, v_amt, v_fx, 0, nullif(btrim(p_notes), ''), auth.uid())
  returning id into v_id;

  insert into master_access_log (workspace_id, master_id, action, detail)
  values (p_ws, auth.uid(), 'invoice_issued',
          jsonb_build_object('invoice_no', v_no, 'amount', v_amt, 'currency', v_cur, 'due_date', v_due));

  perform notify_ws_admins(p_ws, 'billing', 'Invoice ' || v_no || ' — ' || money_text(v_cur, v_amt),
    'For ' || to_char(v_from, 'DD Mon YYYY') || ' to ' || to_char(v_to, 'DD Mon YYYY') ||
    ', due ' || to_char(v_due, 'DD Mon YYYY') || '.', '#/billing');
  perform notify_masters('billing', 'Invoice ' || v_no || ' issued to ' || w.name,
    money_text(v_cur, v_amt) || ', due ' || to_char(v_due, 'DD Mon YYYY') || '.', '#/master/finance?tab=invoices');

  return v_id;
end $$;

-- 18.4 Void an invoice ----------------------------------------------------------------
-- An invoice is never deleted; a wrong one is voided and the reason is kept.
create or replace function public.master_void_rent_invoice(p_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare i rent_invoices%rowtype; w_name text;
begin
  if not is_master() then raise exception 'Only a Master may void a rent invoice'; end if;
  select * into i from rent_invoices where id = p_id for update;
  if i.id is null then raise exception 'Invoice not found'; end if;
  if i.status = 'paid' then raise exception 'A paid invoice cannot be voided'; end if;
  if i.status = 'void' then return; end if;

  update rent_invoices
     set status = 'void',
         notes  = btrim(coalesce(notes || ' · ', '') || 'Voided: ' || coalesce(nullif(btrim(p_reason), ''), 'no reason given'))
   where id = p_id;

  select name into w_name from workspaces where id = i.workspace_id;
  insert into master_access_log (workspace_id, master_id, action, detail)
  values (i.workspace_id, auth.uid(), 'invoice_voided',
          jsonb_build_object('invoice_no', i.invoice_no, 'reason', nullif(btrim(p_reason), '')));
  perform notify_ws_admins(i.workspace_id, 'billing', 'Invoice ' || i.invoice_no || ' was cancelled',
    coalesce(nullif(btrim(p_reason), ''), 'No payment is needed against it.'), '#/billing');
end $$;

-- 18.5 Settling ---------------------------------------------------------------------------
-- A recorded payment closes the oldest open invoice for that workspace. Called from
-- master_record_payment(), so the Master never has to tick an invoice off by hand.
create or replace function public.settle_rent_invoice(p_ws uuid, p_payment uuid, p_paid_on date)
returns text
language plpgsql security definer set search_path = public as $$
declare v_no text;
begin
  update rent_invoices
     set status = 'paid', payment_id = p_payment, paid_on = p_paid_on
   where id = (select id from rent_invoices
                where workspace_id = p_ws and status = 'sent'
                order by period_from, issue_date limit 1)
  returning invoice_no into v_no;
  return v_no;
end $$;

-- 18.6 Who may see what ---------------------------------------------------------------------
alter table public.rent_invoices enable row level security;

drop policy if exists rent_inv_master on public.rent_invoices;
create policy rent_inv_master on public.rent_invoices for all
  using ( public.is_master() ) with check ( public.is_master() );

-- The workspace Admin reads their own invoices — including while the workspace is on hold.
drop policy if exists rent_inv_admin_read on public.rent_invoices;
create policy rent_inv_admin_read on public.rent_invoices for select
  using ( workspace_id = public.current_workspace() and public.is_admin() );

drop policy if exists master_counters_master on public.master_counters;
create policy master_counters_master on public.master_counters for select
  using ( public.is_master() );

-- 18.7 Deleting a workspace --------------------------------------------------------------------
-- rent_invoices cascades from workspaces, but the delete is spelled out so the order is plain.
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
  delete from public.rent_invoices        where workspace_id = p_id;
  delete from public.subscription_payments where workspace_id = p_id;
  delete from public.subscriptions        where workspace_id = p_id;
  delete from public.billing_log          where workspace_id = p_id;
  delete from public.master_access_log    where workspace_id = p_id;
  delete from public.profiles             where workspace_id = p_id and is_master = false;
  delete from public.workspaces           where id = p_id;
  return ids;
end $$;
revoke all on function public.purge_workspace(uuid) from public, anon, authenticated;

-- 18.8 Grants -----------------------------------------------------------------------------------
revoke execute on function public.master_next_invoice_no(),
                           public.settle_rent_invoice(uuid, uuid, date)
  from public, anon, authenticated;

revoke execute on function
  public.master_issue_rent_invoice(uuid, date, date, date, numeric, text, numeric, text),
  public.master_void_rent_invoice(uuid, text)
  from public, anon;

grant execute on function
  public.master_issue_rent_invoice(uuid, date, date, date, numeric, text, numeric, text),
  public.master_void_rent_invoice(uuid, text)
  to authenticated;

revoke all on public.master_counters from anon, authenticated;
grant select on public.master_counters to authenticated;
grant select on public.rent_invoices to authenticated;
grant insert, update, delete on public.rent_invoices to authenticated;

notify pgrst, 'reload schema';
commit;
