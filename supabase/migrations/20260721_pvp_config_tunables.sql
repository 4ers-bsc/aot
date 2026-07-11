-- ===========================================================================
-- pvp_config — single source of truth for global PvP tunables
-- ===========================================================================
-- Three numbers used to be hardcoded in several places at once:
--   * the global concurrent-player cap (150) lived in pvp_capacity_cap()
--   * the entry fee (2500) was a literal in the client AND in every edge
--     function that validates a deposit or pays out
--   * the winner's share (90%, written 900/1000) was a literal in the client UI
--     AND in the treasurer/admin payout math. Stored here as basis points
--     (9000 bps = 90%) so the payout is (total * winner_share_bps) / 10000.
-- They now live in one single-row table. pvp_capacity_cap() reads the cap;
-- pvp_settings() exposes all three to the browser; the payout edge functions
-- read fee + share from here (with the historical literals as fallbacks).
--
-- Edit from the Supabase dashboard: update pvp_config set entry_fee_tokens=...
-- The entry fee is guarded: it cannot change while any match is waiting/active,
-- because in-flight deposits were validated against the OLD fee and would be
-- rejected on-chain if the fee moved underneath them.
-- ---------------------------------------------------------------------------
create table if not exists public.pvp_config (
  id                boolean primary key default true check (id),  -- single-row guard
  player_cap        int not null default 150  check (player_cap between 1 and 100000),
  entry_fee_tokens  int not null default 2500 check (entry_fee_tokens between 1 and 100000000),
  winner_share_bps  int not null default 9000 check (winner_share_bps between 0 and 10000)
);
insert into public.pvp_config (id) values (true) on conflict (id) do nothing;

-- The entry fee gates on-chain deposit validation (f10join / f10treasurer /
-- f10admin reject any transfer that isn't exactly entry_fee_tokens). Changing
-- it while matches are live would strand deposits paid at the old fee, so block
-- that change until the board is clear.
create or replace function public.pvp_config_guard()
returns trigger
language plpgsql
as $$
begin
  if new.entry_fee_tokens is distinct from old.entry_fee_tokens
     and exists (select 1 from public.matches where status in ('waiting', 'active')) then
    raise exception
      'entry_fee_locked: cannot change the entry fee while matches are waiting or active';
  end if;
  return new;
end;
$$;

drop trigger if exists pvp_config_guard on public.pvp_config;
create trigger pvp_config_guard
  before update on public.pvp_config
  for each row execute function public.pvp_config_guard();

-- Global concurrent-player cap, now sourced from pvp_config. Callers are
-- unchanged: join_pvp_match's authoritative check and the client's advisory
-- pvp_capacity() both read through this one function. security definer so a
-- direct anon call (RLS notwithstanding) still sees the real value; falls back
-- to 150 if the row is somehow missing.
create or replace function public.pvp_capacity_cap()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select player_cap from public.pvp_config where id), 150);
$$;

-- Public read of all three tunables in one call. The browser loads this at
-- boot for the balance gate + prize-pot display; security definer so it works
-- for anon before sign-in, same as pvp_capacity().
create or replace function public.pvp_settings()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'player_cap',       public.pvp_capacity_cap(),
    'entry_fee_tokens', coalesce((select entry_fee_tokens from public.pvp_config where id), 2500),
    'winner_share_bps', coalesce((select winner_share_bps from public.pvp_config where id), 9000)
  );
$$;

grant execute on function public.pvp_settings() to authenticated, anon;

-- RLS: world-readable (non-sensitive tunables), writes service-role/dashboard
-- only — same posture as match_config and maintain.
alter table public.pvp_config enable row level security;
drop policy if exists "pvp_config_select_all" on public.pvp_config;
create policy "pvp_config_select_all"
on public.pvp_config for select to authenticated, anon using (true);
