-- ---------------------------------------------------------------------------
-- Migration: the Degent skin (3).
--
-- Adds skin 3 — the Degent, a crowned ape in a black suit — next to
-- 1 = Fighter and 2 = Knight:
--   * profiles.skin_id and profiles.skins accept 3;
--   * every player has it: the skins default becomes {1,2,3} and existing
--     rows are backfilled;
--   * complete_onboarding() accepts 3 as the first-run pick.
--
-- The client already offers the Degent. Until this runs, saving it from the
-- APPEARANCE tab is rejected by the check constraints and onboarding falls
-- back to skin 1.
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor. Kept in sync with fresh_setup.sql §1/§13.
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

update public.profiles
set skins = array_append(skins, 3::smallint)
where not (3 = any (skins));

-- complete_onboarding: unchanged from 20260817_home_chat except that skin 3 is
-- now a valid pick.
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

  -- Skins 1 (Fighter), 2 (Knight) and 3 (Degent) exist; anything else falls
  -- back to 1.
  if v_skin not in (1, 2, 3) then
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
