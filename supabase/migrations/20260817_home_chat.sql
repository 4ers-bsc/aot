-- ---------------------------------------------------------------------------
-- Migration: home chat + host-run Y/N poll + first-sign-in onboarding.
--
-- Adds a lightweight broadcast chat that lives on the home screen:
--   * chat_messages — world-readable message log. ONLY the operator may post,
--     and posting goes exclusively through the admin-gated f10admin edge
--     function (service role). No INSERT grant/policy exists for anon or
--     authenticated, so a browser can never write a message. Same single
--     source of admin truth as every other privileged path (ADMIN_USER_IDS /
--     ADMIN_WALLETS in the edge function env) — no admin flag in the DB.
--   * chat_poll — a single running Yes/No vote the operator opens and closes.
--     yes_count / no_count are maintained by a trigger so every client can read
--     the live tally from one row (realtime UPDATE) with no per-vote fan-out.
--   * chat_votes — one row per (poll, user); a signed-in player casts / changes
--     their vote through cast_chat_vote() while the poll is open. Not client-
--     readable and not realtime-published: the counts on chat_poll are the
--     public surface, and a vote's owner is private.
--
-- Also adds profiles.onboarded so a brand-new player is prompted to pick a
-- name + avatar the first time they sign in. Existing players are backfilled to
-- onboarded = true so they are never re-prompted. complete_onboarding() saves
-- the chosen name (unique-checked) + skin and flips the flag atomically.
--
-- chat_messages and chat_poll are added to the supabase_realtime publication so
-- the client receives new messages and live vote counts over Realtime Postgres
-- Changes. RLS grants anon + authenticated SELECT, so the chat and the tally are
-- visible on the home screen before sign-in, exactly like the online count.
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor. Kept in sync with fresh_setup.sql §13 (Home chat).
-- ---------------------------------------------------------------------------

-- ── Onboarding flag ─────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists onboarded boolean not null default false;

-- Existing players already have a name + skin — never re-prompt them. Only rows
-- created from here on (default false) go through first-run onboarding.
update public.profiles set onboarded = true where onboarded = false;

-- complete_onboarding: the first-run save path. Sets the chosen display name
-- (3–24 chars, unique case-insensitively) and skin, marks the profile onboarded,
-- and returns the whole row. Raises 'username_taken' the same way sync_my_profile
-- does so the picker can show a friendly error.
create or replace function public.complete_onboarding(
  p_display_name text,
  p_skin_id      smallint default 1
)
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid     uuid     := auth.uid();
  v_name    text     := nullif(trim(p_display_name), '');
  v_skin    smallint := coalesce(p_skin_id, 1);
  v_profile public.profiles%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if v_name is null or char_length(v_name) < 3 or char_length(v_name) > 24 then
    raise exception 'invalid_name: username must be 3-24 characters';
  end if;

  -- Only skins 1 (Fighter) and 2 (Knight) exist; anything else falls back to 1.
  if v_skin not in (1, 2) then
    v_skin := 1;
  end if;

  if exists (
    select 1 from public.profiles
    where lower(display_name) = lower(v_name) and user_id <> v_uid
  ) then
    raise exception 'username_taken: that username is already in use';
  end if;

  begin
    update public.profiles
    set display_name = v_name,
        skin_id      = v_skin,
        onboarded    = true
    where user_id = v_uid
    returning * into v_profile;

    -- The row is normally created by sync_my_profile on sign-in; create it here
    -- too so onboarding can never dead-end on a missing profile.
    if not found then
      insert into public.profiles (user_id, display_name, skin_id, onboarded, wallet_address)
      values (
        v_uid, v_name, v_skin, true,
        (select provider_id from auth.identities
           where user_id = v_uid
           order by coalesce(last_sign_in_at, created_at) desc
           limit 1)
      )
      returning * into v_profile;
    end if;
  exception when unique_violation then
    -- Lost a race for the requested name; the pre-check above missed it.
    raise exception 'username_taken: that username is already in use';
  end;

  return v_profile;
end;
$$;

grant execute on function public.complete_onboarding(text, smallint) to authenticated;

-- ── Chat message log ────────────────────────────────────────────────────────
create table if not exists public.chat_messages (
  id          bigint generated always as identity primary key,
  body        text not null check (char_length(body) between 1 and 2000),
  author_id   uuid references auth.users(id) on delete set null,
  author_name text,
  author_skin smallint,
  created_at  timestamptz not null default timezone('utc', now())
);

create index if not exists idx_chat_messages_created_at
  on public.chat_messages (created_at desc);

-- ── Running Yes/No poll ─────────────────────────────────────────────────────
create table if not exists public.chat_poll (
  id         bigint generated always as identity primary key,
  question   text,
  is_open    boolean not null default true,
  yes_count  integer not null default 0,
  no_count   integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  closed_at  timestamptz
);

-- At most one poll may be open at any time. The operator "opens" a vote by
-- closing the previous one and inserting a fresh row (which also resets every
-- player's vote to none), so this index is the integrity backstop.
create unique index if not exists idx_chat_poll_single_open
  on public.chat_poll ((is_open)) where is_open;

-- ── Individual votes ────────────────────────────────────────────────────────
create table if not exists public.chat_votes (
  poll_id    bigint not null references public.chat_poll(id) on delete cascade,
  user_id    uuid   not null references auth.users(id) on delete cascade,
  choice     boolean not null,               -- true = Yes, false = No
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (poll_id, user_id)
);

-- Keep chat_poll.yes_count / no_count exactly in step with chat_votes. Recomputed
-- from scratch on every change (vote counts are bounded by the online crowd, so
-- this is cheap and can never drift the way running deltas can).
create or replace function public.chat_votes_sync_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll bigint := coalesce(new.poll_id, old.poll_id);
begin
  update public.chat_poll p set
    yes_count = (select count(*) from public.chat_votes v where v.poll_id = p.id and v.choice),
    no_count  = (select count(*) from public.chat_votes v where v.poll_id = p.id and not v.choice)
  where p.id = v_poll;
  return null;
end;
$$;

drop trigger if exists chat_votes_sync_counts_trg on public.chat_votes;
create trigger chat_votes_sync_counts_trg
after insert or update or delete on public.chat_votes
for each row execute function public.chat_votes_sync_counts();

-- cast_chat_vote: a signed-in player casts (or changes) their Yes/No on the
-- currently open poll. security definer so the write happens without a direct
-- table grant; the poll-open check and one-row-per-user key stop stuffing.
create or replace function public.cast_chat_vote(p_choice boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid  uuid := auth.uid();
  v_poll public.chat_poll%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_poll from public.chat_poll where is_open order by id desc limit 1;
  if not found then
    raise exception 'no_open_poll: voting is not open right now';
  end if;

  insert into public.chat_votes (poll_id, user_id, choice)
  values (v_poll.id, v_uid, p_choice)
  on conflict (poll_id, user_id)
  do update set choice = excluded.choice, updated_at = timezone('utc', now());

  -- Re-read the counts the AFTER trigger just refreshed.
  select * into v_poll from public.chat_poll where id = v_poll.id;

  return jsonb_build_object(
    'poll_id',   v_poll.id,
    'question',  v_poll.question,
    'is_open',   v_poll.is_open,
    'yes_count', v_poll.yes_count,
    'no_count',  v_poll.no_count,
    'your_vote', p_choice
  );
end;
$$;

grant execute on function public.cast_chat_vote(boolean) to authenticated;

-- get_chat_state: the latest poll (open or not) plus the caller's own vote, for
-- the initial paint. Live updates thereafter come over Realtime. Callable by
-- anon so the home-screen chat can show the current vote before sign-in.
create or replace function public.get_chat_state()
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid    uuid := auth.uid();
  v_poll   public.chat_poll%rowtype;
  v_choice boolean;
begin
  select * into v_poll from public.chat_poll order by id desc limit 1;
  if not found then
    return jsonb_build_object('poll', null, 'your_vote', null);
  end if;

  if v_uid is not null then
    select choice into v_choice
    from public.chat_votes
    where poll_id = v_poll.id and user_id = v_uid;
  end if;

  return jsonb_build_object(
    'poll', jsonb_build_object(
      'id',        v_poll.id,
      'question',  v_poll.question,
      'is_open',   v_poll.is_open,
      'yes_count', v_poll.yes_count,
      'no_count',  v_poll.no_count
    ),
    'your_vote', v_choice
  );
end;
$$;

grant execute on function public.get_chat_state() to authenticated, anon;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.chat_messages enable row level security;
alter table public.chat_poll     enable row level security;
alter table public.chat_votes    enable row level security;

-- Chat + poll tally are world-readable (shown on the home screen before login).
-- No write policy exists for anon/authenticated: messages are written only by
-- the service role via f10admin, and votes only via cast_chat_vote (definer).
drop policy if exists "chat_messages_select_all" on public.chat_messages;
create policy "chat_messages_select_all"
on public.chat_messages for select to authenticated, anon using (true);

drop policy if exists "chat_poll_select_all" on public.chat_poll;
create policy "chat_poll_select_all"
on public.chat_poll for select to authenticated, anon using (true);

-- A voter may read their own vote row (their choice), nothing else.
drop policy if exists "chat_votes_select_own" on public.chat_votes;
create policy "chat_votes_select_own"
on public.chat_votes for select to authenticated using (auth.uid() = user_id);

grant select on public.chat_messages to authenticated, anon;
grant select on public.chat_poll     to authenticated, anon;
grant select on public.chat_votes    to authenticated;

-- ── Realtime ────────────────────────────────────────────────────────────────
-- New messages and live vote counts reach clients over Realtime Postgres
-- Changes. Add the two public-readable tables to the supabase_realtime
-- publication (creating it if a bare project somehow lacks it). chat_votes is
-- deliberately NOT published — individual votes are private; the tally on
-- chat_poll is the realtime surface.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_poll'
  ) then
    alter publication supabase_realtime add table public.chat_poll;
  end if;
end
$$;
