-- join with wrong wallet: the wallet that signed the on-chain deposit must be
-- the wallet the player signed in with (auth.identities.provider_id). A
-- deposit from any other wallet is rejected; chain prefixes ("solana:<key>")
-- are normalised before comparison.
begin;

do $$
declare
  u1  uuid := tests.create_player('solana:WalletOwnA');
  u2  uuid := tests.create_player('solana:WalletOwnB');
  u3  uuid := tests.create_player(null);  -- no wallet identity at all
  res jsonb;
begin
  -- Deposit signed by someone else's wallet
  perform tests.throws(
    format('select tests.join(%L::uuid, 2, %L, %L)', u1, 'sig_wallet_1', 'solana:WalletOwnB'),
    'deposit_wallet_mismatch%', 'deposit from a different wallet is rejected');

  -- ...and no seat, pot, or consumed signature came out of the attempt
  perform tests.ok(
    not exists (select 1 from public.match_players where user_id = u1),
    'rejected join takes no seat');
  perform tests.ok(
    not exists (select 1 from public.consumed_deposits where deposit_tx = 'sig_wallet_1'),
    'rejected join does not consume the deposit');

  -- A player with no login wallet on record can never pass the check
  perform tests.throws(
    format('select tests.join(%L::uuid, 2, %L, %L)', u3, 'sig_wallet_2', 'solana:WalletOwnC'),
    'deposit_wallet_mismatch%', 'player without a login wallet is rejected');

  -- Prefix normalisation: login identity stored as "solana:<key>", deposit
  -- wallet reported bare — same key, must match.
  res := tests.join(u2, 2, 'sig_wallet_3', 'WalletOwnB');
  perform tests.is(res ->> 'status', 'waiting', 'bare pubkey matches its prefixed login identity');
end;
$$;

rollback;
