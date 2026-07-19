-- ---------------------------------------------------------------------------
-- Migration: skin 3 — "Babbler", the black/gold voxel boxer.
--
-- Widens the skin constraints to admit id 3, grants it to every existing
-- player (like 1 and 2, everyone gets it), and makes new profiles start with
-- all three. skin_id write access is unchanged — the client already has the
-- column-level grant from 20260710_profile_skin.sql.
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor. Kept in sync with fresh_setup.sql §1.
-- ---------------------------------------------------------------------------

alter table public.profiles
  drop constraint if exists profiles_skin_id_check;

alter table public.profiles
  add constraint profiles_skin_id_check check (skin_id in (1, 2, 3));

alter table public.profiles
  drop constraint if exists profiles_skins_check;

alter table public.profiles
  add constraint profiles_skins_check check (skins <@ array[1, 2, 3]::smallint[]);

alter table public.profiles
  alter column skins set default '{1,2,3}';

-- Everyone gets Babbler.
update public.profiles
  set skins = skins || 3::smallint
  where not (3 = any (skins));
