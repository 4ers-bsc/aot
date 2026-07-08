/// Deposit-transfer verification, shared by f10join and f10treasurer.
//
// Given the parsed instructions of a confirmed Solana transaction, decides
// whether ANY of them is the exact SPL-token transfer a match entry requires:
//   * executed by the token program that owns the mint (classic or Token-2022),
//   * authorised (signed) by the player's own wallet — a transfer funded by a
//     third party is rejected,
//   * destined for the escrow's token account FOR THE FIGHT10 MINT — a
//     transfer of any other mint lands in a different token account and is
//     rejected by the destination check,
//   * for exactly the entry-fee amount.
//
// Dependency-free on purpose: no web3.js import, so the same file runs in the
// Deno edge runtime and under the Node test runner (tests/edge/).

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(str: string): Uint8Array {
  const map = new Uint8Array(256).fill(255);
  for (let i = 0; i < B58_ALPHABET.length; i++) map[B58_ALPHABET.charCodeAt(i)] = i;
  const bytes: number[] = [];
  for (const ch of str) {
    const v = map[ch.charCodeAt(0)];
    if (v === 255) throw new Error("Invalid base58 char: " + ch);
    let carry = v;
    for (let j = bytes.length - 1; j >= 0; j--) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.unshift(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (str[zeros] === "1") zeros++;
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58_ALPHABET[d]).join("");
}

// Canonical base58 form of a 32-byte pubkey — equivalent to web3.js's
// `new PublicKey(bytes).toBase58()` after the same left-padding the previous
// inline pubkeyFromBase58 helpers applied (web3.js's own base-x decoder does
// NOT pad short values). Non-base58 characters are stripped, mirroring the
// B58_CHARS scrub the edge functions ran on config values. Throws when the
// value cannot be a pubkey (> 32 bytes).
export function canonicalPubkey(str: string): string {
  const raw = base58Decode(str.replace(/[^1-9A-HJ-NP-Za-km-z]/g, ""));
  if (raw.length > 32) throw new Error(`base58 too long: ${raw.length} bytes`);
  const padded = new Uint8Array(32);
  padded.set(raw, 32 - raw.length);
  return base58Encode(padded);
}

export interface DepositCheck {
  /** Canonical base58 pubkey that must have signed the transfer (the player). */
  expectedSender: string;
  /** The escrow's token account for the FIGHT10 mint (base58). */
  escrowAta: string;
  /** Exact entry-fee amount in raw units, as a decimal string. */
  amountRaw: string;
  /** Base58 id of the token program that owns the mint. */
  tokenProgramId: string;
  /** Base58 id of the Token-2022 program (always also accepted). */
  token2022ProgramId: string;
}

// One parsed instruction (top-level or inner), as returned by
// getParsedTransaction. Kept loose — RPC nodes vary in what they attach.
// deno-lint-ignore no-explicit-any
type ParsedInstruction = any;

export function isValidDepositTransfer(ix: ParsedInstruction, p: DepositCheck): boolean {
  const prog = ix?.programId?.toString();
  if (prog !== p.tokenProgramId && prog !== p.token2022ProgramId) return false;
  if (!ix.parsed) return false;
  const { type, info } = ix.parsed;
  // Single-sig wallets use `authority`; multisig uses `multisigAuthority`.
  const senderRaw = info?.authority ?? info?.multisigAuthority;
  if (!senderRaw) return false;
  let sender: string;
  try {
    sender = canonicalPubkey(String(senderRaw));
  } catch {
    return false;
  }
  if (sender !== p.expectedSender) return false;
  if (type === "transfer") {
    return info.destination === p.escrowAta && info.amount === p.amountRaw;
  }
  if (type === "transferChecked") {
    return info.destination === p.escrowAta && info.tokenAmount?.amount === p.amountRaw;
  }
  return false;
}

/** True when any instruction (pass top-level + inner combined) is the required transfer. */
export function hasValidDepositTransfer(instructions: ParsedInstruction[], p: DepositCheck): boolean {
  return instructions.some((ix) => isValidDepositTransfer(ix, p));
}
