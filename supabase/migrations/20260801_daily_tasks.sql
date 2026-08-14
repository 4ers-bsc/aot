-- ============================================================================
-- Daily tasks — a lightweight, trackable daily-objectives system.
--
-- Two tables:
--   • daily_tasks             — the task definitions, each with an active time
--                               window (start_time … end_time). "task_id" is a
--                               stable text key (e.g. 'daily_win') so the client
--                               and gameplay hooks can reference a task by name
--                               across day-to-day rows.
--   • daily_task_completions  — the "profiles completed" set: one row per
--                               (task, profile) that has completed it.
--
-- Reads/writes go through SECURITY DEFINER RPCs (same pattern as the
-- leaderboard): the tables have RLS enabled with NO policies, so no client can
-- touch them directly — only the RPCs, which compute an is-me/among-N view.
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor. Kept in sync with fresh_setup.sql.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.daily_tasks (
  id          uuid primary key default gen_random_uuid(),
  task_id     text not null,                                   -- stable key, e.g. 'daily_win'
  title       text not null,
  description text,
  start_time  timestamptz not null,                            -- task becomes active
  end_time    timestamptz not null,                            -- task expires
  created_at  timestamptz not null default timezone('utc', now())
);

-- Active-window lookups (get_daily_tasks filters on now() between the bounds).
create index if not exists daily_tasks_window_idx
  on public.daily_tasks (start_time, end_time);

-- The "profiles completed" join: one row per profile that finished a task.
create table if not exists public.daily_task_completions (
  task_id      uuid not null references public.daily_tasks(id)  on delete cascade,
  user_id      uuid not null references auth.users(id)          on delete cascade,
  completed_at timestamptz not null default timezone('utc', now()),
  primary key (task_id, user_id)
);

create index if not exists daily_task_completions_user_idx
  on public.daily_task_completions (user_id);

-- RLS on, no policies: all access is via the SECURITY DEFINER RPCs below. The
-- service role bypasses RLS for admin/edge use.
alter table public.daily_tasks            enable row level security;
alter table public.daily_task_completions enable row level security;

-- ---------------------------------------------------------------------------
-- get_daily_tasks() — every task active right now, with the caller's own
-- completion flag and the total number of profiles that have completed it.
-- Never returns user_ids. Callable signed-in or not (anon sees completed=false).
-- ---------------------------------------------------------------------------
create or replace function public.get_daily_tasks()
returns table (
  id              uuid,
  task_id         text,
  title           text,
  description     text,
  start_time      timestamptz,
  end_time        timestamptz,
  completed_count bigint,
  completed       boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select t.id, t.task_id, t.title, t.description, t.start_time, t.end_time,
         (select count(*) from public.daily_task_completions c where c.task_id = t.id) as completed_count,
         exists (
           select 1 from public.daily_task_completions c
           where c.task_id = t.id and c.user_id = auth.uid()
         ) as completed
  from public.daily_tasks t
  where now() >= t.start_time and now() < t.end_time
  order by t.end_time asc, t.created_at asc;
$$;

grant execute on function public.get_daily_tasks() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- complete_daily_task(p_task_id) — mark the CURRENT user as having completed a
-- task. Idempotent, and only allowed while the task is within its active
-- window. Records the caller's own completion only (auth.uid()), so a user can
-- never complete a task on someone else's behalf. These tasks carry no payout,
-- so completion is a personal progress marker; if a rewarded task is ever added
-- its completion criteria must be verified server-side before calling this.
-- ---------------------------------------------------------------------------
create or replace function public.complete_daily_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_active boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select (now() >= start_time and now() < end_time)
  into   v_active
  from   public.daily_tasks
  where  id = p_task_id;

  if v_active is null then
    raise exception 'task_not_found';
  end if;
  if not v_active then
    raise exception 'task_not_active';
  end if;

  insert into public.daily_task_completions (task_id, user_id)
  values (p_task_id, v_uid)
  on conflict (task_id, user_id) do nothing;

  return jsonb_build_object(
    'ok', true,
    'task_id', p_task_id,
    'completed', true,
    'completed_count',
      (select count(*) from public.daily_task_completions c where c.task_id = p_task_id)
  );
end;
$$;

revoke all on function public.complete_daily_task(uuid) from public, anon;
grant execute on function public.complete_daily_task(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- ensure_daily_tasks() — (re)seed today's standard set of daily tasks for the
-- current UTC day if they aren't already present. Idempotent: only inserts a
-- task_id whose active window doesn't already cover "now". Call it once a day
-- (e.g. via pg_cron: `select cron.schedule('daily-tasks','5 0 * * *',
-- 'select public.ensure_daily_tasks()');`) so a fresh set rolls over at UTC
-- midnight. Run once now so the tables aren't empty on first deploy.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_daily_tasks()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz := date_trunc('day', timezone('utc', now()));
  v_end   timestamptz := date_trunc('day', timezone('utc', now())) + interval '1 day';
  v_added integer := 0;
begin
  insert into public.daily_tasks (task_id, title, description, start_time, end_time)
  select v.task_id, v.title, v.description, v_start, v_end
  from (values
    ('daily_login', 'Daily check-in',  'Sign in to FIGHT10 today.'),
    ('daily_play',  'Enter the arena', 'Play a PvP match today.'),
    ('daily_win',   'Taste victory',   'Win a PvP match today.')
  ) as v(task_id, title, description)
  where not exists (
    select 1 from public.daily_tasks t
    where t.task_id = v.task_id
      and t.start_time <= now() and t.end_time > now()
  );
  get diagnostics v_added = row_count;
  return v_added;
end;
$$;

revoke all on function public.ensure_daily_tasks() from public, anon, authenticated;
grant execute on function public.ensure_daily_tasks() to service_role;

-- Seed today's set immediately so the board isn't empty before the first
-- scheduled run.
select public.ensure_daily_tasks();

commit;
