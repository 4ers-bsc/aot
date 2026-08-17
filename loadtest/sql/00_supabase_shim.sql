-- ============================================================================
-- FIGHT10 load-test — Supabase environment shim
-- ============================================================================
-- supabase/fresh_setup.sql is written to run on a hosted Supabase project, so it
-- assumes the pieces Supabase provisions for you: the `auth` schema (users /
-- identities / auth.uid()), the anon / authenticated / service_role roles, the
-- pgcrypto extension, a `realtime` schema, and the `supabase_realtime`
-- publication. None of that exists in a bare Postgres cluster.
--
-- This file provides the *minimum* faithful stand-ins so the real schema applies
-- and behaves the way it does in production for the paths we load-test:
--   • auth.uid() reads the same GUC Supabase's GoTrue sets per request
--     (`request.jwt.claim.sub`), so the harness can impersonate a user by
--     setting that GUC inside a transaction — exactly what a real JWT does.
--   • auth.users fires the same on_auth_user_created trigger on insert.
--   • auth.identities.provider_id carries the login wallet, which join_pvp_match
--     reads to enforce "deposit signer == signed-in wallet".
--
-- It is deliberately NOT a full GoTrue clone — only the columns/functions the
-- game schema actually references are present. Nothing here touches production;
-- it runs against a throwaway local cluster.
-- ============================================================================

-- --- Roles Supabase ships with. NOLOGIN; the harness connects as a superuser --
-- (which, like the service role, bypasses RLS — the same trust boundary the
-- edge functions operate under). Created idempotently.
do $$
begin
  perform 1 from pg_roles where rolname = 'anon';
  if not found then create role anon nologin noinherit; end if;
  perform 1 from pg_roles where rolname = 'authenticated';
  if not found then create role authenticated nologin noinherit; end if;
  perform 1 from pg_roles where rolname = 'service_role';
  if not found then create role service_role nologin noinherit bypassrls; end if;
  perform 1 from pg_roles where rolname = 'authenticator';
  if not found then create role authenticator login noinherit; end if;
  perform 1 from pg_roles where rolname = 'supabase_auth_admin';
  if not found then create role supabase_auth_admin nologin noinherit; end if;
  perform 1 from pg_roles where rolname = 'supabase_realtime_admin';
  if not found then create role supabase_realtime_admin nologin noinherit; end if;
end
$$;

grant anon, authenticated, service_role to authenticator;

-- gen_random_uuid() is in core since PG13, but the game seeds decimals/crypto
-- helpers via pgcrypto in a couple of places — enable it to match prod.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- auth schema
-- ---------------------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Minimal auth.users. Real GoTrue has ~30 columns; the game only reads `id` and
-- (via the sign-up trigger) `raw_user_meta_data`. Foreign keys across the schema
-- point at auth.users(id).
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Minimal auth.identities. join_pvp_match reads provider_id (the login wallet)
-- ordered by last_sign_in_at/created_at, so those three columns must exist.
create table if not exists auth.identities (
  id              uuid not null default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  provider        text not null default 'web3',
  provider_id     text not null,
  identity_data   jsonb not null default '{}'::jsonb,
  last_sign_in_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (provider, provider_id)
);
create index if not exists idx_auth_identities_user on auth.identities(user_id);

-- auth.uid() — byte-for-byte the Supabase definition: it resolves the caller
-- from the JWT claims the API gateway injects as GUCs. The harness sets
-- `request.jwt.claim.sub` per transaction to impersonate a signed-in user.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

-- auth.role() / auth.jwt() — not referenced by the load-tested paths, provided
-- for parity so any incidental use resolves instead of erroring.
create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- realtime schema — the game defines RLS policies on realtime.messages so the
-- private per-match topic only admits a seat holder. We stand up just enough of
-- it (the table + realtime.topic()) for those policies to be created. Realtime
-- fan-out itself is out of scope for this DB-concurrency / anti-cheat harness.
-- ---------------------------------------------------------------------------
create schema if not exists realtime;
grant usage on schema realtime to anon, authenticated, service_role;

create table if not exists realtime.messages (
  id         bigint generated always as identity primary key,
  topic      text,
  extension  text,
  payload    jsonb,
  event      text,
  private    boolean default false,
  inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;

create or replace function realtime.topic()
returns text
language sql
stable
as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;

grant execute on function realtime.topic() to anon, authenticated, service_role;
