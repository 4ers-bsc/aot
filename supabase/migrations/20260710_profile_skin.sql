-- ---------------------------------------------------------------------------
-- Migration: per-player skin selection.
--
-- Adds profiles.skin_id so the chosen character skin (1 = Fighter,
-- 2 = Knight) follows the wallet across devices. The client writes it
-- directly (column-level grant below); sync_my_profile returns the whole row,
-- so the value comes back on sign-in with no function changes.
--
-- Safe to run on an existing database. Run in the Supabase SQL editor.
-- Kept in sync with fresh_setup.sql §1/§12.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists skin_id smallint not null default 1;

alter table public.profiles
  drop constraint if exists profiles_skin_id_check;

alter table public.profiles
  add constraint profiles_skin_id_check check (skin_id in (1, 2));

-- Column-level update grants are additive: authenticated keeps display_name
-- and gains skin_id. RLS still restricts updates to the player's own row.
grant update (skin_id) on public.profiles to authenticated;
