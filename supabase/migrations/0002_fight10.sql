-- FIGHT10 tokenomics: entry fee deposits & prize payout tracking
--
-- Constants (raw token units assume 6 decimals on the Pump.fun SPL mint):
--   ENTRY_FEE_RAW = 2500 * 10^6 = 2_500_000_000
--
-- Flow:
--   1. Client transfers 2500 FIGHT10 on-chain → escrow wallet
--   2. Client calls record_deposit() with the confirmed tx signature
--   3. After finish_match(), winner invokes the payout Edge Function
--   4. Edge Function verifies deposits, sends 90% to winner, records payout_tx

-- ---------------------------------------------------------------------------
-- Schema changes
-- ---------------------------------------------------------------------------
alter table public.match_players
  add column if not exists deposit_tx text;

alter table public.matches
  add column if not exists pot_lamports bigint not null default 0,
  add column if not exists payout_tx text;

-- ---------------------------------------------------------------------------
-- record_deposit
-- Called by the client after the on-chain SPL transfer is confirmed.
-- Stores the Solana tx signature and increments the match pot counter.
-- ---------------------------------------------------------------------------
create or replace function public.record_deposit(p_match_id uuid, p_deposit_tx text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  -- Raw FIGHT10 units per player: 2500 × 10^6 (6-decimal Pump.fun mint)
  c_entry_fee_raw constant bigint := 2500000000;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if p_deposit_tx is null or trim(p_deposit_tx) = '' then
    raise exception 'invalid_deposit_tx';
  end if;

  if not exists (
    select 1 from public.match_players
    where match_id = p_match_id and user_id = v_uid
  ) then
    raise exception 'not_in_match';
  end if;

  -- Record this player's deposit signature
  update public.match_players
  set deposit_tx = p_deposit_tx
  where match_id = p_match_id and user_id = v_uid;

  -- Accumulate pot for audit trail
  update public.matches
  set pot_lamports = pot_lamports + c_entry_fee_raw
  where id = p_match_id;
end;
$$;

grant execute on function public.record_deposit(uuid, text) to authenticated;
