-- ---------------------------------------------------------------------------
-- Migration: per-player skins.
--
-- profiles.skins    — skins available to the player (1 = Fighter, 2 = Knight);
--                     every player currently gets both.
-- profiles.skin_id  — the default character: the player's saved skin
--                     preference (1 by default). Must be one of their
--                     available skins.
--
-- The client writes skin_id directly (column-level grant below) when the
-- player hits Save in the APPEARANCE tab; skins is server-managed only.
-- sync_my_profile returns the whole row, so both values come back on sign-in
-- with no function changes.
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor. Kept in sync with fresh_setup.sql §1/§12.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists skin_id smallint not null default 1;

alter table public.profiles
  add column if not exists skins smallint[] not null default '{1,2}';

alter table public.profiles
  drop constraint if exists profiles_skin_id_check;

alter table public.profiles
  add constraint profiles_skin_id_check check (skin_id in (1, 2));

alter table public.profiles
  drop constraint if exists profiles_skins_check;

alter table public.profiles
  add constraint profiles_skins_check check (skins <@ array[1, 2]::smallint[]);

-- The saved preference must be a skin the player actually has.
alter table public.profiles
  drop constraint if exists profiles_skin_in_skins;

alter table public.profiles
  add constraint profiles_skin_in_skins check (skin_id = any (skins));

-- Column-level update grants are additive: authenticated keeps display_name
-- and gains skin_id (but NOT skins — availability is server-managed). RLS
-- still restricts updates to the player's own row.
grant update (skin_id) on public.profiles to authenticated;
