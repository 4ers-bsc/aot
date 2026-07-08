// Unit tests for the deposit-transfer verification shared by the f10join and
// f10treasurer edge functions (supabase/functions/_shared/deposit_verify.ts).
//
// Run with: node --experimental-strip-types --test tests/edge/
//
// The fixtures mirror what Solana's getParsedTransaction returns for SPL-token
// instructions. "Wrong mint" is caught by the destination check: an SPL
// transfer of a different mint necessarily lands in a different token account
// than the escrow's FIGHT10 ATA the functions resolve on-chain.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  base58Decode,
  base58Encode,
  canonicalPubkey,
  hasValidDepositTransfer,
  isValidDepositTransfer,
} from "../../supabase/functions/_shared/deposit_verify.ts";

const TOKEN_PROG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ENTRY_FEE = "2500000000"; // 2500 tokens on the 6-decimal FIGHT10 mint

const randomPubkey = () => new PublicKey(crypto.randomBytes(32)).toBase58();

const PLAYER = randomPubkey(); // wallet recorded at join time
const OTHER_WALLET = randomPubkey(); // anyone else
const ESCROW_ATA = randomPubkey(); // escrow's token account for the FIGHT10 mint
const OTHER_MINT_ATA = randomPubkey(); // escrow's token account for some OTHER mint
const ATTACKER_ATA = randomPubkey(); // some non-escrow token account

const params = {
  expectedSender: canonicalPubkey(PLAYER),
  escrowAta: ESCROW_ATA,
  amountRaw: ENTRY_FEE,
  tokenProgramId: TOKEN_PROG,
  token2022ProgramId: TOKEN_2022,
};

// A parsed `transfer` instruction as an RPC node reports it.
const transfer = (over = {}) => ({
  programId: TOKEN_PROG,
  parsed: {
    type: "transfer",
    info: { authority: PLAYER, destination: ESCROW_ATA, amount: ENTRY_FEE, ...over },
  },
});

// A parsed `transferChecked` instruction (carries mint + tokenAmount).
const transferChecked = (over = {}) => ({
  programId: TOKEN_PROG,
  parsed: {
    type: "transferChecked",
    info: {
      authority: PLAYER,
      destination: ESCROW_ATA,
      mint: randomPubkey(),
      tokenAmount: { amount: ENTRY_FEE, decimals: 6 },
      ...over,
    },
  },
});

test("valid transfer from the player to escrow is accepted", () => {
  assert.equal(isValidDepositTransfer(transfer(), params), true);
});

test("valid transferChecked is accepted", () => {
  assert.equal(isValidDepositTransfer(transferChecked(), params), true);
});

test("programId may be a PublicKey object (as web3.js returns it)", () => {
  const ix = transfer();
  ix.programId = new PublicKey(TOKEN_PROG);
  assert.equal(isValidDepositTransfer(ix, params), true);
});

test("token-2022 transfers are accepted", () => {
  const ix = transfer();
  ix.programId = TOKEN_2022;
  assert.equal(isValidDepositTransfer(ix, params), true);
});

test("multisig wallets (multisigAuthority) are accepted", () => {
  const ix = transfer({ authority: undefined, multisigAuthority: PLAYER });
  assert.equal(isValidDepositTransfer(ix, params), true);
});

test("wrong mint: transfer of another token lands in another ATA and is rejected", () => {
  // Same signer, same amount — but a different mint's transfer can only credit
  // the escrow's token account for THAT mint, never the FIGHT10 ATA.
  const ix = transferChecked({ destination: OTHER_MINT_ATA });
  assert.equal(isValidDepositTransfer(ix, params), false);
});

test("wrong escrow destination: transfer to a non-escrow account is rejected", () => {
  assert.equal(isValidDepositTransfer(transfer({ destination: ATTACKER_ATA }), params), false);
  assert.equal(
    isValidDepositTransfer(transferChecked({ destination: ATTACKER_ATA }), params),
    false,
  );
});

test("wrong sender: transfer signed by another wallet is rejected", () => {
  assert.equal(isValidDepositTransfer(transfer({ authority: OTHER_WALLET }), params), false);
});

test("missing authority (no signer info) is rejected", () => {
  assert.equal(isValidDepositTransfer(transfer({ authority: undefined }), params), false);
});

test("garbage authority that is not a pubkey is rejected, not thrown", () => {
  const tooLong = base58Encode(crypto.randomBytes(48));
  assert.equal(isValidDepositTransfer(transfer({ authority: tooLong }), params), false);
});

test("wrong amount is rejected (short, long, and zero)", () => {
  assert.equal(isValidDepositTransfer(transfer({ amount: "2499999999" }), params), false);
  assert.equal(isValidDepositTransfer(transfer({ amount: "25000000000" }), params), false);
  assert.equal(isValidDepositTransfer(transfer({ amount: "0" }), params), false);
  assert.equal(
    isValidDepositTransfer(transferChecked({ tokenAmount: { amount: "1", decimals: 6 } }), params),
    false,
  );
});

test("non-token-program instructions are rejected even with matching fields", () => {
  const ix = transfer();
  ix.programId = "11111111111111111111111111111111"; // System program
  assert.equal(isValidDepositTransfer(ix, params), false);
});

test("unparsed instructions are rejected", () => {
  assert.equal(isValidDepositTransfer({ programId: TOKEN_PROG }, params), false);
});

test("other instruction types (approve, burn, mintTo) are rejected", () => {
  for (const type of ["approve", "burn", "mintTo", "closeAccount"]) {
    const ix = transfer();
    ix.parsed.type = type;
    assert.equal(isValidDepositTransfer(ix, params), false, type);
  }
});

test("hasValidDepositTransfer finds a CPI-wrapped transfer among noise", () => {
  const noise = [
    { programId: "ComputeBudget111111111111111111111111111111" },
    transfer({ destination: ATTACKER_ATA }),
  ];
  assert.equal(hasValidDepositTransfer([...noise, transfer()], params), true);
  assert.equal(hasValidDepositTransfer(noise, params), false);
  assert.equal(hasValidDepositTransfer([], params), false);
});

// ── canonicalPubkey must agree byte-for-byte with web3.js ────────────────────
// The edge functions previously canonicalised via `new PublicKey(...).toBase58()`;
// the shared module re-implements that without the dependency. Cross-check.

test("canonicalPubkey matches web3.js PublicKey.toBase58 on random keys", () => {
  for (let i = 0; i < 500; i++) {
    const bytes = crypto.randomBytes(32);
    const expected = new PublicKey(bytes).toBase58();
    assert.equal(canonicalPubkey(expected), expected);
  }
});

test("canonicalPubkey left-pads short (leading-zero) keys like web3.js", () => {
  for (const zeros of [1, 2, 5, 31, 32]) {
    const bytes = Buffer.concat([Buffer.alloc(zeros), crypto.randomBytes(32 - zeros)]);
    const expected = new PublicKey(bytes).toBase58();
    // Feed the UNPADDED base58 form — this is what pubkeyFromBase58 handled.
    const short = base58Encode(bytes.subarray(zeros));
    assert.equal(canonicalPubkey(short), expected, `zeros=${zeros}`);
  }
});

test("canonicalPubkey strips non-base58 characters (whitespace, newlines)", () => {
  const key = randomPubkey();
  assert.equal(canonicalPubkey(`  ${key}\n`), key);
});

test("canonicalPubkey throws on values longer than 32 bytes", () => {
  assert.throws(() => canonicalPubkey(base58Encode(crypto.randomBytes(33))));
});

test("base58 encode/decode round-trips, including all-zero keys", () => {
  for (let i = 0; i < 100; i++) {
    const bytes = crypto.randomBytes(1 + (i % 40));
    assert.deepEqual(base58Decode(base58Encode(bytes)), new Uint8Array(bytes));
  }
  assert.equal(base58Encode(new Uint8Array(32)), "1".repeat(32)); // System program
});
