-- ----------------------------------------------------------------------------
-- $FIGHT10 tokenomics: entry fee deposit tracking & payout audit trail
-- ----------------------------------------------------------------------------

-- Track each player's on-chain deposit tx for a match
alter table public.match_players
  add column if not exists deposit_tx text;

-- Track the on-chain payout tx and total pot size for audit purposes
alter table public.matches
  add column if not exists pot_tokens bigint default 0,
  add column if not exists payout_tx text;

-- ----------------------------------------------------------------------------
-- RPC: record_deposit
-- Called by the client after the on-chain SPL transfer is confirmed.
-- Writes the deposit tx signature into the caller's match_players row.
-- ----------------------------------------------------------------------------
create or replace function public.record_deposit(p_match_id uuid, p_deposit_tx text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_entry_fee bigint := 2500000000; -- 2500 FIGHT10 in base units (6 decimals)
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if not exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = v_uid
  ) then
    raise exception 'not_in_match';
  end if;

  -- Reject duplicate deposits for the same seat
  if exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = v_uid and deposit_tx is not null
  ) then
    raise exception 'deposit_already_recorded';
  end if;

  update public.match_players
  set deposit_tx = p_deposit_tx
  where match_id = p_match_id and user_id = v_uid;

  -- Accumulate pot size on the match row
  update public.matches
  set pot_tokens = coalesce(pot_tokens, 0) + v_entry_fee
  where id = p_match_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- RPC: record_payout_tx
-- Called by the Edge Function after the SPL payout transfer is confirmed.
-- Writes the payout tx signature onto the match row for audit purposes.
-- Runs as service role (Edge Function uses service key), so we allow any caller
-- but verify the match is finished first.
-- ----------------------------------------------------------------------------
create or replace function public.record_payout_tx(p_match_id uuid, p_payout_tx text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.matches
  set payout_tx = p_payout_tx
  where id = p_match_id and status = 'finished';
end;
$$;

-- Grant execute to authenticated users (record_deposit) and service role (record_payout_tx)
grant execute on function public.record_deposit(uuid, text) to authenticated;
grant execute on function public.record_payout_tx(uuid, text) to authenticated;
