-- ---------------------------------------------------------------------------
-- Migration: players may only edit their own name + skin; admin wallets are
-- matched against the wallet a user actually signs in with.
--
-- The hole: Supabase's default privileges grant anon + authenticated ALL on
-- every table created in `public`, and a column-level GRANT only ADDS rights —
-- it never narrows a table-level one. So the intended
--   grant update (display_name, skin_id) on public.profiles to authenticated
-- was a no-op: the table-wide UPDATE stayed, and the row-level policy
-- (profiles_update_own_name) let any signed-in player rewrite EVERY column of
-- their own row through the REST API — wallet_address, wins, points, streaks.
--
-- Why that mattered:
--   * f10admin matched ADMIN_WALLETS against profiles.wallet_address, so a
--     player who copied an admin's (public, on-chain) wallet into their own
--     profile passed the ops-dashboard gate.
--   * The leaderboards read wins / points / wallet_address from profiles.
--   * The dashboard's manual-payout tools read the profile wallet.
--
-- Fix:
--   1. Revoke the table-wide privileges and grant back exactly what the client
--      needs: SELECT (own row, via RLS) and UPDATE of display_name + skin_id.
--      Every other write already goes through SECURITY DEFINER functions
--      (sync_my_profile, complete_onboarding, apply_match_result, …), which
--      run as the table owner and are unaffected.
--   2. login_wallets_of(): the wallet(s) a user has signed in with, straight
--      from auth.identities — the same source join_pvp_match trusts. f10admin
--      now checks ADMIN_WALLETS against this. Service role only.
--   3. One-time repair: reset any stored wallet_address that doesn't match the
--      player's latest sign-in wallet. sync_my_profile already does exactly
--      this at every sign-in; doing it now also covers dormant accounts. The
--      number of rows reset is reported as a NOTICE — a non-zero count means
--      wallets were rewritten through the hole (or drifted since sign-in).
--      Empty wallets are left for sync_my_profile to fill at the next sign-in.
--
-- Stats (wins / points / …) have no second copy to restore from; see the
-- read-only audit query at the end to find profiles whose stats exceed what
-- their settled matches account for.
--
-- Safe to run (and re-run) on an existing database. Run in the Supabase SQL
-- editor BEFORE deploying the matching f10admin. Kept in sync with
-- fresh_setup.sql §12 (grants) and §21 (login_wallets_of).
-- ---------------------------------------------------------------------------

begin;

-- ── 1. Profile write privileges ─────────────────────────────────────────────
-- REVOKE on a table also drops any column privileges, so re-grant after it.
revoke all on public.profiles from anon, authenticated;
grant select, update (display_name, skin_id) on public.profiles to authenticated;

-- ── 2. Sign-in wallets (for the admin allowlist) ────────────────────────────
-- Every wallet the user has authenticated with. provider_id may carry a CAIP /
-- provider prefix ("web3:solana:<addr>"); keep only the trailing segment —
-- base58 is case-sensitive, so no lower().
create or replace function public.login_wallets_of(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(array_agg(distinct regexp_replace(trim(provider_id), '^.*:', '')), '{}')
  from auth.identities
  where user_id = p_user_id
    and provider_id is not null;
$$;

revoke all on function public.login_wallets_of(uuid) from public, anon, authenticated;
grant execute on function public.login_wallets_of(uuid) to service_role;

-- ── 3. Repair wallets rewritten through the old hole ────────────────────────
do $$
declare
  v_fixed bigint;
begin
  update public.profiles p
  set wallet_address = i.provider_id
  from (
    select distinct on (user_id) user_id, provider_id
    from auth.identities
    where provider_id is not null
    order by user_id, coalesce(last_sign_in_at, created_at) desc
  ) i
  where i.user_id = p.user_id
    and nullif(trim(p.wallet_address), '') is not null
    and regexp_replace(trim(p.wallet_address), '^.*:', '')
        <> regexp_replace(trim(i.provider_id), '^.*:', '');
  get diagnostics v_fixed = row_count;
  raise notice 'profile_write_guard: reset % profile wallet(s) that did not match the owner''s sign-in wallet', v_fixed;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- Audit (read-only — run by hand). Profiles whose stats exceed what their
-- settled matches account for: apply_match_result is the only writer, adding
-- one win or loss per settled match (+60 base and +10 per streak step for a
-- win, +10 for a loss). A row here was edited outside the game — or predates
-- stats_applied tracking, so check the account before acting on it.
--
-- with settled as (
--   select mp.user_id,
--          count(*) filter (where m.winner_user_id = mp.user_id)                as wins,
--          count(*) filter (where m.winner_user_id is distinct from mp.user_id) as losses
--   from public.match_players mp
--   join public.matches m on m.id = mp.match_id
--   where m.stats_applied
--   group by mp.user_id
-- )
-- select p.user_id, p.display_name, p.wallet_address,
--        p.wins,   coalesce(s.wins, 0)   as settled_wins,
--        p.losses, coalesce(s.losses, 0) as settled_losses,
--        p.games_played, p.points, p.best_streak
-- from public.profiles p
-- left join settled s on s.user_id = p.user_id
-- where p.wins         > coalesce(s.wins, 0)
--    or p.losses       > coalesce(s.losses, 0)
--    or p.games_played > coalesce(s.wins, 0) + coalesce(s.losses, 0)
--    or p.best_streak  > p.wins
--    or p.points       > 60 * p.wins + 5 * p.wins * greatest(p.wins - 1, 0) + 10 * p.losses
-- order by p.points desc;
-- ---------------------------------------------------------------------------
