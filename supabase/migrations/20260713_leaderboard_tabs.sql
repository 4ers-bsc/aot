-- ============================================================================
-- Leaderboard tabs: points, wins / win%, and $FIGHT10 holdings.
-- ----------------------------------------------------------------------------
-- * get_leaderboard grows a p_sort argument ('points' | 'wins') and now also
--   returns losses so the client can show win%. Old 1-arg calls keep working
--   (p_sort defaults to 'points'), but the return type changed, so the old
--   function must be dropped first.
-- * get_holdings_wallets backs the holdings tab. $FIGHT10 balances live
--   on-chain, so the client ranks wallets by balance itself; this RPC hands
--   it the wallet addresses to look up. Exposing wallet_address here is
--   deliberate: a holdings leaderboard only works by linking fighters to
--   their (already public) on-chain wallets. It still never exposes user_id.
-- ============================================================================

drop function if exists public.get_leaderboard(integer);

create or replace function public.get_leaderboard(
  p_limit integer default 20,
  p_sort  text    default 'points'
)
returns table (
  rank         bigint,
  display_name text,
  level        integer,
  points       integer,
  wins         integer,
  losses       integer,
  is_me        boolean
)
language sql
security definer
set search_path = public
stable
as $$
  with ranked as (
    select p.display_name,
           p.level,
           p.points,
           p.wins,
           p.losses,
           coalesce(p.user_id = auth.uid(), false) as is_me,
           p.created_at,
           p.wins::numeric / nullif(p.wins + p.losses, 0) as win_pct
    from public.profiles p
  )
  select row_number() over (
           order by
             case when p_sort = 'wins' then r.wins else r.points end desc,
             case when p_sort = 'wins' then r.win_pct end desc nulls last,
             case when p_sort = 'wins' then r.points else r.wins end desc,
             r.created_at asc
         ) as rank,
         r.display_name, r.level, r.points, r.wins, r.losses, r.is_me
  from ranked r
  order by
    case when p_sort = 'wins' then r.wins else r.points end desc,
    case when p_sort = 'wins' then r.win_pct end desc nulls last,
    case when p_sort = 'wins' then r.points else r.wins end desc,
    r.created_at asc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

grant execute on function public.get_leaderboard(integer, text) to authenticated, anon;

create or replace function public.get_holdings_wallets(p_limit integer default 100)
returns table (
  display_name   text,
  level          integer,
  wallet_address text,
  is_me          boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select p.display_name,
         p.level,
         p.wallet_address,
         coalesce(p.user_id = auth.uid(), false) as is_me
  from public.profiles p
  where p.wallet_address is not null
  order by p.points desc, p.created_at asc
  limit least(greatest(coalesce(p_limit, 100), 1), 100);
$$;

grant execute on function public.get_holdings_wallets(integer) to authenticated, anon;
