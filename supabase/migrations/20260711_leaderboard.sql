-- ============================================================================
-- Points leaderboard.
-- ----------------------------------------------------------------------------
-- profiles RLS only exposes a player's own row, so the public leaderboard is
-- served by this security definer RPC instead. It returns only display data
-- (name, level, points, wins) — never user_id or wallet_address — plus an
-- is_me flag computed server-side so the client can highlight the caller's
-- row without the RPC leaking anyone's identity.
-- ============================================================================

create or replace function public.get_leaderboard(p_limit integer default 20)
returns table (
  rank         bigint,
  display_name text,
  level        integer,
  points       integer,
  wins         integer,
  is_me        boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select row_number() over (order by p.points desc, p.wins desc, p.created_at asc) as rank,
         p.display_name,
         p.level,
         p.points,
         p.wins,
         coalesce(p.user_id = auth.uid(), false) as is_me
  from public.profiles p
  order by p.points desc, p.wins desc, p.created_at asc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- Anyone may view the leaderboard, signed in or not.
grant execute on function public.get_leaderboard(integer) to authenticated, anon;
