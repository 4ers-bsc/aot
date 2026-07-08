-- ============================================================================
-- Test-only shim for the Supabase-managed pieces fresh_setup.sql depends on.
-- Runs against a plain PostgreSQL cluster BEFORE supabase/fresh_setup.sql:
--   * the anon / authenticated / service_role roles
--   * the auth schema (auth.users, auth.identities, auth.uid())
-- auth.uid() reads the test.auth_uid GUC so tests can impersonate any player
-- via tests.set_uid() (see 01_test_helpers.sql).
-- ============================================================================

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I with nologin', r);
    end if;
  end loop;
end
$$;

create extension if not exists pgcrypto;

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create table if not exists auth.identities (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  provider        text not null default 'web3',
  provider_id     text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz not null default now()
);

-- Supabase resolves auth.uid() from the request JWT; here it resolves from a
-- session GUC the test sets. Empty / unset means "not authenticated" (null),
-- matching an anonymous caller in production.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('test.auth_uid', true), '')::uuid;
$$;
