// Reset the isolated DB and mint N synthetic users. Each user is a real
// auth.users row (which fires the on_auth_user_created trigger → a profile) plus
// an auth.identities row whose provider_id is the login wallet — the value
// join_pvp_match checks the deposit signer against.

import { q, pool } from "./db.mjs";
import { wallet as mkWallet, uuid, makeRng } from "./util.mjs";

// Every table that hangs off auth.users / public.matches. TRUNCATE ... CASCADE
// from these two roots clears the whole game state between phases.
export async function reset() {
  await q(
    `truncate table auth.users, public.matches restart identity cascade`,
  );
}

export async function seedUsers(n, seed = 20260817) {
  const rng = makeRng(seed);
  const users = Array.from({ length: n }, (_, i) => ({
    id: uuid(),
    wallet: mkWallet(rng),
    idx: i,
  }));

  // Bulk insert users, then identities, in chunks to keep parameter counts sane.
  const chunk = 500;
  for (let i = 0; i < users.length; i += chunk) {
    const slice = users.slice(i, i + chunk);
    const values = slice.map((_, k) => `($${k + 1})`).join(",");
    await q(
      `insert into auth.users (id) values ${values}`,
      slice.map((u) => u.id),
    );
  }
  for (let i = 0; i < users.length; i += chunk) {
    const slice = users.slice(i, i + chunk);
    const values = slice
      .map((_, k) => `($${2 * k + 1}, $${2 * k + 2}, now())`)
      .join(",");
    const params = slice.flatMap((u) => [u.id, u.wallet]);
    await q(
      `insert into auth.identities (user_id, provider_id, last_sign_in_at) values ${values}`,
      params,
    );
  }
  return users;
}

export { pool };
